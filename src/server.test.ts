// The HTTP surface, against a real listening engine.
//
// `server.ts` had no test file at all, and the defects clustered there exactly as you would expect:
// a route that saved a configuration without re-deriving anything from it, an undo entry that
// recorded null in both directions, a preview that answered a different question than the run, and
// two routes that executed or wrote without checking anything first.
//
// Nothing here spends. Every route exercised is free — column configuration, the send dry run, the
// script save gate — and no model, provider or network call is made by any of it.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { db } from "./db.ts";
import { addColumn, createSheet, getColumn, insertRows } from "./store.ts";
import { createServer } from "./server.ts";
import { DEFAULT_HTTP, normalizeHttpConfig } from "./http/httpColumn.ts";
import { createSource, listDeliveries, updateSource } from "./sources/webhook.ts";
import { saveScript } from "./scripts.ts";
import { undo } from "./undo.ts";
import { createWorkbook, trashTable } from "./views.ts";
import { flushNow, markCellsDirty } from "./bus.ts";
import { claimInstance, createPerson, startSession, SESSION_COOKIE } from "./people.ts";

const app = createServer("test-boot");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
// Every test file gets its own process and its own database, so one server for the file is enough.
// Closed with its sockets: fetch keeps the connection alive, and `close()` alone waits for a peer
// that is never coming back, which would hang the run rather than fail it.
after(() => { server.closeAllConnections(); server.close(); });

async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json() };
}

/** Two tables: a source with something worth sending, and somewhere to send it. */
function fixture(name: string) {
  const sheet = createSheet(`${name}-source`);
  const target = createSheet(`${name}-target`);
  const company = addColumn(sheet.id, { name: "Company" });
  const domain = addColumn(sheet.id, { name: "Domain", valueType: "url" });
  const send = addColumn(sheet.id, { name: "Send to CRM", kind: "send" });
  const targetName = addColumn(target.id, { name: "Name" });
  insertRows(
    sheet.id,
    [{ values: { [Number(company.id)]: "Acme", [Number(domain.id)]: "acme.com" } }],
    0,
    [Number(company.id), Number(domain.id)],
  );
  return { sheet, target, company, domain, send, targetName };
}

/** The edges a column has, as plain pairs. The driver hands back null-prototype rows, which no
 *  deep-equality assertion will match against an object literal. */
const depsOf = (columnId: string | number): Array<[number, string]> =>
  (db.prepare("SELECT depends_on, via FROM column_deps WHERE column_id = ? ORDER BY depends_on")
    .all(Number(columnId)) as any[]).map((d) => [Number(d.depends_on), String(d.via)]);

const sendBody = (f: ReturnType<typeof fixture>) => ({
  send: {
    targetSheetId: f.target.id,
    method: "row",
    mapping: { [Number(f.targetName.id)]: { from: "row", columnId: Number(f.company.id) } },
    onConflict: "insert",
    withBackRef: false,
    cap: 50,
  },
});

test("saving a destination records what the send column reads", async () => {
  // `rebuildDeps` was called from ONE place — saving a generated script — so a send configured
  // through this route had no edges at all. Run order is `topoDepths` over those edges, so the send
  // came out at depth 0 and ran before the column it reads: a table of nulls over there, and a null
  // match key, so the later correct run could not repair it and duplicated the destination instead.
  const f = fixture("deps-send");
  const res = await call(`/api/columns/${f.send.id}`, { method: "PATCH", body: sendBody(f) });
  assert.equal(res.status, 200);

  assert.deepEqual(depsOf(f.send.id), [[Number(f.company.id), "send"]]);
});

test("saving an instruction records the columns it references", async () => {
  const f = fixture("deps-prompt");
  const ai = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const res = await call(`/api/columns/${ai.id}`, {
    method: "PATCH",
    body: { prompt: `What industry is {{col:${f.company.id}}} in, given {{col:${f.domain.id}}}?` },
  });
  assert.equal(res.status, 200);

  assert.deepEqual(
    depsOf(ai.id).map(([id]) => id).sort((a, b) => a - b),
    [Number(f.company.id), Number(f.domain.id)].sort((a, b) => a - b),
  );
});

test("undoing a destination change puts the previous destination back", async () => {
  // Recording `{from: null, to: null}` would make undo AND redo both run
  // `UPDATE columns SET send_config = NULL`: one click erased the destination, the mapping, the
  // conflict rule and the cap.
  const f = fixture("undo-send");
  await call(`/api/columns/${f.send.id}`, { method: "PATCH", body: sendBody(f) });

  const second = sendBody(f);
  second.send.mapping = { [Number(f.targetName.id)]: { from: "row", columnId: Number(f.domain.id) } };
  await call(`/api/columns/${f.send.id}`, { method: "PATCH", body: second });
  assert.equal((getColumn(f.send.id)!.sendConfig as any).mapping[String(f.targetName.id)].columnId, Number(f.domain.id));

  assert.equal(undo(f.sheet.id).ok, true);
  const back = getColumn(f.send.id)!.sendConfig as any;
  assert.ok(back, "the whole configuration must not be wiped by an undo of one change to it");
  assert.equal(back.mapping[String(f.targetName.id)].columnId, Number(f.company.id));
  assert.equal(back.targetSheetId, f.target.id);
});

