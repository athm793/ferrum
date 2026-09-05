// Coercion: the model's answer → what actually goes in the cell.
//
// This is the last gate before a value is written with status `done` and starts being sorted,
// summed, filtered and exported as real data. The old implementation took the first numeric
// substring it could find ANYWHERE in the answer, which is why every one of these has a wrong answer
// recorded beside it — each one was silently written through, and none of them errored.
//
// The rule under test throughout is REJECT, NEVER SALVAGE. A schema error is retried once and is
// visible in the cell; a silent factor of a million is neither.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addColumn, createSheet, setColumnWaterfall } from "../store.ts";
import { coerce, executeCell, goodEnough } from "./executor.ts";
import type { CellJob } from "../runs.ts";

const ok = (v: unknown, type: Parameters<typeof coerce>[1], expected: string, opts = {}) => {
  const r = coerce(v, type, opts);
  assert.equal(r.error, undefined, `unexpected error: ${r.error}`);
  assert.equal(r.text, expected);
};

const rejects = (v: unknown, type: Parameters<typeof coerce>[1], opts = {}) => {
  const r = coerce(v, type, opts);
  assert.ok(r.error, `"${String(v)}" must be refused, got ${JSON.stringify(r.text)}`);
  assert.equal(r.text, null);
};

// ── numbers ─────────────────────────────────────────────────────────────────

test("a magnitude suffix is expanded, not ignored", () => {
  // Used to store 5.2 — a factor of a million out, written `done`, and summed as revenue.
  ok("5.2M", "number", "5200000");
  ok("1.4bn", "currency", "1400000000");
  ok("300k", "number", "300000");
  ok("2 trillion", "number", "2000000000000");
});

test("exponent notation is read as a number, not truncated at the 'e'", () => {
  ok("1.5e6", "number", "1500000");   // used to store 1.5
  ok("2E3", "number", "2000");
});

test("an accounting negative keeps its sign", () => {
  ok("(29)", "currency", "-29");      // used to store 29 — a credit became a debit
  ok("-29.5", "number", "-29.5");
});

test("prose containing a number is refused, not mined for one", () => {
  rejects("Q4 2024 revenue", "number");        // used to store 4
  rejects("between 100 and 200", "number");    // used to store 100
  rejects("about a hundred", "number");
  rejects("29/mo", "number");
});

test("a European decimal is ambiguous, so it is refused rather than guessed", () => {
  rejects("1.234,56", "number");     // used to store 1.23456
  rejects("1,23", "number");
  // The unambiguous grouping still works, because there is only one reading of it.
  ok("1,234,567.89", "number", "1234567.89");
});

test("currency symbols and codes are stripped, which is what a number column is for", () => {
  ok("$29", "currency", "29");
  ok("29 USD", "currency", "29");
  ok("€1,299.00", "currency", "1299");
});

test("percent columns store percentage points, and money is never a percentage", () => {
  ok("29%", "percent", "29");
  ok("29", "percent", "29");
  rejects("29%", "currency");
});

// ── dates ───────────────────────────────────────────────────────────────────

test("a written date becomes ISO-8601, because sorting and range filters compare lexically", () => {
  // Written verbatim, "March 3rd, 2024" sorts between January and May and matches no range at all.
  ok("March 3rd, 2024", "date", "2024-03-03");
  ok("3 March 2024", "date", "2024-03-03");
  ok("Mar 3 2024", "date", "2024-03-03");
  ok("2024-03-03", "date", "2024-03-03");
});

test("a datetime is normalised to UTC, and a date column keeps only the day", () => {
  ok("2024-03-03T10:30:00Z", "datetime", "2024-03-03T10:30:00.000Z");
  ok("2024-03-03T10:30:00+02:00", "datetime", "2024-03-03T08:30:00.000Z");
  ok("2024-03-03T10:30:00Z", "date", "2024-03-03");
  ok("2024-03-03", "datetime", "2024-03-03T00:00:00.000Z");
});

test("an all-numeric date is ambiguous and a non-date is not a date", () => {
  rejects("03/04/2024", "date");   // the 3rd of April, or the 4th of March — nothing says which
  rejects("sometime in March", "date");
  rejects("2024-02-31", "date");   // a day that does not exist
  rejects("29", "date");
});

// ── the types that must not fall through to the default branch ──────────────

test("an enum answer is checked against the column's options, in their spelling", () => {
  ok("smb", "enum", "SMB", { enumValues: ["SMB", "Mid-market", "Enterprise"] });
  rejects("Startup", "enum", { enumValues: ["SMB", "Mid-market", "Enterprise"] });
  // A column with no options configured is not a constraint anyone expressed.
  ok("anything", "enum", "anything");
});

