// What a run will cost, worked out BEFORE it starts.
//
// This lives on the server rather than in the browser for one reason: the browser does not know how
// many rows a scope resolves to on a million-row sheet, and it does not know each column's lane or
// model. Estimating from what the client happens to have loaded would produce a number that is
// confidently wrong in the direction that matters — too low.
//
// Everything here is an estimate and every surface that shows it says so. The purpose is not
// accounting, it is the difference between "this run costs pennies" and "this run costs four
// thousand dollars", which is a decision you cannot make from a row count alone.

import { callCost } from "./http/httpColumn.ts";
import { db } from "./db.ts";
import { listColumns } from "./store.ts";
import { blended, listModels, type CatalogModel } from "./providers/catalog.ts";
import { DEFAULT_MODEL, effectiveDefaultModel } from "./providers/resolve.ts";
import { searchCostUsd } from "./providers/openrouter.ts";
import { modelPricePerMillion } from "./providers/prices.ts";
import { splitModelId } from "./providers/registry.ts";
import { isLocalModel } from "./providers/local.ts";
import { parseWaterfall, waterfallCost } from "./waterfall.ts";
import type { Column } from "./types.ts";

/**
 * Typical token counts per cell, by lane.
 *
 * These are the parts that do NOT depend on the sheet: the system prompt, the finish-tool schema,
 * and — on the agent lane — the page text and search results a research loop pulls back and re-reads
 * on every turn. The row itself is measured rather than assumed; see `recordTokens`.
 */
const SHAPE = {
  ai: { baseInTok: 400, outTok: 60 },
  agent: { baseInTok: 12_000, outTok: 200 },
} as const;

/**
 * The loop's own ceiling on tool calls per cell, from runAgent's default.
 *
 * The estimate must not assume ONE search. A search-capable agent column may make up to this many,
 * and on the lane where a single call costs more than a thousand tokens do, assuming the best case
 * is how a four-figure run is presented as a two-figure one.
 */
export const MAX_TOOL_CALLS = 16;

/** Roughly what a character costs in tokens. Close enough for an estimate; deliberately not precise. */
const CHARS_PER_TOKEN = 4;

/** How many rows are measured to work out the size of a typical record. */
const SAMPLE_ROWS = 100;

export interface ColumnCost {
  columnId: number;
  name: string;
  kind: string;
  /** Null for a lane that does not bill per row. */
  model: string | null;
  perRow: number;
  total: number;
  /** Set when the model could not be priced, so the UI can say so instead of showing a false $0. */
  unpriced?: boolean;
  /**
   * Set when this column spends somewhere we cannot see — an HTTP endpoint or an MCP provider.
   *
   * Distinct from `unpriced`, which blocks the run. This one does not: the user is the person who
   * chose the endpoint and is the only one who knows its rate. What it must NOT be called is free.
   */
  external?: boolean;
  /** The host an external column posts to, so the warning can name it. */
  host?: string;
  /** Requests this column will make — rowCount for an external lane. */
  requests?: number;
  /**
   * A waterfall's OTHER number: what it costs if the first step usually answers.
   *
   * `perRow` and `total` carry the worst case, because the question a spend warning answers is
   * "could this exceed what I am willing to spend". This pair is shown beside it so the dialog is
   * not so pessimistic that nobody presses the button on a job that will really cost a fifth of it.
   * Absent on every other lane, which has one price rather than a range.
   */
  bestPerRow?: number;
  bestTotal?: number;
  /**
   * Steps whose price nobody has declared, by name.
   *
   * Named rather than counted as zero: a total that quietly omits a paid provider reads as
   * authoritative and is short by exactly the amount that matters.
   */
  unpricedSteps?: string[];
  /**
   * Fan-out: the sampled item distribution of the source column.
   *
   * `perRow`/`total` already carry the WORST case — the sampled maximum, bounded by the cap — and
   * `bestPerRow`/`bestTotal` carry the sampled AVERAGE, the same pair a waterfall shows. These
   * fields name the multiplier so the dialog can say "× ~12 items" instead of a bare number that
   * nobody can check.
   */
  fanOutItems?: number;
  fanOutMaxItems?: number;
  fanOutCap?: number;
}