test("the send dry run says so when a run condition will narrow it", async () => {
  // The preview reported the UNGATED count and never mentioned the condition, so a send that would
  // write two rows previewed as four with nothing on screen to explain the difference.
  const f = fixture("preview-condition");
  await call(`/api/columns/${f.send.id}`, { method: "PATCH", body: sendBody(f) });
  saveScript({
    sheetId: f.sheet.id,
    columnId: Number(f.send.id),
    hook: "condition",
    runtime: "js",
    intent: "only the ones worth sending",
    code: "function condition(row) { return true; }",
  });

  const res = await call(`/api/columns/${f.send.id}/send/preview`, { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserts, 1);
  assert.match(String(res.body.warnings?.join(" ")), /run condition/i);
});

test("the send dry run refuses a destination that is in the trash", async () => {
  const f = fixture("preview-trashed");
  await call(`/api/columns/${f.send.id}`, { method: "PATCH", body: sendBody(f) });
  trashTable(f.target.id);

  const res = await call(`/api/columns/${f.send.id}/send/preview`, { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserts, 0);
  assert.match(String(res.body.errors?.join(" ")), /trash|gone|archived/i);
});

test("the legacy write-target route refuses a destination that is in the trash", async () => {
  // It takes its target from the REQUEST rather than from a column, so it never went through
  // `targetOf` and never had the check `targetOf` performs — it wrote into the trash and reported
  // success.
  const f = fixture("legacy-trashed");
  trashTable(f.target.id);

  const body = {
    fanOut: "row",
    target: {
      targetSheetId: f.target.id,
      mapping: { [Number(f.targetName.id)]: { from: "row", columnId: Number(f.company.id) } },
      onConflict: "insert",
    },
  };
  const res = await call(`/api/sheets/${f.sheet.id}/write-target/apply`, { method: "POST", body });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /trash|gone|archived/i);
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ?").get(f.target.id) as any).n),
    0,
    "nothing may be written into a table that is not there any more",
  );
});

test("code that nobody reviewed cannot be run through the benchmark route", async () => {
  // `run-direct` executes whatever is in the body — including a shell runtime, which spawns a
  // process. It is the one route that breaks the rule the rest of the product is built on, so it is
  // off unless the benchmark harness has explicitly switched it on.
  const f = fixture("run-direct");
  const res = await call("/api/scripts/run-direct", {
    method: "POST",
    body: { sheetId: f.sheet.id, columnId: Number(f.company.id), code: "function transform(row){return 1}" },
  });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /FERRUM_DEV_SCRIPTS/);
});

test("a script cannot be saved to run on something nothing knows how to run", async () => {
  // `runShell` tests for one value — powershell — and treats everything else as bash, so an
  // unrecognised runtime was never rejected: it silently became a bash script.
  const f = fixture("bad-runtime");
  const res = await call(`/api/columns/${f.company.id}/scripts`, {
    method: "POST",
    body: { hook: "transform", runtime: "python", intent: "", code: "function transform(row){return 1}" },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /js, powershell or bash/);
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS n FROM scripts WHERE column_id = ?").get(Number(f.company.id)) as any).n),
    0,
    "a runtime nothing can run must not be stored and reviewed as if it were runnable",
  );
});

test("repointing the engine at another account is refused unless it came from the app", async () => {
  // `provenLocal` was written for exactly these two routes and then never called, so the hardening
  // was inert: an anonymous POST still overwrote the stored credential, which is how an attacker
  // makes the victim's rows run — and be charged — against the attacker's key.
  //
  // Only the REFUSAL is exercised. The accepting path verifies the credential against the provider,
  // and nothing in this suite is allowed to make a call that costs anything.
  const cred = await call("/api/auth/token", { method: "POST", body: { token: "not-a-real-token" } });
  assert.equal(cred.status, 403);

  const key = await call("/api/providers/openrouter/key", { method: "POST", body: { key: "not-a-real-key" } });
  assert.equal(key.status, 403);
});

