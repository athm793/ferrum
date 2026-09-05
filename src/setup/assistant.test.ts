// The table assistant.
//
// The properties worth guarding are all about what it is NOT allowed to do. An assistant that can
// be talked into deleting rows, starting a paid run, or offering an action that errors on click is
// worse than no assistant — so those are the tests, plus the one that makes troubleshooting work at
// all: that it is shown the errors rather than the data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { addColumn, createSheet, insertRows, listColumns } from "../store.ts";
import { undoState, undo } from "../undo.ts";
import {
  appendTurn, applyAction, clearConversation, deriveColumnName, describeTable, isComplexAsk, loadConversation, markApplied, parseReply,
} from "./assistant.ts";

function fixture(name: string) {
  const sheet = createSheet(name);
  const company = addColumn(sheet.id, { name: "Company" });
  const domain = addColumn(sheet.id, { name: "Domain", valueType: "url" });
  const industry = addColumn(sheet.id, { name: "Industry", kind: "ai" });
  const ids = [Number(company.id), Number(domain.id), Number(industry.id)];
  insertRows(
    sheet.id,
    [
      { values: { [ids[0]!]: "Acme", [ids[1]!]: "acme.com" } },
      { values: { [ids[0]!]: "Beta", [ids[1]!]: "beta.io" } },
    ],
    0,
    ids,
  );
  return { sheet, company, domain, industry, ids };
}

test("what it is shown is counts and error messages, never the table's contents", () => {
  const f = fixture("as-describe");
  // Two rows failing with ONE message is one problem, not two — and saying so is the entire
  // troubleshooting story.
  db.prepare("UPDATE cells SET status = 'error', error_msg = 'Missing API key in Authorization header' WHERE column_id = ?")
    .run(Number(f.industry.id));

  const text = describeTable(f.sheet.id);
  assert.match(text, /2 rows, 3 columns/);
  assert.match(text, /\/Industry \(text, ai\)/);
  assert.match(text, /failing on 2 rows: Missing API key/);

  // The fill rate, which is the fact that changes the answer and was not here before: a column with
  // nothing in it must READ as empty, not merely lack an example.
  assert.match(text, /\/Company \(text, static\) — 100% filled/);
  assert.match(text, /\/Industry \(text, ai\) — EMPTY/);
});

test("the description is bounded by the sample cap, not by the size of the table", () => {
  // The premise CHANGED, and deliberately. This used to assert exactly one sample value per column,
  // on the reasoning that more than one is "not a sample, it is the table". That was right about the
  // risk and wrong about the fix: one value cannot show that a column holds both `acme.com` and
  // `https://acme.com/about`, so rules got written against whichever shape row 1 happened to have.
  //
  // The guarantee that actually matters is that the description does not grow with the table, and it
  // is that which is asserted here — a few distinct values per column whether the sheet holds ten
  // rows or a million.
  const f = fixture("as-bounded");
  const many = Array.from({ length: 60 }, (_, i) => ({
    values: { [f.ids[0]!]: `Company ${i}`, [f.ids[1]!]: `example-${i}.com` },
  }));
  // After the fixture's two rows: positions are unique per sheet, so starting at 0 again collides.
  insertRows(f.sheet.id, many, 2, f.ids);

  const text = describeTable(f.sheet.id);
  const domains = (text.match(/example-\d+\.com/g) ?? []).length;
  assert.ok(domains > 0, "some real values are shown, or the model is guessing at the shape");
  assert.ok(domains <= 4, `at most four examples per column, got ${domains}`);
  assert.ok(!text.includes("example-59.com") || domains <= 4, "the whole column is never listed");
});

test("a table's kind reaches the description; generic says nothing", () => {
  // The reader `sheets.kind` was waiting for: both proposal surfaces describe the table through
  // describeTable, so a marked table steers column suggestions. It was settable for a long time
  // before anything read it back.
  const people = createSheet("as-kind-people", null, "people");
  const generic = createSheet("as-kind-generic");
  assert.match(describeTable(people.id), /These rows are people\./);
  assert.ok(!describeTable(generic.id).includes("These rows are"), "generic is the absence of an answer, not an answer");
});