export interface RunCost {
  total: number;
  columns: ColumnCost[];
  /** True when at least one column's model could not be priced, for any reason. */
  incomplete: boolean;
  /**
   * Models named by a column that the published list does not contain, with the catalogue readable.
   *
   * This is the SUNSET case, and it needs its own answer. Providers retire model ids routinely, and
   * a column pointed at a retired one fails on every single row — so the run is refused before it
   * starts rather than after it has failed a hundred thousand times.
   *
   * Deliberately NOT the same as `incomplete`: a briefly unreachable price sheet also leaves a
   * column unpriced, and refusing every paid run because a price list timed out would be a worse
   * failure than proceeding without an estimate. Empty when the catalogue could not be read at all,
   * because then nothing is known to be missing — only unknown.
   */
  missingModels: string[];
  /**
   * Whether the published price list could be read at all.
   *
   * The one fact that separates the two very different reasons a column ends up unpriced, and it was
   * computed here and then thrown away — never returned, so the screen that blocks the run could not
   * tell them apart. With no key configured, or the provider briefly down, EVERY paid column was
   * greyed out under the message "pick a model with a price", when no model had one and picking a
   * different one could not possibly help.
   *
   * See `missingModels` above: a model the list does not contain is gone and that run should be
   * refused. A list that could not be fetched means we cannot tell, and refusing every paid run
   * because a price sheet timed out is the worse failure of the two.
   */
  catalogueReachable: boolean;
  /** True when nothing in this run bills at all — a script-only run really is free. */
  free: boolean;
  /**
   * True when a column bills through a third party at a rate we do not know.
   *
   * `free` and `external` are not the same answer. Collapsing them presents an HTTP or MCP run over
   * a million rows as free and skips the type-the-amount gate, while the engine treats both as
   * per-cell spend lanes. Priced at nothing is not the same as costing nothing.
   */
  external: boolean;
}

function priceOf(models: CatalogModel[], id: string): CatalogModel | null {
  return models.find((m) => m.id === id) ?? null;
}

/**
 * How much row data the prompt actually inlines, measured rather than assumed.
 *
 * `recordFor` in the executor puts EVERY other non-empty column of the row into the prompt, inside
 * the <record> block. The old flat 400-token figure was the size of a bare instruction with no row
 * attached, which on a thirty-column enriched sheet is out by an order of magnitude — and out in the
 * direction that makes a run look affordable.
 *
 * Sampled from the head of the sheet and bounded, because this runs while a dialog is waiting.
 */
