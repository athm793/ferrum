// Thin API client. Commands are POST/PATCH; live state arrives separately over SSE.

import { EMPTY_VIEW, viewQuery, type GridView, type SavedView } from "./view.ts";
import type { CellDelta } from "./types.ts";
import type { RuleSet } from "@shared/validate.ts";

export interface Sheet {
  id: string;
  name: string;
  rowCount: number;
  /** Null for a standalone sheet not filed under a workbook. */
  workbookId: string | null;
  createdAt: string;
  updatedAt: string;
  budgetUsd: number | null;
  /** What the rows are. Seeds the table wizard's defaults and decides which templates suit. */
  kind: SheetKind;
  /** The column that names a row. Null means fall back to the row's position. */
  primaryColumnId: string | null;
  /** The saved view this table opens on. Null means all rows. */
  defaultViewId: string | null;
}

/** Mirrors SHEET_KINDS in src/types.ts. */
export type SheetKind = "generic" | "people" | "companies";

/** Mirrors src/types.ts — keep the two in step when a type is added. */
export type ValueType =
  | "text" | "number" | "boolean" | "url" | "email" | "enum" | "json"
  | "date" | "datetime" | "currency" | "percent" | "phone"
  | "multi_select" | "array" | "file" | "relation";

export interface Column {
  /** Per-column agent configuration — currently the web-search settings. */
  agent?: { search?: Record<string, unknown> };
  id: string;
  sheetId: string;
  name: string;
  key: string;
  position: number;
  kind: "static" | "script" | "http" | "mcp" | "ai" | "agent" | "send" | "lookup" | "rollup" | "waterfall" | "wait";
  valueType: ValueType;
  /** The allowed values of an `enum` column. Empty or absent means no constraint (behaves as text). */
  enumValues?: string[];
  /** Display descriptor for a `currency`/`percent` column — symbol and decimals. Presentation only. */
  format?: { currency?: string; decimals?: number };
  /** The instruction an `ai` or `agent` column runs on every row. */
  prompt?: string | null;
  /** Which model this column runs on, or "auto" to follow the engine default. */
  model?: string | null;
  /**
   * A cheaper model tried before `model`, or absent when the column just uses `model`.
   *
   * Never escalates on its own: a row the cheap model was unsure about keeps that answer, is marked
   * unsure, and waits for a run the user starts.
   */
  firstModel?: string | null;
  /** The request an `http` column makes. Shaped by HttpConfig in prompt/HttpSettings.tsx. */
  httpConfig?: Record<string, unknown> | null;
  mcpConfig?: Record<string, unknown> | null;
  /**
   * Which connected apps an agent column may reach, and which tools it may call.
   *
   * Both were read through `any` casts because neither was declared here, which is how the tool
   * checkbox came to be written against a field the type system did not know existed.
   */
  mcpServers?: string[];
  allowedTools?: string[];
  /** Where a `send` column writes. Shaped by SendConfig in prompt/SendSettings.tsx. */
  sendConfig?: Record<string, unknown> | null;
  /** The ordered steps of a waterfall column, as the stored JSON string. Shaped by Waterfall in waterfall.ts. */
  waterfall?: string | null;
  /** Calls this column may start per minute. 0 means no limit. */
  rateLimitPerMin?: number;
  /** Per-column rules, run after the type check. The engine's own module defines the shape — see
   *  `@shared/validate.ts` — so the editor and the engine cannot disagree about what is valid. */
  validation?: RuleSet;
  /** Seconds a wait column holds each row for. */
  waitSeconds?: number;
  /** Runs itself when the values it depends on change, instead of waiting to be run. */
  autoRun?: boolean;
  /**
   * The most one auto-run firing may spend, in dollars. Null means no ceiling.
   *
   * Only meaningful with `autoRun` on. Hitting it pauses that firing rather than failing it.
   */
  autoRunBudgetUsd?: number | null;
  /** The most ONE CELL of this column may spend, in dollars. `0` means no ceiling. */
  maxBudgetUsd?: number;
  /** Pinned to the left of the grid — it stays on screen while the other columns scroll. */
  frozen?: boolean;
  /** Rendered width in pixels. Null or absent means the default. */
  width?: number | null;
  /** A colour token NAME for this column — see COLUMN_COLORS. Null means no colour. */
  color?: string | null;
  /** The predicate deciding which rows this column runs on at all, if it has one. */
  conditionScriptId?: string;
  /** What this column is for, in the author's words. Shown on hover over the header. */
  description?: string;
  /** For a `lookup` column: which link it reads through, and which field it pulls across. */
  relationId?: number | null;
  lookupColumnId?: number | null;
  /** For a `rollup` column: which calculation, and how a list is joined. */
  rollup?: { fn: RollupFn; separator?: string } | null;
  /** The column this one is a JSON projection of, and the path it reads. Null on every other column. */
  sourceColumnId?: number | null;
  jsonPath?: string | null;
  /**
   * Whether this column takes typed-in values. False on anything that produces its own.
   *
   * The server computes it and the server enforces it — this is a mirror, not a second opinion.
   * Deriving it here as well is how the two eventually disagree, and the way that fails is a cell
   * that accepts a keystroke and is then refused on the way to the database.
   *
   * Optional so an older engine answering without it does not lock the whole grid: absent means
   * editable, which is exactly how the app behaved before this existed.
   */
  editable?: boolean;
  /** Why not, in a sentence, when `editable` is false. Shown when an edit is refused. */
  lockedReason?: string | null;
}

