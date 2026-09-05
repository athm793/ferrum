// Sheet and column persistence.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addColumn, createSheet, deleteColumn, deleteRow, deleteSheet, getCell, getColumn, getSheet, insertRows,
  isBackfilling, listColumns, listSheets, readGroupedWindow, readWindow, renameColumn, setCellValue, setColumnValueType,
} from "./store.ts";
import { db } from "./db.ts";
import { record, redo, snapshotRow, undo, undoState } from "./undo.ts";
import { runnableColumns } from "./scope.ts";
import { trashTable, restoreTable } from "./views.ts";
import { isValueType, VALUE_TYPES } from "./types.ts";

test("a trashed table disappears from every list the user sees", () => {
  const keep = createSheet("stays");
  const gone = createSheet("trashed");

  trashTable(gone.id);

  const names = listSheets().map((s) => s.name);
  assert.ok(names.includes("stays"));
  // `listSheets` filtered on `archived` alone, so trashing a table did nothing visible — it stayed
  // in the switcher and could still be opened.
  assert.ok(!names.includes("trashed"), "a trashed sheet must not appear in the sheet list");
  assert.equal(getSheet(gone.id), null, "and must not be openable by id either");

  restoreTable(gone.id);
  assert.ok(listSheets().map((s) => s.name).includes("trashed"), "restoring brings it back");
  assert.ok(keep);
});

test("changing a column's type invalidates the cells produced under the old one", () => {
  const sheet = createSheet("types");
  const col = addColumn(sheet.id, { name: "Price" });
  const before = getColumn(col.id)!;
  assert.equal(before.valueType, "text");

  setColumnValueType(col.id, "currency");

  const after = getColumn(col.id)!;
  assert.equal(after.valueType, "currency");
  // promptVersion is part of every cell's input hash, so bumping it is what stops a re-run from
  // skipping cells as "unchanged" when the contract they were produced under has in fact changed.
  assert.equal(after.promptVersion, before.promptVersion + 1);
});

test("the value-type list is checkable at runtime, not just at compile time", () => {
  // The guard exists so an HTTP request can be validated. If the array and the type ever drift, the
  // server would accept a type nothing else understands and write it into a column.
  for (const t of VALUE_TYPES) assert.ok(isValueType(t), `${t} should be recognised`);
  assert.ok(!isValueType("nonsense"));
  assert.ok(!isValueType(""));
  assert.ok(!isValueType(null));
  assert.ok(!isValueType(42));
});

test("a plain value is stored once, not duplicated into value_json", () => {
  // `insertRows` wrote `JSON.stringify(raw)` into value_json for EVERY cell. Every value on that
  // path is already a string, so the blob was a quoted second copy of value_text and nothing else —
  // measured at 107% of the text column on this fixture and 113% across the real database.
  const sheet = createSheet("no-dup-json");
  const col = addColumn(sheet.id, { name: "Company" });
  const colId = Number(col.id);
  insertRows(sheet.id, [{ values: { [String(colId)]: "Acme Holdings International" } }], 0, [colId]);

  const stored = db.prepare("SELECT value_text, value_json FROM cells WHERE column_id = ?").get(colId) as any;
  assert.equal(stored.value_text, "Acme Holdings International");
  assert.equal(stored.value_json, null, "no second copy of the same string");

  // Nothing is lost by dropping it: an absent blob means the TEXT is the value, and a reader that
  // returned null there would make every imported cell look empty.
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(sheet.id) as any).id);
  assert.equal(getCell(rowId, colId)?.value, "Acme Holdings International");
  assert.equal(getCell(rowId, colId)?.valueText, "Acme Holdings International");

  // The hand-edit path says the same thing.
  setCellValue(rowId, colId, "Corrected by hand");
  const edited = db.prepare("SELECT value_text, value_json FROM cells WHERE column_id = ?").get(colId) as any;
  assert.equal(edited.value_json, null);
  assert.equal(getCell(rowId, colId)?.value, "Corrected by hand");
});

