// CSV import and export.
//
// Both directions are STREAMED and bounded: a 100MB lead export must never be buffered whole on the
// way in, and a million-row sheet must never be assembled into one string on the way out. Inserts
// run 500-at-a-time inside a transaction; the export hands back a stream for the route to pipe.
//
// Three guards here exist because all three failures are silent and only noticed much later:
//   - Excel on Windows writes cp1252, not UTF-8. Decoding it as UTF-8 mangles every accented company
//     name into mojibake that then flows into prompts and outreach copy.
//   - A cell beginning = + - @ is executed as a formula when the exported file is opened in Excel.
//   - An import that fails half way must not leave everything it already committed behind, or the
//     retry appends a second copy of it.

import { createReadStream, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify";
import { markSheetDirty } from "./columnStats.ts";
import { resolveScope, type ResolvedScope, type RunScope } from "./scope.ts";
import { db, tx } from "./db.ts";
import { autoDedupe } from "./dedupe.ts";
import {
  addColumn,
  bumpDataVersion,
  insertRows,
  invalidateRowCount,
  listColumns,
  nextRowPosition,
  normalizeKey,
} from "./store.ts";
import type { Column } from "./types.ts";

// Rows per transaction. Bigger commits fewer times — worth ~10% on a large import, and the insert
// rate past that is bound by SQLite writing every cell and its index, not by how the rows are grouped.
const BATCH = 2000;

/**
 * File size at which the import drops the cells table's one secondary index for the duration.
 *
 * `ix_cells_col_status` is maintained on EVERY cell written, and on a wide file its writes scatter
 * across one B-tree section per column — which is what turns a large import into a crawl. Measured on
 * a 100-column file: 997 rows/sec with the index against 8,100 without it. Rebuilding it afterwards is
 * a single sorted pass, far cheaper than a cell-at-a-time maintenance. Only above this size, because
 * the rebuild scans the whole cells table and a small import must not be made to pay for that.
 */
const BIG_IMPORT_BYTES = 8 * 1024 * 1024;

/**
 * Database size above which the import KEEPS the index instead of dropping and rebuilding it.
 *
 * `ix_cells_col_status` is GLOBAL — every sheet's cells share it — so rebuilding it reads and
 * re-sorts the ENTIRE cells table, not just the rows this import added. That is the right trade for a
 * fresh bulk load, where the import is most of the data. But appending an 8 MB file to a database that
 * already holds millions of cells would pay a full multi-gigabyte re-sort to save index maintenance on
 * a few hundred thousand new rows — minutes of synchronous work that freezes the whole engine (node's
 * SQLite runs on the one thread), during which the import cannot even stream its own progress, so the
 * row counter sits frozen and the app looks hung. Above this size the index stays put and the import
 * pays only the far cheaper incremental maintenance on its own rows. Sized so that a full rebuild below
 * the ceiling stays a few seconds at most; ~256 MB is low millions of cells.
 */
const INDEX_REBUILD_CEILING_BYTES = 256 * 1024 * 1024;

/**
 * Whether an import should drop the shared cells index and rebuild it once at the end.
 *
 * True only when the file is large enough to earn the rebuild AND the database is still small enough
 * that rebuilding the whole-table index is quick — i.e. a fresh bulk load. On a database already past
 * the ceiling (an append into a table with millions of existing cells) it is false, so the index
 * stays put and the import never pays the multi-gigabyte re-sort that would freeze the engine.
 */
export function shouldDropCellsIndex(fileBytes: number, dbBytes: number): boolean {
  return fileBytes >= BIG_IMPORT_BYTES && dbBytes < INDEX_REBUILD_CEILING_BYTES;
}

/** Bytes of the head read to sniff encoding, delimiter and types. */
const SAMPLE_BYTES = 64 * 1024;

/**
 * A csv-parse failure caused by quoting rather than by the data.
 *
 * `relax_quotes` (set on every parse below) already lets a stray quote — an inches mark, an
 * unescaped `"` in a note — be read as a plain character. What it CANNOT rescue is a quote that
 * opens a field and is never closed: the parser then swallows the rest of the file into one field
 * and ends with `CSV_QUOTE_NOT_CLOSED`. That is the signal to re-read the file with quoting turned
 * off entirely, so the rows land as plain text instead of the whole import failing on one bad line.
 */
function isQuoteError(e: unknown): boolean {
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  return code === "CSV_QUOTE_NOT_CLOSED" || code === "INVALID_OPENING_QUOTE" || code === "INVALID_CLOSING_QUOTE";
}

// ─────────────────────────────────────────────────────────────── encoding + delimiter

/**
 * Decide how to decode the file. UTF-8 is assumed unless the bytes say otherwise.
 *
 * A valid UTF-8 stream has strict continuation rules; cp1252 text containing accented characters
 * almost always violates them. So: if strict UTF-8 decoding fails, fall back to cp1252 (win1252),
 * which is what Excel produced.
 */
export function detectEncoding(sample: Buffer): "utf8" | "latin1" {
  // UTF-8 BOM is definitive.
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return "utf8";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return "utf8";
  } catch {
    return "latin1"; // Node's latin1 covers the cp1252 byte range for our purposes
  }
}