test("an action naming a column that does not exist is dropped rather than offered", () => {
  // Offering it and erroring on click is worse than never offering it: the user has already decided
  // to trust the suggestion by the time it fails.
  const f = fixture("as-invalid");
  const out = parseReply(
    {
      reply: "Here are two changes.",
      actions: [
        { kind: "set_prompt", columnId: 999999, prompt: "anything", why: "invented column" },
        { kind: "set_prompt", columnId: Number(f.industry.id), prompt: "What industry is /Company in?", why: "real column" },
      ],
    },
    f.sheet.id,
  );
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0]!.kind, "set_prompt");
  assert.equal((out.actions[0] as any).columnId, Number(f.industry.id));
});

test("there is no way to express deleting anything, or starting a run", () => {
  // The guard is structural rather than persuasive: these action kinds do not exist, so a model
  // that asks for them gets nothing rather than being trusted not to ask.
  const f = fixture("as-destructive");
  const out = parseReply(
    {
      reply: "Cleaning up.",
      actions: [
        { kind: "delete_column", columnId: Number(f.company.id), why: "unused" },
        { kind: "delete_rows", why: "duplicates" },
        { kind: "run_column", columnId: Number(f.industry.id), why: "fill it in" },
        { kind: "trash_table", why: "start again" },
      ],
    },
    f.sheet.id,
  );
  assert.deepEqual(out.actions, []);
});

test("an empty answer is refused, so the chat never shows a blank bubble", () => {
  const f = fixture("as-empty");
  assert.throws(() => parseReply({ reply: "   ", actions: [] }, f.sheet.id), /empty answer/i);
});

test("a new column's name is salvaged when the model puts it in the dedupe field", () => {
  // The single most common way add_column arrives malformed: the name lands in `columnNames` — the
  // field that belongs to a dedupe rule — and `name` is left empty, so the whole proposal used to be
  // dropped and the user's "add an email column" produced nothing but a "1 didn't fit" count.
  const f = fixture("as-salvage");
  const out = parseReply({
    reply: "Adds it.",
    actions: [{ kind: "add_column", columnKind: "ai", columnNames: ["Cold Email"],
      prompt: "Write to /Company.", why: "email" }],
  }, f.sheet.id);
  assert.equal(out.dropped, 0);
  assert.equal(out.actions.length, 1);
  const a = out.actions[0]!;
  assert.equal(a.kind, "add_column");
  assert.equal(a.kind === "add_column" && a.name, "Cold Email");
});

test("a broad ask gets the full self-check loop; a narrow one gets a single pass", () => {
  // The loop's depth is chosen from the ask, because a review is a whole extra model call. A one-line
  // single-column request does not need three of them; a "read every column" request — broad, and the
  // kind a first draft half-finishes — does.
  const col = { kind: "add_column" as const, name: "Industry", columnKind: "ai" as const, valueType: "text" as const, why: "" };
  const draft = (n: number) => ({ reply: "", actions: Array.from({ length: n }, () => ({ ...col })), dropped: 0 });
  assert.equal(isComplexAsk("add a column for the industry", draft(1)), false, "short, one action → one pass");
  assert.equal(isComplexAsk("read every column and write a personalized email", draft(1)), true, "'every' → full loop");
  assert.equal(isComplexAsk("write a hyper-personalized email", draft(1)), true, "'hyper-personalized' → full loop");
  // More than one proposed change is complex on its own, whatever the words were.
  assert.equal(isComplexAsk("do it", draft(2)), true, "two actions → full loop");
});

test("a name is derived from the instruction's verb and object", () => {
  // "Write a cold email" is the "Cold Email" column; the adjectives that say HOW are dropped, the
  // deliverable is kept, and a reference never leaks into the name.
  assert.equal(deriveColumnName("Write a hyper-personalized cold email under 60 words to /Full name."), "Cold Email");
  assert.equal(deriveColumnName("Write a personalized email to /Company."), "Email");
  assert.equal(deriveColumnName("Summarise the company from /Description"), "Company");
  // No verb to hang a name on — the caller falls back to the generic default rather than guessing.
  assert.equal(deriveColumnName("How many people work at /Company?"), null);
  assert.equal(deriveColumnName(undefined), null);
});