export type RollupFn = "count" | "sum" | "min" | "max" | "avg" | "list";

export type MatchMode = "exact" | "normalized" | "fuzzy";

/** A link between two tables, as the table looking at it sees it. */
export interface Relation {
  id: number;
  fromSheetId: string;
  fromColumnId: number;
  toSheetId: string;
  toColumnId: number;
  cardinality: "many_to_one" | "one_to_one";
  /** How strictly two values have to agree to be the same thing. */
  matchMode: MatchMode;
  /** Which end THIS table is. The other table is the one it can read from. */
  side: "from" | "to";
  otherSheetId: string;
  otherSheetName: string;
  health: RelationHealth;
}

/**
 * How much of the pointing table actually found something.
 *
 * Travels WITH the link rather than behind a second request. "Linked" on its own is not the useful
 * fact — "linked, and 340 of your 2,000 rows found nothing" is — and a screen that only says a link
 * exists leaves that discovery to happen one empty column at a time.
 */
export interface RelationHealth {
  keyed: number;
  /** No value in the key column — nothing to match WITH. A different problem from not matching. */
  blank: number;
  matched: number;
  unmatched: number;
  /** Keys hitting more than one row on the other side: the failure that looks like success. */
  ambiguous: number;
  targetKeys: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as any).error) {
    throw new Error((body as any).error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

/** What the app knows about a stored key. Never the key itself — only enough to tell two apart. */
export interface ProviderStatus {
  provider: "openrouter";
  present: boolean;
  /** Masked, e.g. "sk-or-v1-05…68ab". Enough to recognise, not enough to use. */
  label: string | null;
  storedAt: string | null;
}

// ── Usage and cost ─────────────────────────────────────────────────────────────────────────────

export type UsageScope = "workspace" | "workbook" | "table";

export interface UsageTotals {
  attempts: number;
  errors: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreate: number;
  durationMs: number;
}

export interface UsageSlice extends UsageTotals {
  key: string;
  label: string;
  units: number;
  /** Empty when the group mixes more than one kind of unit — see usage.ts for why. */
  unit: string;
}

export interface UsageReport {
  scope: UsageScope;
  scopeId: string | null;
  scopeName: string;
  from: string | null;
  to: string | null;
  totals: UsageTotals;
  byModel: UsageSlice[];
  byLane: UsageSlice[];
  byColumn: UsageSlice[];
  byTable: UsageSlice[];
  byDay: UsageSlice[];
  byUnit: UsageSlice[];
}

/**
 * What the engine declined to spend, and why.
 *
 * `usd` is an estimate from the same per-row function the run confirmation quotes, so the two
 * cannot disagree. `cellsUnpriced` is the part it could not value — reported rather than folded in
 * as zero, because a total that hides its own blind spot overstates its certainty.
 */
export interface SavingsTotals {
  usd: number;
  cells: number;
  cellsUnpriced: number;
  byReason: Array<{ reason: string; label: string; usd: number; cells: number; cellsUnpriced: number }>;
}

/** A model provider other than OpenRouter, and whether it is ready to use. */
export interface LlmProviderStatus {
  id: string;
  label: string;
  /** One line on what it is FOR. Twenty provider names is not a choice. */
  note: string;
  signupUrl: string;
  /** False for providers whose models cannot call tools, so agent columns can say why. */
  tools: boolean;
  hasKey: boolean;
}

// ── web search ─────────────────────────────────────────────────────────────────────────────────

export interface SearchBackendInfo {
  id: string;
  label: string;
  signupUrl: string;
  /** What the shipped price assumes, so a wrong figure is recognisable rather than just a number. */
  priceNote: string;
  supportsDomainFilter: boolean;
  /** True when it returns page CONTENT, not only links and snippets. */
  returnsContent: boolean;
  listPriceUsd: number | null;
  /** What it costs today — the user's figure if they set one, else the list price. */
  perSearchUsd: number | null;
  priceIsCustom: boolean;
  hasKey: boolean;
  /** Its key is set on another screen, so no field is offered here. */
  keyManagedElsewhere?: boolean;
  secretName: string;
}

export interface CustomEngine {
  id: string;
  label: string;
  url: string;
  perSearchUsd: number | null;
  cost: { unit: string; perCall: number; packUnits: number; packUsd: number } | null;
}

export interface SearchPresetInfo {
  key: string;
  label: string;
  note: string;
  signupUrl: string;
  secretNames: string[];
}

export interface SearchSettings {
  chosen: string;
  /** The per-cell ceiling a column uses unless it overrides it. */
  budgetUsd: number;
  maxSearches: number;
  builtins: SearchBackendInfo[];
  custom: CustomEngine[];
  presets: SearchPresetInfo[];
}

export interface SearchTry {
  hits: Array<{ url: string; title?: string; snippet?: string }>;
  costUsd?: number;
  error?: string;
  /** The whole response, returned ONLY when the results path found nothing — see tryCustom. */
  raw?: unknown;
}

/** A rate the user copied off a vendor's pricing page. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Where the vendor charges less for a repeated prompt. Blank means no discount. */
  cachedInput?: number;
  /** The scale it was typed at — both appear on real pricing pages. */
  scale: 1000 | 1000000;
  note?: string;
  updatedAt: string;
}

export interface ProviderPrices {
  /** Applies to every model from this provider unless one below overrides it. */
  provider: ModelPrice | null;
  models: Array<{ model: string; price: ModelPrice }>;
}

export interface SavePriceInput {
  /** Blank for a provider-wide price; a bare model id for one that applies to just that model. */
  model?: string;
  input: number;
  output: number;
  cachedInput?: number | "";
  scale: 1000 | 1000000;
  note?: string;
}

export interface SaveProviderResult {
  hasKey?: boolean;
  /** How many models the provider listed. Zero means they have to be typed by hand. */
  modelCount: number;
  /**
   * Set when the key could not be confirmed either way — some providers serve no model list.
   *
   * Shown as its own state rather than folded into success, because a tick the check has not earned
   * is exactly what sends someone into a long run believing they are set up.
   */
  unverified?: string;
}

/** The result of asking the provider whether a key actually works. */
export interface KeyCheck {
  ok: boolean;
  error?: string;
  /** The provider's own name for the key. */
  label?: string;
  /** Credit left, when a limit is set on the key. Null means the key has no limit. */
  remainingUsd?: number | null;
  usageUsd?: number;
  /** True when the key may only call free models — a web-search column would fail on every row. */
  freeTierOnly?: boolean;
}

export const api = {
  health: () => req<{ ok: boolean; warnings: string[]; db: { path: string; rows: number } }>("/api/health"),

  // ── providers ────────────────────────────────────────────────────────────────────────────────
  //
  // There was no client for these at all: the routes shipped, and nothing in the app ever called
  // them, so a paid column could only be enabled by hand-editing a file in the data directory. The
  // key travels one way — up. Nothing here ever asks for it back, because no screen needs it and a
  // route that can return a key is a route that can leak one.

  providers: () => req<{ providers: ProviderStatus[] }>("/api/providers"),

  /**
   * Store a key, but only after the provider confirms it works.
   *
   * The verification is the server's, not a convenience here: storing first would leave the app
   * looking configured while every row failed with something that reads like an outage.
   */
  saveOpenRouterKey: (key: string) =>
    req<{ status: ProviderStatus; check: KeyCheck }>("/api/providers/openrouter/key", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  /** Re-check the stored key — credit runs out, and keys get revoked from the other end. */
  checkOpenRouterKey: () =>
    req<{ check: KeyCheck }>("/api/providers/openrouter/check", { method: "POST" }),

  removeOpenRouterKey: () =>
    req<{ status: ProviderStatus }>("/api/providers/openrouter/key", { method: "DELETE" }),

  // ── every other model provider ───────────────────────────────────────────────────────────────
  //
  // Same one-way rule as above: the key travels up and nothing here ever asks for it back.

  llmProviders: () => req<{ providers: LlmProviderStatus[] }>("/api/llm-providers"),

  /** Checked with the provider before it is stored, for the same reason the OpenRouter one is. */
  saveLlmProviderKey: (id: string, key: string) =>
    req<SaveProviderResult>(`/api/llm-providers/${encodeURIComponent(id)}/key`, {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  checkLlmProviderKey: (id: string) =>
    req<SaveProviderResult & { ok: boolean; error?: string }>(
      `/api/llm-providers/${encodeURIComponent(id)}/check`,
      { method: "POST" },
    ),

  removeLlmProviderKey: (id: string) =>
    req<{ hasKey: boolean }>(`/api/llm-providers/${encodeURIComponent(id)}/key`, { method: "DELETE" }),

  // ── web search ───────────────────────────────────────────────────────────────────────────────
  //
  // The most expensive thing a cell can do, and the one whose price varies most between vendors.

  search: () => req<SearchSettings>("/api/search"),

  chooseSearchBackend: (id: string) =>
    req<{ chosen: string }>("/api/search/backend", { method: "PUT", body: JSON.stringify({ id }) }),

  /** Null clears back to the shipped list price. Zero is a real answer for a free tier. */
  setSearchPrice: (id: string, usd: number | null) =>
    req<{ id: string; perSearchUsd: number | null; priceIsCustom: boolean }>("/api/search/price", {
      method: "PUT",
      body: JSON.stringify({ id, usd }),
    }),

  setSearchKey: (id: string, key: string) =>
    req<{ id: string; hasKey: boolean }>(`/api/search/backends/${encodeURIComponent(id)}/key`, {
      method: "PUT",
      body: JSON.stringify({ key }),
    }),

  saveSearchEngine: (body: { preset?: string; label?: string; [k: string]: unknown }) =>
    req<{ custom: CustomEngine; list: CustomEngine[] }>("/api/search/custom", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  deleteSearchEngine: (id: string) =>
    req<{ list: CustomEngine[]; chosen: string }>(`/api/search/custom/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /**
   * One real search. The only way to tell a wrong results path from a hard question.
   *
   * Deliberately NOT through `req`. That helper treats any `error` field as a thrown failure, which
   * is right everywhere else and wrong here: a Try that fails IS the answer — "no key saved", "the
   * path found nothing, here is the response" — and it belongs under the engine it is about, beside
   * the fields that need correcting. Thrown, it surfaced as a page-level error at the top of a list
   * of sixteen engines, detached from the one it described.
   */
  trySearchEngine: async (body: { id?: string; preset?: string; query?: string }): Promise<SearchTry> => {
    const res = await fetch("/api/search/try", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    // A transport failure still has to look like one rather than an empty result set.
    if (!res.ok && !(out as SearchTry).error) {
      return { hits: [], error: `${res.status} ${res.statusText}` };
    }
    const t = out as Partial<SearchTry>;
    // `hits` defaulted explicitly rather than by spread order: a response without it must render as
    // "found nothing", not crash the row on `.length` of undefined.
    return { ...t, hits: t.hits ?? [] };
  },

  // ── what a directly-bought model costs ───────────────────────────────────────────────────────
  //
  // These vendors publish no rate a program can read, so it is copied across once. After that the
  // estimate, the spend report and the per-cell dollar limit all work as they do on OpenRouter.

  llmPrices: (id: string) => req<ProviderPrices>(`/api/llm-providers/${encodeURIComponent(id)}/prices`),

  saveLlmPrice: (id: string, price: SavePriceInput) =>
    req<{ prices: ProviderPrices }>(`/api/llm-providers/${encodeURIComponent(id)}/prices`, {
      method: "PUT",
      body: JSON.stringify(price),
    }),

  deleteLlmPrice: (id: string, model?: string) =>
    req<{ prices: ProviderPrices }>(
      `/api/llm-providers/${encodeURIComponent(id)}/prices?model=${encodeURIComponent(model ?? "")}`,
      { method: "DELETE" },
    ),

  /**
   * What a scope has spent, and on what.
   *
   * One request for the totals and every breakdown. They are read off the same small rollup table,
   * and a screen that fetched them separately would be a screen where the total and its own
   * breakdown can disagree while you look at them.
   */
  usage: (scope: UsageScope, id: string | null, range: { from?: string | null; to?: string | null } = {}) => {
    const q = new URLSearchParams({ scope });
    if (id) q.set("id", id);
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
    return req<{ report: UsageReport; savings?: SavingsTotals | null }>(`/api/usage?${q}`);
  },

  listSheets: () => req<{ sheets: Sheet[] }>("/api/sheets"),
  listWorkbooks: () => req<{ workbooks: Array<{ id: string; name: string }> }>("/api/workbooks"),
  /**
   * Make a table. `workbookId` is the file it joins.
   *
   * Not optional in practice: the engine gives a table with no workbook a BRAND NEW one, so every
   * caller that left this out made a table that vanished from the workbook it was created in — it
   * showed up as its own file in the browser and never appeared in the tab bar it came from.
   */
  createSheet: (name: string, workbookId?: string | null) =>
    req<{ sheet: Sheet }>("/api/sheets", { method: "POST", body: JSON.stringify({ name, workbookId: workbookId ?? null }) }),
  // `defaultView` travels in this payload rather than as a second request, so the opener can apply
  // the narrowing before the grid's first read of the rows instead of painting everything and then
  // snapping to a subset.
  getSheet: (id: string) =>
    req<{ sheet: Sheet; columns: Column[]; defaultView: SavedView | null }>(`/api/sheets/${id}`),
  /** The column that names a row. Null clears it and falls back to the row's position. */
  setPrimaryColumn: (id: string, primaryColumnId: string | null) =>
    req<{ sheet: Sheet }>(`/api/sheets/${id}`, { method: "PATCH", body: JSON.stringify({ primaryColumnId }) }),
  /** The view this table opens on. Null returns it to all rows. */
  setDefaultView: (id: string, defaultViewId: string | null) =>
    req<{ sheet: Sheet }>(`/api/sheets/${id}`, { method: "PATCH", body: JSON.stringify({ defaultViewId }) }),
  setSheetKind: (id: string, kind: SheetKind) =>
    req<{ sheet: Sheet }>(`/api/sheets/${id}`, { method: "PATCH", body: JSON.stringify({ kind }) }),
  renameSheet: (id: string, name: string) =>
    req<{ sheet: Sheet }>(`/api/sheets/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  /** Soft delete — recoverable. The UI never hard-deletes a sheet. */
  trashSheet: (id: string) => req(`/api/sheets/${id}/trash`, { method: "POST" }),
  startRun: (sheetId: string, scope: Record<string, unknown>) =>
    req<{ run: { id: string } }>(`/api/sheets/${sheetId}/runs`, { method: "POST", body: JSON.stringify({ scope }) }),
  restoreSheet: (id: string) => req<{ sheet: Sheet }>(`/api/sheets/${id}/restore`, { method: "POST" }),

  readRows: (sheetId: string, offset: number, limit: number, view: GridView = EMPTY_VIEW) =>
    req<{ rows: Array<{ id: string; position: number; cells: Record<string, any> }>; total: number; offset: number }>(
      `/api/sheets/${sheetId}/rows?offset=${offset}&limit=${limit}${viewQuery(view)}`,
    ),

  addColumn: (sheetId: string, name: string, kind = "static") =>
    req<{ column: Column }>(`/api/sheets/${sheetId}/columns`, { method: "POST", body: JSON.stringify({ name, kind }) }),
  renameColumn: (id: string, name: string) => req(`/api/columns/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  describeColumn: (id: string, description: string) =>
    req<{ column: Column }>(`/api/columns/${id}`, { method: "PATCH", body: JSON.stringify({ description }) }),
  /** Copy a column's whole definition. The copy arrives empty and runs on your say-so. */
  duplicateColumn: (id: string) => req<{ column: Column }>(`/api/columns/${id}/duplicate`, { method: "POST" }),
  /** Put a column at a new place in the visible order. */
  moveColumn: (id: string, toIndex: number) =>
    req<{ column: Column }>(`/api/columns/${id}`, { method: "PATCH", body: JSON.stringify({ toIndex }) }),
  deleteColumn: (id: string) => req(`/api/columns/${id}`, { method: "DELETE" }),
  /** Change the lane a column runs on — the single biggest cost decision on a column. */
  setColumnKind: (id: string, kind: Column["kind"]) =>
    req<{ column: Column }>(`/api/columns/${id}`, { method: "PATCH", body: JSON.stringify({ kind }) }),
  deleteRow: (id: string) => req<{ sheetId: string }>(`/api/rows/${id}`, { method: "DELETE" }),
  /** Delete many rows at once — the grid's checkbox selection. Undoable as one step. */
  deleteRows: (sheetId: string, ids: Array<string | number>) =>
    req<{ deleted: number }>(`/api/sheets/${sheetId}/rows/delete`, { method: "POST", body: JSON.stringify({ ids }) }),
  /** Every row id in the table, in position order — backs the header "select all rows" checkbox. */
  allRowIds: (sheetId: string) => req<{ ids: number[] }>(`/api/sheets/${sheetId}/row-ids`),
  /** Delete many columns at once — the header checkbox selection. Soft-deleted, undoable as one step. */
  deleteColumns: (sheetId: string, ids: Array<string | number>) =>
    req<{ deleted: number }>(`/api/sheets/${sheetId}/columns/delete`, { method: "POST", body: JSON.stringify({ ids }) }),

  // ── links between tables ──────────────────────────────────────────────────────────────────────
  relations: (sheetId: string) => req<{ relations: Relation[] }>(`/api/sheets/${sheetId}/relations`),
  createRelation: (input: {
    fromSheetId: string; fromColumnId: number; toSheetId: string; toColumnId: number;
  }) => req<{ relation: Relation }>("/api/relations", { method: "POST", body: JSON.stringify(input) }),
  /** Change how strictly a link matches. Answers with the new health, since that is the point. */
  setMatchMode: (id: number, matchMode: MatchMode) =>
    req<{ relation: Relation; health: RelationHealth }>(`/api/relations/${id}`, {
      method: "PATCH", body: JSON.stringify({ matchMode }),
    }),
  /** Re-index both sides. Needed after rows arrive by a path that does not go through a run. */
  rebuildRelation: (id: number) =>
    req<{ health: RelationHealth }>(`/api/relations/${id}/rebuild`, { method: "POST" }),
  /** Returns how many columns were reading through it, so the loss can be stated rather than implied. */
  deleteRelation: (id: number) =>
    req<{ columnsAffected: number }>(`/api/relations/${id}`, { method: "DELETE" }),
  /** Point a rollup column at a link and a calculation over the other table. */
  setRollup: (columnId: string, relationId: number, fn: RollupFn, sourceColumnId: number | null, separator?: string) =>
    req<{ column: Column }>(`/api/columns/${columnId}`, {
      method: "PATCH",
      body: JSON.stringify({ rollup: { relationId, fn, sourceColumnId, separator } }),
    }),
  /** Point a lookup column at a link and a field on the other table. */
  setLookup: (columnId: string, relationId: number, sourceColumnId: number) =>
    req<{ column: Column }>(`/api/columns/${columnId}`, {
      method: "PATCH",
      body: JSON.stringify({ lookup: { relationId, sourceColumnId } }),
    }),

  getCell: (id: string) => req<{ cell: any; attempts: any[] }>(`/api/cells/${id}`),
  setCell: (id: string, value: string | null) => req(`/api/cells/${id}`, { method: "PUT", body: JSON.stringify({ value }) }),

  previewCsv: (path: string) =>
    req<{ headers: string[]; sampleRows: string[][]; inferredTypes: string[]; delimiter: string; encoding: string; raggedCount: number }>(
      "/api/csv/preview",
      { method: "POST", body: JSON.stringify({ path }) },
    ),

  /**
   * Preview from the file's HEAD alone — the raw first chunk sent as the request body, not a staged
   * path. Lets the mapping screen appear instantly while the whole file uploads in the background.
   * Not routed through `req`, which forces a JSON content type; this body is raw bytes.
   */
  previewHead: async (head: Blob) => {
    const res = await fetch("/api/csv/preview-head", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: head,
    });
    const body = (await res.json().catch(() => ({}))) as {
      preview?: { headers: string[]; sampleRows: string[][]; inferredTypes: string[]; delimiter: string; encoding: string; raggedCount: number; quotesDisabled: boolean };
      error?: string;
    };
    if (!res.ok || body.error || !body.preview) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body.preview;
  },
  /**
   * Mirrors `ImportResult` in src/csv.ts — keep the two in step when a field is added or renamed.
   *
   * Named `raggedFixed`, not `raggedSkipped`: the engine pads or truncates a ragged row and keeps
   * every good field beside the missing one, so nothing is discarded and the name has to say so.
   */
  importCsv: (sheetId: string, path: string) =>
    req<{
      rowsInserted: number;
      duplicatesSkipped: number;
      /** Rows the TABLE's own duplicate rule removed after the import, when it runs itself. The
       *  engine has always returned this and nothing read it, so an import into a sheet with
       *  auto-dedupe on could delete rows and the summary said nothing about it. */
      dedupedAfter: number;
      /** Rows whose field count differed from the header: padded or truncated, never dropped. */
      raggedFixed: number;
      /** Headers the file repeated. Each repeat got its own suffixed column — "Email (2)" — rather
       *  than overwriting the first one's values. */
      duplicateHeaders: string[];
      /** What the file was finally decoded as, INCLUDING a mid-stream correction away from UTF-8. */
      encoding: "utf8" | "latin1";
      columnsCreated: number;
      ms: number;
      rowCount: number;
    }>(`/api/sheets/${sheetId}/import`, { method: "POST", body: JSON.stringify({ path }) }),
};

/**
 * Connect to the live stream.
 *
 * EventSource reconnects on its own, which is most of why SSE was chosen over a WebSocket here. On
 * reconnect the client re-fetches its visible window rather than replaying history — deltas carry a
 * per-cell rev, so a stale frame arriving after the refetch is simply dropped.
 */
export function connectStream(handlers: {
  onCells: (deltas: CellDelta[]) => void;
  onRun?: (run: unknown) => void;
  onColumnStats?: (stats: unknown[]) => void;
  onOpen?: () => void;
  onError?: () => void;
}): () => void {
  const es = new EventSource("/api/stream");

  es.addEventListener("cells", (e) => {
    try {
      const payload = JSON.parse((e as MessageEvent).data) as { cells: CellDelta[] };
      handlers.onCells(payload.cells);
    } catch { /* a malformed frame must not kill the stream */ }
  });

  es.addEventListener("run", (e) => {
    try { handlers.onRun?.(JSON.parse((e as MessageEvent).data).run); } catch { /* ignore */ }
  });

  es.addEventListener("columnStats", (e) => {
    try { handlers.onColumnStats?.(JSON.parse((e as MessageEvent).data).stats ?? []); } catch { /* ignore */ }
  });

  es.addEventListener("hello", () => handlers.onOpen?.());
  es.onerror = () => handlers.onError?.();

  return () => es.close();
}

// ── who you are ──────────────────────────────────────────────────────────────────────────────────
//
// Inert on a single-user install: an unclaimed instance reports `claimed: false`, no person, and
// every capability true. The app reads exactly one shape either way, so no screen has to ask
// "are we in team mode?" — it asks "may I?", which is the question it actually has.

export type Role = "viewer" | "member" | "admin" | "owner";

export interface Me {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface SessionState {
  claimed: boolean;
  /** Bound to a public address. Drives the warnings that only matter off localhost. */
  shared: boolean;
  person: Me | null;
  can: { write: boolean; spend: boolean; settings: boolean; people: boolean; own: boolean };
}

export interface Person extends Me {
  disabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PendingInvite {
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

export interface DeviceSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
  current: boolean;
}

export const session = {
  who: () => req<SessionState>("/api/session"),
  signIn: (email: string, password: string) =>
    req<SessionState>("/api/session", { method: "POST", body: JSON.stringify({ email, password }) }),
  signOut: () => req<SessionState>("/api/session", { method: "DELETE" }),
  claim: (email: string, password: string, name: string) =>
    req<SessionState>("/api/session/claim", { method: "POST", body: JSON.stringify({ email, password, name }) }),
  peekInvite: (token: string) => req<{ invite: { email: string; role: Role } }>(`/api/session/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string, name: string) =>
    req<SessionState>("/api/session/invite", { method: "POST", body: JSON.stringify({ token, password, name }) }),

  updateMe: (patch: { name?: string; password?: string; currentPassword?: string }) =>
    req<SessionState>("/api/session/me", { method: "PATCH", body: JSON.stringify(patch) }),
  devices: () => req<{ sessions: DeviceSession[] }>("/api/session/devices"),
  endOtherDevices: () => req<{ ok: boolean; sessions: DeviceSession[] }>("/api/session/devices/end-others", { method: "POST" }),

  // ── the members list (admin only; the server refuses the rest) ──────────────────────────────
  people: () => req<{ people: Person[]; invites: PendingInvite[] }>("/api/people"),
  invite: (email: string, role: Role) =>
    req<{ ok: boolean; link: string; invites: PendingInvite[] }>("/api/invites", {
      method: "POST", body: JSON.stringify({ email, role }),
    }),
  revokeInvite: (email: string) =>
    req<{ ok: boolean; invites: PendingInvite[] }>(`/api/invites/${encodeURIComponent(email)}`, { method: "DELETE" }),
  setRole: (id: number, role: Role) =>
    req<{ ok: boolean; people: Person[] }>(`/api/people/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  setDisabled: (id: number, disabled: boolean) =>
    req<{ ok: boolean; people: Person[] }>(`/api/people/${id}`, { method: "PATCH", body: JSON.stringify({ disabled }) }),
  remove: (id: number) => req<{ ok: boolean; people: Person[] }>(`/api/people/${id}`, { method: "DELETE" }),

  // ── one workbook's sharing ──────────────────────────────────────────────────────────────────
  access: (workbookId: string) =>
    req<{ restricted: boolean; grants: Array<{ userId: number; access: "view" | "edit" }>; people: Person[] }>(
      `/api/workbooks/${workbookId}/access`,
    ),
  setRestricted: (workbookId: string, restricted: boolean) =>
    req<{ ok: boolean; restricted: boolean; grants: Array<{ userId: number; access: "view" | "edit" }> }>(
      `/api/workbooks/${workbookId}/access`, { method: "PATCH", body: JSON.stringify({ restricted }) },
    ),
  setGrant: (workbookId: string, userId: number, access: "view" | "edit" | null) =>
    req<{ ok: boolean; restricted: boolean; grants: Array<{ userId: number; access: "view" | "edit" }> }>(
      `/api/workbooks/${workbookId}/access`, { method: "PATCH", body: JSON.stringify({ grant: { userId, access } }) },
    ),
};
