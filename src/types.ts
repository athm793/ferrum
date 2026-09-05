// Shared domain types, readable by both the engine and the web client.
//
// The one import is a TYPE from `errorClass.ts`, which itself imports nothing — so this file still
// pulls no runtime code into a browser bundle, which is the property the old "kept free of imports"
// note was actually protecting. Any further import here has to hold that same line.

// ─────────────────────────────────────────────────────────────── cells

export type CellStatus =
  | "empty"      // never run
  | "queued"     // job exists, waiting for a worker
  | "running"    // in flight
  | "done"       // has a value
  | "not_found"  // ran successfully; the answer genuinely does not exist. NOT an error.
  | "error"      // the run failed
  | "skipped"    // condition returned false, or an upstream was empty
  | "blocked"    // an upstream cell errored
  | "cancelled";

/** Terminal states — a downstream job may be evaluated once its upstreams are all in one of these. */
export const TERMINAL: ReadonlySet<CellStatus> = new Set<CellStatus>([
  "done", "not_found", "error", "skipped", "blocked", "cancelled",
]);

/** States that carry a usable value for interpolation into a downstream prompt/script. */
export const HAS_VALUE: ReadonlySet<CellStatus> = new Set<CellStatus>(["done"]);

// ─────────────────────────────────────────────────────────────── columns

/**
 * How a column's value is produced. This is the lane selector, and it is the single most important
 * cost decision in the app — see the lane table in the plan.
 *   static  — typed in or imported. No execution.
 *   script  — AI wrote the code ONCE; the code runs deterministically per row. Effectively free.
 *   http    — a REST call per row. Costs the third party, not us.
 *   mcp     — an MCP provider lookup per row. Costs provider credits.
 *   ai      — a model call per row (cloud or local).
 *   agent   — a full Claude Code agent run per row. Tools, browsing, MCP. The expensive lane.
 */
/**
 *   send    — writes this table's rows into ANOTHER table. Free, deterministic, one pass.
 *
 *   waterfall — try one lane, and if the answer is not good enough try the next. Its steps are
 *               ordinary lanes, never vendors: see waterfall.ts for why that distinction is the whole
 *               design, and why "email waterfall", "phone waterfall" and "LLM waterfall" are one
 *               feature rather than three.
 */
export const COLUMN_KINDS = ["static", "script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup", "waterfall", "wait"] as const;

export type ColumnKind = (typeof COLUMN_KINDS)[number];

export function isColumnKind(v: unknown): v is ColumnKind {
  return typeof v === "string" && (COLUMN_KINDS as readonly string[]).includes(v);
}

/**
 * What a table's rows ARE — people, companies, or neither.
 *
 * Declared here as an array for the same reason `VALUE_TYPES` below is: the runtime check and the
 * type derive from one list, so a request arriving over HTTP is validated against exactly the thing
 * the compiler enforces. This list previously existed twice — once in the schema comment and once as
 * a private `KINDS` set inside the workbook importer — and two hand-maintained copies of three
 * strings is the drift that comment argues against.
 *
 * `generic` is the default and means "neither", not "unknown". A table is generic until somebody
 * says otherwise, and every table that existed before this shipped is generic.
 */
export const SHEET_KINDS = ["generic", "people", "companies"] as const;

export type SheetKind = (typeof SHEET_KINDS)[number];

export function isSheetKind(v: unknown): v is SheetKind {
  return typeof v === "string" && (SHEET_KINDS as readonly string[]).includes(v);
}

/**
 * A column's data type. Drives the output schema handed to a model, the coercion applied to a
 * result, the cell renderer, the sort comparator, and which filter operators are offered.
 *
 * `date` stores ISO-8601 so it sorts and range-filters lexically without parsing.
 * `currency` and `percent` are numbers carrying a format descriptor, not separate storage.
 * `relation` holds no value of its own — it reads through a relation to another table.
 */
