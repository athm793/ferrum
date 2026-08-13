// CSV import and export.
//
// This file exists because of what shipped without it: every export wrote a correct header over
// entirely blank data for months, in a file whose row count, column order and headers were all
// right. Nothing about the shape of the output said anything was wrong.
//
// So the properties tested here are the silent, total ones — an export that does not carry the
// values, an import that leaves half a file behind when it fails, and a file whose encoding is
// decided by where a 64KB sample happened to be cut rather than by what is in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { db } from "./db.ts";
import type { FilterGroup } from "./filter.ts";
import { addColumn, countRows, createSheet, getCell, insertRows, listColumns, readWindow, setCellValue } from "./store.ts";
import { readFileSync } from "node:fs";
import { detectEncoding, exportCsv, guardFormula, ImportCancelled, importCsv, previewCsv, previewFromHead, shouldDropCellsIndex, trimToCharBoundary , unguardFormula} from "./csv.ts";

const SAMPLE_BYTES = 64 * 1024;

const dir = mkdtempSync(join(tmpdir(), "ferrum-csv-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold it */ } });

let seq = 0;
function fixture(content: string | Buffer): string {
  const path = join(dir, `f${seq++}.csv`);
  writeFileSync(path, content);
  return path;
}

/** The export is a stream, so the test drains it exactly as the route pipes it. */
async function exported(sheetId: string, opts: Parameters<typeof exportCsv>[1] = {}): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of exportCsv(sheetId, opts)) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Every visible value in the sheet, in grid order — what an export has to reproduce. */
function gridValues(sheetId: string): string[][] {
  const cols = listColumns(sheetId);
  return readWindow(sheetId, 0, 100_000).rows.map((r) =>
    cols.map((c) => {
      const cell = r.cells[c.id];
      return cell && cell.s === "done" ? (cell.v ?? "") : "";
    }),
  );
}

test("the export carries the values the grid holds, cell for cell", async () => {
  // The one that was missing. The per-row cell map was keyed by the numeric column_id and read back
  // with the string Column.id, so every lookup missed — headers, order and row count stayed correct
  // and every value came out blank.
  const sheet = createSheet("csv-roundtrip");
  const path = fixture(
    "Company,Country,Note\r\n" +
      "Acme,US,sent\r\n" +
      'Brik & Co,"Bergen, NO","a note, quoted"\r\n' +
      "Éclair,FR,=SUM(A1)\r\n",
  );

  const result = await importCsv(sheet.id, path);
  assert.equal(result.rowsInserted, 3);
  assert.equal(result.columnsCreated, 3);
  assert.equal(result.encoding, "utf8");

  const rows = parse(await exported(sheet.id), { bom: true }) as string[][];
  const cols = listColumns(sheet.id);
  assert.deepEqual(rows[0], cols.map((c) => c.name), "the header is the sheet's columns, in order");

  const grid = gridValues(sheet.id);
  assert.equal(rows.length - 1, grid.length, "one line per row, no more and no fewer");
  grid.forEach((expected, i) => {
    // Through guardFormula, because that is what the file is meant to contain: the value as text,
    // not as something Excel will execute.
    assert.deepEqual(rows[i + 1], expected.map(guardFormula), `row ${i} must export what the grid shows`);
  });

  assert.deepEqual(rows[1], ["Acme", "US", "sent"], "and the values are real, not blanks that happen to match");
  assert.equal(rows[2]![1], "Bergen, NO", "a quoted field survives the round trip");
  assert.equal(rows[3]![0], "Éclair", "so does an accent");
  assert.equal(rows[3]![2], "'=SUM(A1)", "a formula is neutralized on the way out, not on the way in");
});

test("export metadata columns line up with the values they describe", async () => {
  const sheet = createSheet("csv-meta");
  const path = fixture("Company\r\nAcme\r\n\r\n");
  await importCsv(sheet.id, path);

  const rows = parse(await exported(sheet.id, { includeMeta: true }), { bom: true }) as string[][];
  assert.deepEqual(rows[0], ["Company", "Company status", "Company cost"]);
  assert.deepEqual(rows[1], ["Acme", "done", ""]);
});

test("a repeated header gets its own column instead of overwriting the first", async () => {
  // Two columns headed "Email" resolved to one sheet column and the second overwrote the first, row
  // by row. The file looked imported, the summary reported a column count that matched, and one
  // whole column of addresses was simply gone.
  const sheet = createSheet("csv-dupe-headers");
  const path = fixture("Email,Name,Email\r\nfirst@x.com,Ada,second@x.com\r\n");

  const result = await importCsv(sheet.id, path);
  // The summary names WHERE THE DATA WENT, not just what repeated. It used to report `["Email"]` —
  // the source name — which tells the reader something was duplicated and not which column to go and
  // look in. The arrow is the useful half.
  assert.deepEqual(result.duplicateHeaders, ["Email → Email (2)"]);
  assert.equal(result.columnsCreated, 3);

  const cols = listColumns(sheet.id);
  assert.deepEqual(cols.map((c) => c.name), ["Email", "Name", "Email (2)"]);
  assert.deepEqual(gridValues(sheet.id), [["first@x.com", "Ada", "second@x.com"]]);
});

test("a row with the wrong number of fields keeps the fields it does have", async () => {
  // Dropping the whole record threw away every good field beside the missing one. On a list where
  // one line in ten is short a trailing comma, that is a tenth of the leads gone.
  const sheet = createSheet("csv-ragged");
  const path = fixture("A,B,C\r\n1,2,3\r\n4,5\r\n6,7,8,9\r\n");

  const result = await importCsv(sheet.id, path);
  assert.equal(result.rowsInserted, 3, "nothing is dropped");
  assert.equal(result.raggedFixed, 2, "and both are reported");
  assert.deepEqual(gridValues(sheet.id), [
    ["1", "2", "3"],
    ["4", "5", ""],   // padded
    ["6", "7", "8"],  // truncated
  ]);
});

test("a quote that never closes imports with quoting off, rather than failing the whole file", async () => {
  // The exact failure a messy export hands you: one field opens a quote and never closes it, so a
  // strict parser swallows the rest of the file and ends with "Quote Not Closed". The whole list used
  // to be refused over that one line; now it is read with quoting off and every row lands.
  const path = fixture('name,note\nAlice,ok\nBob,"he said hi\nCara,fine\nDan,ok\n');

  const preview = await previewCsv(path);
  assert.equal(preview.quotesDisabled, true, "the preview reports what it had to do");

  const sheet = createSheet("csv-unclosed-quote");
  const result = await importCsv(sheet.id, path);
  assert.equal(result.quotesDisabled, true, "so does the result");
  assert.equal(result.rowsInserted, 4, "no row is lost to the bad line");
  // The stray quote is kept as a literal character rather than swallowing everything after it.
  assert.deepEqual(gridValues(sheet.id), [
    ["Alice", "ok"],
    ["Bob", '"he said hi'],
    ["Cara", "fine"],
    ["Dan", "ok"],
  ]);
});

test("a stray quote inside a field is read as text, and real quoting is left intact", async () => {
  // `relax_quotes` handles the common cases WITHOUT turning quoting off: an inches mark reads as
  // text, while a properly quoted field that holds a comma still parses as one value. quotesDisabled
  // stays false, because nothing was given up.
  const path = fixture('name,detail\nBob,5\'10"\nCara,"Acme, Inc."\n');

  const sheet = createSheet("csv-stray-quote");
  const result = await importCsv(sheet.id, path);
  assert.equal(result.quotesDisabled, false, "quoting was never disabled");
  assert.deepEqual(gridValues(sheet.id), [
    ["Bob", '5\'10"'],
    ["Cara", "Acme, Inc."],  // the quoted comma stayed one field
  ]);
});

test("a character straddling the encoding sample does not condemn the whole file to cp1252", async () => {
  // The sample is cut at a fixed byte offset, so a multi-byte character crossing it fails the strict
  // decode exactly like a cp1252 byte would. The file is then read as cp1252 from its first row to
  // its last, and the corruption appears nowhere near the byte that caused it.
  const header = "Name\r\n";
  const filler = "padding-row\r\n";
  let body = "";
  while (Buffer.byteLength(header + body) + filler.length <= SAMPLE_BYTES) body += filler;
  // Top up with single bytes so the accent begins on exactly the last byte the sample reaches.
  body += "x".repeat(SAMPLE_BYTES - Buffer.byteLength(header + body));
  const buf = Buffer.from(`${header}${body}é\r\nAcmé\r\n`, "utf8");
  assert.equal(buf[SAMPLE_BYTES], 0xc3, "the fixture must actually straddle the boundary");

  // `end` is inclusive, so the sample is the first SAMPLE_BYTES + 1 bytes — ending on a lead byte
  // whose continuation it does not have.
  const sampled = buf.subarray(0, SAMPLE_BYTES + 1);
  assert.equal(detectEncoding(sampled), "latin1", "untrimmed, the sample lies");
  assert.equal(detectEncoding(trimToCharBoundary(sampled)), "utf8", "trimmed back to a whole character, it does not");

  const path = fixture(buf);
  assert.equal((await previewCsv(path)).encoding, "utf8");

  const sheet = createSheet("csv-straddle");
  const result = await importCsv(sheet.id, path);
  assert.equal(result.encoding, "utf8");
  const last = readWindow(sheet.id, result.rowsInserted - 1, 1).rows[0]!;
  assert.equal(Object.values(last.cells)[0]!.v, "Acmé", "the row past the boundary is intact");
});

test("a cp1252 file whose first accent is past the sample is re-read, not mojibaked", async () => {
  // The milder sibling of the straddle: nothing in the first 64KB says the file is not UTF-8, so it
  // is decoded as UTF-8 and every accented value becomes U+FFFD — permanently, because the
  // replacement character is what gets stored. The import has to notice mid-stream and start again.
  const parts: Buffer[] = [Buffer.from("Name\r\n", "ascii")];
  let size = parts[0]!.length;
  let n = 0;
  while (size < SAMPLE_BYTES + 512) {
    const line = Buffer.from(`plain-${n++}\r\n`, "ascii");
    parts.push(line);
    size += line.length;
  }
  parts.push(Buffer.from([0x41, 0x63, 0x6d, 0xe9, 0x0d, 0x0a])); // "Acmé" as cp1252 bytes
  const path = fixture(Buffer.concat(parts));

  assert.equal((await previewCsv(path)).encoding, "utf8", "the head genuinely looks like UTF-8");

  const sheet = createSheet("csv-late-accent");
  const result = await importCsv(sheet.id, path);
  assert.equal(result.encoding, "latin1", "the file is re-read as cp1252 once the bytes disagree");
  assert.equal(result.rowsInserted, n + 1);
  assert.equal(countRows(sheet.id), n + 1, "the abandoned first pass leaves nothing behind to double");

  const last = readWindow(sheet.id, n, 1).rows[0]!;
  assert.equal(Object.values(last.cells)[0]!.v, "Acmé");
});

test("an import that fails part way leaves nothing behind, and says how far it got", async () => {
  // It commits every 500 rows, so a failure at row 3,000 would leave 2,500 rows sitting in the sheet
  // with no report and no undo — and re-importing the corrected file appended a second copy of them.
  //
  // The failure is injected through the progress callback rather than a malformed line, deliberately:
  // the parser is now tolerant enough (stray quotes read as text, an unclosed quote read with quoting
  // off) that bad CONTENT no longer fails an import — which is the whole point of the quote handling.
  // The property under test is the OTHER half: whatever the reason a batch throws mid-stream, every
  // committed row is rolled back and the message says how far it got.
  let csv = "Company,Note\r\n";
  for (let i = 0; i < 600; i++) csv += `company-${i},${"filler ".repeat(16)}\r\n`;
  // Past the 64KB preview window, so the failure happens during the streamed import rather than the
  // sniff — the case that can leave rows behind.
  assert.ok(Buffer.byteLength(csv) > SAMPLE_BYTES);
  const path = fixture(csv);

  // Throws once the first batch has committed, so there ARE rows to roll back when it does.
  const failAfterFirstBatch = () => { throw new Error("boom"); };

  const sheet = createSheet("csv-midfile-failure");
  await assert.rejects(
    () => importCsv(sheet.id, path, { onProgress: failAfterFirstBatch }),
    (e: Error) => {
      assert.match(e.message, /CSV import failed after \d+ rows/, "the message says how far it got");
      assert.match(e.message, /were removed/, "and that nothing was kept");
      return true;
    },
  );

  assert.equal(countRows(sheet.id), 0, "no orphans");
  assert.deepEqual(gridValues(sheet.id), []);

  // The retry is the second half of the property: a rollback that only half worked shows up here.
  await assert.rejects(() => importCsv(sheet.id, path, { onProgress: failAfterFirstBatch }));
  assert.equal(countRows(sheet.id), 0, "and retrying cannot double them");
});

test("a cancelled import rolls back every row it had written", async () => {
  // Cancel is the Cancel button: the request is aborted, the engine sees it between batches and
  // stops. It must leave the table exactly as it was — the same all-or-nothing a failure gets — so
  // the cancelled rows cannot be re-imported into a doubled copy.
  let csv = "Company,Note\r\n";
  for (let i = 0; i < 6000; i++) csv += `company-${i},note\r\n`; // several batches at BATCH=2000
  const path = fixture(csv);

  const sheet = createSheet("csv-cancel");
  const controller = new AbortController();
  // Abort the moment the first batch lands, so there ARE committed rows to undo.
  await assert.rejects(
    () => importCsv(sheet.id, path, { signal: controller.signal, onProgress: () => controller.abort() }),
    (e: Error) => e instanceof ImportCancelled,
  );
  assert.equal(countRows(sheet.id), 0, "nothing kept");
  assert.deepEqual(gridValues(sheet.id), []);
});

test("every column of an imported row can still be written to", async () => {
  // The import only writes values for the columns the file fills, but a row still needs a cell for
  // every column: each writer in the app — a manual edit, a run, a script — is an UPDATE on
  // (row_id, column_id), so a missing cell is a cell that can never be given a value, silently.
  const sheet = createSheet("csv-existing-columns");
  const untouched = addColumn(sheet.id, { name: "Researched" });

  const path = fixture("Company\r\nAcme\r\n");
  await importCsv(sheet.id, path);

  const row = readWindow(sheet.id, 0, 10).rows[0]!;
  assert.ok(row.cells[untouched.id], "the column this file said nothing about still has a cell");

  setCellValue(Number(row.id), Number(untouched.id), "yes");
  assert.equal(getCell(Number(row.id), Number(untouched.id))?.valueText, "yes");
});

test("a second import of the same headers fills the columns already there", async () => {
  // Resolving by key rather than creating again is what keeps a weekly list from growing a new
  // "Company (2)" every time it arrives.
  const sheet = createSheet("csv-second-import");
  const first = await importCsv(sheet.id, fixture("Company,Country\r\nAcme,US\r\n"));
  assert.equal(first.columnsCreated, 2);

  const second = await importCsv(sheet.id, fixture("Company,Country\r\nBrik,NO\r\n"));
  assert.equal(second.columnsCreated, 0);
  assert.deepEqual(second.duplicateHeaders, []);
  assert.deepEqual(gridValues(sheet.id), [["Acme", "US"], ["Brik", "NO"]]);
});

test("a value the export protected comes back as what it was", () => {
  // Export writes `=1+1` as `'=1+1` so a spreadsheet cannot execute it on open. Import did not undo
  // that, so one round trip through this app's own export permanently added an apostrophe to every
  // formula-shaped value — Ferrum was not a faithful copy of itself.
  for (const v of ["=1+1", "+1", "-3", "@SUM(A1)", "=cmd|' /C calc'!A0"]) {
    assert.equal(unguardFormula(guardFormula(v)), v, v);
  }
});

test("a genuine leading apostrophe is not eaten", () => {
  // The narrow condition is the whole point. Stripping any leading apostrophe would damage real data
  // to undo damage the app did to its own — these are values a person typed and must survive.
  for (const v of ["'tis the season", "'Ndrangheta", "6' 2\"", "'", "'hello"]) {
    assert.equal(unguardFormula(v), v, v);
  }
  // And the guard is still doing its job on the way out.
  assert.equal(guardFormula("=1+1"), "'=1+1");
  assert.equal(guardFormula("plain"), "plain");
});

// ── an import cannot quietly overwrite what a run produced ──────────────────
//
// The cell lock guards PUT /api/cells/:id. The importer writes cells directly, so it was never
// covered: a CSV could overwrite a whole column of enrichment results with whatever was in the file,
// on every row, silently. The lock's exact failure, through the one door it did not cover, at the
// largest scale available.

test("a mapping onto a column a run fills is refused, and names it", async () => {
  const sheet = createSheet("ZZ csv lock");
  addColumn(sheet.id, { name: "Company", kind: "static" });
  const ai = addColumn(sheet.id, { name: "Industry", kind: "ai" });

  const path = fixture("Company,Industry\nAcme,Biotech\n");
  await assert.rejects(
    () => importCsv(sheet.id, path, {
      mappings: [{ target: "new", name: "Company" }, { target: String(ai.id) }],
    }),
    // Named, because "the import failed" sends someone hunting through a mapping screen.
    /"Industry"[\s\S]*filled in by a run/,
  );

  assert.equal(countRows(sheet.id), 0, "and not one row landed before it refused");
});

test("the same mapping goes through when it is asked for outright", async () => {
  // The sibling of the single-cell `override` flag: the same decision, taken once for a whole file.
  const sheet = createSheet("ZZ csv lock override");
  addColumn(sheet.id, { name: "Company", kind: "static" });
  const ai = addColumn(sheet.id, { name: "Industry", kind: "ai" });

  const path = fixture("Company,Industry\nAcme,Biotech\n");
  const res = await importCsv(sheet.id, path, {
    mappings: [{ target: "new", name: "Company" }, { target: String(ai.id) }],
    overwriteComputed: true,
  });
  assert.equal(res.rowsInserted, 1);
  const cols = listColumns(sheet.id);
  const industry = cols.find((c) => c.name === "Industry")!;
  assert.equal(String(industry.id), String(ai.id), "it went into the computed column, as asked");
});

test("a header that merely collides with a computed column gets a new column instead", async () => {
  // Not an instruction — a coincidence. A file headed "Industry" landing on a sheet whose AI column
  // happens to be called "Industry" must not be read as "overwrite that". The data lands, nothing
  // computed is touched, and the result says where it went.
  const sheet = createSheet("ZZ csv collide");
  addColumn(sheet.id, { name: "Company", kind: "static" });
  const ai = addColumn(sheet.id, { name: "Industry", kind: "ai" });

  const path = fixture("Company,Industry\nAcme,Biotech\n");
  const res = await importCsv(sheet.id, path, {});

  assert.equal(res.rowsInserted, 1);
  assert.deepEqual(res.dodgedComputed, ["Industry"], "and it says so, or the surprise is silent");

  const cols = listColumns(sheet.id);
  const made = cols.find((c) => c.name !== "Industry" && c.name.startsWith("Industry"));
  assert.ok(made, `expected a new column beside the computed one, got: ${cols.map((c) => c.name).join(", ")}`);

  // The computed column is untouched — the whole point.
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(sheet.id) as any).id);
  assert.equal(getCell(rowId, Number(ai.id))?.valueText ?? null, null);
  assert.equal(getCell(rowId, Number(made!.id))?.valueText, "Biotech");
});