/**
 * Cut a fixed-size byte sample back to the last COMPLETE UTF-8 sequence.
 *
 * A sample sliced at byte 65,536 ends mid-character on any file with multi-byte text in it, and an
 * incomplete sequence fails the strict decode exactly like a stray cp1252 byte does. That is how a
 * perfectly valid UTF-8 file with an accent crossing the sample boundary was declared cp1252 and
 * then mojibaked from its first row to its last — the damage lands nowhere near the byte that caused
 * it, which is what makes it so hard to recognise.
 *
 * Only the sniffing sample is trimmed. The file itself is still decoded whole.
 */
export function trimToCharBoundary(sample: Buffer): Buffer {
  let i = sample.length - 1;
  // Continuation bytes are 10xxxxxx, and a sequence is at most four bytes — so at most three of them
  // can belong to one lead byte.
  let trailing = 0;
  while (i >= 0 && trailing < 3 && (sample[i]! & 0xc0) === 0x80) { i--; trailing++; }
  if (i < 0) return sample; // nothing but continuations: not UTF-8 at all, let the detector say so

  const lead = sample[i]!;
  const need =
    lead < 0x80 ? 1
    : (lead & 0xe0) === 0xc0 ? 2
    : (lead & 0xf0) === 0xe0 ? 3
    : (lead & 0xf8) === 0xf0 ? 4
    : 1; // not a lead byte either — same thing, leave it in so the decode fails on it
  return sample.length - i < need ? sample.subarray(0, i) : sample;
}

/** The head said UTF-8 and the rest of the file disagreed. Internal control flow, never surfaced. */
class NotUtf8 extends Error {
  constructor() {
    super("The file stops being valid UTF-8 part way through.");
    this.name = "NotUtf8";
  }
}

/** Thrown when `opts.signal` aborts an import. Distinct so the catch can roll back WITHOUT dressing a
 *  deliberate cancel up as a failure. */
export class ImportCancelled extends Error {
  constructor() {
    super("Import cancelled.");
    this.name = "ImportCancelled";
  }
}

/**
 * Byte-for-byte pass-through that fails the moment the stream stops being valid UTF-8.
 *
 * The encoding is decided from the first 64KB and applied to the whole file, so a cp1252 export
 * whose first accented byte lands after that window decoded as UTF-8 and turned every such value
 * into U+FFFD — permanently, because the replacement character is what got stored. Failing here lets
 * the import throw the file away and read it again as cp1252 instead.
 *
 * The decoder is stateful (`{ stream: true }`), so a character split across two chunks is not
 * mistaken for a broken one. Bytes are forwarded untouched; the parser does the real decoding.
 */
function utf8Guard(): Transform {
  const probe = new TextDecoder("utf-8", { fatal: true });
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        probe.decode(chunk, { stream: true });
        cb(null, chunk);
      } catch {
        cb(new NotUtf8());
      }
    },
    flush(cb) {
      // A file ending mid-character is truncated, not cp1252 — but it is not UTF-8 either, and
      // latin1 is the reading that keeps every byte.
      try { probe.decode(); cb(); } catch { cb(new NotUtf8()); }
    },
  });
}

/** Pick the delimiter by counting candidates in the header line. */
export function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const n = headerLine.split(d).length - 1;
    if (n > bestCount) { bestCount = n; best = d; }
  }
  return best;
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ─────────────────────────────────────────────────────────────── type inference

export type InferredType = "text" | "number" | "url" | "email" | "boolean";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BOOL_RE = /^(true|false|yes|no|y|n)$/i;

/** Infer a column type from sampled values. Needs a clear majority — mixed data stays text. */
export function inferType(values: string[]): InferredType {
  const vals = values.filter((v) => v != null && v.trim() !== "");
  if (vals.length === 0) return "text";
  const frac = (pred: (v: string) => boolean) => vals.filter(pred).length / vals.length;

  if (frac((v) => EMAIL_RE.test(v.trim())) > 0.8) return "email";
  if (frac((v) => { try { const u = new URL(v.trim()); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } }) > 0.8) return "url";
  if (frac((v) => BOOL_RE.test(v.trim())) > 0.8) return "boolean";
  if (frac((v) => v.trim() !== "" && Number.isFinite(Number(v.replace(/[,\s]/g, "")))) > 0.8) return "number";
  return "text";
}

// ─────────────────────────────────────────────────────────────── preview

export interface CsvPreview {
  headers: string[];
  sampleRows: string[][];
  inferredTypes: InferredType[];
  delimiter: string;
  encoding: "utf8" | "latin1";
  /** Rows whose field count differs from the header. Surfaced, never silently dropped. */
  raggedCount: number;
  /** The file had a quote that never closed, so it was read with quoting off — quotes are literal. */
  quotesDisabled: boolean;
}