test("a batch spanning many insert chunks lands every cell on its own row, appends included", () => {
  // insertRows groups rows and cells into multi-row INSERTs and reclaims each row's id from the block
  // AUTOINCREMENT just handed out — `[last - N + 1 … last]`. If that reclamation were off by a row, or
  // a chunk boundary split a row's cells from their id, cells would attach to the wrong rows silently.
  // So: a batch larger than both chunk sizes (250 rows, 120 cell-tuples), with a distinct value in
  // every cell, then a SECOND batch appended when rows already exist — the case that would expose a
  // wrong id base — and every value is checked against the (batch, row, column) it must hold.
  const sheet = createSheet("chunked-insert");
  const cols = [addColumn(sheet.id, { name: "A" }), addColumn(sheet.id, { name: "B" }), addColumn(sheet.id, { name: "C" }), addColumn(sheet.id, { name: "D" })]
    .map((c) => Number(c.id));
  const N = 300; // > 250 rows/chunk, and 300×4 = 1200 cells > 120/chunk
  const mkBatch = (tag: string) =>
    Array.from({ length: N }, (_, r) => ({ values: Object.fromEntries(cols.map((id, c) => [String(id), `${tag}-${r}-${c}`])) }));

  insertRows(sheet.id, mkBatch("X"), 0, cols);
  insertRows(sheet.id, mkBatch("Y"), N, cols); // append: rows already exist

  const rows = db.prepare("SELECT id, position FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[];
  assert.equal(rows.length, N * 2);
  let mismatches = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    const tag = ri < N ? "X" : "Y";
    const localR = ri % N;
    for (let c = 0; c < cols.length; c++) {
      const cell = db.prepare("SELECT value_text FROM cells WHERE row_id = ? AND column_id = ?").get(rows[ri]!.id, cols[c]!) as any;
      if (cell?.value_text !== `${tag}-${localR}-${c}`) mismatches++;
    }
  }
  assert.equal(mismatches, 0, "every one of the 2,400 cells is on the right row and column");
});

test("the materialized view indexes are bounded, and the one in use survives the trim", () => {
  // A plain GET on the read path WRITES permanent rows into view_index, and nothing ever removed
  // them — 337 MB across 52 view keys on the real database, 21% of the whole file, for views nobody
  // had opened in weeks. Every distinct search below is one more index.
  const sheet = createSheet("view-index-cap");
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  // Zero-padded so no term is a substring of another — search is a LIKE, so "needle1" would also
  // match "needle10" and "needle11" and the per-search count below would be meaningless.
  const term = (i: number) => `needle-${String(i).padStart(2, "0")}`;
  insertRows(
    sheet.id,
    Array.from({ length: 12 }, (_, i) => ({ values: { [String(colId)]: term(i) } })),
    0,
    [colId],
  );

  const keys = () =>
    Number((db.prepare("SELECT COUNT(*) AS c FROM view_index_meta WHERE sheet_id = ?").get(sheet.id) as any).c);
  const orphans = () =>
    Number((db.prepare(
      "SELECT COUNT(*) AS c FROM view_index vi WHERE vi.view_key NOT IN (SELECT view_key FROM view_index_meta)",
    ).get() as any).c);

  for (let i = 0; i < 12; i++) {
    const win = readWindow(sheet.id, 0, 10, { search: term(i) });
    // The key built by THIS call must never be a candidate for its own eviction — built_at has
    // one-second granularity, so a same-second tie could otherwise delete it moments after building
    // it and hand back an empty window over a sheet that is not empty.
    assert.equal(win.total, 1, `search ${i} must still find its row`);
    assert.equal(win.rows.length, 1);
  }

  assert.ok(keys() <= 8, `at most 8 indexes per sheet, got ${keys()}`);
  // The meta row and its index rows are removed together. Index rows outliving their meta would be
  // dead weight; meta outliving its rows would pass the freshness check and render an empty sheet.
  assert.equal(orphans(), 0, "no index rows are left behind without their meta row");
});