test("a plain column with the same name is still filled, because nothing computes it", async () => {
  // The guard must not turn every re-import into a pile of duplicate columns.
  const sheet = createSheet("ZZ csv plain");
  const company = addColumn(sheet.id, { name: "Company", kind: "static" });

  await importCsv(sheet.id, fixture("Company\nAcme\n"), {});
  assert.equal(listColumns(sheet.id).filter((c) => c.name.startsWith("Company")).length, 1);
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT 1").get(sheet.id) as any).id);
  assert.equal(getCell(rowId, Number(company.id))?.valueText, "Acme");
});

// ─────────────────────────────────────────────────── exporting a filtered view

// The export filtered COLUMNS and never ROWS. A user narrowed the grid to the leads worth sending,
// pressed Export, and got a file with every row in the table — right headers, right column order,
// nothing whatsoever to say it was the wrong set. That file then goes to a sequencer.
//
// The property is not "the filter works"; it is that the export and the grid name the SAME rows.
// So each test below compares the export against `readWindow` reading through the same view, rather
// than against a hand-written expectation that could be wrong in the same direction as the code.

function scopedFixture(name: string) {
  const sheet = createSheet(name);
  const col = addColumn(sheet.id, { name: "Stage", kind: "static" });
  const colId = Number(col.id);
  // Through the store, not raw INSERTs: the read path serves the grid from a view index that only
  // refreshes when the store says the data moved, so rows written behind its back are invisible to
  // `readWindow` and the test compares the export against an empty grid.
  insertRows(
    sheet.id,
    ["keep", "drop", "keep", "drop", "keep"].map((v) => ({ values: { [String(colId)]: v } })),
    0,
    [colId],
  );
  return { sheetId: sheet.id, colId };
}