test("a column that fills itself in refuses a typed value, and says why", async () => {
  // Before this, every column took a hand edit and kept it. A typed value sitting where a computed
  // one should be is indistinguishable from it — same cell, same font, nothing that survives a
  // reload — so the column looks like it worked on the one row it did not.
  const f = fixture("locked-cell");
  const ai = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(f.sheet.id) as any).id);

  const res = await call(`/api/cells/${rowId}:${ai.id}`, { method: "PUT", body: { value: "typed" } });
  assert.equal(res.status, 409, "409, not 400 — the request is fine, the state forbids it");
  assert.equal(res.body.code, "cell_locked");
  assert.equal(res.body.canOverride, true);
  assert.ok(String(res.body.lockedReason).length > 20, "and it says what fills the column instead");

  const cell = db.prepare("SELECT value_text FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, Number(ai.id)) as any;
  assert.equal(cell?.value_text ?? null, null, "and nothing was written");
});

test("the same edit lands when it is asked for deliberately, and is marked as yours", async () => {
  const f = fixture("override-cell");
  const ai = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(f.sheet.id) as any).id);

  const res = await call(`/api/cells/${rowId}:${ai.id}`, {
    method: "PUT", body: { value: "Software", override: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.cell.value, "Software");
  assert.equal(res.body.cell.pinned, true, "a deliberate override is still a hand edit, and a run leaves it alone");
});

test("asking a model to fix a rejected key is refused, and costs nothing", async () => {
  // The whole reason the fix route consults the same table the panel does. `auth` is aiCanHelp:
  // false — no model can guess a working key — so a proposal here could only ever say "fix your
  // key", and it would be BILLED. The refusal has to happen before a token is spent, which means
  // before proposeSetup is reached at all: this test passes with no provider configured, and would
  // fail with a credential error rather than a 400 if the order were ever reversed.
  const f = fixture("fix-auth");
  const ai = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(f.sheet.id) as any).id);
  db.prepare("UPDATE cells SET status='error', error_type='auth', error_msg='401' WHERE row_id=? AND column_id=?")
    .run(rowId, Number(ai.id));

  const res = await call(`/api/cells/${rowId}:${ai.id}/fix`, { method: "POST" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ai_cannot_help");
  assert.equal(res.body.fixWhere, "settings_keys", "and it says where the fix actually is");
  assert.match(String(res.body.error), /key/i);
});

test("a cell that has not failed has nothing to diagnose", async () => {
  // A working cell reaching the fix route means a button was offered where it should not have been.
  // Answering with a paid proposal about a cell that is fine is the expensive way to hide that bug.
  const f = fixture("fix-not-failed");
  const ai = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(f.sheet.id) as any).id);
  db.prepare("UPDATE cells SET status='done', value_text='Software' WHERE row_id=? AND column_id=?")
    .run(rowId, Number(ai.id));

  const res = await call(`/api/cells/${rowId}:${ai.id}/fix`, { method: "POST" });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /not failed/i);
});

test("a plain column is unaffected — the lock is not a blanket ban on typing", async () => {
  const f = fixture("static-still-editable");
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(f.sheet.id) as any).id);
  const res = await call(`/api/cells/${rowId}:${f.company.id}`, { method: "PUT", body: { value: "acme.com" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.cell.value, "acme.com");
});

test("undoing an override puts back both the value and the fact that it was not yours", async () => {
  // Undo restores through its own SQL and must never be refused by the lock — a guard that stopped
  // undo would leave someone unable to take back the very edit they were warned about. And it has to
  // restore `pinned` too: a cell left pinned after the override is undone would go on being
  // protected from runs for a value nobody typed.
  const f = fixture("undo-override");
  const ai = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(f.sheet.id) as any).id);

  await call(`/api/cells/${rowId}:${ai.id}`, { method: "PUT", body: { value: "Software", override: true } });
  undo(f.sheet.id);

  const cell = db.prepare("SELECT value_text, pinned FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, Number(ai.id)) as any;
  assert.equal(cell?.value_text ?? null, null);
  assert.equal(Number(cell?.pinned ?? 0), 0, "and it is no longer marked as typed in by hand");
});