// Declared as an ARRAY with the type derived from it, rather than as a bare union. A union exists
// only at compile time, so anything arriving over HTTP has nothing to be checked against — the
// server would have had to repeat the list by hand to validate a request, and a hand-repeated list
// drifts. This way the runtime check and the type cannot disagree.
export const VALUE_TYPES = [
  "text", "number", "boolean", "url", "email", "enum", "json",
  "date", "datetime", "currency", "percent", "phone",
  "multi_select", "array", "file", "relation",
] as const;

export type ValueType = (typeof VALUE_TYPES)[number];

export function isValueType(v: unknown): v is ValueType {
  return typeof v === "string" && (VALUE_TYPES as readonly string[]).includes(v);
}

/** Types that sort and compare numerically rather than as text. */
export const NUMERIC_TYPES: ReadonlySet<ValueType> = new Set<ValueType>(["number", "currency", "percent"]);

/** Types whose values are ISO strings — lexical comparison is chronological. */
export const DATE_TYPES: ReadonlySet<ValueType> = new Set<ValueType>(["date", "datetime"]);

/** Where generated code plugs into the engine. Every Clay feature is one of these hooks. */
export type HookName = "condition" | "transform" | "accept" | "map" | "key" | "score" | "filter";

/** Runtime for generated code. `js` is the default and the only one fast enough for 7-figure rows. */
export type ScriptRuntime = "js" | "powershell" | "bash";

export interface GeneratedScript {
  id: string;
  columnId: string;
  hook: HookName;
  runtime: ScriptRuntime;
  /** The plain-English request the user typed. */
  intent: string;
  /** The code itself. Reviewed and approved by a human before it can ever run. */
  code: string;
  /** sha256 of `code`. An approved script is pinned by hash so it cannot silently change. */
  hash: string;
  version: number;
  approvedAt: string | null;
  /** Column ids this script reads via {{refs}} — feeds the dependency graph. */
  refs: string[];
  /** Why the model chose this runtime. Shown in the review UI. */
  rationale: string | null;
  createdAt: string;
}

export interface Column {
  id: string;
  sheetId: string;
  name: string;
  /** Normalized name; what {{references}} bind to. Unique per sheet. */
  key: string;
  position: number;
  kind: ColumnKind;
  valueType: ValueType;
  enumValues?: string[];
  jsonSchema?: object;
  /**
   * How a `currency` or `percent` value is DISPLAYED — the symbol and decimals. Never affects what is
   * stored (a plain number), only the pixels. Shaped by ValueFormat in valueFormat.ts.
   */
  format?: { currency?: string; decimals?: number };
  /**
   * What this column is for, in the author's words.
   *
   * The column has always had somewhere to put this and nowhere to say it. On a sheet with thirty
   * columns named things like "Score" and "Tier", the difference between a table someone else can
   * use and one only its author understands is one sentence per column.
   */
  description?: string;

  /** For `ai`/`agent` columns. Template containing {{col:<id>}} references. */
  prompt?: string;
  /** Bumped on any change that invalidates existing values. Part of the cell input hash. */
  promptVersion: number;