/** Every value the grid shows under this filter, in grid order. */
function visible(sheetId: string, colId: number, filter: FilterGroup): string[] {
  const win = readWindow(sheetId, 0, 1000, { filter });
  return win.rows.map((r: any) => {
    const cell = r.cells[String(colId)];
    return cell && cell.s === "done" ? (cell.v ?? "") : "";
  });
}

test("a filtered export writes the filtered rows, not the whole table", async () => {
  const { sheetId, colId } = scopedFixture("ZZ csv scope");
  const filter: FilterGroup = { conj: "and", children: [{ columnId: colId, op: "eq", value: "keep" }] };

  const text = await exported(sheetId, { scope: { filter } });
  const rows = parse(text, { bom: true }) as string[][];
  const body = rows.slice(1).map((r) => r[0] ?? "");

  const onScreen = visible(sheetId, colId, filter).filter((v) => v !== "");
  assert.ok(onScreen.length > 0 && onScreen.length < 5, `fixture is not actually narrowed: ${onScreen.length}`);
  assert.deepEqual(body, onScreen, "the export and the grid must name the same rows");
  assert.ok(!body.includes("drop"), "a filtered-out value reached the file");
});

test("an export with no scope is still the whole table", async () => {
  // The narrowing must not leak into the ordinary case: this path is the one every existing export
  // takes, and it keeps its keyset read.
  const { sheetId } = scopedFixture("ZZ csv scope none");
  const rows = parse(await exported(sheetId), { bom: true }) as string[][];
  assert.equal(rows.length - 1, 5);
});