test("creating a column refuses a field it cannot set, rather than dropping it", async () => {
  // Found the expensive way. This route accepted `model`, returned 200, and created the column on
  // `auto` — so a column meant for a free local model was silently created pointing at a paid one,
  // and the next run spent real money proving it. A drop that returns success is worse than an
  // error, because nothing downstream has any reason to check.
  const f = fixture("create-column-refuses");

  const res = await call(`/api/sheets/${f.sheet.id}/columns`, {
    method: "POST",
    body: { name: "Industry", kind: "ai", model: "some/expensive-model", prompt: "What do they sell?" },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /model/);
  assert.match(String(res.body.error), /prompt/);

  const made = db
    .prepare("SELECT COUNT(*) AS n FROM columns WHERE sheet_id = ? AND name = 'Industry'")
    .get(f.sheet.id) as any;
  assert.equal(Number(made.n), 0, "and no column was created on a model nobody chose");
});

test("applying an assistant action goes through the same checks the proposal did", async () => {
  // The route handed the request body straight to `applyAction`, so the caps the propose path
  // enforces — prompt length, a column that exists, a mode the app recognises — were all bypassable
  // by posting the action directly. A prompt is sent once per row, so the length cap is a spend cap.
  const f = fixture("assistant-apply");
  const ai = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });

  const tooLong = await call(`/api/sheets/${f.sheet.id}/assistant/apply`, {
    method: "POST",
    body: { action: { kind: "set_prompt", columnId: Number(ai.id), prompt: "x".repeat(50_000), why: "" } },
  });
  assert.equal(tooLong.status, 400);
  assert.equal(getColumn(ai.id)!.prompt, undefined, "and nothing was written");

  // The same action within the cap still applies, so the check narrows nothing legitimate.
  const ok = await call(`/api/sheets/${f.sheet.id}/assistant/apply`, {
    method: "POST",
    body: { action: { kind: "set_prompt", columnId: Number(ai.id), prompt: "What industry is /Company in?", why: "" } },
  });
  assert.equal(ok.status, 200);
  // The assistant marks its references OPTIONAL (the trailing `?`), so a row missing the column still
  // runs rather than being skipped — see storeRefsOptional. The hand-built PATCH above keeps them
  // required; only what the assistant writes is softened this way.
  assert.equal(getColumn(ai.id)!.prompt, `What industry is {{col:${f.company.id}?}} in?`);
});