export async function previewCsv(path: string, sampleSize = 50): Promise<CsvPreview> {
  const { createReadStream: crs } = await import("node:fs");
  const head: Buffer = await new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const s = crs(path, { end: SAMPLE_BYTES });
    // No encoding is set on this stream, so chunks are Buffers — but the type allows string.
    s.on("data", (c: string | Buffer) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      chunks.push(b);
      n += b.length;
    });
    s.on("end", () => res(Buffer.concat(chunks, n)));
    s.on("error", rej);
  });

  // A short file was not cut by us, so its trailing bytes are the file's own business: an incomplete
  // sequence there is real damage and the detector should see it.
  const truncated = head.length >= SAMPLE_BYTES;
  const sample = truncated ? trimToCharBoundary(head) : head;

  const encoding = detectEncoding(sample);
  const raw = stripBom(sample.toString(encoding));
  // The 64KB head almost always ends mid-record. Feeding that to the parser fails with
  // "Quote Not Closed" on any file whose truncation point lands inside a quoted field, so drop the
  // trailing partial line. (Only matters when we actually truncated — a short file has no tail.)
  const lastNewline = raw.lastIndexOf("\n");
  const text = truncated && lastNewline > 0 ? raw.slice(0, lastNewline + 1) : raw;

  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);

  // `relax_quotes` reads a stray quote as text; `quote: false` (only on the retry) turns quoting off
  // entirely for a file whose quote never closes, so the head always yields SOME rows to show and a
  // mapping can still be picked. The preview is a sample either way — the import re-decides on the
  // whole file, so a truncated head that merely looks unclosed does not commit the import to anything.
  const parseHead = (quotesOff: boolean) =>
    new Promise<{ records: string[][]; ragged: number }>((res, rej) => {
      const records: string[][] = [];
      let ragged = 0;
      const parser = parse({
        delimiter, relax_column_count: true, skip_empty_lines: true, bom: true,
        relax_quotes: true, ...(quotesOff ? { quote: false } : {}),
      });
      parser.on("readable", () => {
        let rec: string[] | null;
        while ((rec = parser.read() as string[] | null) !== null) {
          if (records.length > 0 && rec.length !== records[0]!.length) ragged++;
          if (records.length <= sampleSize) records.push(rec);
        }
      });
      parser.on("error", rej);
      parser.on("end", () => res({ records, ragged }));
      parser.write(text);
      parser.end();
    });

  let quotesDisabled = false;
  let parsed: { records: string[][]; ragged: number };
  try {
    parsed = await parseHead(false);
  } catch (e) {
    if (!isQuoteError(e)) throw e;
    quotesDisabled = true;
    parsed = await parseHead(true);
  }
  const records = parsed.records;
  const ragged = parsed.ragged;

  const headers = (records.shift() ?? []).map((h, i) => stripBom(h).trim() || `Column ${i + 1}`);
  const inferredTypes = headers.map((_, i) => inferType(records.map((r) => r[i] ?? "")));

  return { headers, sampleRows: records, inferredTypes, delimiter, encoding, raggedCount: ragged, quotesDisabled };
}

// ─────────────────────────────────────────────────────────────── import

export interface ImportMapping {
  /** Per CSV column: create a new sheet column, map to an existing one, or skip it. */
  target: "new" | "skip" | string; // string = existing column id
  name?: string;
  valueType?: InferredType;
}

export interface ImportOptions {
  delimiter?: string;
  encoding?: "utf8" | "latin1";
  hasHeader?: boolean;
  mappings?: ImportMapping[];
  /** Index of the CSV column used to dedupe. Values are normalized before comparison. */
  dedupeOnIndex?: number;
  /**
   * Allow this file to write into columns a run fills.
   *
   * Off by default and named the long way on purpose. Its sibling is the  flag on a
   * single cell edit; this is the same decision taken once for a whole file, which is why it has to
   * be asked for rather than assumed.
   */
  overwriteComputed?: boolean;
  onProgress?: (rowsInserted: number) => void;
  /**
   * Cancels the import between batches. On abort the run stops and rolls back everything it wrote —
   * the same all-or-nothing guarantee a mid-file failure gets — so a cancelled import leaves the
   * table exactly as it was and cannot be re-imported into a doubled copy.
   */
  signal?: AbortSignal;
}

export interface ImportResult {
  rowsInserted: number;
  duplicatesSkipped: number;
  /** Rows the table's own dedupe rule removed after the import, when it is set to run itself. */
  dedupedAfter: number;
  /** Rows whose field count differed from the header: padded or truncated, never discarded. */
  raggedFixed: number;
  /** Headers the file repeated. Each repeat got its own suffixed column rather than overwriting. */
  duplicateHeaders: string[];
  /**
   * Computed columns a header collided with, where a new column was made instead of overwriting.
   *
   * Reported because it is a surprise otherwise: the file said "Industry" and the data went into
   * "Industry (2)". Silence would read as the import having filled the column you were looking at.
   */
  dodgedComputed: string[];
  columnsCreated: number;
  /** What the file was finally decoded as, including a mid-stream correction to cp1252. */
  encoding: "utf8" | "latin1";
  /**
   * The file had a quote that opened and never closed, so it was re-read with quoting turned off and
   * every quote kept as a literal character. Reported because it changes what a quoted field means:
   * `"a, b"` lands as two columns, not one, and the user should know why before they trust the rows.
   */
  quotesDisabled: boolean;
  ms: number;
}