test("a filter the engine cannot apply refuses the export instead of widening it", () => {
  // The whole point of the refusal. A dropped condition means a BIGGER export, and every row it
  // adds is a row the user filtered out on purpose.
  const { sheetId } = scopedFixture("ZZ csv scope bad");
  assert.throws(
    () => exportCsv(sheetId, { scope: { filter: { conj: "and", children: [{ columnId: 999999, op: "is", value: "x" }] } as any } }),
    /not started|could not/i,
  );
});

test("a big import drops the shared index only while the database is still small", () => {
  // The index is global to every sheet, so rebuilding it re-sorts the WHOLE cells table. That is a
  // fair trade for a fresh bulk load and a disaster for an 8MB append into a table with millions of
  // existing cells: the same multi-gigabyte re-sort, to save maintenance on a few new rows, freezing
  // the one engine thread for minutes. So the decision turns on BOTH the file size and how much is
  // already there.
  const MB = 1024 * 1024;
  const smallFile = 1 * MB;
  const bigFile = 8 * MB;         // the file-size threshold
  const smallDb = 10 * MB;        // a fresh/empty database
  const bigDb = 2 * 1024 * MB;    // 2GB — well past the rebuild ceiling

  // A small file never drops the index — it would pay the rebuild without earning it.
  assert.equal(shouldDropCellsIndex(smallFile, smallDb), false, "small file, small db");
  assert.equal(shouldDropCellsIndex(smallFile, bigDb), false, "small file, big db");

  // A big file drops it ONLY into a small database (fresh bulk load).
  assert.equal(shouldDropCellsIndex(bigFile, smallDb), true, "big file, small db → drop+rebuild");

  // The regression this guards: a big file appended to a big database KEEPS the index.
  assert.equal(shouldDropCellsIndex(bigFile, bigDb), false, "big file, big db → keep index");

  // Boundaries: exactly at the file threshold counts as big; exactly at the ceiling counts as large.
  assert.equal(shouldDropCellsIndex(8 * MB, 255 * MB), true, "at file threshold, under ceiling");
  assert.equal(shouldDropCellsIndex(8 * MB - 1, 10 * MB), false, "one byte under the file threshold");
  assert.equal(shouldDropCellsIndex(8 * MB, 256 * MB), false, "at the ceiling → keep index");
});