test("an oversized delivery is refused without describing this machine", async () => {
  // `/hook` is the one unauthenticated route, and no error handler was mounted on it — so a body
  // over the limit fell through to Express's default handler and answered a stranger with an HTML
  // stack trace carrying absolute filesystem paths.
  const res = await fetch(`http://127.0.0.1:${port}/hook/whatever-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(300 * 1024),
  });
  const text = await res.text();
  assert.equal(res.status, 413);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.doesNotMatch(text, /Error:|at .*\(|\.ts:|\\\\|node_modules/, "no stack, no paths");
});

test("a column cannot be created on a table that is not there", async () => {
  const res = await call("/api/sheets/no-such-table/columns", { method: "POST", body: { name: "Orphan" } });
  assert.equal(res.status, 404);
});

test("switching on a schedule that will spend is refused until it is confirmed", async () => {
  // A schedule MAY run a paid column — a cadence is an instruction the user wrote, not a reaction to
  // somebody else's import. What it must never be is a surprise. The switch is the moment of
  // consent, so it carries the columns that bill and what one firing costs.
  const f = fixture("sched-confirm");
  const paid = addColumn(f.sheet.id, { name: "Enrich", kind: "ai" });
  db.prepare("UPDATE columns SET model = 'openrouter/some-paid-model' WHERE id = ?").run(Number(paid.id));

  const made = await call(`/api/sheets/${f.sheet.id}/schedules`, {
    method: "POST",
    body: { cadence: { kind: "daily", at: 420 }, scope: { columnIds: [Number(paid.id)] } },
  });
  assert.equal(made.status, 200);
  const id = made.body.schedule.id;
  assert.deepEqual(made.body.schedule.paidColumns, ["Enrich"], "the list says so before anyone clicks");

  const blocked = await call(`/api/schedules/${id}`, { method: "PATCH", body: { enabled: true } });
  assert.equal(blocked.status, 409, "409, not 400 — the request is fine, it just needs saying twice");
  assert.equal(blocked.body.code, "schedule_would_spend");
  assert.deepEqual(blocked.body.paidColumns, ["Enrich"]);

  const off = db.prepare("SELECT enabled FROM schedules WHERE id = ?").get(Number(id)) as any;
  assert.equal(off.enabled, 0, "and it did not switch on behind the refusal");

  const ok = await call(`/api/schedules/${id}`, { method: "PATCH", body: { enabled: true, confirmPaid: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.schedule.enabled, true);
});

test("a schedule over free columns switches on without a word", async () => {
  // The guard must not make every schedule ceremonial. A rule column on a timer costs nothing and
  // should behave like the harmless thing it is.
  const f = fixture("sched-free");
  const rule = addColumn(f.sheet.id, { name: "Clean", kind: "script" });

  const made = await call(`/api/sheets/${f.sheet.id}/schedules`, {
    method: "POST",
    body: { cadence: { kind: "daily", at: 420 }, scope: { columnIds: [Number(rule.id)] } },
  });
  const on = await call(`/api/schedules/${made.body.schedule.id}`, { method: "PATCH", body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.schedule.enabled, true);
});

test("a column can finally be given the web search tool, and refuses a tool that does not exist", async () => {
  // `allowed_tools` was in the schema from the first migration. The executor read it, the estimate
  // read it, the savings ledger read it, the live cost preview read it — and NOTHING wrote it. It
  // defaults to `[]`, buildToolset only attaches web_search when the name is in the list, so no agent
  // column could search the web however carefully the Search tab was filled in. Confirmed against the
  // live database before this was written: two agent columns, zero rows containing web_search.
  const f = fixture("tools");
  const agent = addColumn(f.sheet.id, { name: "Research", kind: "agent" });

  const before = getColumn(agent.id)!;
  assert.deepEqual(before.allowedTools, [], "which is why it could never search");

  const on = await call(`/api/columns/${agent.id}`, {
    method: "PATCH", body: { allowedTools: ["fetch_url", "web_search"] },
  });
  assert.equal(on.status, 200);
  assert.deepEqual(getColumn(agent.id)!.allowedTools, ["fetch_url", "web_search"]);

  // A name buildToolset does not know is dropped there silently, so accepting it here would store a
  // setting that does nothing and looks like it does.
  const bad = await call(`/api/columns/${agent.id}`, {
    method: "PATCH", body: { allowedTools: ["fetch_url", "read_my_email"] },
  });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /read_my_email/);
  assert.deepEqual(getColumn(agent.id)!.allowedTools, ["fetch_url", "web_search"], "and nothing changed");

  // Order is normalised, so a column and a template made from it compare equal rather than differing
  // by the order somebody happened to click.
  await call(`/api/columns/${agent.id}`, { method: "PATCH", body: { allowedTools: ["web_search", "fetch_url"] } });
  assert.deepEqual(getColumn(agent.id)!.allowedTools, ["fetch_url", "web_search"]);

  const off = await call(`/api/columns/${agent.id}`, { method: "PATCH", body: { allowedTools: ["fetch_url"] } });
  assert.equal(off.status, 200);
  assert.deepEqual(getColumn(agent.id)!.allowedTools, ["fetch_url"]);
});

// ── The two clock settings ───────────────────────────────────────────────────────────────────────
//
// A speed limit and a wait were both stored, both read by the engine, and reachable from NOTHING —
// the route ignored them, so the only way to set either was a SQL client. These tests are the thing
// that stops that regressing: a column that cannot be configured is a feature that does not exist.

test("a speed limit can be set, and is read back", async () => {
  const sheet = createSheet("ZZ pace");
  const col = addColumn(sheet.id, { name: "Enrich", kind: "http" });
  const res = await call(`/api/columns/${col.id}`, { method: "PATCH", body: { rateLimitPerMin: 120 } });
  assert.equal(res.status, 200);
  assert.equal(getColumn(col.id)?.rateLimitPerMin, 120);
});

test("an absurd speed limit is clamped rather than refused, and the answer says what was stored", async () => {
  // A typo in a number field is not worth an error dialog — but silently keeping 9,000,000 would let
  // the field claim a limit the engine will never honour.
  const sheet = createSheet("ZZ pace clamp");
  const col = addColumn(sheet.id, { name: "Enrich", kind: "http" });
  await call(`/api/columns/${col.id}`, { method: "PATCH", body: { rateLimitPerMin: -5 } });
  assert.equal(getColumn(col.id)?.rateLimitPerMin, 0, "negative means no limit, not a negative limit");
  const res = await call(`/api/columns/${col.id}`, { method: "PATCH", body: { rateLimitPerMin: 9_000_000 } });
  assert.equal(Number(res.body.column?.rateLimitPerMin), 100_000);
});

test("a wait is capped at an hour — past that a scheduled run is the honest answer", async () => {
  const sheet = createSheet("ZZ wait");
  const col = addColumn(sheet.id, { name: "Hold", kind: "wait" });
  const res = await call(`/api/columns/${col.id}`, { method: "PATCH", body: { waitSeconds: 99_999 } });
  assert.equal(res.status, 200);
  assert.equal(getColumn(col.id)?.waitSeconds, 3600);
  assert.equal(Number(res.body.column?.waitSeconds), 3600, "the client is told what was actually stored");
});

test("setting either of them can be taken back", async () => {
  const sheet = createSheet("ZZ pace undo");
  const col = addColumn(sheet.id, { name: "Hold", kind: "wait" });
  await call(`/api/columns/${col.id}`, { method: "PATCH", body: { waitSeconds: 30 } });
  await call(`/api/columns/${col.id}`, { method: "PATCH", body: { waitSeconds: 600 } });
  assert.equal(undo(sheet.id).ok, true);
  assert.equal(getColumn(col.id)?.waitSeconds, 30, "back to the previous wait, not to zero");
});

// ─────────────────────────────────────────────── pasting a block of cells

// A paste is the one write in the grid that is not one cell. Looping the single-cell route would
// have given it a thousand transactions, a thousand undo entries — enough to evict the whole
// session's history at MAX_DEPTH 50 — and a half-written table whenever one of them failed. So the
// properties here are the ones that only hold if it is genuinely ONE operation.

test("a pasted block writes every cell and is one undo away from gone", async () => {
  const sheet = createSheet("ZZ paste");
  const a = Number(addColumn(sheet.id, { name: "A", kind: "static" }).id);
  const b = Number(addColumn(sheet.id, { name: "B", kind: "static" }).id);
  insertRows(sheet.id, [{ values: {} }, { values: {} }], 0, [a, b]);
  const rows = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[]).map((r) => Number(r.id));

  const res = await call(`/api/sheets/${sheet.id}/cells/bulk`, {
    method: "POST",
    body: {
      label: "Paste",
      edits: [
        { rowId: rows[0], columnId: a, value: "a1" }, { rowId: rows[0], columnId: b, value: "b1" },
        { rowId: rows[1], columnId: a, value: "a2" }, { rowId: rows[1], columnId: b, value: "b2" },
      ],
      // Runs off the bottom of the table, exactly as a paste from a spreadsheet does.
      newRows: [{ [a]: "a3", [b]: "b3" }],
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.written, 4);
  assert.equal(res.body.rowsAdded, 1);
  assert.equal(res.body.rowCount, 3, "the block that overflowed grew the table rather than being dropped");

  const values = () =>
    (db.prepare(
      "SELECT value_text FROM cells c JOIN rows r ON r.id = c.row_id WHERE r.sheet_id = ? AND c.column_id = ? ORDER BY r.position",
    ).all(sheet.id, a) as any[]).map((x) => x.value_text);
  assert.deepEqual(values(), ["a1", "a2", "a3"]);

  // ONE undo. Not one per cell, and it takes the created row with it.
  const back = undo(sheet.id);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(values(), [null, null], "the paste is gone, rows and all");
});

test("a paste onto a column a run fills is refused whole, and names the column", async () => {
  // Half-applied is the failure worth preventing: the editable columns written, the locked one not,
  // and a table the user believes carries the block they pasted.
  const sheet = createSheet("ZZ paste locked");
  const a = Number(addColumn(sheet.id, { name: "Company", kind: "static" }).id);
  const ai = Number(addColumn(sheet.id, { name: "Industry", kind: "ai" }).id);
  insertRows(sheet.id, [{ values: {} }], 0, [a, ai]);
  const row = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(sheet.id) as any).id);

  const res = await call(`/api/sheets/${sheet.id}/cells/bulk`, {
    method: "POST",
    body: { edits: [{ rowId: row, columnId: a, value: "Acme" }, { rowId: row, columnId: ai, value: "Biotech" }] },
  });

  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /Industry/);
  assert.equal(
    (db.prepare("SELECT value_text FROM cells WHERE row_id = ? AND column_id = ?").get(row, a) as any).value_text,
    null,
    "and nothing at all was written",
  );
});

test("the per-cell search ceilings survive a save, and reach the column", async () => {
  // The same class of fault as the allowed_tools test above, one field over: the Search tab offered
  // both ceilings, the executor read both, and `normalizeAgentSettings` sat in between returning a
  // six-field object that mentioned neither. The PATCH answered 200, the drawer re-seeded from that
  // answer, and both numbers reverted while the user watched.
  const f = fixture("ceilings");
  const agent = addColumn(f.sheet.id, { name: "Research", kind: "agent" });

  const res = await call(`/api/columns/${agent.id}`, {
    method: "PATCH",
    body: { agent: { search: { engine: "auto", maxResults: 5, maxSpendUsd: 0.25, maxSearches: 6 } } },
  });
  assert.equal(res.status, 200);

  // Asserted on the answer the drawer re-seeds from, not only on the database, because that answer
  // is what put the old numbers back on the screen.
  const saved = (res.body.column?.agent as any)?.search;
  assert.equal(saved.maxSpendUsd, 0.25);
  assert.equal(saved.maxSearches, 6);

  const stored = (getColumn(agent.id)!.agent as any)?.search;
  assert.equal(stored.maxSpendUsd, 0.25);
  assert.equal(stored.maxSearches, 6);
});

test("changing a search ceiling makes existing cells stale", async () => {
  // Without the prompt_version bump the next run skips every row as "unchanged", so the column looks
  // re-run under the new ceiling while every value in it was produced under the old one.
  const f = fixture("ceiling-stale");
  const agent = addColumn(f.sheet.id, { name: "Research", kind: "agent" });
  const before = getColumn(agent.id)!.promptVersion;

  await call(`/api/columns/${agent.id}`, {
    method: "PATCH", body: { agent: { search: { engine: "auto", maxResults: 5, maxSearches: 3 } } },
  });

  assert.ok(getColumn(agent.id)!.promptVersion > before, "the ceiling is part of the question asked");
});

// ─────────────────────────────────────────────── the routes that guard a key

test("saving a key refuses a request that cannot show it came from Ferrum's own page", async () => {
  // Every sibling key-write route called `provenLocal` and these two did not, which made them the
  // way around all of them: the provider keys for everything except OpenRouter are read straight out
  // of this store. `call` sends no Origin and no Sec-Fetch-Site, which is exactly what a page that
  // is not Ferrum's own looks like from here.
  const saved = await call("/api/secrets", { method: "POST", body: { name: "ZZ Anthropic", value: "sk-test" } });
  assert.equal(saved.status, 403);
  assert.match(String(saved.body.error), /Ferrum's own page/);

  const removed = await call("/api/secrets/ZZ%20Anthropic", { method: "DELETE" });
  assert.equal(removed.status, 403);

  const dropped = await call("/api/providers/openrouter/key", { method: "DELETE" });
  assert.equal(dropped.status, 403, "removing a key repoints the engine as surely as overwriting it");
});

// ─────────────────────────────────────────────── discovering a list's fields

test("list-fields samples, and says over how many rows", async () => {
  // Unbounded, this read every row of the table and JSON-parsed every cell in JavaScript — 11
  // seconds of blocked event loop on a million-row table, for one GET. The bound is only half the
  // fix: a count over a sample presented as a total is a number somebody plans a fan-out against.
  const sheet = createSheet("ZZ list fields");
  const col = addColumn(sheet.id, { name: "Contacts", kind: "static", valueType: "json" });
  insertRows(
    sheet.id,
    [{ values: { [Number(col.id)]: '[{"name":"Ada","email":"ada@acme.com"}]' } }],
    0,
    [Number(col.id)],
  );

  const res = await call(`/api/columns/${col.id}/list-fields`);
  assert.equal(res.status, 200);
  assert.equal(res.body.sampledRows, 1);
  assert.equal(res.body.sheetRows, 1);
  assert.equal(res.body.sampled, false, "nothing was left out of a one-row table");
});

// ─────────────────────────────────────────────── the live stream, per subscriber
//
// These two claim the instance, which every other test in this file relies on NOT being the case —
// so each one puts it back in `finally`, whatever it does in between.

/** A claimed instance with one ordinary member, and the way to undo that. */
function claimed(tag: string) {
  claimInstance(`owner-${tag}@ferrum.test`, "a-long-enough-password", "Owner");
  const member = createPerson({ email: `member-${tag}@ferrum.test`, password: "a-long-enough-password", role: "member" });
  const cookie = `${SESSION_COOKIE}=${startSession(member.id)}`;
  return {
    member,
    cookie,
    release: () => { db.prepare("DELETE FROM sessions").run(); db.prepare("DELETE FROM users").run(); },
  };
}

/** Everything one subscriber received while `act` ran. */
async function streamText(cookie: string, act: () => void): Promise<string> {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { Cookie: cookie }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch { /* aborted, which is how this ends */ }
  })();

  // The subscription is registered when the handler runs, not when fetch resolves.
  await new Promise((r) => setTimeout(r, 50));
  act();
  await new Promise((r) => setTimeout(r, 150));
  ctrl.abort();
  await pump;
  return text;
}

test("the stream does not deliver a restricted workbook's cells to someone without a grant", async () => {
  // The gate 404s this account on every REST route into that workbook — and the bus broadcast the
  // same cells to every subscriber anyway, values, costs and error text included. So a workbook
  // somebody had been deliberately shut out of filled in live in front of them.
  const ctx = claimed("stream");
  try {
    const secretWb = createWorkbook("ZZ restricted");
    const secretSheet = createSheet("ZZ secret", secretWb.id);
    const secretCol = addColumn(secretSheet.id, { name: "Deal", kind: "static" });
    insertRows(secretSheet.id, [{ values: { [Number(secretCol.id)]: "classified" } }], 0, [Number(secretCol.id)]);
    db.prepare("UPDATE workbooks SET restricted = 1 WHERE id = ?").run(secretWb.id);

    const openSheet = createSheet("ZZ open");
    const openCol = addColumn(openSheet.id, { name: "Company", kind: "static" });
    insertRows(openSheet.id, [{ values: { [Number(openCol.id)]: "Acme" } }], 0, [Number(openCol.id)]);

    const rowOf = (sheetId: string): number =>
      Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(sheetId) as any).id);
    const secretCell = `${rowOf(secretSheet.id)}:${Number(secretCol.id)}`;
    const openCell = `${rowOf(openSheet.id)}:${Number(openCol.id)}`;

    const text = await streamText(ctx.cookie, () => {
      markCellsDirty([secretCell, openCell]);
      flushNow();
    });

    // Matched on the delta's own id field rather than on the bare id, which is two numbers and a
    // colon and could turn up anywhere in a frame.
    const delivered = (cellId: string) => text.includes(`"i":"${cellId}"`);
    assert.ok(text.includes("hello"), "the connection itself still works");
    assert.ok(delivered(openCell), "the workbook they can reach still streams");
    assert.ok(!delivered(secretCell), "the one they are 404'd out of does not");
    assert.ok(!text.includes("classified"), "and neither does its value");
  } finally {
    ctx.release();
  }
});

test("health tells an anonymous caller that it is up, and nothing else", async () => {
  // Open by design, so a monitor can reach it — and it was answering with the absolute path of the
  // database, the table and row counts and the credential mode, to anyone who could reach the port.
  const ctx = claimed("health");
  try {
    const anon = await call("/api/health");
    assert.equal(anon.status, 200);
    assert.equal(anon.body.ok, true, "still usable as a health check");
    assert.equal(anon.body.db, undefined, "no path and no counts");
    assert.equal(anon.body.auth, undefined);

    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: ctx.cookie } });
    const body = await res.json() as any;
    assert.ok(body.db?.path, "someone signed in still gets the whole thing");
  } finally {
    ctx.release();
  }
});

test("the key-usage check names the column that really refers to the key", async () => {
  // The route's SELECT omitted c.http_config while its filter read it, so `r.http_config` was
  // undefined for every row and EVERY key answered "no column refers to it" — including one in use
  // everywhere. A safety check that always returns the reassuring answer is worse than none.
  const ctx = claimed("keyusage");
  try {
    const { sheet } = fixture("keyusage");
    const http = addColumn(sheet.id, { name: "Enrich", kind: "http" });
    db.prepare("UPDATE columns SET http_config = ? WHERE id = ?").run(
      JSON.stringify(normalizeHttpConfig({
        ...DEFAULT_HTTP,
        url: "https://api.example.com/v1",
        headers: [{ name: "Authorization", value: "Bearer {{secret:Keyusage Key}}" }],
      })),
      Number(http.id),
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/api/secrets/${encodeURIComponent("keyusage key")}/usage`,
      { headers: { Cookie: ctx.cookie } },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.used.length, 1, "the one column that refers to it is named");
    assert.equal(body.used[0].columnId, Number(http.id));
    assert.equal(body.used[0].column, "Enrich");
  } finally {
    ctx.release();
  }
});