test("deleting a table takes its view indexes and its version stamp with it", () => {
  // None of those three tables has a foreign key onto `sheets`, so nothing cascaded: on the real
  // database 91 of 98 `dv:` keys and 30 `view_index` rows belonged to tables that no longer existed.
  // Trivial at that size and unbounded by design — `view_index` is 318 MB, so one deleted
  // million-row table would strand hundreds of megabytes nothing can ever reach again.
  const sheet = createSheet("delete-cleanup");
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  insertRows(sheet.id, [{ values: { [String(colId)]: "needle" } }], 0, [colId]);
  readWindow(sheet.id, 0, 10, { search: "needle" });

  const metas = () =>
    Number((db.prepare("SELECT COUNT(*) AS c FROM view_index_meta WHERE sheet_id = ?").get(sheet.id) as any).c);
  const indexRows = () =>
    Number((db.prepare("SELECT COUNT(*) AS c FROM view_index WHERE view_key LIKE ?").get(`${sheet.id}|%`) as any).c);
  const stamp = () => db.prepare("SELECT v FROM kv WHERE k = ?").get(`dv:${sheet.id}`);

  assert.ok(metas() > 0, "the fixture must actually build an index");
  assert.ok(indexRows() > 0);
  assert.ok(stamp(), "and stamp a data version");

  deleteSheet(sheet.id);

  assert.equal(metas(), 0, "the meta row goes with the table");
  assert.equal(indexRows(), 0, "so do its index rows");
  assert.equal(stamp(), undefined, "and its data-version key");
});

// ─────────────────────────────────────────────────────── undo / redo

test("deleting a column is reversible, and its values survive", () => {
  const sheet = createSheet("undo-col");
  const keep = addColumn(sheet.id, { name: "Keep" });
  const drop = addColumn(sheet.id, { name: "Drop" });
  insertRows(
    sheet.id,
    [{ values: { [keep.id]: "a", [drop.id]: "x" } }, { values: { [keep.id]: "b", [drop.id]: "y" } }],
    0,
    [Number(keep.id), Number(drop.id)],
  );

  deleteColumn(drop.id);
  record(sheet.id, "column.delete", 'Delete column "Drop"', {
    columnId: Number(drop.id),
    deletedAt: (db.prepare("SELECT deleted_at FROM columns WHERE id = ?").get(Number(drop.id)) as any).deleted_at,
  });

  assert.deepEqual(listColumns(sheet.id).map((c) => c.name), ["Keep"], "the column is gone from the sheet");
  // The whole point of the soft delete: the values were never destroyed, so undo is not a
  // reconstruction from a snapshot — it is the original data, untouched.
  const stillThere = db.prepare("SELECT COUNT(*) n FROM cells WHERE column_id = ?").get(Number(drop.id)) as any;
  assert.equal(Number(stillThere.n), 2, "the cells are retained, not deleted");

  const r = undo(sheet.id);
  assert.equal(r.ok, true);
  assert.deepEqual(listColumns(sheet.id).map((c) => c.name), ["Keep", "Drop"]);

  const win = readWindow(sheet.id, 0, 10);
  assert.deepEqual(win.rows.map((row) => row.cells[String(drop.id)]?.v), ["x", "y"], "values came back intact");
});

test("a deleted column cannot be run — including after the delete", () => {
  const sheet = createSheet("undo-scope");
  const a = addColumn(sheet.id, { name: "A", kind: "script" });
  const b = addColumn(sheet.id, { name: "B", kind: "script" });
  insertRows(sheet.id, [{ values: {} }], 0, [Number(a.id), Number(b.id)]);

  assert.equal(runnableColumns(sheet.id).length, 2);
  deleteColumn(b.id);
  // The expensive failure mode: a soft delete that only hid the column in the UI while runs kept
  // targeting it would keep spending on a column the user believes is gone.
  assert.deepEqual(runnableColumns(sheet.id), [Number(a.id)]);
});