  model: string;               // "auto" | provider-qualified model id
  /**
   * A cheaper model to try FIRST, falling through to `model` only when the answer is not confident.
   *
   * Undefined means off, which is every existing column. When set, most rows are answered by
   * something free or nearly free and only the hard ones reach the model you are paying for — which
   * is the whole economics of running a million rows.
   *
   * Deliberately a separate field rather than a list: two steps is the shape that is honest about
   * cost (one cheap call, sometimes one expensive one), and a general waterfall is its own feature
   * with its own accept-rule.
   */
  firstModel?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  allowedTools: string[];      // EXACT tool names. Never a server-wide wildcard.
  mcpServers: string[];
  /** Agent configuration for this column — currently the web-search settings. */
  agent?: { search?: Record<string, unknown> };
  /** Request definition for an `http` column, and for outbound webhooks. */
  httpConfig?: Record<string, unknown>;
  /** Which connected app and tool an `mcp` column calls. Shaped by McpConfig in mcp/mcpColumn.ts. */
  mcpConfig?: Record<string, unknown>;
  /** Destination definition for a `send` column. Shaped by SendConfig in writeTarget.ts. */
  sendConfig?: Record<string, unknown>;
  /**
   * The ordered steps of a `waterfall` column, as stored JSON. Shaped by Waterfall in waterfall.ts.
   *
   * Carried as the raw string rather than parsed here, because parsing REPORTS what it had to drop
   * and every caller needs to decide what to do about that — the executor refuses to run a step it
   * could not read, and the editor has to show the user which one.
   */
  waterfall?: string | null;
  /** Calls this column may start per minute. 0 means no limit. See pace.ts. */
  rateLimitPerMin?: number;
  /** Per-column rules run AFTER coercion — see src/validate.ts. Absent means no rules. */
  validation?: RuleSet;
  /** Seconds a `wait` column holds each row for. See the wait lane in executor.ts. */
  waitSeconds?: number;

  /**
   * Fan-out: run the prompt once per item of the source column's list, IN PLACE.
   *
   * NOT the `send` column's per-item, which explodes a list into rows of another table — this is
   * the same row, answered once per item. ai/agent lanes only.
   */
  fanOut?: "per_item" | null;
  /** The column the list is read from. Required when fanOut is "per_item". */
  fanOutSource?: string | null;
  /**
   * Per-row ceiling on items. Default 50 when the lane runs; the excess is skipped and SAID, the
   * way the send column reports "sent 50 of 140".
   */
  fanOutCap?: number | null;

  /** Generated run condition. When it returns false the cell is `skipped` and nothing is spent. */
  conditionScriptId?: string;
  /** Runs itself when upstream values change, instead of waiting to be run. */
  autoRun?: boolean;
  /**
   * The most one auto-run firing may spend, in dollars. Null or absent means no ceiling.
   *
   * Only meaningful alongside `autoRun`. It becomes the run's own `budgetUsd`, so hitting it pauses
   * that firing rather than failing it, and the rows already answered keep their values.
   */
  autoRunBudgetUsd?: number | null;
  /** Pinned to the left of the grid. */
  frozen?: boolean;
  /** Rendered width in pixels. Absent means the default. */
  width?: number | null;
  /**
   * A colour for this column, as a token NAME rather than a hex value.
   *
   * A name, so the same column reads correctly in both themes and stays legible if the palette is
   * ever retuned. A stored `#fde68a` is a light-theme decision baked into the data, and on a dark
   * background it becomes a glare with unreadable text on it.
   */
  color?: string | null;
  /** Generated value producer, for kind === "script". */
  transformScriptId?: string;

  onUpstreamEmpty: "skip" | "run";
  onUpstreamError: "block" | "run" | "fallback";
  autoRecompute: boolean;

  /**
   * How a `lookup` or `rollup` column reads across a link.
   *
   * Read off the row by `toColumn` since these lanes shipped, and declared here only now — which
   * meant every reader had to reach for them through a cast, and nothing checked that the name it
   * used was the name the store sets. `rollup` stays loosely typed because its shape belongs to
   * rollup.ts, which validates it.
   */
  relationId?: number | null;
  lookupColumnId?: number | null;
  rollup?: { fn?: string } | Record<string, unknown>;

  /** The column this one is a JSON projection of, and the path it reads. Null on every other column. */
  sourceColumnId?: number | null;
  jsonPath?: string | null;
  /**
   * Whether this column takes typed-in values.
   *
   * Server-computed, because the server is what enforces it — see the note in `toColumn`. False on
   * anything that produces its own value, which a deliberate per-cell override can still write to.
   */
  editable?: boolean;
  /** Why not, in a sentence, when `editable` is false. Names the source column where there is one. */
  lockedReason?: string | null;
}