test("the inside of a restricted workbook is a 404 to someone without a grant", async () => {
  // GET /api/workspace?workbook=<id> filtered every OTHER branch of the route through visible(),
  // and answered the inside branch to anyone holding the id — name, tables and row counts. The id
  // is the one the app itself writes into the address bar, so a link outlives a restriction.
  const ctx = claimed("crumb");
  try {
    const wb = createWorkbook("ZZ crumb-restricted");
    const sheet = createSheet("ZZ crumb-secret", wb.id);
    addColumn(sheet.id, { name: "Deal", kind: "static" });
    db.prepare("UPDATE workbooks SET restricted = 1 WHERE id = ?").run(wb.id);

    const denied = await fetch(`http://127.0.0.1:${port}/api/workspace?workbook=${wb.id}`, {
      headers: { Cookie: ctx.cookie },
    });
    assert.equal(denied.status, 404, "the same answer as a workbook that does not exist");
    assert.equal((await denied.json() as any).error, "Workbook not found");

    db.prepare("INSERT INTO workbook_grants (workbook_id, user_id) VALUES (?, ?)").run(wb.id, ctx.member.id);
    const granted = await fetch(`http://127.0.0.1:${port}/api/workspace?workbook=${wb.id}`, {
      headers: { Cookie: ctx.cookie },
    });
    assert.equal(granted.status, 200);
    const body = await granted.json() as any;
    assert.ok(Array.isArray(body.entries) && body.entries.some((e: any) => e.name === "ZZ crumb-secret"),
      "a granted person still sees the tables inside");
  } finally {
    ctx.release();
  }
});