test("undo and redo walk the same path in both directions", () => {
  const sheet = createSheet("undo-redo");
  const col = addColumn(sheet.id, { name: "One" });

  renameColumn(col.id, "Two");
  record(sheet.id, "column.rename", "Rename", { columnId: Number(col.id), from: "One", to: "Two" });
  renameColumn(col.id, "Three");
  record(sheet.id, "column.rename", "Rename", { columnId: Number(col.id), from: "Two", to: "Three" });

  const name = () => listColumns(sheet.id)[0]!.name;
  assert.equal(name(), "Three");

  undo(sheet.id); assert.equal(name(), "Two");
  undo(sheet.id); assert.equal(name(), "One");
  assert.equal(undo(sheet.id).ok, false, "nothing left to undo");

  redo(sheet.id); assert.equal(name(), "Two");
  redo(sheet.id); assert.equal(name(), "Three");
  assert.equal(redo(sheet.id).ok, false, "nothing left to redo");
});

test("a new operation discards the redo branch", () => {
  const sheet = createSheet("undo-branch");
  const col = addColumn(sheet.id, { name: "One" });

  renameColumn(col.id, "Two");
  record(sheet.id, "column.rename", "Rename", { columnId: Number(col.id), from: "One", to: "Two" });
  undo(sheet.id);
  assert.ok(undoState(sheet.id).redo, "the undone entry is redoable");

  // Doing something new makes the undone branch unreachable — replaying it would apply an operation
  // against a state it was never valid for.
  renameColumn(col.id, "Other");
  record(sheet.id, "column.rename", "Rename", { columnId: Number(col.id), from: "One", to: "Other" });

  assert.equal(undoState(sheet.id).redo, null, "the redo branch is discarded");
});

test("a deleted row comes back with its id, so back-references still resolve", () => {
  const sheet = createSheet("undo-row");
  const col = addColumn(sheet.id, { name: "Value" });
  insertRows(sheet.id, [{ values: { [col.id]: "keep" } }, { values: { [col.id]: "gone" } }], 0, [Number(col.id)]);

  const ids = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[]).map((r) => Number(r.id));
  const victim = ids[1]!;

  const snap = snapshotRow(victim);
  assert.ok(snap);
  deleteRow(victim);
  record(sheet.id, "row.delete", "Delete row", snap);

  assert.equal(readWindow(sheet.id, 0, 10).total, 1);

  assert.equal(undo(sheet.id).ok, true);
  const win = readWindow(sheet.id, 0, 10);
  assert.equal(win.total, 2);
  // The SAME id, not a fresh one. A fan-out writes the parent's row id into its children, and
  // restoring under a new id would leave every one of them pointing at nothing.
  assert.deepEqual(win.rows.map((r) => Number(r.id)), ids);
  assert.deepEqual(win.rows.map((r) => r.cells[String(col.id)]?.v), ["keep", "gone"]);
});

test("undoing a column delete makes its values findable again", () => {
  const sheet = createSheet("undo-search");
  const a = addColumn(sheet.id, { name: "A" });
  const b = addColumn(sheet.id, { name: "B" });
  const ids = [Number(a.id), Number(b.id)];
  insertRows(
    sheet.id,
    [
      { values: { [ids[0]!]: "plain", [ids[1]!]: "needle" } },
      { values: { [ids[0]!]: "plain", [ids[1]!]: "other" } },
    ],
    0,
    ids,
  );

  assert.equal(readWindow(sheet.id, 0, 10, { search: "needle" }).total, 1);

  deleteColumn(b.id);
  record(sheet.id, "column.delete", 'Delete column "B"', {
    columnId: ids[1]!,
    deletedAt: (db.prepare("SELECT deleted_at FROM columns WHERE id = ?").get(ids[1]!) as any).deleted_at,
  });
  assert.equal(readWindow(sheet.id, 0, 10, { search: "needle" }).total, 0, "a deleted column's values are not searchable");

  assert.equal(undo(sheet.id).ok, true);
  // A search matches over the sheet's LIVE columns, and the materialized view index is stamped with
  // the sheet's data version. `deleteColumn` bumps that stamp; the INVERSE did not, so the index
  // went on answering from before the restore — the column and its values were back on screen and
  // the search still found nothing.
  assert.equal(readWindow(sheet.id, 0, 10, { search: "needle" }).total, 1);
});