/**
 * Undo everything a failed import wrote.
 *
 * The import commits every 500 rows, so a file that failed at row 3,000 left 2,500 rows behind with
 * no report and no undo entry — and re-importing the corrected file appended a second copy of them.
 * The rows this import wrote are exactly the ones in the position range it claimed, which is why the
 * starting position is taken before a single row is read.
 *
 * Columns created before the parse began are deliberately left alone: they are empty, and a retry
 * resolves to them by key, so keeping them cannot double anything.
 */
function rollbackImport(sheetId: string, fromPosition: number, toPosition: number): void {
  if (toPosition <= fromPosition) return;
  tx(() => {
    db.prepare(
      `DELETE FROM cells WHERE row_id IN
         (SELECT id FROM rows WHERE sheet_id = ? AND position >= ? AND position < ?)`,
    ).run(sheetId, fromPosition, toPosition);
    db.prepare("DELETE FROM rows WHERE sheet_id = ? AND position >= ? AND position < ?")
      .run(sheetId, fromPosition, toPosition);
  });
  // The same bookkeeping any row delete does: the cached count, the grid's view indexes and the
  // column stats all describe a sheet that no longer exists.
  invalidateRowCount(sheetId);
  bumpDataVersion(sheetId);
  markSheetDirty(sheetId);
}