test("the preview built from the file's head matches the one built from the whole file", async () => {
  // The instant upload shows the mapping screen from the head bytes alone, before the full file has
  // finished staging. That preview MUST match what the old whole-file path produced, or the columns a
  // user maps against would not be the columns the import then reads.
  const lines = ["Name,Email,Company"];
  for (let i = 0; i < 5000; i++) lines.push(`Person ${i},p${i}@example.com,Company ${i}`);
  const path = fixture(lines.join("\n") + "\n");

  const fromFile = await previewCsv(path);
  const head = readFileSync(path).subarray(0, 128 * 1024); // what the browser posts to preview-head
  const fromHead = await previewFromHead(head);

  assert.deepEqual(fromHead.headers, fromFile.headers, "same headers");
  assert.equal(fromHead.delimiter, fromFile.delimiter, "same delimiter");
  assert.equal(fromHead.encoding, fromFile.encoding, "same encoding");
  assert.deepEqual(fromHead.sampleRows.slice(0, 5), fromFile.sampleRows.slice(0, 5), "same sample rows");
  // The head of a 5000-row file is truncated mid-record; the partial trailing line must be dropped,
  // never surfaced as a short row.
  const width = fromHead.headers.length;
  assert.ok(fromHead.sampleRows.every((r) => r.length === width), "no partial row from the cut");
});