test("a complete column with no name is named from its prompt, not dropped", () => {
  // On a wide table the model tends to write a full, correct prompt but leave the name off entirely
  // (columnNames empty, name absent). Throwing away a column that has its instruction for want of a
  // name it can simply be given is the failure the user hit: "nothing to apply" for a ready column.
  const f = fixture("as-noname");
  const out = parseReply({
    reply: "Adds it.",
    actions: [{ kind: "add_column", columnKind: "ai", valueType: "text",
      prompt: "Write a cold email to /Company.", why: "email", columnNames: [] }],
  }, f.sheet.id);
  assert.equal(out.dropped, 0);
  assert.equal(out.actions.length, 1);
  const a = out.actions[0]!;
  assert.equal(a.kind === "add_column" && a.name, "Cold Email", "named from what the prompt does");
});

test("a nameless column whose prompt yields nothing clean falls back to the generic default", () => {
  const f = fixture("as-noname-fallback");
  const out = parseReply({
    reply: "Adds it.",
    actions: [{ kind: "add_column", columnKind: "static", valueType: "text", why: "a place to type" }],
  }, f.sheet.id);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0]!.kind === "add_column" && out.actions[0]!.name, "New column");
});

test("an ai column proposed with no instruction is refused, not created empty", () => {
  // An ai or agent column with no prompt does nothing on every row — the exact silent no-op the
  // propose-then-apply panel exists to prevent. It is counted, so the transcript stays honest.
  const f = fixture("as-noprompt");
  const out = parseReply({
    reply: "Adds it.",
    actions: [{ kind: "add_column", name: "Cold Email", columnKind: "ai", why: "email" }],
  }, f.sheet.id);
  assert.equal(out.actions.length, 0, "not offered");
  assert.equal(out.dropped, 1, "and counted, not silently gone");
});

test("a static column with no instruction is fine — only ai and agent need one", () => {
  const f = fixture("as-static-noprompt");
  const out = parseReply({
    reply: "Adds it.",
    actions: [{ kind: "add_column", name: "Notes", columnKind: "static", why: "a place to type" }],
  }, f.sheet.id);
  assert.equal(out.actions.length, 1);
  assert.equal(out.dropped, 0);
});

test("adding a column creates it and does NOT run it", () => {
  // An assistant that can start a paid run from a sentence is one bad interpretation away from an
  // expensive afternoon.
  const f = fixture("as-add");
  const before = listColumns(f.sheet.id).length;
  const said = applyAction(f.sheet.id, {
    kind: "add_column", name: "Headcount", columnKind: "ai", valueType: "number",
    prompt: "How many people work at /Company?", why: "",
  });

  const cols = listColumns(f.sheet.id);
  assert.equal(cols.length, before + 1);
  const made = cols.find((c) => c.name === "Headcount")!;
  assert.equal(made.kind, "ai");
  // STORED, not display, form, and OPTIONAL (the trailing `?`). `/Company` left verbatim is not a
  // reference at all: the engine finds no dependency and every row asks about the literal string. The
  // assistant marks its references optional so a row missing a column still runs rather than being
  // skipped — see storeRefsOptional. It also has to survive someone renaming the column.
  assert.equal(made.prompt, `How many people work at {{col:${f.company.id}?}}?`);
  assert.match(said, /Nothing has run yet/);

  // Every cell is waiting, not running or done.
  const statuses = db.prepare("SELECT DISTINCT status FROM cells WHERE column_id = ?").all(Number(made.id)) as any[];
  assert.deepEqual(statuses.map((s) => s.status), ["empty"]);
});