export async function importCsv(sheetId: string, path: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const started = Date.now();
  const preview = await previewCsv(path, 20);
  const delimiter = opts.delimiter ?? preview.delimiter;
  const hasHeader = opts.hasHeader ?? true;

  const headers = hasHeader ? preview.headers : preview.headers.map((_, i) => `Column ${i + 1}`);
  const mappings: ImportMapping[] =
    opts.mappings ??
    headers.map((h, i) => ({ target: "new", name: h, valueType: preview.inferredTypes[i] ?? "text" }));

  // Resolve each CSV column index to a sheet column id (or null when skipped).
  //
  // `claimed` is the ids THIS file has already taken. Two columns headed "Email" both resolved to
  // the same sheet column and the second one overwrote the first, row by row, with nothing in the
  // result to say a whole column of data had been dropped. A claimed id falls through to addColumn
  // instead, which already suffixes the name to "Email (2)".
  const all = listColumns(sheetId);
  const existing = new Map(all.map((c) => [c.key, c.id]));
  /**
   * The columns an import must not silently fill: the ones a run fills.
   *
   * The lock on `PUT /api/cells/:id` never covered this path — the importer writes cells directly —
   * so a CSV could overwrite a column of enrichment results with whatever was in the file, on every
   * row, with nothing on screen saying so. That is the exact failure the lock exists to prevent,
   * through the one door it did not cover, and at the largest possible scale.
   *
   * Two ways in, and they get different answers, because the user meant different things:
   *
   *   AN EXPLICIT MAPPING — "put this file's column into that one" — is a deliberate instruction
   *   about a specific column, so it is REFUSED and named, the way a typed edit is, and can be
   *   repeated with `overwriteComputed`. Silently obeying it would be the lock's whole point undone.
   *
   *   A NAME COLLISION is not an instruction at all. A file with a column headed "Industry" landing
   *   on a sheet whose AI column happens to be called "Industry" is a coincidence, and the safe
   *   reading is the one already used for a name claimed twice in one file: make a new column. The
   *   data lands, nothing computed is touched, and the result names what happened.
   */
  const locked = new Map(all.filter((c) => c.editable === false).map((c) => [String(c.id), c]));
  const refused = mappings
    .filter((m) => m.target !== "new" && m.target !== "skip" && locked.has(String(m.target)))
    .map((m) => locked.get(String(m.target))!.name);
  if (refused.length > 0 && !opts.overwriteComputed) {
    const names = [...new Set(refused)].map((n) => `"${n}"`).join(", ");
    throw new Error(
      `${names} ${refused.length === 1 ? "is" : "are"} filled in by a run, not from a file. ` +
      `Map ${refused.length === 1 ? "that column" : "those columns"} somewhere else, or import again ` +
      `with "replace computed columns" if you really mean to write over what the column produced.`,
    );
  }

  const claimed = new Set<string>();
  const duplicateHeaders: string[] = [];
  /** Computed columns a header collided with, so the result can say a new column was made instead. */
  const dodgedComputed: string[] = [];
  const targetIds: Array<string | null> = [];
  let columnsCreated = 0;
  for (let i = 0; i < headers.length; i++) {
    const m = mappings[i] ?? { target: "new" as const };
    if (m.target === "skip") { targetIds.push(null); continue; }
    if (m.target !== "new") { targetIds.push(m.target); claimed.add(m.target); continue; }
    const name = m.name ?? headers[i] ?? `Column ${i + 1}`;
    const hit = existing.get(normalizeKey(name));
    // A collision with a computed column falls through to addColumn, exactly as a name already
    // claimed by this file does — see the note above.
    if (hit && locked.has(String(hit))) { dodgedComputed.push(locked.get(String(hit))!.name); }
    else if (hit && !claimed.has(hit)) { targetIds.push(hit); claimed.add(hit); continue; }
    const col = addColumn(sheetId, { name, kind: "static", valueType: (m.valueType ?? "text") as any });
    // Report the RESULT, not the input. This said `Email, Email` — the repeated source name, twice —
    // which tells the reader something was duplicated and not where their data actually went. What
    // they need is the column to go and look at, so record `Email → Email (2)` using the name
    // addColumn settled on after de-clashing.
    if (hit) duplicateHeaders.push(col.name === name ? name : `${name} → ${col.name}`);
    existing.set(col.key, col.id);
    claimed.add(col.id);
    targetIds.push(col.id);
    columnsCreated++;
  }

  // Resolved once, outside the insert loop: insertRows needs column ids for every batch, and
  // re-querying them per batch is pure waste on a large import.
  //
  // Only the ids this file actually fills carry a value. De-duplicated because two CSV columns can
  // be mapped onto one sheet column, and (row_id, column_id) is the cells primary key.
  const mapped = new Set(targetIds.filter((id): id is string => id != null).map(Number));
  const mappedIds = [...mapped].sort((a, b) => a - b);
  const unmappedIds = listColumns(sheetId).map((c) => Number(c.id)).filter((id) => !mapped.has(id));

  // The columns this file does NOT fill still need their (empty) cells, one statement per column per
  // batch rather than one .run() per cell.
  //
  // They cannot simply be left out: every writer in the app — a manual edit, a run, a script, a send
  // — is an UPDATE on (row_id, column_id), so a row with no cell for a column can never be given
  // one, and a filter on that column would not see the row either. Writing them through the JS
  // bridge one at a time is what made importing into a 30-column sheet 3.2x slower than into a fresh
  // one; this is the same rows written inside SQLite.
  const fillEmpty = db.prepare(
    `INSERT OR IGNORE INTO cells (row_id, column_id, status)
     SELECT r.id, ?, 'empty' FROM rows r
      WHERE r.sheet_id = ? AND r.position >= ? AND r.position < ?`,
  );

  // Snapshotted rather than mutated in place, because a cp1252 restart has to rewind it too.
  const preexistingKeys = new Set<string>();
  if (opts.dedupeOnIndex != null) {
    const target = targetIds[opts.dedupeOnIndex];
    if (target) {
      for (const r of db.prepare("SELECT dedupe_key FROM rows WHERE sheet_id = ? AND dedupe_key IS NOT NULL").all(sheetId) as any[]) {
        preexistingKeys.add(r.dedupe_key);
      }
    }
  }

  const startPosition = nextRowPosition(sheetId);
  let position = startPosition;
  let inserted = 0;
  let duplicates = 0;
  let ragged = 0;
  let seenDedupe = new Set(preexistingKeys);
  let batch: Array<{ values: Record<string, string>; dedupeKey?: string }> = [];

  const flushBatch = () => {
    if (batch.length === 0) return;
    // Checked here because this is the one place the loop pauses on its own — once per batch. A
    // cancel throws, which lands in the same catch a parse failure does, so the partial import is
    // rolled back rather than left half-written.
    if (opts.signal?.aborted) throw new ImportCancelled();
    const from = position;
    const to = position + batch.length;
    // One transaction per batch. Without this, SQLite fsyncs per statement and a large import
    // crawls.
    tx(() => {
      insertRows(sheetId, batch, from, mappedIds);
      for (const colId of unmappedIds) fillEmpty.run(colId, sheetId, from, to);
    });
    position = to;
    inserted += batch.length;
    batch = [];
    opts.onProgress?.(inserted);
  };

  const runPass = (encoding: "utf8" | "latin1", strict: boolean, quotesOff: boolean) =>
    new Promise<void>((resolve, reject) => {
      const parser = parse({
        delimiter,
        bom: true,
        relax_column_count: true,
        skip_empty_lines: true,
        from_line: hasHeader ? 2 : 1,
        // A stray quote is read as text rather than aborting the file; a quote that never closes
        // cannot be, so the caller re-runs this pass with quoting off when that is the failure.
        relax_quotes: true,
        ...(quotesOff ? { quote: false } : {}),
      });

      const src = createReadStream(path);
      const guard = strict ? utf8Guard() : null;

      let settled = false;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        // Stop reading the file. Left alone, the source kept pumping into a parser that had already
        // failed, so a batch could still flush after the promise had settled and after the caller
        // had begun cleaning up.
        src.destroy();
        guard?.destroy();
        parser.destroy(e instanceof Error ? e : new Error(String(e)));
        reject(e);
      };

      parser.on("readable", () => {
        let rec: string[] | null;
        while ((rec = parser.read() as string[] | null) !== null) {
          // A short row keeps the fields it does have and a long one loses only its extras: the
          // value loop below reads by header index, so a missing field arrives as an empty cell and
          // a surplus one is never looked at. Dropping the whole record threw away every good field
          // beside the missing one — on a file where one line in ten has a trailing comma missing,
          // that is a tenth of the list gone with a number in the summary as its only trace.
          if (rec.length !== headers.length) ragged++;

          let dedupeKey: string | undefined;
          if (opts.dedupeOnIndex != null) {
            const raw = rec[opts.dedupeOnIndex] ?? "";
            dedupeKey = raw.trim().toLowerCase();
            if (dedupeKey && seenDedupe.has(dedupeKey)) { duplicates++; continue; }
            if (dedupeKey) seenDedupe.add(dedupeKey);
          }

          const values: Record<string, string> = {};
          for (let i = 0; i < targetIds.length; i++) {
            const colId = targetIds[i];
            if (!colId) continue;
            // Unguarded on the way in, so a file this app exported comes back as what it held.
            // See unguardFormula: it only ever removes an apostrophe the export itself would have
            // added, and leaves a genuine leading apostrophe alone.
            const v = rec[i];
            if (v != null && v !== "") values[colId] = unguardFormula(v);
          }
          batch.push({ values, dedupeKey });
          if (batch.length >= BATCH) {
            try { flushBatch(); } catch (e) { fail(e); return; }
          }
        }
      });
      parser.on("error", fail);
      parser.on("end", () => {
        if (settled) return;
        settled = true;
        try { flushBatch(); resolve(); } catch (e) { reject(e); }
      });

      if (guard) {
        // Strict pass: raw bytes through the guard, decoded as UTF-8 by the parser itself, which
        // assembles each field before decoding it and so cannot be split mid-character.
        guard.on("error", fail);
        src.on("error", fail);
        src.pipe(guard).pipe(parser);
      } else {
        // cp1252 cannot fail to decode, so there is nothing to guard against on this pass.
        src.on("error", fail);
        src.setEncoding(encoding).pipe(parser);
      }
    });

  // Undo everything this import wrote and rewind every counter, so a re-read starts from a clean
  // sheet and an honest zero. Used by both fallbacks below.
  const resetProgress = () => {
    rollbackImport(sheetId, startPosition, position);
    position = startPosition;
    inserted = 0;
    duplicates = 0;
    ragged = 0;
    batch = [];
    seenDedupe = new Set(preexistingKeys);
  };

  // An explicit choice is honoured as given — the guard exists to correct a GUESS, and second-
  // guessing the user would make the override useless on the one file they reached for it.
  let encoding = opts.encoding ?? preview.encoding;
  let quotesDisabled = false;

  // One import attempt, with the cp1252 fallback nested inside: the head can misjudge the encoding
  // and force a re-read as latin1, exactly as before.
  const attempt = async (quotesOff: boolean) => {
    try {
      await runPass(encoding, opts.encoding == null && encoding === "utf8", quotesOff);
    } catch (e) {
      if (!(e instanceof NotUtf8)) throw e;
      // The head lied. Throw away what the UTF-8 reading produced and read the file again as cp1252
      // rather than storing a sheet full of U+FFFD nobody can recover the original bytes from.
      // Progress is reported from zero again, which is the honest account of what is happening.
      resetProgress();
      encoding = "latin1";
      await runPass(encoding, false, quotesOff);
    }
  };

  // For a big file, take the cells secondary index out of the write path and rebuild it once at the
  // end — the single largest speedup on a wide import. Dropped only when the file is large enough to
  // earn back the rebuild; rebuilt in `finally`, so a cancel or a failure restores it too. A crash
  // between the two would leave it dropped, but the schema recreates it on boot, so the worst case is
  // self-healing rather than a permanently missing index.
  // Drop-and-rebuild only when BOTH the file is large enough to earn the rebuild AND the table is
  // still small enough that rebuilding the shared index is cheap. `page_count * page_size` is the
  // database's size on disk, read from its header in O(1) — no scan. On a database already past the
  // ceiling this stays false, so an append keeps the index and never triggers the whole-table re-sort
  // that would otherwise freeze the engine for minutes. See INDEX_REBUILD_CEILING_BYTES.
  const dbBytes = (() => {
    try {
      const pc = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
      const ps = db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined;
      return (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
    } catch {
      // Can't tell how big it is — assume large, so the safe (no-rebuild) path is taken.
      return Number.MAX_SAFE_INTEGER;
    }
  })();
  const fileBytes = (() => { try { return statSync(path).size; } catch { return 0; } })();
  const bigImport = shouldDropCellsIndex(fileBytes, dbBytes);
  if (bigImport) db.exec("DROP INDEX IF EXISTS ix_cells_col_status;");

  try {
    try {
      await attempt(false);
    } catch (e) {
      if (!isQuoteError(e)) throw e;
      // A quote opened and never closed. Rather than fail the whole file on one bad line, read it
      // again with quoting off so every row lands as plain text — recorded in the result, because a
      // field that used quotes is now taken literally and that is a thing the user should see.
      resetProgress();
      encoding = opts.encoding ?? preview.encoding;
      quotesDisabled = true;
      await attempt(true);
    }
  } catch (e) {
    rollbackImport(sheetId, startPosition, position);
    // A cancel is not a failure: the rows are rolled back the same way, but it is thrown back plainly
    // rather than wrapped in "import failed", so nothing downstream reports an error the user caused
    // on purpose.
    if (e instanceof ImportCancelled) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `CSV import failed after ${inserted} row${inserted === 1 ? "" : "s"} ` +
        `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped, ${ragged} with the wrong field count): ${msg} ` +
        `— those ${inserted} row${inserted === 1 ? "" : "s"} were removed, so nothing from this file was kept and ` +
        `re-importing the corrected file cannot double anything.`,
    );
  } finally {
    if (bigImport) db.exec("CREATE INDEX IF NOT EXISTS ix_cells_col_status ON cells(column_id, status);");
  }

  db.prepare("UPDATE sheets SET updated_at = datetime('now') WHERE id = ?").run(sheetId);

  // The import's own `dedupeOnIndex` only compares rows WITHIN the file. The table's rule compares
  // the new rows against everything already there — which is the case that matters when the same
  // list is imported twice a week.
  const dedupedAfter = autoDedupe(sheetId)?.duplicates ?? 0;

  return {
    rowsInserted: inserted,
    duplicatesSkipped: duplicates,
    dedupedAfter,
    raggedFixed: ragged,
    duplicateHeaders,
    dodgedComputed: [...new Set(dodgedComputed)],
    columnsCreated,
    encoding,
    quotesDisabled,
    ms: Date.now() - started,
  };
}