test("a preview from a whole small file that fits within the head is identical either way", async () => {
  // When the file is smaller than the head, preview-head sees the entire file — trailing bytes and
  // all — so it must behave exactly like reading the file from disk, including a short final row.
  const path = fixture("A,B,C\r\n1,2,3\r\n4,5,6\r\n");
  const fromFile = await previewCsv(path);
  const fromHead = await previewFromHead(readFileSync(path));
  assert.deepEqual(fromHead, fromFile);
});

test("previewFromHead ignores bytes past the sample window, matching previewCsv's encoding decision", async () => {
  // The browser posts more than SAMPLE_BYTES of head. If previewFromHead scanned all of it, a latin1
  // byte sitting PAST the 64KB window would flip its encoding to latin1 while previewCsv (which reads
  // only the first SAMPLE_BYTES from the file) still reports utf8 — the two previews would disagree and
  // the user would map against a differently-decoded sample than the import produces. The cap keeps
  // them identical. Removing the `head.subarray(0, SAMPLE_BYTES + 1)` cap fails this test.
  let body = "Name,Note\n";
  while (Buffer.byteLength(body) < 70 * 1024) body += "Alice,ok\n"; // clean ASCII well past 64KB
  // A lone 0xE9 (é in cp1252) followed by a newline is invalid UTF-8 → would force latin1 if seen.
  const buf = Buffer.concat([Buffer.from(body, "utf8"), Buffer.from([0xe9]), Buffer.from("\nBob,ok\n")]);
  const path = fixture(buf);

  const fromFile = await previewCsv(path);      // reads only the first SAMPLE_BYTES of the file
  const fromHead = await previewFromHead(buf);  // whole buffer, but capped internally to SAMPLE_BYTES

  assert.equal(fromFile.encoding, "utf8", "the first 64KB are clean ASCII, so the file preview is utf8");
  assert.equal(fromHead.encoding, fromFile.encoding, "the head preview must agree despite the late latin1 byte");
  assert.deepEqual(fromHead.headers, fromFile.headers);
});