test("every reference the assistant stores is optional, so a row missing a column still runs", () => {
  // A required reference SKIPS any row where that column is empty. For a column that reads many
  // others — "an email from every column" — that would skip nearly every row on a real table. So the
  // assistant marks each one optional, both when adding a column and when changing one.
  const f = fixture("as-optional");
  applyAction(f.sheet.id, {
    kind: "add_column", name: "Email", columnKind: "ai", valueType: "text",
    prompt: "Write to /Company at /Domain.", why: "",
  });
  const made = listColumns(f.sheet.id).find((c) => c.name === "Email")!;
  assert.equal(made.prompt, `Write to {{col:${f.company.id}?}} at {{col:${f.domain.id}?}}.`);

  applyAction(f.sheet.id, {
    kind: "set_prompt", columnId: Number(made.id), prompt: "Just /Company.", why: "",
  });
  const after = listColumns(f.sheet.id).find((c) => Number(c.id) === Number(made.id))!;
  assert.equal(after.prompt, `Just {{col:${f.company.id}?}}.`, "a changed prompt is optional too");
});

test("a prompt the assistant wrote becomes a real dependency, not just text", () => {
  // Converting `/Company` to `{{col:N}}` is only half of it. The engine reads dependencies out of
  // `column_deps`, and that table was written from exactly one place — saving a generated script —
  // so a column added here had no edges at all: `topoDepths` put it at depth 0 and it ran BEFORE the
  // column it reads, on the paid lane, against an empty value.
  const f = fixture("as-deps");
  applyAction(f.sheet.id, {
    kind: "add_column", name: "Headcount", columnKind: "ai", valueType: "number",
    prompt: "How many people work at /Company?", why: "",
  });
  const made = listColumns(f.sheet.id).find((c) => c.name === "Headcount")!;

  // Mapped to plain pairs: the driver returns null-prototype rows, which no deep-equality assertion
  // matches against an object literal.
  const deps = db.prepare("SELECT depends_on, via FROM column_deps WHERE column_id = ?").all(Number(made.id)) as any[];
  assert.deepEqual(deps.map((d) => [Number(d.depends_on), String(d.via)]), [[Number(f.company.id), "prompt"]]);

  // And changing the instruction re-derives them rather than leaving the old set in place.
  applyAction(f.sheet.id, {
    kind: "set_prompt", columnId: Number(made.id), prompt: "What is the website of /Domain?", why: "",
  });
  const after = db.prepare("SELECT depends_on FROM column_deps WHERE column_id = ?").all(Number(made.id)) as any[];
  assert.deepEqual(after.map((d) => Number(d.depends_on)), [Number(f.domain.id)]);
});

test("a model-authored change can be undone, like a hand-made one", () => {
  // Model-authored edits were the only changes in the app with no way back — exactly backwards,
  // since they are the ones the user did not type.
  const f = fixture("as-undo");
  applyAction(f.sheet.id, { kind: "add_column", name: "Headcount", columnKind: "static", valueType: "number", why: "" });
  assert.ok(listColumns(f.sheet.id).some((c) => c.name === "Headcount"));

  assert.match(undoState(f.sheet.id).undo?.label ?? "", /Headcount/);
  assert.equal(undo(f.sheet.id).ok, true);
  assert.ok(!listColumns(f.sheet.id).some((c) => c.name === "Headcount"), "the column it added is gone again");
});

test("the model cannot turn on private addresses through the assistant", () => {
  // The same setting aiSetup strips from a proposal. This path called normalizeHttpConfig raw, so a
  // model-authored request could point the engine at its own metadata service.
  const f = fixture("as-private");
  applyAction(f.sheet.id, {
    kind: "add_column", name: "Meta", columnKind: "http", valueType: "json",
    http: { method: "GET", url: "http://169.254.169.254/latest/meta-data/", allowPrivate: true },
    why: "",
  });
  const made = listColumns(f.sheet.id).find((c) => c.name === "Meta")!;
  assert.equal((made.httpConfig as any)?.allowPrivate, false);
});

test("a request's references are stored, not left as the text the model wrote", () => {
  const f = fixture("as-httpref");
  applyAction(f.sheet.id, {
    kind: "add_column", name: "Size", columnKind: "http", valueType: "number",
    http: { method: "GET", url: "https://api.example.com/size", query: [{ name: "domain", value: "/Domain" }] },
    why: "",
  });
  const made = listColumns(f.sheet.id).find((c) => c.name === "Size")!;
  assert.equal((made.httpConfig as any).query[0].value, `{{col:${f.domain.id}}}`);
});