function recordTokens(sheetId: string, excludeColumnId: number): number {
  const cols = listColumns(sheetId).filter((c) => Number(c.id) !== excludeColumnId);
  if (cols.length === 0) return 0;

  // The sample rides the (sheet_id, position) index, so it reads a hundred index entries rather than
  // counting a million rows to find out how many there are.
  const sampled = Number(
    (db
      .prepare("SELECT COUNT(*) AS n FROM (SELECT id FROM rows WHERE sheet_id = ? ORDER BY position LIMIT ?)")
      .get(sheetId, SAMPLE_ROWS) as any)?.n ?? 0,
  );
  if (sampled === 0) return 0;

  const ids = cols.map((c) => Number(c.id));
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(c.value_text)), 0) AS chars,
              COUNT(c.value_text)                    AS filled
         FROM cells c
         JOIN (SELECT id FROM rows WHERE sheet_id = ? ORDER BY position LIMIT ?) r ON r.id = c.row_id
        WHERE c.column_id IN (${ids.map(() => "?").join(",")})
          AND c.value_text IS NOT NULL AND c.value_text <> ''`,
    )
    .get(sheetId, SAMPLE_ROWS, ...ids) as { chars: number; filled: number } | undefined;
  if (!row) return 0;

  // Each field also carries its own "Name: " label and a newline.
  const avgNameChars = cols.reduce((n, c) => n + c.name.length + 3, 0) / cols.length;
  const chars = (Number(row.chars) + Number(row.filled) * avgNameChars) / sampled;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The template itself is re-sent on every turn too. */
const promptTokens = (col: Column): number => Math.ceil((col.prompt ?? "").length / CHARS_PER_TOKEN);

/**
 * The item distribution of a fan-out's source column, sampled like `recordTokens`.
 *
 * Returned as AVERAGE (what a run is expected to spend) and MAX (what one row can spend, before the
 * cap) over the sampled head of the sheet. Null when no sampled row holds a list — which is also the
 * executor's own skip condition, so a column whose source is empty prices exactly as free as it runs.
 */
function fanOutDistribution(sheetId: string, sourceColumnId: number): { avg: number; max: number } | null {
  const rows = db
    .prepare(
      `SELECT c.value_json AS vj, c.value_text AS vt
         FROM cells c
         JOIN (SELECT id FROM rows WHERE sheet_id = ? ORDER BY position LIMIT ?) r ON r.id = c.row_id
        WHERE c.column_id = ?`,
    )
    .all(sheetId, SAMPLE_ROWS, sourceColumnId) as any[];
  if (rows.length === 0) return null;

  let total = 0;
  let max = 0;
  for (const r of rows) {
    let parsed: unknown = undefined;
    if (r.vj != null) { try { parsed = JSON.parse(r.vj); } catch { /* degrades to skip, same as the executor */ } }
    if (!Array.isArray(parsed)) {
      try { parsed = typeof r.vt === "string" && r.vt.trim().startsWith("[") ? JSON.parse(r.vt) : undefined; } catch { parsed = undefined; }
    }
    if (Array.isArray(parsed)) {
      total += parsed.length;
      if (parsed.length > max) max = parsed.length;
    }
  }
  if (max === 0) return null;
  // The average is over EVERY sampled row, not only the list-bearing ones: rows whose source is
  // empty or scalar are skipped free by the executor, and the estimate must price them at what they
  // cost — nothing.
  return { avg: total / rows.length, max };
}

/** What the executor will actually do: turns bounded by the column, defaulting the way it does. */
const turnsFor = (col: Column): number => (col.maxTurns > 0 ? col.maxTurns : 6);

/** Search is a tool, and a column only gets the tool if it was enabled by exact name. */
const canSearch = (col: Column): boolean =>
  col.kind === "agent" && (col.allowedTools ?? []).includes("web_search");

/** The host an external column reaches, for the warning. Never the interpolated form. */
function hostOf(col: Column): string | undefined {
  const url = String((col.httpConfig as any)?.url ?? "").trim();
  if (!url) return undefined;
  try { return new URL(url.replace(/\{\{[^}]*\}\}/g, "x")).host; } catch { return undefined; }
}

/** What one row of a model lane costs, and what that figure is made of. */
export interface PerRow {
  perRow: number;
  /** True when the model has no usable published price, so `perRow` means nothing. */
  unpriced: boolean;
  /** Input tokens per row, prompt and record included. Shown so the number is checkable. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Dollars per row for the WORDS — the prompt, the record, and the answer.
   *
   * Kept apart from the search figure because on the agent lane they are not the same order of
   * magnitude and they are moved by different controls. Reading one blended number, someone tunes
   * the prompt to save a hundredth of a cent while a search setting three tabs away is costing
   * fifty times that.
   */
  tokensUsd: number;
  /** Dollars per row of web search, charged per CALL rather than per token. */
  searchUsd: number;
  /** How many searches one row may make, and what each costs — so the figure can be checked. */
  searches: number;
  perSearchUsd: number;
}

/**
 * The cost of ONE row, from the pieces that decide it.
 *
 * Extracted so the figure shown while someone TYPES a prompt and the figure in the run confirmation
 * come from the same arithmetic. Two implementations of one question is the shape of most of the
 * bugs in this codebase's history — a cost estimate that disagrees with the bill is the worst of
 * them, because it is the number the decision was made on.
 *
 * `promptText` is passed in rather than read off the column, which is the whole point: the live
 * estimate has to price the draft in the editor, not the last thing that was saved.
 */
export function perRowCost(opts: {
  kind: "ai" | "agent";
  /** Already resolved — "auto" must be turned into a real id before it gets here. */
  modelId: string;
  promptText: string;
  sheetId: string;
  columnId: number;
  turns: number;
  /** Dollars per search call, and how many the lane may make. Zero when search is off. */
  searchPerCall: number;
  maxSearches: number;
  models: CatalogModel[];
}): PerRow {
  const local = isLocalModel(opts.modelId);
  // The catalogue first, then whatever the user typed for a directly-bought model. Reading only the
  // catalogue here made every direct-provider column estimate as "price unknown" while the run
  // itself, going through the same shared price source, knew exactly what it would cost.
  const m = local ? null : modelPricePerMillion(opts.modelId);
  const shape = SHAPE[opts.kind];

  // The record and the prompt are re-sent on EVERY turn, because the loop hands back the whole
  // conversation each time.
  const inputTokens =
    shape.baseInTok +
    (recordTokens(opts.sheetId, opts.columnId) + Math.ceil(opts.promptText.length / CHARS_PER_TOKEN)) * opts.turns;
  const searchUsd = opts.searchPerCall * opts.maxSearches;
  const shared = {
    inputTokens,
    outputTokens: shape.outTok,
    searchUsd,
    searches: opts.maxSearches,
    perSearchUsd: opts.searchPerCall,
  };

  if (!local && !m) {
    return { perRow: 0, unpriced: true, tokensUsd: 0, ...shared };
  }

  // A local model is free to THINK and paid to LOOK: its searches still run through OpenRouter's
  // plugin on the user's key, so the two halves genuinely do not move together.
  const tokensUsd = local ? 0 : (inputTokens * m!.inputPerM) / 1e6 + (shape.outTok * m!.outputPerM) / 1e6;
  return { perRow: tokensUsd + searchUsd, unpriced: false, tokensUsd, ...shared };
}

export async function estimateRun(
  columns: Column[],
  rowCount: number,
  /**
   * The run will bypass any cheap first model and call the column's own.
   *
   * Passed through from the scope so the confirmation prices the model this run will really use. A
   * two-model column quoted at its cheap model, for a run that was started specifically to use the
   * expensive one, would under-quote the only run that actually spends.
   */
  useStrongModel = false,
): Promise<RunCost> {
  let models: CatalogModel[] = [];
  let catalogueReachable = true;
  try {
    models = await listModels();
  } catch {
    // No catalogue means no prices. The result is reported as incomplete rather than as zero —
    // showing "$0.00" because the price list was unreachable would be the worst possible failure of
    // a screen whose entire job is to warn about spending.
    //
    // Recorded separately from `unpriced`, because the two need OPPOSITE handling and collapsing
    // them was hiding a real case. "This model is not on the list" means the model is gone — a
    // provider sunsets ids regularly — and that run should be refused, because every row of it will
    // fail. "The list could not be fetched" means we cannot tell, and refusing every paid run
    // because a price sheet is briefly unreachable would be a worse failure than proceeding
    // unpriced.
    catalogueReachable = false;
  }

  const out: ColumnCost[] = [];
  let total = 0;
  let incomplete = false;
  const missingModels: string[] = [];
  let external = false;

  for (const col of columns) {
    const kind = col.kind;

    // http and mcp bill a third party per row. We cannot know their rate and will not invent one —
    // but "we cannot price this" and "this is free" are opposite statements, and only one of them is
    // true here.
    if (kind === "http" || kind === "mcp") {
      external = true;
      /**
       * Unless the column was told what it costs.
       *
       * "We cannot know their rate" stopped being true the moment an HTTP column could declare one.
       * A column that says "2 credits a call, 1,000 credits for $49" has given us the rate, and
       * leaving it out of the estimate meant the confirmation dialog — the whole point of which is
       * to say what a run will spend before it spends it — reported $0 for a run that would put a
       * real number on a real bill.
       *
       * Still marked `external`, because the money leaves through someone else's account and the
       * warning about that is still the right warning. Declared, not observed: it is only as right
       * as what was typed in, which is why it says "about".
       */
      const charge = callCost(
        ((kind === "http" ? col.httpConfig : col.mcpConfig) as any)?.cost,
      );
      const perRow = charge.usd;
      total += perRow * rowCount;
      out.push({
        columnId: Number(col.id), name: col.name, kind, model: null,
        perRow, total: perRow * rowCount, external: true, requests: rowCount, host: hostOf(col),
      });
      continue;
    }

    /**
     * A waterfall costs a RANGE, and reporting one number for it would be wrong whichever number
     * was picked.
     *
     * Best case is the first step's price, which is what people quote themselves. Worst case is
     * every row falling through every step, which on a hard list is most rows. The dialog was
     * reporting "free" for a waterfall of paid providers, because a kind it did not recognise fell
     * into the catch-all below at zero — the single most dangerous output a spend warning can
     * produce, and the reason this branch sits ABOVE it.
     *
     * `perRow` carries the WORST case, not an average. Everything downstream — the sheet budget
     * check, the per-run cap, the number on the button — is a question of "could this exceed what I
     * am willing to spend", and the honest answer to that is the ceiling.
     */
    if (kind === "waterfall") {
      const { waterfall } = parseWaterfall(col.waterfall ?? null);
      const cost = waterfallCost(waterfall);
      // Marked external for the same reason an HTTP column is: the money leaves through someone
      // else's account, at a rate that was declared here rather than observed.
      if (waterfall.steps.some((s) => s.enabled && s.kind !== "script" && s.kind !== "lookup")) external = true;
      // A step nobody has priced makes the whole total a floor rather than a figure. Flagged, never
      // silently counted as zero — see waterfallCost.
      if (cost.unpriced.length > 0) incomplete = true;
      // The WORST case goes into the run total. Leaving it out — which it was, until the resolved
      // estimate came back `total: 0, free: true` for a column with a declared $0.008 step — puts
      // "free" on the dialog for a waterfall of paid providers, which is the single most dangerous
      // sentence a spend warning can print.
      total += cost.worst * rowCount;
      out.push({
        columnId: Number(col.id), name: col.name, kind, model: null,
        perRow: cost.worst, total: cost.worst * rowCount,
        bestPerRow: cost.best, bestTotal: cost.best * rowCount,
        unpricedSteps: cost.unpriced,
        external: external || undefined,
        requests: rowCount,
      });
      continue;
    }

    if (kind !== "ai" && kind !== "agent") {
      out.push({ columnId: Number(col.id), name: col.name, kind, model: null, perRow: 0, total: 0 });
      continue;
    }

    const modelId = col.model && col.model !== "auto" ? col.model : effectiveDefaultModel();
    const local = isLocalModel(modelId);
    // The catalogue entry is still needed for what only IT knows — the per-search rate below. The
    // PRICE, though, comes from the shared source, so a rate typed for a directly-bought model makes
    // this estimate real instead of "could not be priced".
    const m = local ? null : priceOf(models, modelId);
    const priced = local ? null : modelPricePerMillion(modelId);

    // A model with no usable price either way is refused, not estimated at zero. OpenRouter's
    // auto-routers publish `-1` — "whichever model this lands on" — and read as free they ranked as
    // the cheapest thing on a 345-model list.
    if (!local && !priced) {
      incomplete = true;
      // Named as MISSING only when the list was actually read AND this is an OpenRouter model. A
      // directly-bought one is absent from that list by definition; calling it missing would tell
      // the user their model no longer exists when the truth is that its price has not been entered.
      if (catalogueReachable && splitModelId(modelId).provider === "openrouter" && !models.some((x) => x.id === modelId)) missingModels.push(modelId);
      out.push({ columnId: Number(col.id), name: col.name, kind, model: modelId, perRow: 0, total: 0, unpriced: true });
      continue;
    }

    // Through the SHARED per-row function, so the number in this confirmation and the number shown
    // while the prompt was being written cannot drift apart.
    //
    // Skipping local columns entirely would price a search-enabled local agent column at $0.00 for a
    // run that bills on every search it makes: a local model is free to THINK and paid to LOOK.
    const perSearch = canSearch(col)
      ? m?.webSearchPerCall ?? searchCostUsd(Number((col.agent as any)?.search?.maxResults ?? 5))
      : 0;
    const { perRow } = perRowCost({
      kind,
      modelId,
      promptText: col.prompt ?? "",
      sheetId: col.sheetId,
      columnId: Number(col.id),
      turns: kind === "agent" ? turnsFor(col) : 1,
      searchPerCall: perSearch,
      // Bounded by the TURN limit as well as the tool-call cap, because the loop stops at whichever
      // comes first. A flat 16 made a 2-turn column look eight times more expensive than it can be —
      // and, now that the same figure is shown live while the settings are being changed, the two
      // surfaces would have disagreed about the same column.
      maxSearches: canSearch(col) ? Math.min(turnsFor(col), MAX_TOOL_CALLS) : 0,
      models,
    });

    /**
     * A column with a cheap first model is priced at the CHEAP model, because that is the only one
     * this run will call.
     *
     * An earlier version of this priced the worst case — both calls on every row — which was the
     * right instinct for a feature that escalated automatically and is simply wrong now that it
     * cannot. Nothing falls through to the paid model on its own; a row the cheap model was unsure
     * about is flagged and waits. Quoting the expensive model here would attach a four-figure number
     * to a run that is about to spend nothing, and an estimate that cries wolf is one nobody reads.
     *
     * The paid model gets priced when the user starts the run that actually uses it — the one
     * carrying `useStrongModel`, which is the only thing that reaches it.
     */
    const firstId = col.firstModel?.trim();
    const usesFirst = !!firstId && firstId !== modelId && !useStrongModel;
    const effectivePerRow = usesFirst
      ? perRowCost({
          kind,
          modelId: firstId!,
          promptText: col.prompt ?? "",
          sheetId: col.sheetId,
          columnId: Number(col.id),
          turns: kind === "agent" ? turnsFor(col) : 1,
          // Search still bills, and bills through the search provider rather than the model — a local
          // first model is free to think and paid to look, exactly as it is on any other column.
          searchPerCall: perSearch,
          maxSearches: canSearch(col) ? Math.min(turnsFor(col), MAX_TOOL_CALLS) : 0,
          models,
        }).perRow
      : perRow;

    /**
     * Fan-out multiplies the per-row figure by the row's item count, which is a DISTRIBUTION, not a
     * number. Priced the way a waterfall is priced, for the same reason: the worst case answers
     * "could this exceed what I am willing to spend" — the sampled maximum, bounded by the cap — and
     * the average rides beside it so the dialog is not so pessimistic that nobody believes it.
     * The average is over every sampled row, so rows the executor will skip price in at nothing.
     */
    const fanStat = col.fanOut === "per_item" && col.fanOutSource != null
      ? fanOutDistribution(col.sheetId, Number(col.fanOutSource))
      : null;
    const cap = Math.max(1, Math.floor(Number(col.fanOutCap ?? 50)));
    const worstItems = fanStat ? Math.min(cap, Math.ceil(fanStat.max)) : 1;
    const avgItems = fanStat ? fanStat.avg : 1;

    const colTotal = effectivePerRow * worstItems * rowCount;

    total += colTotal;
    out.push({
      columnId: Number(col.id),
      name: col.name,
      kind,
      // The model this run will actually call, not the one the column is configured with. Naming the
      // expensive model beside a cheap-model price would be two halves of two different answers.
      model: usesFirst ? firstId! : modelId,
      perRow: effectivePerRow * worstItems,
      total: colTotal,
      bestPerRow: fanStat ? effectivePerRow * avgItems : undefined,
      bestTotal: fanStat ? effectivePerRow * avgItems * rowCount : undefined,
      fanOutItems: fanStat?.avg,
      fanOutMaxItems: fanStat ? worstItems : undefined,
      fanOutCap: fanStat ? cap : undefined,
    });
  }

  return {
    total,
    columns: out,
    incomplete,
    missingModels: [...new Set(missingModels)],
    catalogueReachable,
    external,
    // "Free" means NOTHING bills — not that the total rounded to zero, and not that we simply could
    // not price it. A million rows of a fraction-of-a-cent model rounds to nothing per row and is not
    // free; a million requests to somebody's metered API is not free either.
    //
    // A WATERFALL is free only when every step in it is. Testing the column's kind alone said "free"
    // for a waterfall with a declared $0.008 provider in it, because `waterfall` is neither `ai` nor
    // `agent` — the lane was new and the test was a list of the old ones. Asking what it actually
    // costs cannot go stale the next time a lane is added.
    free: !external && out.every((c) => c.kind !== "ai" && c.kind !== "agent" && c.total === 0),
  };
}

/** Blended dollars per million tokens, for showing a model's price beside its name. */
export { blended };