test("an undo entry that records no change cannot destroy the field it names", () => {
  const sheet = createSheet("undo-noop-field");
  const col = addColumn(sheet.id, { name: "Send" });
  const cfg = JSON.stringify({ targetSheetId: "elsewhere", mapping: {}, onConflict: "update" });
  db.prepare("UPDATE columns SET send_config = ? WHERE id = ?").run(cfg, Number(col.id));

  // The exact shape the send-destination route records: BOTH directions null, so the entry cannot
  // describe a change. Applying it ran `SET send_config = NULL` and erased the destination, the
  // mapping, the conflict rule and the cap — and redo, being the exact mirror, did it a second time.
  record(sheet.id, "column.field", "Change the destination", {
    columnId: Number(col.id), field: "send_config", from: null, to: null,
  });

  assert.equal(undo(sheet.id).ok, true);
  const after = db.prepare("SELECT send_config FROM columns WHERE id = ?").get(Number(col.id)) as any;
  assert.equal(after.send_config, cfg, "a step that recorded nothing must not delete anything");

  assert.equal(redo(sheet.id).ok, true);
  const back = db.prepare("SELECT send_config FROM columns WHERE id = ?").get(Number(col.id)) as any;
  assert.equal(back.send_config, cfg);
});

test("a real field change still reverses in both directions", () => {
  // The guard above skips entries whose two directions match. This is the check that it did not
  // also swallow the honest ones.
  const sheet = createSheet("undo-real-field");
  const col = addColumn(sheet.id, { name: "Notes" });
  db.prepare("UPDATE columns SET description = ? WHERE id = ?").run("after", Number(col.id));
  record(sheet.id, "column.field", "Describe", {
    columnId: Number(col.id), field: "description", from: "before", to: "after",
  });

  const description = () => (db.prepare("SELECT description FROM columns WHERE id = ?").get(Number(col.id)) as any).description;
  assert.equal(undo(sheet.id).ok, true);
  assert.equal(description(), "before");
  assert.equal(redo(sheet.id).ok, true);
  assert.equal(description(), "after");
});

test("a new column dodges the keys of DELETED columns too, not only the live ones", () => {
  // Deleted columns are soft-deleted — undo restores them with their key intact — and the
  // UNIQUE(sheet_id, key) index covers them like live rows. Deduping against live names only meant
  // the insert collided with a column nobody could see, and the raw constraint error landed on
  // whoever clicked "Create". This is the "add item as column is broken" bug.
  const sheet = createSheet("dedupe-vs-deleted");
  addColumn(sheet.id, { name: "Industry" });
  const doomed = addColumn(sheet.id, { name: "Industry (2)" });
  deleteColumn(doomed.id);

  // "Industry" is taken by a live column, "Industry (2)" by a deleted one. The next free name is
  // (3) — and reaching it must not throw on the invisible (2).
  const created = addColumn(sheet.id, { name: "Industry" });
  assert.equal(created.name, "Industry (3)");
  assert.deepEqual(
    listColumns(sheet.id).map((c) => c.name),
    ["Industry", "Industry (3)"],
    "the deleted column stays invisible, and the new one lives beside the survivor",
  );
});