test("an instruction longer than one a person may type is refused, not shortened", () => {
  // It is sent once per row, so its length is multiplied by the sheet. The hand-built PATCH has
  // always refused this; going through the assistant was the way around it.
  const f = fixture("as-longprompt");
  const out = parseReply(
    {
      reply: "Here.",
      actions: [{ kind: "set_prompt", columnId: Number(f.industry.id), prompt: "x".repeat(50_000), why: "" }],
    },
    f.sheet.id,
  );
  assert.deepEqual(out.actions, []);
});

test("setting the dedupe rule configures it and removes nothing", () => {
  const f = fixture("as-dedupe");
  const rowsBefore = Number((db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ?").get(f.sheet.id) as any).n);
  const said = applyAction(f.sheet.id, { kind: "set_dedupe", columnNames: ["Domain", "Company"], keep: "oldest", why: "" });

  assert.match(said, /nothing has been removed yet/i);
  const rowsAfter = Number((db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ?").get(f.sheet.id) as any).n);
  assert.equal(rowsAfter, rowsBefore, "configuring a rule must never delete data");
});

test("a broken request degrades the column instead of throwing", () => {
  const f = fixture("as-badhttp");
  const said = applyAction(f.sheet.id, {
    kind: "add_column", name: "Size", columnKind: "http", valueType: "number",
    http: { method: "SUMMON", url: "nowhere at all" }, why: "",
  });
  assert.ok(listColumns(f.sheet.id).some((c) => c.name === "Size"));
  assert.ok(said.length > 0);
});

// ── the conversation, kept ──────────────────────────────────────────────────
//
// It lived in React state, so the panel's own close button destroyed it — along with a reload and
// with opening another table and coming back. A conversation about a table is built up over turns,
// so losing it costs everything said so far rather than one line.

test("the conversation survives the panel closing, and remembers what was applied", () => {
  const f = fixture("kept");
  const q = appendTurn(f.sheet.id, { role: "user", text: "add an industry column" });
  const a = appendTurn(f.sheet.id, {
    role: "assistant",
    text: "A column that asks a model for each company's industry.",
    actions: [{ kind: "add_column", name: "Industry", columnKind: "ai", valueType: "text", why: "so you can segment" }],
  });
  assert.ok(q > 0 && a > q);

  markApplied(f.sheet.id, a, 0, `Added "Industry".`);

  // A fresh read, which is what re-opening the panel does.
  const back = loadConversation(f.sheet.id);
  assert.equal(back.length, 2);
  assert.equal(back[0]!.role, "user");
  assert.equal(back[1]!.actions.length, 1);
  assert.equal(back[1]!.applied[0], `Added "Industry".`, "an applied change is not offered a second time");
});

test("a conversation belongs to its own table and to no other", () => {
  const a = fixture("mine");
  const b = fixture("yours");
  appendTurn(a.sheet.id, { role: "user", text: "about mine" });
  assert.equal(loadConversation(b.sheet.id).length, 0);
  assert.equal(loadConversation(a.sheet.id).length, 1);
  assert.equal(clearConversation(a.sheet.id), 1);
  assert.equal(loadConversation(a.sheet.id).length, 0);
});

test("a proposal this table cannot take is COUNTED, not silently dropped", () => {
  // The other half of "it says it will do something and then does not": the reply describes the
  // change, the change fails its checks on the way back, and the bubble showed the sentence with
  // nothing under it and no explanation.
  const f = fixture("dropped");
  const out = parseReply(
    {
      reply: "Pointing the industry column at the website instead.",
      actions: [
        { kind: "set_prompt", columnId: 99999, prompt: "look at /Website", why: "more reliable" },
        { kind: "add_column", name: "Industry", columnKind: "ai", valueType: "text", prompt: "What industry is /Company in?", why: "so you can segment" },
      ],
    },
    f.sheet.id,
  );
  assert.equal(out.actions.length, 1, "only the one that fits is offered");
  assert.equal(out.dropped, 1, "and the one that does not is reported rather than vanishing");
});

test("nothing dropped means nothing to report", () => {
  const f = fixture("clean");
  const out = parseReply({ reply: "Here is what is in it.", actions: [] }, f.sheet.id);
  assert.equal(out.dropped, 0);
});