test("a json column holds JSON or an error, never a sentence", () => {
  ok('{"b":2,"a":1}', "json", '{"b":2,"a":1}');
  ok({ a: 1 }, "json", '{"a":1}');
  rejects("I could not find the pricing object", "json");
});

test("a list has ONE encoding, the comma-joined one the rest of the app reads", () => {
  // `toText` renders a scalar list comma-joined and `toList` reads that back. JSON here would be a
  // second encoding in the same column, and which one a row got would decide whether a fan-out saw it.
  ok('["a","b"]', "array", "a, b");
  ok("a\nb\nc", "multi_select", "a, b, c");
  ok("a; b", "array", "a, b");
  ok("single", "array", "single");
  rejects('[{"name":"x"}]', "array");
});

// ── the shapes that were already right ──────────────────────────────────────

test("booleans, urls and emails are unchanged", () => {
  ok("Yes", "boolean", "true");
  ok("0", "boolean", "false");
  rejects("maybe", "boolean");
  ok("https://acme.com/pricing", "url", "https://acme.com/pricing");
  rejects("file:///etc/passwd", "url");
  ok("Sales <SALES@Acme.com>", "email", "sales@acme.com");
  rejects("no address here", "email");
});

test("an empty answer coerces to nothing and never to a value", () => {
  assert.deepEqual(coerce(null, "text"), { text: null });
  assert.deepEqual(coerce("   ", "number"), { text: null });
});

// ── when a cheap answer is good enough ──────────────────────────────────────
//
// This one predicate decides, on every row of a two-model column, whether the expensive model is
// called. Get it too loose and the column fills with a small model's guesses; too tight and the
// setting saves nothing while doubling the latency. Every case below is a judgement, not a detail.

test("only a confident, storable answer is kept without a second opinion", () => {
  assert.equal(goodEnough({ status: "done", valueText: "SaaS", confidence: "high" }), true);
  assert.equal(goodEnough({ status: "done", valueText: "SaaS", confidence: "medium" }), false);
  assert.equal(goodEnough({ status: "done", valueText: "SaaS", confidence: "low" }), false);
});

test("no grade is not the same as a good grade", () => {
  // gradeOf returns null when the model said something the tool did not ask for — "very high",
  // "0.9", nothing at all. "It did not tell me how sure it was" must never read as "it was sure",
  // because the cheap model is the one most likely to answer off-schema.
  assert.equal(goodEnough({ status: "done", valueText: "SaaS" }), false);
  assert.equal(goodEnough({ status: "done", valueText: "SaaS", confidence: null }), false);
});

test("a confident nothing still goes to the expensive model", () => {
  // The judgement call in this whole feature. A big model saying "this does not exist" is a finding;
  // a small one saying it is usually a small one giving up — and accepting that fills a column with
  // blanks that look like facts, which is the failure the app exists to prevent, reached through a
  // cost optimisation. The price is that an unfindable answer costs two calls instead of one.
  assert.equal(goodEnough({ status: "not_found", confidence: "high" }), false);
});

test("an error or a skip is never good enough", () => {
  assert.equal(goodEnough({ status: "error", errorType: "timeout", confidence: "high" }), false);
  assert.equal(goodEnough({ status: "skipped", confidence: "high" }), false);
});

// ── what a waterfall step is allowed to become ──────────────────────────────
//
// Through the real `executeCell`, because the failure being pinned is entirely about ROUTING: every
// step kind the lane fork does not recognise falls through to the model path, so a step with no lane
// behind it does not fail — it quietly becomes a model call. Nothing that reads `accepts` in
// isolation can see that.

/** A waterfall column with these steps saved on it, and a job pointed at it. */
function waterfallJob(name: string, waterfall: unknown): CellJob {
  const sheet = createSheet(name);
  const col = addColumn(sheet.id, { name: "Work email", kind: "waterfall", valueType: "email" });
  setColumnWaterfall(Number(col.id), JSON.stringify(waterfall));
  // No row is inserted: a waterfall with nothing runnable in it answers before it reads the row, and
  // that is exactly the claim under test.
  return { runId: `r-${name}`, sheetId: sheet.id, rowId: 1, columnId: Number(col.id), kind: "waterfall", attempt: 1 };
}