test("adding a column to a large table returns immediately and backfills its cells in the background", async () => {
  // The freeze that made "+ Column" look dead: addColumn backfilled an empty cell for EVERY row inline,
  // so on a 586k-row table it blocked the single-threaded engine for ~15s with no feedback. Above the
  // threshold the column is returned at once and its cells fill in yielding background chunks. Below,
  // it stays inline. This test proves both the instant return and the eventual completeness.
  const sheet = createSheet("big-add");
  const seed = addColumn(sheet.id, { name: "Seed" });      // small sheet → inline, instant
  assert.equal(isBackfilling(Number(seed.id)), false, "an empty sheet backfills inline, not in the background");

  // Seed just over the inline threshold (20,000).
  const N = 25000, B = 5000;
  for (let i = 0; i < N; i += B) {
    insertRows(sheet.id, Array.from({ length: B }, (_, k) => ({ values: { [String(seed.id)]: "v" + (i + k) } })), i, [Number(seed.id)]);
  }

  const t = Date.now();
  const col = addColumn(sheet.id, { name: "Added" });
  const ms = Date.now() - t;
  assert.ok(ms < 500, `addColumn on ${N} rows must return fast, took ${ms}ms`);
  assert.equal(isBackfilling(Number(col.id)), true, "over the threshold, the backfill runs in the background");

  // Wait for the background backfill, then every row must have a cell for the new column.
  const deadline = Date.now() + 20000;
  while (isBackfilling(Number(col.id)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(isBackfilling(Number(col.id)), false, "the backfill finishes");
  const cells = (db.prepare("SELECT COUNT(*) AS c FROM cells WHERE column_id = ?").get(Number(col.id)) as any).c;
  assert.equal(cells, N, "every row ends up with a cell for the new column");
});

test("a grouped window paginates in display space, headers before their groups", () => {
  const sheet = createSheet("grp");
  const company = addColumn(sheet.id, { name: "Company" });
  const city = addColumn(sheet.id, { name: "City" });
  const ids = [Number(company.id), Number(city.id)];
  insertRows(
    sheet.id,
    [
      { values: { [ids[0]!]: "Acme", [ids[1]!]: "Berlin" } },
      { values: { [ids[0]!]: "Acme", [ids[1]!]: "Berlin" } },
      { values: { [ids[0]!]: "Beta", [ids[1]!]: "Berlin" } },
      { values: { [ids[0]!]: "Beta", [ids[1]!]: "Lima" } },
      { values: { [ids[0]!]: "Norfolk" } }, // no city: the blank group
    ],
    0,
    ids,
  );

  const win = readGroupedWindow(sheet.id, 0, 100, {}, ids[1]!);
  // Grouping orders by the group column (blanks last), so: Berlin x3, Lima x1, blank x1 —
  // five rows plus three headers, and a display total that counts BOTH.
  assert.equal(win.total, 8);
  assert.equal(win.groups, 3);

  const first = win.entries[0]!;
  assert.equal(first.kind, "header");
  assert.equal(first.label, "Berlin");
  assert.equal(first.n, 3, "the count is over the whole view, not the loaded window");
  const rows = win.entries.filter((e) => e.kind === "row");
  assert.equal(rows.length, 5);
  assert.ok(win.entries.some((e) => e.kind === "header" && e.label === null), "blank values are a group, not a scatter");
  // Row records carry their VIEW position — the number "open this row as a record" has to hand back.
  const withPos = rows[0]!.row!;
  assert.equal(typeof withPos.position, "number");
  assert.equal(withPos.cells[ids[0]!]!.v, "Acme");

  // A window that starts mid-display starts mid-group: display offsets are honored, not row offsets.
  const page2 = readGroupedWindow(sheet.id, 3, 2, {}, ids[1]!);
  assert.equal(page2.total, 8);
  assert.equal(page2.entries.length, 2);
  assert.equal(page2.entries[0]!.kind, "row", "display slot 3 is the third Berlin row");
  assert.equal(page2.entries[1]!.kind, "header", "display slot 4 is Lima's header");

  // Read twice: the second read answers from the built index and must not drift.
  const again = readGroupedWindow(sheet.id, 0, 100, {}, ids[1]!);
  assert.deepEqual(again.entries.map((e) => e.kind), win.entries.map((e) => e.kind));
});