export interface Sheet {
  id: string;
  name: string;
  rowCount: number;
  /** Null for a standalone sheet that is not filed under a workbook. */
  workbookId: string | null;
  createdAt: string;
  updatedAt: string;
  budgetUsd: number | null;
  /** What these rows are. Drives the table wizard's defaults and which column templates suit. */
  kind: SheetKind;
  /**
   * The column that NAMES a row — shown in the record view's header, offered first in a lookup's
   * field picker, and written as the send column's back-reference when one is set.
   *
   * Resolved on read rather than stored blindly: a column delete is soft and undoable, so a pointer
   * at a deleted column reads as null and comes BACK when the delete is undone. Clearing it on
   * delete would lose the setting for good.
   */
  primaryColumnId: string | null;
  /** The saved view this table opens on. Null means all rows, which is what every table did before. */
  defaultViewId: string | null;
}

export interface Cell {
  id: string;
  sheetId: string;
  rowId: string;
  columnId: string;
  status: CellStatus;
  value: unknown | null;
  /** Display / sort / export / interpolation form. Stored rather than derived so a downstream
   *  interpolation never has to re-parse JSON. */
  valueText: string | null;
  confidence?: "high" | "medium" | "low";
  sourceUrl?: string;
  note?: string;
  errorType?: ErrClass;
  errorMsg?: string;
  stale: boolean;
  /** User-edited. Never auto-overwritten by a run. */
  pinned: boolean;
  inputHash?: string;
  /** Bumped on every write. The SSE client drops any delta whose rev it already holds. */
  rev: number;
  runId?: string;
  attempt: number;
  costUsd?: number;
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────── execution

/**
 * Re-exported, not redefined.
 *
 * The classes now carry meaning beyond the engine — what each one means to a person, and whether
 * running the cell again could help — and that table lives in `errorClass.ts`, which imports nothing
 * so the browser can read it too. Two copies of the union would eventually disagree, and the one
 * that lost would be whichever file the next person did not open.
 */
import type { ErrClass } from "./errorClass.ts";
import type { RuleSet } from "./validate.ts";
export type { ErrClass };

export type JobStatus = "blocked" | "ready" | "leased" | "done" | "failed" | "cancelled" | "skipped";

/**
 * `paused` is the plain one, and it was missing — which is exactly why every pause was recorded as
 * `paused_quota`, including a person pressing the Pause button and a run interrupted by an engine
 * restart. Both were told a rate limit had stopped them.
 *
 * `paused_budget` was the same omission one case further along: a run stopped by ITS OWN SPENDING
 * LIMIT — a ceiling the user deliberately set — also reported a provider rate limit. That is the
 * one pause the user asked for, reported as the one they have no control over.
 *
 * They stay apart because the advice differs and does not overlap: wait (quota), fix your key
 * (auth), raise the limit or accept it (budget), press Resume (paused).
 */
export type RunStatus =
  | "pending" | "running" | "paused" | "paused_auth" | "paused_quota" | "paused_budget"
  | "cancelling" | "cancelled" | "done" | "failed";

export interface Run {
  id: string;
  sheetId: string;
  kind: "column" | "rows" | "cell" | "sheet";
  status: RunStatus;
  total: number;
  doneCount: number;
  errorCount: number;
  skippedCount: number;
  costUsd: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pauseReason: string | null;
}

/** The compact per-cell delta pushed over SSE. Deliberately terse — 200 of these ride in one frame. */
export interface CellDelta {
  i: string;            // cell id
  r: number;            // rev
  s: CellStatus;
  v?: string | null;    // valueText, omitted while running
  e?: string;           // short error label
  m?: string;           // the error MESSAGE, truncated — the class alone explains nothing
  c?: number;           // est cost usd
  d?: number;           // duration ms
}

/** The envelope every AI cell must return. `found: false` is a SUCCESS, not an error — conflating
 *  the two makes retry loops burn quota re-asking an unanswerable question. */
export interface CellOutput {
  found: boolean;
  value: unknown | null;
  confidence: "high" | "medium" | "low";
  source_url?: string;
  note?: string;
}