test("a lookup step is refused by the engine, never run as a model call", async () => {
  // "Look it up in another table" was one click away in the step picker and had nothing behind it.
  // On a fresh column it came back skipped while the cell's note said it had TRIED; on a column
  // switched over from `ai`, which keeps its prompt, it made a real billable model call that answered
  // from memory — on a step the forecast and the schedule gate had both priced at nothing.
  const job = waterfallJob("wf-lookup", {
    steps: [{ id: "a", name: "From Companies", kind: "lookup", config: { prompt: "What is their work email?" } }],
  });
  const out = await executeCell(job);

  assert.equal(out.status, "skipped", "a step with no lane behind it must not answer");
  assert.match(String(out.errorMsg), /cannot run inside a waterfall/);
  assert.equal(out.costUsd ?? 0, 0);
});

test("a script accept rule never reaches the engine, because the engine cannot evaluate one", async () => {
  // The engine calls `accepts` with no runner, so such a rule was false on every row: every step ran
  // on every row and the bill was the sum of all of them, while the editor showed a rule that read as
  // if it were being applied.
  const job = waterfallJob("wf-script-rule", {
    steps: [{ id: "a", name: "Guess", kind: "script", config: {}, accept: { kind: "script", scriptId: 7 } }],
  });
  const out = await executeCell(job);

  assert.equal(out.status, "skipped");
  assert.match(String(out.errorMsg), /cannot evaluate/);
});

// ── fan-out: once per item of a list, in place ────────────────────────────────────────────────
//
// The wrapper's own decisions are tested without a model: what skips for free, what the cap bounds,
// and how per-item failures aggregate. The model call itself is exercised everywhere else in this
// file through the same `once` the wrapper calls — fan-out adds the loop, not a new lane.

import { db } from "../db.ts";
import { insertRows } from "../store.ts";

function fanOutFixture(name: string, items: unknown, cap: number | null) {
  const sheet = createSheet(name);
  const source = addColumn(sheet.id, { name: "Titles", valueType: "json" });
  const col = addColumn(sheet.id, { name: "Per title", kind: "ai" });
  insertRows(sheet.id, [{ values: { [Number(source.id)]: items === null ? "" : JSON.stringify(items) } }], 0, [Number(source.id)]);
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(sheet.id) as any).id);
  if (items !== null) {
    // The parsed blob is what `getCell` returns, and what the fan-out loop reads the list from.
    db.prepare("UPDATE cells SET value_json = ?, value_text = NULL WHERE row_id = ? AND column_id = ?")
      .run(JSON.stringify(items), rowId, Number(source.id));
  }
  db.prepare("UPDATE columns SET fan_out = 'per_item', fan_out_source = ?, fan_out_cap = ?, prompt = ?, model = ? WHERE id = ?")
    .run(Number(source.id), cap, "Summarise this item in five words.", "openrouter/test-model", Number(col.id));
  return { sheet, source, col, rowId, job: (): CellJob => ({ runId: `r-${name}`, sheetId: sheet.id, rowId, columnId: Number(col.id), kind: "ai", attempt: 1 }) };
}

test("fan-out skips, free, when the source column holds no list", async () => {
  // A scalar is refused, not split: splitting a string on a guessed separator is salvage, and
  // salvage is the author's explicit choice in a rule column, not the executor's to invent.
  const f = fanOutFixture("fo-scalar", "just one value", 50);
  const out = await executeCell(f.job());
  assert.equal(out.status, "skipped");
  assert.match(String(out.errorMsg), /holds no list/);
  assert.equal(out.costUsd ?? 0, 0);
});

test("fan-out pointed at a column that is gone is skipped, not errored", async () => {
  const f = fanOutFixture("fo-nosource", ["a", "b"], 50);
  db.prepare("UPDATE columns SET fan_out_source = 999999 WHERE id = ?").run(Number(f.col.id));
  const out = await executeCell(f.job());
  assert.equal(out.status, "skipped");
  assert.match(String(out.errorMsg), /no longer exists/);
});

test("fan-out bounds items by the cap and says so, and aggregates per-item failures", async () => {
  // No provider key is configured under test, so every item fails the same way a real row would —
  // which is exactly the aggregation under test: the failures are COUNTED, the cap is NAMED, and
  // the cell only errors when every item failed.
  const f = fanOutFixture("fo-cap", ["a", "b", "c"], 2);
  const out = await executeCell(f.job());
  assert.equal(out.status, "error", `every item failed: ${out.errorMsg ?? "(no message)"}`);
  assert.match(String(out.errorMsg), /OpenRouter key/);
  assert.match(String(out.note), /capped at 2 of 3 items/);
  assert.match(String(out.note), /2 of 2 items failed/);
  assert.equal(out.costUsd ?? 0, 0);
  const stored = JSON.parse(String(out.valueText));
  assert.equal(stored.length, 2, "the cap bounds the results, not just the attempts");
});