// ─────────────────────────────────────────────────────────────── export

/**
 * Neutralize spreadsheet formula injection.
 *
 * A value starting with = + - @ (or a leading tab/CR, which Excel strips before parsing) is executed
 * as a formula on open. `=cmd|'/c calc'!A0` in an imported lead list becomes code execution on
 * whoever opens the export. Prefixing with an apostrophe forces Excel to treat it as text.
 */
export function guardFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/**
 * The inverse of `guardFormula`, applied on the way in.
 *
 * Export writes `=1+1` as `'=1+1` so a spreadsheet cannot execute it. Import did not reverse that,
 * so Ferrum's own export was not a faithful copy of its own table: one round trip through
 * export-then-import permanently added an apostrophe to every formula-shaped value. (Measured: it
 * does not compound — the guarded value no longer starts with `=`, so a second trip leaves it alone
 * — but one silent alteration of the user's data is one too many.)
 *
 * The condition is deliberately narrow. It strips ONE apostrophe, and only when what follows is a
 * character the guard would itself have escaped. A value that genuinely begins with an apostrophe —
 * a transliterated name, a quoted fragment, a measurement in feet — is left exactly as written,
 * because guessing wrong there damages real data to undo damage the app did to its own.
 */
export function unguardFormula(v: string): string {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

export interface ExportOptions {
  columnIds?: string[];
  includeMeta?: boolean;
  /**
   * Narrow to the rows the grid is showing — a saved view, the filter bar, the search box.
   *
   * Absent means the whole table, which is what an export with no narrowing should be. It is the
   * PRESENT-but-ignored case that was the bug: the export filtered COLUMNS and never rows, so a
   * user who had filtered to 400 leads and pressed Export got a file with all 1,000,000 in it, with
   * the right headers and the right shape and nothing at all to say it was the wrong set. Silent,
   * and only noticed after the file has been sent somewhere.
   *
   * A `RunScope`, resolved through `resolveScope`, so the export narrows through the SAME predicate
   * as the grid and as a run. Anything else here would be a third copy that drifts.
   */
  scope?: RunScope;
}

/** Rows read per pass. Bounded so neither the heap nor the event loop ever holds the whole sheet. */
const EXPORT_PAGE = 1000;

// A type alias rather than an interface: only a type literal gets the implicit index signature that
// makes the row shape castable from what `all()` returns, and naming the shape is the whole point —
// an `as any[]` here is what let the column-id key mismatch through the typechecker.
type ExportCell = {
  row_id: number;
  column_id: number;
  status: string;
  value_text: string | null;
  cost_usd: number | null;
};

/**
 * Every row of the sheet, in position order, a page at a time.
 *
 * Keyset paging on (sheet_id, position), which is UNIQUE — an OFFSET would re-walk every row it has
 * already emitted, and the last page of a million-row sheet would walk all of them.
 */
function* allRowPages(sheetId: string): Generator<Array<{ id: number }>> {
  const pageStmt = db.prepare(
    "SELECT id, position FROM rows WHERE sheet_id = ? AND position > ? ORDER BY position LIMIT ?",
  );
  let after = -1;
  for (;;) {
    const page = pageStmt.all(sheetId, after, EXPORT_PAGE) as Array<{ id: number; position: number }>;
    if (page.length === 0) return;
    after = page[page.length - 1]!.position;
    yield page;
  }
}

/**
 * The scope's rows, in position order, a page at a time.
 *
 * `iterate`, not `all`: a filter matching 900,000 rows must not be materialised as one array before
 * the first byte of the download leaves — that is the same failure the streaming export was built to
 * avoid, reintroduced one layer up.
 *
 * No keyset here. The scope's SQL already carries its own ORDER BY, and it may carry a LIMIT/OFFSET;
 * re-paging over it would either fight that or silently drop the bound. One cursor, held open for
 * the length of the download, is the honest way to read it.
 */
function* scopedRowPages(resolved: ResolvedScope): Generator<Array<{ id: number }>> {
  const cursor = db.prepare(resolved.sql).iterate(...resolved.params) as Iterable<{ id: number }>;
  let page: Array<{ id: number }> = [];
  for (const r of cursor) {
    page.push({ id: Number(r.id) });
    if (page.length >= EXPORT_PAGE) { yield page; page = []; }
  }
  if (page.length > 0) yield page;
}

/**
 * The sheet, one record at a time.
 *
 * A generator rather than an array so the consumer's backpressure reaches all the way back to
 * SQLite: the next page is only read once the previous one has been written out.
 */
function* exportRecords(
  pages: Iterable<Array<{ id: number }>>,
  cols: Column[],
  includeMeta: boolean,
): Generator<string[]> {
  const header = cols.map((c) => c.name);
  if (includeMeta) for (const c of cols) header.push(`${c.name} status`, `${c.name} cost`);
  yield header;

  const rangeStmt = db.prepare(
    "SELECT row_id, column_id, status, value_text, cost_usd FROM cells WHERE row_id BETWEEN ? AND ?",
  );

  for (const page of pages) {
    if (page.length === 0) continue;

    // One range scan of the clustered primary key for the whole page, not one query per row: the
    // per-row version froze the engine for twelve seconds on a million rows.
    //
    // Rows come out in position order and ids are handed out in insert order, so the range is dense
    // in practice — but a sheet that has had rows deleted can spread a page across the whole id
    // space, and BETWEEN over that would read millions of cells to serve 1,000 rows. Same density
    // guard the grid's read path uses, for the same reason: picking wrong here is silent.
    let minId = page[0]!.id;
    let maxId = page[0]!.id;
    for (const r of page) {
      if (r.id < minId) minId = r.id;
      if (r.id > maxId) maxId = r.id;
    }
    const dense = maxId - minId + 1 <= page.length * 2;
    const cells = dense
      ? (rangeStmt.all(minId, maxId) as ExportCell[])
      : (db
          .prepare(
            `SELECT row_id, column_id, status, value_text, cost_usd
               FROM cells WHERE row_id IN (${page.map(() => "?").join(",")})`,
          )
          .all(...page.map((r) => r.id)) as ExportCell[]);

    const byRow = new Map<number, Map<string, ExportCell>>();
    for (const r of page) byRow.set(r.id, new Map());
    for (const c of cells) {
      const bucket = byRow.get(c.row_id);
      if (!bucket) continue; // inside the id range, outside this page
      // Keyed by STRING. `Column.id` is a string and `cells.column_id` is an integer, and a Map
      // compares with SameValueZero — so 87 and "87" are two different keys. Storing the raw number
      // here meant every lookup below missed and every export was a correct header over blank data,
      // in a file that looked entirely normal.
      bucket.set(String(c.column_id), c);
    }

    for (const r of page) {
      const bucket = byRow.get(r.id)!;
      const line: string[] = [];
      for (const c of cols) {
        const cell = bucket.get(c.id);
        // not_found and error export as EMPTY, never the literal words — writing "error" into a data
        // column silently poisons whatever consumes the file next.
        line.push(guardFormula(cell && cell.status === "done" ? (cell.value_text ?? "") : ""));
      }
      if (includeMeta) {
        for (const c of cols) {
          const cell = bucket.get(c.id);
          line.push(cell?.status ?? "empty", cell?.cost_usd != null ? String(cell.cost_usd) : "");
        }
      }
      yield line;
    }
  }
}

/**
 * Export a sheet as CSV.
 *
 * Returns a STREAM, for the caller to PIPE at the response — `exportCsv(id, opts).pipe(res)`, never
 * `res.send(...)`, which would serialize the stream object itself. Building the file first held
 * about a gigabyte and blocked the engine for twelve seconds at a million rows before a single byte
 * reached the browser, and the string it built would eventually have hit V8's own length limit.
 */
export function exportCsv(sheetId: string, opts: ExportOptions = {}): Readable {
  const cols = listColumns(sheetId).filter((c) => !opts.columnIds || opts.columnIds.includes(c.id));

  // Resolved EAGERLY, before a single header goes out.
  //
  // `resolveScope` refuses a filter it cannot fully apply, and the whole value of that refusal is
  // that the caller can turn it into a 400 with the reason in it. Resolving inside the generator
  // instead would defer the throw until the stream was already piped at a 200 response, and the user
  // would get a truncated download rather than a message.
  const pages =
    opts.scope
      ? scopedRowPages(resolveScope(sheetId, opts.scope))
      : allRowPages(sheetId);

  // UTF-8 BOM + CRLF: without the BOM, Excel on Windows renders every non-ASCII character wrong.
  const out = stringify({ bom: true, record_delimiter: "\r\n" });
  const rows = Readable.from(exportRecords(pages, cols, !!opts.includeMeta));
  // A read failure part way has to abort the download. Piped alone it would end the response
  // cleanly, handing over a truncated file that looks complete.
  rows.on("error", (e) => out.destroy(e));
  rows.pipe(out);
  return out;
}