test("a delivery to a switched-off source is recorded, and still answers exactly like a wrong token", async () => {
  // The route answered !source.enabled with its 404 before deliver() was reached, so
  // recordDisabledDelivery — written for exactly this — had no caller and neither counter moved.
  // "We switched it off and they kept sending" is the one thing the delivery list exists to show.
  // The 404 must not change shape: a distinct answer for "this token exists but is off" tells a
  // prober which tokens are real.
  const { sheet } = fixture("hook-off");
  const source = createSource(sheet.id, "Off source");
  updateSource(source.id, { enabled: false });

  const off = await call(`/hook/${source.token}`, { method: "POST", body: { plan: "enterprise" } });
  const wrong = await call("/hook/no-such-token-here", { method: "POST", body: { plan: "enterprise" } });
  assert.equal(off.status, 404);
  assert.equal(wrong.status, 404);
  assert.deepEqual(off.body, wrong.body, "identical to a wrong token, so the endpoint is not an oracle");

  // And the sender who kept posting is on the record, with what they sent.
  const deliveries = listDeliveries(source.id);
  const first = deliveries[0];
  assert.ok(first, "the attempt is recorded");
  assert.equal(deliveries.length, 1);
  assert.equal(first.ok, false);
  assert.ok(first.note?.includes("switched off"), first.note ?? "");
  assert.ok(first.body.includes("enterprise"), "the body they sent is kept");
});
