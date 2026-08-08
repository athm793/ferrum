// HTTP surface. Commands are plain POST JSON; live state arrives on ONE SSE stream.
//
// Binding: localhost only. This process holds subscription tokens, provider API keys and a
// tool-capable agent runner — it must not be reachable from the network.
//
// ── A localhost bind is not a boundary on its own ────────────────────────────────────────────────
//
// Binding to 127.0.0.1 stops another machine connecting. It does NOT stop a web page the user is
// looking at from making the browser connect on its behalf, and DNS rebinding turns that page into
// a same-origin caller — at which point CORS stops applying and every route below is reachable by
// whatever site is open in another tab. Two guards close that, both at the top of createServer:
// the Host header must name this machine, and a mutating request must not announce that it comes
// from somewhere else. Both fail closed.

import express from "express";
import type { Request, Response } from "express";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { db, getKv, parseCellId, tx } from "./db.ts";
import { can, mayManage, mayRemove, neededFor, workbookAccess, asRole, type Capability, type Role } from "./access.ts";
import {
  SESSION_COOKIE, acceptInvite, actorOf, claimInstance, createInvite, endAllSessions, endSession,
  findByEmail, getPerson, grantOf, grantsFor, isClaimed, listInvites, listPeople, listSessions,
  hashPassword, peekInvite, purgeExpiredSessions, removePerson, revokeInvite, setDisabled, setGrant, setPassword,
  setRole, startSession, transferOwnership, verifyPassword, whoIs, type Person,
} from "./people.ts";
import { currentSeq, emitRun, markCellsDirty, subscribe } from "./bus.ts";
import { DATA_DIR, DB_PATH, TMP_DIR, isUnder, isUnderSyncRoot } from "./paths.ts";
import {
  addColumn, countRows, createSheet, deleteColumn, deleteColumns, deleteRow, deleteRows, deleteSheet, getCell, getSheet,
  duplicateSheet, getColumn, insertRows, listColumns, listSheets, listSiblingSheets, moveColumn,
  moveSheet, nextRowPosition, readWindow, renameColumn, renameSheet, setCellValue,
  duplicateColumn, setColumnDescription, setColumnSendConfig, setColumnWaterfall, setColumnWidth, setColumnColor,
  setColumnAgent, setColumnAllowedTools, setColumnAutoRun, setColumnAutoRunBudget, setColumnMaxBudget, setColumnFrozen, setColumnHttpConfig, setColumnMcpConfig, setColumnMcpServers, setColumnFirstModel, setColumnKind, setColumnModel, setColumnPrompt,
  setColumnValueType, setColumnEnumValues, setColumnFormat, unpinCell, setPrimaryColumn, setSheetKind, rowLabelColumn,
  type ReadOptions,
} from "./store.ts";
import { proposeSetup, safeHttp, storeRefs, type SetupArea, type WaterfallStepProposal } from "./setup/aiSetup.ts";
import { gatherEvidence } from "./setup/evidence.ts";
import { buildFixIntent } from "./setup/fixCell.ts";
import { errorFacts } from "./errorClass.ts";
import { redactSecrets } from "./redact.ts";
import { estimateSetupCost, getSetupSettings, setSetupSettings } from "./setup/setupModel.ts";
import { applyPlan, nextStep, type TablePlan, type Turn } from "./setup/tableWizard.ts";
import {
  applyAction, appendTurn, ask as askAssistant, clearConversation, describeTable, loadConversation,
  markApplied, parseReply, type Action, type Message,
} from "./setup/assistant.ts";
import {
  createSource, deleteSource, deliver, findByToken, listDeliveries, listSources, rotateToken,
  updateSource, MAX_BODY_BYTES,
} from "./sources/webhook.ts";
import { exportCsv, ImportCancelled, importCsv, previewCsv } from "./csv.ts";
import { isColumnKind, isSheetKind, isValueType } from "./types.ts";
import { checkKey, normalizeAgentSettings, searchCostUsd } from "./providers/openrouter.ts";
import { catalogAge, listModels, type CatalogModel } from "./providers/catalog.ts";
import { defaultLocalUrl, discoverLocalModels, isLocalModel, isLocalRuntimeId, localReach, localRuntimes, localSecretName, setLocalUrl } from "./providers/local.ts";
import { effectiveDefaultModel, getDefaultModelSetting, providerHasKey, providerKeyFor, setDefaultModelSetting } from "./providers/resolve.ts";
import { LLM_PROVIDERS, llmProvider } from "./providers/registry.ts";
/** What provider keys are filed under, so one can be told apart from a key the user made themselves. */
const MODEL_KEY_CATEGORY = "Model providers";

/**
 * A preset minus the three fields that describe the preset rather than the engine.
 *
 * `key`, `signupUrl`, `secretNames` and `note` exist to present a choice; they are not part of a
 * saved engine, and passing them through would store four fields `saveCustom` neither reads nor
 * round-trips — dead data that later reads as configuration.
 */
function stripPresetOnly(p: SearchPreset): Record<string, unknown> {
  const { key, signupUrl, secretNames, note, ...rest } = p;
  return rest;
}
import { cacheDirectModels, directModelsForPicker, forgetDirectModels, verifyProviderKey } from "./providers/direct.ts";
import { deletePrice, pricesFor, savePrice } from "./providers/prices.ts";
import { createRelation, deleteRelation, listRelations, rebuildRelationKeys, relationHealth, relationsSpanning, setMatchMode } from "./relations.ts";
import { lookupColumnsFor, noteRelationChange, setLookup } from "./lookup.ts";
import { setRollup } from "./rollup.ts";
import { usageReport } from "./usage.ts";
import { savingsFor } from "./savings.ts";
import { getSnapshot, listSnapshots, restoreSnapshot } from "./snapshots.ts";
import { parseWaterfall } from "./waterfall.ts";
import { proposePromotion, gatherExamples } from "./promoteRun.ts";
import { MIN_EXAMPLES } from "./promote.ts";
import { cacheDays, cacheEnabled, cacheStats, clearCache, setCacheDays, setCacheEnabled } from "./answerCache.ts";
import { deleteSecret, getSecretValue, listCategories, listSecrets, saveSecret, secretNamesIn } from "./secrets.ts";
import { createSchedule, deleteSchedule, getSchedule, listSchedules, paidColumnsOf, runScheduleNow, updateSchedule } from "./schedules.ts";
import { applyColumnTemplate, checkColumnTemplate, deleteColumnTemplate, listColumnTemplates, saveColumnTemplate, updateColumnTemplate } from "./columnTemplates.ts";
import { estimateRun, perRowCost, MAX_TOOL_CALLS } from "./estimate.ts";
import { notReadyReason } from "./columnReady.ts";
import { normalizeEnumValues } from "./enumValues.ts";
import { normalizeFormat } from "./valueFormat.ts";
import { DEFAULT_HTTP, normalizeHttpConfig } from "./http/httpColumn.ts";
import { normalizeMcpConfig } from "./mcp/mcpColumn.ts";
import { listMcpServers, saveMcpServer, deleteMcpServer, getMcpServer } from "./mcp/servers.ts";
import { parseMcpToolName } from "./mcp/agentTools.ts";
import { McpPool } from "./mcp/client.ts";
import { DEFAULT_MAX_SEARCHES, DEFAULT_MODEL, DEFAULT_SEARCH_BUDGET_USD } from "./agent/executor.ts";
import { deleteProviderKey, getProviderKey, providerKeyStatus, saveProviderKey } from "./providers/keys.ts";
import type { FilterGroup } from "./filter.ts";
import {
  createView, createWorkbook, deleteView, getView, getWorkbook, listTemplates,
  listTables, listViews, listWorkbooks, restoreTable, rowStatuses, setDefaultView, trashTable, updateView,
} from "./views.ts";
import {
  droppedRelationsIn, duplicateWorkbook, exportWorkbook, importWorkbook, literalSecretsIn,
  templatizeWorkbook, useTemplate,
} from "./workbookCopy.ts";
import { explainBlanks } from "./blanks.ts";
import {
  BACKENDS, backendSpec, chosenBackend, perSearchUsd, priceIsCustom, setChosenBackend, setPerSearchUsd,
} from "./search/registry.ts";
import { customPerSearchUsd, deleteCustom, getCustom, listCustom, saveCustom, tryCustom } from "./search/custom.ts";
import { preset, SEARCH_PRESETS, type SearchPreset } from "./search/presets.ts";
import { resolveScope, runnableColumns, type RunScope } from "./scope.ts";
import { forecastWithEstimate, sampleRowIds, DEFAULT_SAMPLE_ROWS } from "./sample.ts";
import {
  breadcrumb, createFolder, getFolder, listFolder, listRecent, listStarred, listWorkbook, markOpened,
  moveEntry, pathToSheet, renameFolder, search as searchWorkspace, setStarred, trashFolder,
} from "./workspace.ts";
import { approveScript, assertRunnable, getScript, listScripts, revokeApproval, saveScript } from "./scripts.ts";
import { runScriptColumn } from "./runtime/scriptRunner.ts";
import { cachedCanary, credentialStatus, saveCredential } from "./auth.ts";
import { countListItems, discoverJsonFields, discoverListItemFields, discoverListPaths, expandJsonColumn, mapJsonField, refreshChildren, refreshDerivedCell } from "./derive.ts";
import { apply as applyDedupe, autoDedupe, getConfig as getDedupe, preview as previewDedupe, setConfig as setDedupe } from "./dedupe.ts";
import {
  applyWrite, assertTargetExists, buildWriteItems, ensureBackRefColumn, planWrite, resolveSendScope,
  targetOf, DEFAULT_SEND,
  type SendConfig, type WriteItem,
} from "./writeTarget.ts";
import { markDownstreamStale, rebuildDeps } from "./refs.ts";
import { isFreeToRun, noteRowsArrived, noteUpstreamChange } from "./autoRun.ts";
import { getPath, toList } from "./jsonPath.ts";
import { cancelRun, createRun, executeRun, getRun, listRuns, pauseRun, resumeRun } from "./runs.ts";
import { getColumnStats, getSheetColumnStats, warmSheetStats } from "./columnStats.ts";
import { record, redo, snapshotRow, undo, undoState } from "./undo.ts";
import { checkValue, rulesProblem, type RuleSet } from "./validate.ts";

/** Ceiling on a dry run. Mirrored by TRY_MAX in web/src/prompt/ColumnEditor.tsx. */
const TRY_MAX_ROWS = 10_000;

/** Methods that change something. GETs are readable cross-origin only through a browser that has
 *  already been given a same-origin document, which the Host guard is what prevents. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A real hash of a password nobody has, verified against when the address is unknown.
 *
 * Sign-in must take the same time whether or not the account exists. Skipping the scrypt for an
 * unknown address answers "does this person have an account here?" in milliseconds, without the
 * response ever saying so.
 */
const DUMMY_HASH = hashPassword(randomBytes(32).toString("base64url"));

/**
 * Is this Host header naming THIS machine?
 *
 * The whole DNS-rebinding trick is that the attacker's page keeps its own name — `evil.example` —
 * while the address behind it becomes 127.0.0.1. The connection is genuinely local; the Host header
 * is the one thing that still says where the browser thought it was going.
 */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(?::\d{1,5})?$/i;

function hostIsLocal(host: unknown): boolean {
  return typeof host === "string" && LOOPBACK_HOST.test(host.trim());
}

/**
 * Whether an Origin names the same host the request was addressed to.
 *
 * The shared-instance counterpart of `originIsLocal`. A server answers to its own name, so "same
 * origin" there means "the Origin's host equals the Host header" rather than "the Origin is
 * loopback". Compared on hostname only: a proxy in front can terminate TLS, which changes the scheme
 * and the port without changing who is talking.
 */
function originMatchesHost(origin: string, host: unknown): boolean {
  if (typeof host !== "string" || !host) return false;
  try {
    return new URL(origin).hostname.toLowerCase() === host.trim().replace(/:\d+$/, "").toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Why a request was refused, said in terms of what the person would have to be.
 *
 * "Forbidden" sends someone looking for a bug. Naming the rung they are on and the rung the action
 * needs is the difference between a dead end and a message they can act on — usually by asking an
 * admin, which is the actual next step.
 */
function refusalFor(need: Capability, role: Role): string {
  switch (need) {
    case "spend":
      return role === "viewer"
        ? "Running a column spends money, and your account is read-only. Ask an admin to make you a member."
        : "You are not allowed to start runs here.";
    case "write":
      return "Your account is read-only. Ask an admin to make you a member.";
    case "settings":
      return "Only an admin can change the settings that affect everyone here.";
    case "people":
      return "Only an admin can see or change who is on this instance.";
    case "own":
      return "Only the owner can do that.";
    default:
      return "You are not allowed to do that.";
  }
}

/**
 * Whether this copy is meant to be reached from another machine.
 *
 * The Host guard above is exactly right for the single-user case and exactly wrong for the shared
 * one — a server answers to its own name, not to "localhost". So it is relaxed only when the process
 * was deliberately bound to a public address, and only then; the default remains loopback-only, and
 * an instance that has not been told to listen wider keeps every protection it has today.
 */
export const BIND_HOST = process.env.FERRUM_HOST ?? process.env.CLAYCODE_HOST ?? "127.0.0.1";
export const IS_SHARED = !(BIND_HOST === "127.0.0.1" || BIND_HOST === "localhost" || BIND_HOST === "::1");

/**
 * The cookies on a request, as a plain object.
 *
 * Hand-parsed rather than adding `cookie-parser`: it is six lines, this app reads exactly one cookie,
 * and a dependency in the authentication path is a dependency whose next version has to be read.
 */
function cookiesOf(header: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    if (!k || out[k] !== undefined) continue;             // first wins, like a browser
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Same question for an Origin/Referer, which arrives as a whole URL rather than a host. */
function originIsLocal(value: string): boolean {
  try {
    const h = new URL(value).hostname;
    return h === "localhost" || h === "[::1]" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

/**
 * What status an exception deserves — a refusal, or a fault.
 *
 * The distinction is drawn on the SHAPE of the error rather than on its text. Everything this app
 * refuses is a plain `new Error("a sentence for a person")`. Everything that goes wrong underneath
 * it arrives either as a built-in error type or carrying a `code` — `ERR_SQLITE_ERROR`, `ENOENT`,
 * `ECONNREFUSED`. Reading the message to guess would be the fragile version of the same test.
 */
function statusOf(e: unknown): number {
  const carried = Number((e as { status?: unknown; statusCode?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode);
  if (Number.isInteger(carried) && carried >= 400 && carried < 600) return carried;
  if (!(e instanceof Error)) return 500;
  if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) return 500;
  if (typeof (e as NodeJS.ErrnoException).code === "string") return 500;
  return 400;
}

/** How long an uploaded-but-never-imported CSV is kept before the next upload clears it out. */
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete staged CSV uploads that nothing is ever coming back for.
 *
 * The upload route writes the bytes to a temp file and hands the PATH to the browser; the import
 * that consumes it may simply never happen — the tab is closed, the preview fails, the mapping
 * screen is abandoned. Nothing deleted them, so one review session left 625 MB of raw customer
 * lists sitting in the temp directory next to files from an earlier session.
 *
 * Deliberately NOT deleted on import: the same staged file is legitimately imported into more than
 * one table, and removing it under the user would break an ordinary flow to fix a housekeeping
 * problem. Age is the only signal that is safe on its own.
 */
function sweepStagedUploads(): void {
  let names: string[];
  try { names = readdirSync(TMP_DIR); } catch { return; }
  const cutoff = Date.now() - STAGED_TTL_MS;
  for (const name of names) {
    // Only this route's own files. The directory is shared, and a sweep that deleted anything it
    // did not create would be a worse bug than the one it fixes.
    if (!name.startsWith("upload-")) continue;
    const p = join(TMP_DIR, name);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    } catch { /* gone already, or held open — either way not this request's problem */ }
  }
}

/**
 * A column's send configuration exactly as it is stored — the JSON TEXT, or null.
 *
 * Undo replays a field change as `UPDATE columns SET <field> = ?`, so what it records has to be the
 * value that statement can bind. The parsed object on `Column` is the right shape for every other
 * caller and the wrong one for this.
 */
function storedSendConfig(id: number | string): string | null {
  const row = db.prepare("SELECT send_config FROM columns WHERE id = ?").get(Number(id)) as { send_config?: string | null } | undefined;
  return row?.send_config ?? null;
}

/** The same, for a rule set: the undo entry replays raw SQL, so it stores the raw blob. */
function storedValidation(id: number | string): string | null {
  const row = db.prepare("SELECT validation FROM columns WHERE id = ?").get(Number(id)) as { validation?: string | null } | undefined;
  return row?.validation ?? null;
}

/** The same, for a waterfall, and for the same reason: the undo entry replays raw SQL. */
function storedWaterfall(id: number | string): string | null {
  const row = db.prepare("SELECT waterfall_json FROM columns WHERE id = ?").get(Number(id)) as { waterfall_json?: string | null } | undefined;
  return row?.waterfall_json ?? null;
}

/** Most rows one "add rows" call may create. Bulk loading goes through the CSV importer, which
 *  streams and commits in batches instead of building every cell in one transaction. */
const ADD_ROWS_MAX = 1000;

/**
 * Cells one paste may write.
 *
 * A block copied out of a spreadsheet is ordinary work — 5,000 rows across ten columns is a normal
 * lead list — so this is generous. It exists because the write is ONE synchronous transaction, and
 * past this size that transaction is long enough to stall every other request against the file. The
 * door built for more than this is the CSV import, which streams; the refusal says so.
 */
const BULK_CELLS_MAX = 100_000;

/**
 * Rows the list-field discovery reads.
 *
 * It answers "what is inside these items, and how many would a fan-out produce", and it answers it
 * by JSON-parsing every cell IN JAVASCRIPT. Unbounded, that is 11 seconds of a fully blocked event
 * loop on a million-row table — for one GET, on a single-threaded server, while every other request
 * waits. A sample answers the question; the response says it sampled and over how many rows, so the
 * screen cannot present the count as a total.
 */
const LIST_FIELD_SAMPLE_ROWS = 2_000;

export function createServer(bootId: string) {
  const app = express();

  // Express advertises itself by default. It tells an attacker which stack to aim at and tells a
  // user nothing.
  app.disable("x-powered-by");

  /**
   * A secret minted per boot and accepted as proof on any mutation.
   *
   * Deliberately NOT the boot id: that one is broadcast on the SSE hello frame and returned by the
   * health check, so it is public.
   *
   * NOTHING SERVES IT YET. There is no HTML injection here and `web/src/api.ts` does not send it, so
   * every request today is "absent" and the guards below rest on Origin and Sec-Fetch-Site instead —
   * headers a page cannot forge, which is why that is a boundary rather than a gap. Stated plainly,
   * because a security note describing a mechanism that does not exist is worse than no note at all:
   * it invites the next reader to rely on it.
   */
  const mutationToken = randomBytes(24).toString("base64url");

  const tokenPresented = (req: Request): "absent" | "ok" | "wrong" => {
    const raw = req.headers["x-ferrum-token"];
    const got = Array.isArray(raw) ? raw[0] : raw;
    if (typeof got !== "string" || got.length === 0) return "absent";
    const a = Buffer.from(got);
    const b = Buffer.from(mutationToken);
    return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "wrong";
  };

  /**
   * Everything answers on localhost only — except the delivery endpoint.
   *
   * `/hook` is exempt on purpose. It is the one address a stranger is MEANT to post to, and the
   * documented way to expose it is a tunnel (`cloudflared`, `ngrok http 4317`) which forwards the
   * public hostname in the Host header. Refusing that would break the only integration path the
   * product offers. Nothing is lost: a delivery's credential is the token in its path, and rebinding
   * hands an attacker no token it did not already have.
   */
  app.use((req, res, next) => {
    if (req.path.startsWith("/hook")) return next();
    // A shared instance answers to its own name. See IS_SHARED — the default is still loopback-only.
    if (IS_SHARED) return next();
    if (!hostIsLocal(req.headers.host)) {
      res.status(403).json({
        error: "Ferrum only answers when it is addressed as localhost. This request named a different host.",
      });
      return;
    }
    next();
  });

  /**
   * A mutation must not announce that it came from somewhere else.
   *
   * With the Host guard above, a cross-site page can no longer become same-origin — so it is stuck
   * being cross-site, and a browser says so on every request it makes: `Origin` on anything that
   * is not a plain navigation, and `Sec-Fetch-Site` on everything. Neither header can be forged by
   * the page. So this refuses any mutation that declares a foreign origin.
   *
   * A request carrying NEITHER header is something on this machine that is not a browser — a
   * script, curl, the bench harness — and is allowed, because anything running as this user can
   * already read the database and the credentials file directly. That exemption is also the one
   * thing keeping the token optional: the moment web/src/api.ts sends `x-ferrum-token` on every
   * mutation (one line in `req()`), this can require it outright and drop the exemption.
   */
  app.use((req, res, next) => {
    if (!MUTATING.has(req.method) || req.path.startsWith("/hook")) return next();

    const token = tokenPresented(req);
    if (token === "ok") return next();
    // A token that is present and wrong is a stale tab or a forgery. Either way it is not this boot.
    if (token === "wrong") {
      res.status(403).json({ error: "That page was loaded from an older run of Ferrum. Reload it." });
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === "string" && origin && origin !== "null" && !originIsLocal(origin)) {
      res.status(403).json({ error: "Cross-site requests cannot change anything here." });
      return;
    }
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      res.status(403).json({ error: "Cross-site requests cannot change anything here." });
      return;
    }
    next();
  });

  /**
   * The stricter form, for the two routes that repoint the engine at a different account.
   *
   * Here an anonymous caller is NOT waved through: the request has to be either the app's own page
   * (a loopback Origin, or a browser reporting same-origin) or the holder of this boot's token.
   * Overwriting the stored credential is how an attacker makes the victim's rows run — and be
   * charged — against the attacker's key, so "it did not say where it came from" is not good enough.
   */
  const provenLocal = (req: Request): boolean => {
    if (tokenPresented(req) === "ok") return true;
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin && origin !== "null") return originIsLocal(origin);
    const site = req.headers["sec-fetch-site"];
    return site === "same-origin";
  };

  /**
   * The refusal `provenLocal` produces. One place, so the routes behind it cannot drift.
   *
   * The reason is a parameter because the guard covers routes with different stakes. "This changes
   * which account Ferrum spends against" is true of the credential routes and false of clearing the
   * cache, and a refusal that misstates why it refused sends whoever hit it looking in the wrong
   * place.
   */
  const refuseUnproven = (res: Response, because = "changes which account Ferrum spends against"): void => {
    res.status(403).json({
      error:
        `This ${because}, so it only accepts requests it can tell came from Ferrum's own page. ` +
        "Use the app, or send an Origin of http://127.0.0.1.",
    });
  };

  /**
   * The delivery endpoint takes its body RAW, and must be mounted before the JSON parser.
   *
   * Route-level middleware runs after app-level middleware, so `express.json()` had already consumed
   * the stream and handed the route a parsed object — which the raw handler then stringified to
   * "[object Object]" and failed to parse. Every delivery was rejected as "body must be JSON",
   * including the ones that were.
   *
   * Raw rather than parsed because the body is recorded verbatim: "the sender is posting
   * form-encoded" is only diagnosable by seeing exactly what arrived.
   */
  app.use("/hook", express.raw({ type: "*/*", limit: MAX_BODY_BYTES }));
  app.use(express.json({ limit: "4mb" }));

  // ───────────────────────────────────────────────────── who is asking
  //
  // Everything from here to the end of this block is inert on a single-user install: with no rows in
  // `users` the instance is unclaimed, `signedIn` is null, and every check below waves the request
  // through exactly as it did before teams existed. The moment somebody claims it, the same code
  // starts requiring a session — there is no second setting to be left off.

  /** The session cookie on this request, or undefined. */
  const sessionToken = (req: Request): string | undefined =>
    cookiesOf(req.headers.cookie)[SESSION_COOKIE];

  /**
   * Which workbook a request is about, or null if it is not about one.
   *
   * Walked from whatever id the path carries back to the workbook, because that is where a
   * restriction is set. Every one of these is a primary-key lookup on an indexed column.
   *
   * Returns `"unknown"` — distinct from null — when the path names something that SHOULD resolve and
   * did not. That is the fail-closed case: a cell id that matches no row is refused rather than
   * treated as unscoped, because "I could not work out what this touches" is not permission.
   */
  type Scope = { workbookId: string } | null | "unknown";
  const ONE = (sql: string, id: string): any => { try { return db.prepare(sql).get(id); } catch { return undefined; } };

  function scopeOf(path: string): Scope {
    const m = /^\/api\/(workbooks|sheets|columns|rows|cells|views|runs|schedules|relations|scripts|sources)\/([^/]+)/.exec(path);
    if (!m) return null;
    const [, what, rawId] = m as unknown as [string, string, string];
    const id = decodeURIComponent(rawId);
    let sheetId: string | undefined;
    switch (what) {
      case "workbooks":
        return ONE("SELECT id FROM workbooks WHERE id = ?", id) ? { workbookId: id } : "unknown";
      case "relations": {
        const r = ONE("SELECT workbook_id w FROM relations WHERE id = ?", id);
        return r?.w ? { workbookId: String(r.w) } : "unknown";
      }
      case "sheets":    sheetId = id; break;
      case "views":     sheetId = ONE("SELECT sheet_id s FROM views WHERE id = ?", id)?.s; break;
      case "runs":      sheetId = ONE("SELECT sheet_id s FROM runs WHERE id = ?", id)?.s; break;
      case "schedules": sheetId = ONE("SELECT sheet_id s FROM schedules WHERE id = ?", id)?.s; break;
      case "sources":   sheetId = ONE("SELECT sheet_id s FROM webhook_sources WHERE id = ?", id)?.s; break;
      case "rows":      sheetId = ONE("SELECT sheet_id s FROM rows WHERE id = ?", id)?.s; break;
      case "columns":   sheetId = ONE("SELECT sheet_id s FROM columns WHERE id = ?", id)?.s; break;
      case "scripts":
        sheetId = ONE("SELECT c.sheet_id s FROM scripts sc JOIN columns c ON c.id = sc.column_id WHERE sc.id = ?", id)?.s;
        break;
      case "cells":
        sheetId = ONE("SELECT r.sheet_id s FROM cells c JOIN rows r ON r.id = c.row_id WHERE c.id = ?", id)?.s;
        break;
    }
    if (!sheetId) return "unknown";
    const wb = ONE("SELECT workbook_id w FROM sheets WHERE id = ?", String(sheetId))?.w;
    return wb ? { workbookId: String(wb) } : "unknown";
  }

  /**
   * The restricted workbooks this person cannot reach, as a set of ids.
   *
   * Listing routes need this and the per-request gate does not: the gate answers "may I touch THIS
   * one?", and a list has to answer "which ones do I not mention at all?". Without it the gate works
   * perfectly and the file browser still shows the NAME of every restricted workbook — which for a
   * workbook called "Acquisition targets" is most of the secret. Reproduced exactly that way.
   *
   * Empty on a single-user install and on an instance with no restricted workbooks, which is the
   * normal case — so the filter below costs one query that usually returns nothing.
   */
  const hiddenWorkbooks = (req: Request): Set<string> => {
    const person = (req as any).person as Person | null;
    if (!isClaimed() || !person) return new Set();
    if (can((req as any).actor, "settings")) return new Set();   // an admin is not hidden from
    const rows = db.prepare(
      `SELECT w.id FROM workbooks w
        WHERE w.restricted = 1
          AND (w.created_by IS NULL OR w.created_by <> ?)
          AND NOT EXISTS (SELECT 1 FROM workbook_grants g WHERE g.workbook_id = w.id AND g.user_id = ?)`,
    ).all(person.id, person.id) as any[];
    return new Set(rows.map((r) => String(r.id)));
  };

  /** The same answer for a list of things that each name a workbook, directly or through a sheet. */
  const visible = <T,>(req: Request, items: T[], workbookIdOf: (item: T) => string | null | undefined): T[] => {
    const hidden = hiddenWorkbooks(req);
    if (hidden.size === 0) return items;
    return items.filter((i) => {
      const wb = workbookIdOf(i);
      return !wb || !hidden.has(String(wb));
    });
  };

  /** Which workbook a sheet belongs to, for the filter above. One indexed lookup, memo-free. */
  const workbookOfSheet = (sheetId: string): string | null =>
    (db.prepare("SELECT workbook_id w FROM sheets WHERE id = ?").get(sheetId) as any)?.w ?? null;

  /** Paths reachable with no session at all — signing in, and the pages that create the first one. */
  const OPEN_PATHS = new Set([
    "/api/session",           // GET: who am I / is this claimed. POST: sign in. DELETE: sign out.
    "/api/session/claim",     // the first account on an unclaimed instance
    "/api/session/invite",    // what an invitation is for, and accepting it
    "/api/health",
  ]);
  const isOpen = (path: string): boolean =>
    OPEN_PATHS.has(path) || path.startsWith("/api/session/invite/");

  /**
   * The gate.
   *
   * Order matters and is the whole design: identify, then refuse the unidentified, then check the
   * capability the path needs, then check the workbook it touches. Each step is allowed to say no,
   * and a step that cannot answer says no rather than deferring to the next one.
   */
  app.use("/api", (req, res, next) => {
    const token = sessionToken(req);
    const person = whoIs(token);
    (req as any).person = person;
    (req as any).actor = actorOf(person);

    /**
     * The FULL path, rebuilt.
     *
     * Inside `app.use("/api", …)` Express strips the mount point, so `req.path` here is
     * "/session/invite" rather than "/api/session/invite". Every table in this file is written in
     * terms of the whole path — which is how it reads in the routes, in access.ts and in a browser's
     * network tab — so getting this wrong makes the open-path list and the capability table miss
     * silently: the first symptom was every signed-out sign-up route answering "please sign in".
     */
    const path = `${req.baseUrl}${req.path}`;

    if (!isClaimed()) return next();                       // single-user: nothing to enforce
    if (isOpen(path)) return next();

    if (!person) {
      res.status(401).json({ error: "Please sign in.", code: "signin_required" });
      return;
    }

    /**
     * A cookie-authenticated change must prove it came from this app's own page.
     *
     * Before teams, a request carrying no Origin and no Sec-Fetch-Site was waved through, because
     * anything running as this user could already read the database directly. A cookie breaks that
     * reasoning: the browser now attaches the credential automatically, which is the whole mechanism
     * of cross-site request forgery. So for a signed-in mutation the evidence is required rather than
     * merely respected when offered. A browser cannot forge either header, and a script that has no
     * cookie is unaffected by this line.
     */
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      const site = req.headers["sec-fetch-site"];
      const sameSite = site === "same-origin" || site === "none";
      const okOrigin = typeof origin === "string" && origin !== "null"
        ? originIsLocal(origin) || originMatchesHost(origin, req.headers.host)
        : false;
      if (!sameSite && !okOrigin && tokenPresented(req) !== "ok") {
        res.status(403).json({ error: "That request did not come from Ferrum's own page." });
        return;
      }
    }

    const need = neededFor(req.method, path);
    if (!can((req as any).actor, need)) {
      res.status(403).json({ error: refusalFor(need, person.role), code: "not_allowed", need });
      return;
    }

    const scope = scopeOf(path);
    if (scope === "unknown") {
      // Nothing here to check permission against. On a claimed instance that is a refusal, not a
      // shrug — the alternative is that a mistyped id becomes the way past the check.
      res.status(404).json({ error: "That no longer exists." });
      return;
    }
    if (scope) {
      const wb = db.prepare("SELECT restricted, created_by FROM workbooks WHERE id = ?").get(scope.workbookId) as any;
      const access = workbookAccess(
        (req as any).actor,
        { restricted: Number(wb?.restricted ?? 0) === 1, createdBy: wb?.created_by == null ? null : Number(wb.created_by) },
        grantOf(scope.workbookId, person.id),
      );
      if (access === "none") {
        // 404 rather than 403 on purpose: a restricted workbook should not confirm its own existence
        // to somebody who has not been given it.
        res.status(404).json({ error: "That no longer exists." });
        return;
      }
      if (access === "view" && neededFor(req.method, path) !== "read") {
        res.status(403).json({ error: "You have been given this workbook to read, not to change." });
        return;
      }
    }
    next();
  });

  // Express 5 types route params as `string | string[]` (a param can repeat). Every route here wants
  // a single value, so normalize once rather than asserting at each call site.
  const param = (req: Request, name: string): string => {
    const v = (req.params as Record<string, string | string[] | undefined>)[name];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };

  /**
   * Turn the grid's query string into a ReadOptions.
   *
   * ONE function, used by the rows route and by scope resolution, because "when the grid is
   * filtered, running acts on the visible rows" is only true if both sides derive the predicate the
   * same way. Two parsers would drift and the run would quietly cover a different set than the one
   * on screen — the most expensive kind of bug this app can have.
   */
  const readOptionsFrom = (req: Request, sheetId: string): ReadOptions => {
    const filters: FilterGroup[] = [];

    if (req.query.view) {
      const v = getView(Number(req.query.view));
      if (v && v.sheetId === sheetId && v.filter) filters.push(v.filter);
    }

    // The filter bar's unsaved state, sent as JSON.
    //
    // Parsed defensively: a malformed value narrows NOTHING rather than throwing. A filter that
    // fails to parse and takes the whole rows request down turns a typo into an empty grid, and the
    // user cannot tell that apart from "no rows match".
    if (typeof req.query.filter === "string" && req.query.filter.trim()) {
      try {
        const parsed = JSON.parse(req.query.filter) as FilterGroup;
        if (parsed && Array.isArray(parsed.children) && parsed.children.length > 0) filters.push(parsed);
      } catch { /* ignored — compileFilter validates shape anyway, and this is the outer guard */ }
    }

    // A cell status is per-column, but the toolbar's filter means "any cell in this row". So it
    // expands to one condition per column, OR'd. That is N EXISTS probes, but they are evaluated
    // once when the view index is built rather than on every scroll.
    const statuses = String(req.query.status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      const cols = listColumns(sheetId);
      if (cols.length > 0) {
        filters.push({
          conj: "or",
          children: cols.map((c) => ({ columnId: Number(c.id), op: "status_is" as const, value: statuses })),
        });
      }
    }

    const filter: FilterGroup | null =
      filters.length === 0 ? null
      : filters.length === 1 ? filters[0]!
      : { conj: "and", children: filters };

    const sortCol = Number(req.query.sort);
    const sort = Number.isInteger(sortCol) && sortCol > 0
      ? { columnId: sortCol, dir: req.query.dir === "desc" ? ("desc" as const) : ("asc" as const) }
      : null;

    return { filter, search: typeof req.query.q === "string" ? req.query.q : null, sort };
  };

  /**
   * The one error path every route shares.
   *
   * Faults are separated from refusals. Answering 400 with the raw exception text for everything is
   * wrong twice over: a SQLite failure reads to the user as if THEY sent something invalid, and
   * because it looks like an ordinary rejection it is never logged, so the one class of fault that
   * needs a stack produces none anywhere.
   * A refusal is an Error this app threw on purpose, whose
   * message is written for a person ("That destination table no longer exists."); it keeps its 400
   * and its message. Anything else — a driver error, a TypeError, a thrown non-Error — is a 500
   * with a fixed sentence, and the stack goes to the log where it is useful. The response body is
   * still message-only; a stack trace over HTTP tells an attacker the filesystem layout.
   */
  const wrap =
    (fn: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (e) {
        if (res.headersSent) return;
        const status = statusOf(e);
        if (status >= 500) {
          console.error(`[api] ${req.method} ${req.originalUrl}`, e);
          res.status(status).json({ error: "Something went wrong inside Ferrum. The details are in the server log." });
          return;
        }
        res.status(status).json({ error: e instanceof Error ? e.message : String(e) });
      }
    };

  // ───────────────────────────────────────────────────── live stream

  app.get("/api/stream", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer would defeat the whole point of streaming.
      "X-Accel-Buffering": "no",
    });

    const write = (event: string, data: unknown, id?: number) => {
      if (id != null) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    /**
     * Which workbook a column belongs to, memoised for the life of this connection.
     *
     * A frame carries up to 2000 cells and a burst repeats the same handful of columns, so the
     * alternative is thousands of identical lookups per second per subscriber. A column does not
     * move between workbooks, so the memo cannot go stale in a way that matters.
     */
    const columnWorkbook = new Map<number, string | null>();
    const workbookOfColumn = (columnId: number): string | null => {
      const seen = columnWorkbook.get(columnId);
      if (seen !== undefined) return seen;
      const wb = (db
        .prepare("SELECT s.workbook_id w FROM columns c JOIN sheets s ON s.id = c.sheet_id WHERE c.id = ?")
        .get(columnId) as any)?.w;
      const answer = wb == null ? null : String(wb);
      columnWorkbook.set(columnId, answer);
      return answer;
    };

    /**
     * The same filter the REST reads apply, applied per subscriber.
     *
     * The bus broadcasts one frame to everyone, and the frame carries values, costs and error text.
     * Without this, an account that is deliberately 404'd out of a restricted workbook still watched
     * its cells fill in live — the gate held on every route and the stream handed over the data
     * anyway. `hiddenWorkbooks` is re-read per frame rather than captured at connect, so removing
     * someone's grant stops the frames without waiting for them to reconnect.
     *
     * Anything whose workbook cannot be resolved is dropped, not sent: "I could not work out what
     * this touches" is the same fail-closed answer the request gate gives.
     */
    const forViewer = (event: string, data: unknown, hidden: Set<string>): unknown | null => {
      const frame = data as any;
      const shown = (workbookId: string | null): boolean => workbookId != null && !hidden.has(workbookId);
      switch (event) {
        case "cells": {
          const cells = (Array.isArray(frame?.cells) ? frame.cells : []).filter((c: any) => {
            const parsed = parseCellId(String(c?.i ?? ""));
            return parsed ? shown(workbookOfColumn(Number(parsed.columnId))) : false;
          });
          return cells.length > 0 ? { ...frame, cells } : null;
        }
        case "run":
          return shown(frame?.run?.sheetId ? workbookOfSheet(String(frame.run.sheetId)) : null) ? frame : null;
        case "columnStats": {
          const stats = (Array.isArray(frame?.stats) ? frame.stats : [])
            .filter((s: any) => shown(workbookOfColumn(Number(s?.columnId))));
          return stats.length > 0 ? { ...frame, stats } : null;
        }
        default:
          // `hello` and `quota` are about the instance, not about a workbook.
          return frame;
      }
    };

    const send = (event: string, data: unknown, id?: number) => {
      const hidden = hiddenWorkbooks(req);
      if (hidden.size === 0) return write(event, data, id);
      const kept = forViewer(event, data, hidden);
      if (kept !== null) write(event, kept, id);
    };

    // The stream never replays history — the client takes a snapshot via the REST window fetch and
    // then applies deltas, deduped by per-cell rev.
    write("hello", { seq: currentSeq(), bootId });

    const unsub = subscribe(send);
    // Some intermediaries drop an idle connection; a comment line keeps it warm without being an event.
    const ka = setInterval(() => res.write(": keepalive\n\n"), 25_000);
    ka.unref?.();

    req.on("close", () => { clearInterval(ka); unsub(); });
  });

  // ───────────────────────────────────────────────────── health

  app.get("/api/health", wrap((req, res) => {
    /**
     * The short answer for a caller with no session.
     *
     * This route is open so that a monitor can tell whether the process is up and so that the setup
     * screen works before anyone has claimed the instance. It answered rather more than that: the
     * absolute path of the database, how many tables and rows are in it, and which credential mode
     * the engine is in, to anybody who could reach the port. On a shared bind that is a stranger.
     * "Is it up" is still answered, in full, with a 200.
     */
    if (isClaimed() && !(req as any).person) return res.json({ ok: true });

    const counts = db
      .prepare("SELECT (SELECT COUNT(*) FROM sheets WHERE archived=0) AS sheets, (SELECT COUNT(*) FROM rows) AS rows")
      .get() as any;
    const warnings: string[] = [];
    if (isUnderSyncRoot(DB_PATH)) {
      warnings.push(
        "The database is inside a file-sync folder (OneDrive/Dropbox). SQLite WAL files and sync clients corrupt each other — move CLAYCODE_DATA_DIR somewhere unsynced.",
      );
    }
    const cred = credentialStatus();
    // Cached, so a health poll does not cost a round trip. `canaryOk: null` means "not checked yet",
    // which is deliberately distinct from `false` — reporting an unverified token as working is how
    // a 200,000-cell run gets started against a dead credential.
    const canary = cred.present ? cachedCanary() : null;

    res.json({
      ok: true,
      bootId,
      node: process.version,
      db: { path: DB_PATH, sheets: Number(counts.sheets), rows: Number(counts.rows) },
      auth: {
        mode: cred.mode,
        present: cred.present,
        label: cred.label,          // masked; the token itself is never returned over HTTP
        canaryOk: canary ? canary.ok : null,
        canaryMs: canary?.ms ?? null,
        error: canary?.ok === false ? canary.error : undefined,
      },
      warnings,
    });
  }));

  // ───────────────────────────────────────────────────── who you are
  //
  // Signing in, signing out, claiming an unclaimed instance, and accepting an invitation. These are
  // the only routes reachable without a session, which is why each one is deliberately small.

  const me = (req: Request): Person | null => (req as any).person ?? null;
  const requireMe = (req: Request): Person => {
    const p = me(req);
    if (!p) throw new Error("Please sign in.");
    return p;
  };

  /**
   * Set (or clear) the session cookie.
   *
   * `httpOnly` so a script on the page cannot read it — the single most valuable property here, and
   * the reason the token is a cookie rather than something in local storage. `sameSite: Lax` stops a
   * cross-site POST carrying it, which is the CSRF half. `secure` only on a shared instance: setting
   * it on plain http://localhost would make the browser drop the cookie entirely, so the local
   * install would silently never stay signed in.
   */
  const setSessionCookie = (res: Response, token: string | null): void => {
    const bits = [
      `${SESSION_COOKIE}=${token ?? ""}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      token ? `Max-Age=${30 * 86_400}` : "Max-Age=0",
    ];
    if (IS_SHARED) bits.push("Secure");
    res.setHeader("Set-Cookie", bits.join("; "));
  };

  /** The shape the app reads on every load to decide which screen to show. */
  const sessionState = (req: Request) => {
    const p = me(req);
    return {
      claimed: isClaimed(),
      shared: IS_SHARED,
      person: p && { id: p.id, email: p.email, name: p.name, role: p.role },
      can: p
        ? {
            write: can(actorOf(p), "write"),
            spend: can(actorOf(p), "spend"),
            settings: can(actorOf(p), "settings"),
            people: can(actorOf(p), "people"),
            own: can(actorOf(p), "own"),
          }
        // An unclaimed instance is single-user: everything is allowed, because there is nobody to
        // distinguish from. Stated rather than left undefined so the client has one shape to read.
        : { write: true, spend: true, settings: true, people: true, own: true },
    };
  };

  app.get("/api/session", wrap((req, res) => res.json(sessionState(req))));

  app.post("/api/session", wrap((req, res) => {
    const person = findByEmail(String(req.body?.email ?? ""));
    const hash = person
      ? String((db.prepare("SELECT password_hash h FROM users WHERE id = ?").get(person.id) as any)?.h ?? "")
      : "";
    /**
     * One message for a wrong address and a wrong password, and the work is done either way.
     *
     * Telling them apart turns the sign-in form into a way to ask "does this person have an account
     * here?" — and answering FASTER for an unknown address answers the same question without saying
     * anything, which is why the hash is verified against a dummy rather than skipped.
     */
    const ok = person && !person.disabled
      ? verifyPassword(String(req.body?.password ?? ""), hash)
      : (verifyPassword(String(req.body?.password ?? ""), DUMMY_HASH), false);
    if (!ok || !person) {
      res.status(401).json({ error: "That email address and password do not match an account here." });
      return;
    }
    const token = startSession(person.id, {
      userAgent: String(req.headers["user-agent"] ?? ""),
      ip: String(req.ip ?? ""),
    });
    setSessionCookie(res, token);
    (req as any).person = person;
    res.json(sessionState(req));
  }));

  app.delete("/api/session", wrap((req, res) => {
    endSession(sessionToken(req));
    setSessionCookie(res, null);
    (req as any).person = null;
    res.json(sessionState(req));
  }));

  /**
   * The first account. Becomes the owner, and turns authentication on for everyone.
   *
   * `claimInstance` refuses once anybody exists, so this cannot be replayed later to mint a second
   * owner — which matters most on the deployment this whole feature is for, where the address stays
   * reachable forever.
   */
  app.post("/api/session/claim", wrap((req, res) => {
    const person = claimInstance(String(req.body?.email ?? ""), String(req.body?.password ?? ""), String(req.body?.name ?? ""));
    const token = startSession(person.id, { userAgent: String(req.headers["user-agent"] ?? ""), ip: String(req.ip ?? "") });
    setSessionCookie(res, token);
    (req as any).person = person;
    res.json(sessionState(req));
  }));

  /** What an invitation is for, so the sign-up page can say the address and the role before anyone types. */
  app.get("/api/session/invite/:token", wrap((req, res) => {
    const found = peekInvite(param(req, "token"));
    if (!found) {
      res.status(404).json({ error: "That invitation has been used already, or it has expired. Ask for a new one." });
      return;
    }
    res.json({ invite: found });
  }));

  app.post("/api/session/invite", wrap((req, res) => {
    const person = acceptInvite(String(req.body?.token ?? ""), String(req.body?.password ?? ""), String(req.body?.name ?? ""));
    const token = startSession(person.id, { userAgent: String(req.headers["user-agent"] ?? ""), ip: String(req.ip ?? "") });
    setSessionCookie(res, token);
    (req as any).person = person;
    res.json(sessionState(req));
  }));

  /** Your own account: the name, the password, and where you are signed in. */
  app.patch("/api/session/me", wrap((req, res) => {
    const p = requireMe(req);
    if (typeof req.body?.name === "string") {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(req.body.name.trim().slice(0, 120), p.id);
    }
    if (typeof req.body?.password === "string") {
      // The current password is required even though they are already signed in: an unattended
      // screen is how an account is taken over, and this is the change that locks the owner out.
      const hash = String((db.prepare("SELECT password_hash h FROM users WHERE id = ?").get(p.id) as any)?.h ?? "");
      if (!verifyPassword(String(req.body?.currentPassword ?? ""), hash)) {
        res.status(403).json({ error: "That is not your current password." });
        return;
      }
      setPassword(p.id, req.body.password);
      // setPassword ends every session, including this one. Start a fresh one rather than signing
      // the person out of the screen they are standing in front of.
      setSessionCookie(res, startSession(p.id, { userAgent: String(req.headers["user-agent"] ?? ""), ip: String(req.ip ?? "") }));
    }
    (req as any).person = getPerson(p.id);
    res.json(sessionState(req));
  }));

  app.get("/api/session/devices", wrap((req, res) => {
    res.json({ sessions: listSessions(requireMe(req).id, sessionToken(req)) });
  }));

  app.post("/api/session/devices/end-others", wrap((req, res) => {
    const p = requireMe(req);
    endAllSessions(p.id);
    const token = startSession(p.id, { userAgent: String(req.headers["user-agent"] ?? ""), ip: String(req.ip ?? "") });
    setSessionCookie(res, token);
    res.json({ ok: true, sessions: listSessions(p.id, token) });
  }));

  // ───────────────────────────────────────────────────── who else is here
  //
  // Admin only, enforced by the gate above via `neededFor` — these handlers do not repeat that check.
  // What they DO check is the part a path cannot express: which particular person may be acted on.

  app.get("/api/people", wrap((_req, res) => {
    res.json({ people: listPeople(), invites: listInvites() });
  }));

  app.post("/api/invites", wrap((req, res) => {
    const p = requireMe(req);
    const role = asRole(req.body?.role);
    if (role === "owner") {
      res.status(400).json({ error: "There is only ever one owner. Invite them as an admin and hand the instance over." });
      return;
    }
    const { token } = createInvite(String(req.body?.email ?? ""), role, p.id);
    /**
     * The link is returned ONCE, and only its hash is kept.
     *
     * There is no mail server here on purpose: the instance needs no outbound credentials, and the
     * admin sends the link however they already talk to that person. The cost is that a lost link
     * cannot be re-read — so a new invitation is issued instead, which also revokes the old one.
     */
    res.json({ ok: true, link: `/invite/${token}`, invites: listInvites() });
  }));

  app.delete("/api/invites/:email", wrap((req, res) => {
    revokeInvite(decodeURIComponent(param(req, "email")));
    res.json({ ok: true, invites: listInvites() });
  }));

  app.patch("/api/people/:id", wrap((req, res) => {
    const actor = (req as any).actor;
    const target = getPerson(Number(param(req, "id")));
    if (!target) { res.status(404).json({ error: "That person no longer has an account here." }); return; }

    if (req.body?.role !== undefined) {
      const next = asRole(req.body.role);
      const verdict = mayManage(actor, target, next);
      if (!verdict.ok) { res.status(403).json({ error: verdict.because }); return; }
      // Handing over is two writes and has to be one of them, so `transferOwnership` owns it rather
      // than this route setting a second owner and then demoting the first.
      if (next === "owner") transferOwnership(requireMe(req).id, target.id);
      else setRole(target.id, next);
    }

    if (req.body?.disabled !== undefined) {
      const verdict = mayRemove(actor, target);   // suspension is removal's sibling, same protections
      if (!verdict.ok) { res.status(403).json({ error: verdict.because }); return; }
      setDisabled(target.id, Boolean(req.body.disabled));
    }

    res.json({ ok: true, people: listPeople() });
  }));

  app.delete("/api/people/:id", wrap((req, res) => {
    const target = getPerson(Number(param(req, "id")));
    if (!target) { res.status(404).json({ error: "That person no longer has an account here." }); return; }
    const verdict = mayRemove((req as any).actor, target);
    if (!verdict.ok) { res.status(403).json({ error: verdict.because }); return; }
    removePerson(target.id);
    res.json({ ok: true, people: listPeople() });
  }));

  // ───────────────────────────────────────────────────── sharing one workbook
  //
  // Not under /api/people: this is a property of the WORKBOOK, so it goes through the same scope
  // check as everything else about it — which is what stops someone sharing a workbook they cannot
  // themselves reach.

  app.get("/api/workbooks/:id/access", wrap((req, res) => {
    const id = param(req, "id");
    const wb = db.prepare("SELECT restricted FROM workbooks WHERE id = ?").get(id) as any;
    if (!wb) { res.status(404).json({ error: "That workbook no longer exists." }); return; }
    res.json({
      restricted: Number(wb.restricted ?? 0) === 1,
      grants: grantsFor(id),
      // The list to choose from. Only an admin can see everyone; a member sharing their own workbook
      // is handed nothing, because a picker of every colleague is a directory they were not given.
      people: can((req as any).actor, "people") ? listPeople() : [],
    });
  }));

  app.patch("/api/workbooks/:id/access", wrap((req, res) => {
    const id = param(req, "id");
    if (!db.prepare("SELECT 1 FROM workbooks WHERE id = ?").get(id)) {
      res.status(404).json({ error: "That workbook no longer exists." });
      return;
    }
    if (req.body?.restricted !== undefined) {
      const on = Boolean(req.body.restricted);
      tx(() => {
        db.prepare("UPDATE workbooks SET restricted = ? WHERE id = ?").run(on ? 1 : 0, id);
        // Restricting a workbook with nobody on it would lock out everyone including whoever just
        // pressed the button. They get themselves, immediately, in the same transaction.
        if (on) setGrant(id, requireMe(req).id, "edit");
      });
    }
    if (req.body?.grant) {
      const userId = Number(req.body.grant.userId);
      const access = req.body.grant.access === null ? null : req.body.grant.access === "edit" ? "edit" : "view";
      if (!getPerson(userId)) { res.status(404).json({ error: "That person no longer has an account here." }); return; }
      setGrant(id, userId, access);
    }
    const wb = db.prepare("SELECT restricted FROM workbooks WHERE id = ?").get(id) as any;
    res.json({ ok: true, restricted: Number(wb?.restricted ?? 0) === 1, grants: grantsFor(id) });
  }));

  // ───────────────────────────────────────────────────── auth

  app.get("/api/auth", wrap((_req, res) => res.json({ auth: credentialStatus() })));

  app.post("/api/auth/token", wrap((req, res) => {
    // The stricter guard, actually called. `provenLocal` was written for exactly these two routes
    // and then never invoked, so the hardening was inert: an anonymous POST still overwrote the
    // stored credential, which is how an attacker makes the victim's rows run — and be charged —
    // against the attacker's account.
    if (!provenLocal(req)) return refuseUnproven(res);
    const token = String(req.body?.token ?? "").trim();
    if (!token) return res.status(400).json({ error: "Paste the token from `claude setup-token`." });
    saveCredential(token, req.body?.mode === "api_key" ? "api_key" : "subscription");
    // Verify immediately: storing a token that does not work is worse than storing none, because
    // the UI would then look configured.
    const canary = cachedCanary(true);
    res.json({ auth: credentialStatus(), canary });
  }));

  app.post("/api/auth/check", wrap((_req, res) => res.json({ canary: cachedCanary(true) })));

  // ───────────────────────────────────────────────────── provider keys

  app.get("/api/providers", wrap((_req, res) => {
    // Status only. The key itself is never in a response body — the UI has a masked label, which is
    // enough to tell two keys apart and not enough to use one.
    res.json({ providers: [providerKeyStatus("openrouter")] });
  }));

  app.post("/api/providers/openrouter/key", wrap(async (req, res) => {
    // The second of the two routes that repoint the engine at a different account — same guard.
    if (!provenLocal(req)) return refuseUnproven(res);
    const key = String(req.body?.key ?? "").trim();
    if (!key) return res.status(400).json({ error: "Paste your OpenRouter key." });

    // VERIFIED BEFORE STORED. Storing first would leave the app looking configured while every run
    // fails per row with something that reads like an outage rather than a wrong key.
    const check = await checkKey(key);
    if (!check.ok) return res.status(400).json({ error: check.error ?? "That key did not work." });

    const { label } = saveProviderKey("openrouter", key);
    res.json({ status: providerKeyStatus("openrouter"), check: { ...check, label } });
  }));

  app.post("/api/providers/openrouter/check", wrap(async (_req, res) => {
    const key = getProviderKey("openrouter");
    if (!key) return res.status(400).json({ error: "No OpenRouter key stored." });
    res.json({ check: await checkKey(key) });
  }));

  app.delete("/api/providers/openrouter/key", wrap((req, res) => {
    // The mirror of the guard on save, and missing here while its sibling at
    // /api/llm-providers/:id/key had it. Removing the key repoints the engine just as surely as
    // overwriting it does — the next run falls back to whatever else is configured.
    if (!provenLocal(req)) return refuseUnproven(res);
    deleteProviderKey("openrouter");
    res.json({ status: providerKeyStatus("openrouter") });
  }));

  // ─────────────────────────────────────────── every other model provider
  //
  // OpenRouter keeps the routes above and its own key store: it was here first, and its key check
  // answers things no other vendor's does — the remaining credit, and whether the key is limited to
  // free models. Every other provider stores its key in the shared secret store, so masking on read
  // and registration with the redactor come for free rather than being written a second time here
  // and forgotten in one of the two places.

  app.get("/api/llm-providers", wrap((_req, res) => {
    res.json({
      providers: LLM_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        note: p.note,
        signupUrl: p.signupUrl,
        tools: p.tools,
        // Whether a key is present. Never the key, and never a masked copy of it either — the
        // secrets screen is the one place that shows a masked value, and it is enough.
        hasKey: providerHasKey(p),
      })),
    });
  }));

  app.post("/api/llm-providers/:id/key", wrap(async (req, res) => {
    // Repoints the engine at a different paid account, so it carries the same guard as the two
    // routes above that do the same thing.
    if (!provenLocal(req)) return refuseUnproven(res);
    const id = param(req, "id");
    const spec = llmProvider(id);
    if (!spec) return res.status(404).json({ error: `Unknown provider "${id}".` });
    if (spec.id === "openrouter") {
      return res.status(400).json({ error: "OpenRouter keys are saved through /api/providers/openrouter/key." });
    }

    const key = String(req.body?.key ?? "").trim();
    if (!key) return res.status(400).json({ error: `Paste your ${spec.label} key.` });

    // Never overwrite a key the user made for something else.
    //
    // Provider keys live in the same store as the ones an HTTP column refers to by name, and the
    // names collide plausibly: somebody with an `OpenAI` secret for their own API call would have it
    // silently replaced here, and every column using `{{secret:OpenAI}}` would start sending the
    // wrong credential — a failure with no visible cause at the place it happens.
    const clash = listSecrets().find(
      (s) => s.name.toLowerCase() === spec.secretName.toLowerCase() && s.category !== MODEL_KEY_CATEGORY,
    );
    if (clash) {
      return res.status(409).json({
        error:
          `You already have a key called "${clash.name}"${clash.category ? ` under ${clash.category}` : ""}, ` +
          `and it is not this provider's. Rename it on the Keys screen first — saving here would ` +
          `replace it, and any column using {{secret:${clash.name}}} would start sending the wrong key.`,
      });
    }

    // CHECKED BEFORE STORED. A stored key that does not work is worse than none: the screen shows a
    // configured provider and the failure arrives per row, mid-run, reading like an outage.
    const verdict = await verifyProviderKey(spec.id, key);
    if (!verdict.ok) return res.status(400).json({ error: verdict.error ?? "That key did not work." });

    saveSecret({ name: spec.secretName, value: key, category: MODEL_KEY_CATEGORY });
    if (verdict.models) cacheDirectModels(spec.id, verdict.models);

    res.json({
      hasKey: true,
      modelCount: verdict.models?.length ?? 0,
      // Passed straight through so the screen can show that the key was saved WITHOUT being
      // confirmed, rather than a tick it has not earned.
      unverified: verdict.unverified,
    });
  }));

  /**
   * What a directly-bought model costs, typed by the user.
   *
   * The same idea as the HTTP column's cost calculator and the search backends' — a vendor who
   * publishes no machine-readable rate is not a vendor whose cost is unknowable, only one whose rate
   * has to be copied across once. Once it is here, the run estimate, the spend report and the
   * per-cell dollar limit all work exactly as they do on OpenRouter.
   */
  app.get("/api/llm-providers/:id/prices", wrap((req, res) => {
    const spec = llmProvider(param(req, "id"));
    if (!spec) return res.status(404).json({ error: "Unknown provider." });
    res.json(pricesFor(spec.id));
  }));

  app.put("/api/llm-providers/:id/prices", wrap((req, res) => {
    const spec = llmProvider(param(req, "id"));
    if (!spec) return res.status(404).json({ error: "Unknown provider." });
    const b = req.body ?? {};
    // Throws with a readable message on an empty form or a zero price — see savePrice for why a
    // stored zero is refused rather than accepted.
    const price = savePrice({
      provider: spec.id,
      model: String(b.model ?? ""),
      input: Number(b.input),
      output: Number(b.output),
      cachedInput: b.cachedInput === "" || b.cachedInput == null ? undefined : Number(b.cachedInput),
      scale: Number(b.scale) === 1_000 ? 1_000 : 1_000_000,
      note: String(b.note ?? ""),
    });
    res.json({ price, prices: pricesFor(spec.id) });
  }));

  app.delete("/api/llm-providers/:id/prices", wrap((req, res) => {
    const spec = llmProvider(param(req, "id"));
    if (!spec) return res.status(404).json({ error: "Unknown provider." });
    deletePrice(spec.id, String((req.query as any)?.model ?? ""));
    res.json({ prices: pricesFor(spec.id) });
  }));

  app.post("/api/llm-providers/:id/check", wrap(async (req, res) => {
    const id = param(req, "id");
    const spec = llmProvider(id);
    if (!spec) return res.status(404).json({ error: `Unknown provider "${id}".` });
    const key = providerKeyFor(spec);
    if (!key) return res.status(400).json({ error: `No ${spec.label} key saved.` });

    const verdict = await verifyProviderKey(spec.id, key);
    if (verdict.models) cacheDirectModels(spec.id, verdict.models);
    res.json({ ok: verdict.ok, error: verdict.error, unverified: verdict.unverified, modelCount: verdict.models?.length ?? 0 });
  }));

  app.delete("/api/llm-providers/:id/key", wrap((req, res) => {
    if (!provenLocal(req)) return refuseUnproven(res);
    const id = param(req, "id");
    const spec = llmProvider(id);
    if (!spec) return res.status(404).json({ error: `Unknown provider "${id}".` });

    // The mirror of the guard on save. A same-named key the user created for their own use was never
    // this provider's, and removing it here would take out whatever their columns refer to.
    const existing = listSecrets().find((s) => s.name.toLowerCase() === spec.secretName.toLowerCase());
    if (existing && existing.category !== MODEL_KEY_CATEGORY) {
      return res.status(409).json({
        error: `"${existing.name}" is a key you created, not this provider's. Remove it on the Keys screen if you meant to.`,
      });
    }
    deleteSecret(spec.secretName);
    // The cached model list goes with the key. Left behind, the picker would keep offering models
    // from a provider that can no longer be reached, and every one of them would fail on the row.
    forgetDirectModels(spec.id);
    res.json({ hasKey: false });
  }));

  // ───────────────────────────────────────────────────── reused answers

  app.get("/api/cache", wrap((_req, res) => {
    res.json({ on: cacheEnabled(), days: cacheDays(), stats: cacheStats() });
  }));

  app.patch("/api/cache", wrap((req, res) => {
    const b = req.body ?? {};
    if (b.on !== undefined) setCacheEnabled(b.on === true);
    // Throws with a readable message on zero or a negative — see setCacheDays for why zero is
    // refused rather than accepted as "never reuse".
    if (b.days !== undefined && b.days !== null && b.days !== "") setCacheDays(Number(b.days));
    res.json({ on: cacheEnabled(), days: cacheDays(), stats: cacheStats() });
  }));

  /** Throw the lot away. Reports the count, so the screen can confirm rather than merely claim. */
  app.post("/api/cache/clear", wrap((req, res) => {
    // Guarded like a credential route because the cost lands the same way: throwing away every
    // stored answer makes the next run pay again for all of them.
    if (!provenLocal(req)) return refuseUnproven(res, "makes the next run pay again for every stored answer");
    res.json({ removed: clearCache(), stats: cacheStats() });
  }));

  // ───────────────────────────────────────────────────── web search
  //
  // A search is the most expensive thing a cell can do — a flat per-call charge that appears in no
  // token count and varies by a factor of fourteen between engines. All of this existed and none of
  // it was reachable: eight built-in backends, sixteen described engines and an add-your-own form,
  // with no screen. So the choice defaulted forever to the most expensive option.

  /** Everything the search screen needs, in one request. */
  app.get("/api/search", wrap((_req, res) => {
    const chosen = chosenBackend();
    res.json({
      chosen,
      budgetUsd: DEFAULT_SEARCH_BUDGET_USD,
      maxSearches: DEFAULT_MAX_SEARCHES,
      builtins: BACKENDS.map((b) => ({
        id: b.id,
        label: b.label,
        signupUrl: b.signupUrl,
        priceNote: b.priceNote,
        supportsDomainFilter: b.supportsDomainFilter,
        returnsContent: b.returnsContent,
        listPriceUsd: b.listPriceUsd,
        /** What it costs today: the user's figure if they set one, else the list price. */
        perSearchUsd: perSearchUsd(b.id),
        priceIsCustom: priceIsCustom(b.id),
        // Whether a key is present. Never the key.
        //
        // OpenRouter is read from ITS OWN store, not the shared secrets — its search runs on the
        // same key the models do, resolved through the provider, and there is no secret named
        // "OpenRouter" for it to find. Asking the secret store would report "no key" on the one
        // engine that is always configured, and offer to save a second copy that nothing reads.
        hasKey: b.id === "openrouter" ? !!getProviderKey("openrouter") : !!getSecretValue(b.secretName),
        /** Its key is set elsewhere, so the screen must not offer a field for it. */
        keyManagedElsewhere: b.id === "openrouter",
        secretName: b.secretName,
      })),
      custom: listCustom().map((c) => ({
        id: c.id,
        label: c.label,
        url: c.url,
        perSearchUsd: customPerSearchUsd(c),
        cost: c.cost ?? null,
      })),
      presets: SEARCH_PRESETS.map((p) => ({
        key: p.key, label: p.label, note: p.note, signupUrl: p.signupUrl, secretNames: p.secretNames,
      })),
    });
  }));

  app.put("/api/search/backend", wrap((req, res) => {
    setChosenBackend(String(req.body?.id ?? ""));
    res.json({ chosen: chosenBackend() });
  }));

  /**
   * What one search costs on a built-in backend.
   *
   * Editable because the shipped figure is a DEFAULT, not a fact — several of these bill from a
   * credit balance or a plan rather than per call, and volume pricing moves. A budget enforced
   * against a wrong number is worse than none: it stops early, or never.
   */
  app.put("/api/search/price", wrap((req, res) => {
    const id = String(req.body?.id ?? "");
    const raw = req.body?.usd;
    // Null clears back to the list price. Zero is a real answer for a free tier and is kept.
    setPerSearchUsd(id, raw == null || raw === "" ? null : Number(raw));
    res.json({ id, perSearchUsd: perSearchUsd(id), priceIsCustom: priceIsCustom(id) });
  }));

  /** A search engine's key. Same store, same masking, same redaction as every other credential. */
  app.put("/api/search/backends/:id/key", wrap((req, res) => {
    if (!provenLocal(req)) return refuseUnproven(res);
    const spec = backendSpec(param(req, "id"));
    if (!spec) return res.status(404).json({ error: "Unknown search engine." });
    // Its search runs on the key from the OpenRouter screen's own store. Writing a secret here would
    // create a second copy that nothing reads, and removing one would look like it had worked.
    if (spec.id === "openrouter") {
      return res.status(400).json({ error: "The OpenRouter key is set on the OpenRouter screen." });
    }
    const key = String(req.body?.key ?? "").trim();
    if (key) saveSecret({ name: spec.secretName, value: key, category: "Search engines" });
    else deleteSecret(spec.secretName);
    res.json({ id: spec.id, hasKey: !!key });
  }));

  /** Add or edit an engine the user described, optionally starting from a preset. */
  app.put("/api/search/custom", wrap((req, res) => {
    const b = req.body ?? {};
    const base = b.preset ? preset(String(b.preset)) : null;
    if (b.preset && !base) return res.status(404).json({ error: `Unknown preset "${b.preset}".` });

    // A preset supplies the request shape; anything sent alongside it wins, so the label or a field
    // path can be corrected at the moment it is added rather than saved wrong and edited after.
    const merged = base ? { ...stripPresetOnly(base), ...b } : b;
    const spec = saveCustom(merged);
    res.json({ custom: spec, list: listCustom() });
  }));

  app.delete("/api/search/custom/:id", wrap((req, res) => {
    const id = param(req, "id");
    deleteCustom(id);
    // The chosen engine cannot be one that no longer exists — it would fail on every row with
    // "unknown backend" rather than saying the engine was deleted.
    if (chosenBackend() === id) setChosenBackend("openrouter");
    res.json({ list: listCustom(), chosen: chosenBackend() });
  }));

  /**
   * Run one real search against a described engine.
   *
   * The single most valuable control on the screen. A wrong results path returns zero hits on every
   * row, forever, costs money each time, and is indistinguishable from a hard question — the ONLY
   * way to tell the difference is to look at the shape of what actually came back, which is what
   * this hands over when the path finds nothing.
   */
  app.post("/api/search/try", wrap(async (req, res) => {
    const b = req.body ?? {};
    const spec = b.id ? getCustom(String(b.id)) : null;
    const base = b.preset ? preset(String(b.preset)) : null;
    const use = spec ?? (base ? { ...stripPresetOnly(base), id: "custom:preview" } : null);
    if (!use) return res.status(400).json({ error: "Nothing to try — pick an engine first." });

    const query = String(b.query ?? "").trim() || "site:example.com test";
    const out = await tryCustom({ ...use, ...(b.spec ?? {}) } as any, query);
    res.json(out);
  }));

  // ───────────────────────────────────────────────────── sheets

  app.get("/api/sheets", wrap((req, res) =>
    res.json({ sheets: visible(req, listSheets(), (sh: any) => sh.workbookId) })));

  app.post("/api/sheets", wrap((req, res) => {
    const name = String(req.body?.name ?? "Untitled sheet").trim() || "Untitled sheet";
    // A new sheet joins the workbook it was created FROM. Without this every "+" from the tab bar
    // made a loose sheet that then vanished from the bar it was created in.
    const workbookId = typeof req.body?.workbookId === "string" ? req.body.workbookId : null;
    // An unrecognised kind degrades to generic rather than refusing the table. What the rows are is
    // a hint that improves defaults; it is never worth failing a table creation over.
    const kind = isSheetKind(req.body?.kind) ? req.body.kind : "generic";
    res.json({ sheet: createSheet(name, workbookId, kind) });
  }));

  /** The sheets sharing a tab bar with this one — its workbook's, or the loose ones. */
  app.get("/api/sheets/:id/siblings", wrap((req, res) => {
    const sheet = getSheet(param(req, "id"));
    if (!sheet) return res.status(404).json({ error: "Sheet not found" });
    res.json({ workbookId: sheet.workbookId ?? null, sheets: listSiblingSheets(sheet.id) });
  }));

  app.post("/api/sheets/:id/duplicate", wrap((req, res) => {
    const copy = duplicateSheet(param(req, "id"), { withRows: !!req.body?.withRows });
    if (!copy) return res.status(404).json({ error: "Sheet not found" });
    res.json({ sheet: copy });
  }));

  app.post("/api/sheets/:id/move", wrap((req, res) => {
    const to = Number(req.body?.toIndex);
    if (!Number.isInteger(to) || to < 0) return res.status(400).json({ error: "A sheet can only move to a whole position." });
    moveSheet(param(req, "id"), to);
    res.json({ ok: true, sheets: listSiblingSheets(param(req, "id")) });
  }));

  app.get("/api/sheets/:id", wrap((req, res) => {
    const sheet = getSheet(param(req, "id"));
    if (!sheet) return res.status(404).json({ error: "Sheet not found" });
    // Recorded here rather than on every read of a row: this route is "open the table", the row
    // routes are "scroll it", and a recents list built from scrolling is a list of nothing.
    markOpened("table", sheet.id);
    if (sheet.workbookId) markOpened("workbook", sheet.workbookId);
    // The default view travels WITH the sheet, in this payload, rather than as a second request the
    // opener would have to make. One indexed row, and it is what lets the grid apply the narrowing
    // before its first read of the rows instead of painting everything and then snapping to a subset.
    const defaultView = sheet.defaultViewId ? getView(Number(sheet.defaultViewId)) : null;
    res.json({ sheet, columns: listColumns(sheet.id), defaultView });
  }));

  app.patch("/api/sheets/:id", wrap((req, res) => {
    const id = param(req, "id");
    if (typeof req.body?.name === "string") {
      // Recorded, because renaming the table you are looking at is one keystroke away from renaming
      // the wrong one, and "what was it called before?" is a question nothing else in the app answers.
      const was = getSheet(id)?.name ?? "";
      const now = req.body.name.trim();
      renameSheet(id, now);
      if (now && now !== was) {
        record(id, "sheet.rename", `Rename "${was}" to "${now}"`, { sheetId: id, from: was, to: now });
      }
    }

    // Move a table to a different workbook. Two tables that reference each other belong in one
    // file, and until this existed the only way to get them there was to rebuild one of them.
    if (typeof req.body?.workbookId === "string" && req.body.workbookId) {
      if (!getWorkbook(req.body.workbookId)) return res.status(404).json({ error: "Workbook not found" });

      // A link may only join two tables in ONE workbook — `createRelation` refuses anything else.
      // Nothing re-checked that after the fact, so this move used to produce exactly the state the
      // product declines to build: a link that keeps matching, that a copy drops, that an export
      // dropped silently, and whose stored workbook is what authorizes access to it.
      //
      // Refused rather than repaired. Moving the link with the table is impossible — its other end
      // stays — and deleting it would throw away configuration on a menu click. Which to give up,
      // the link or the move, is the user's call, so the refusal names what is in the way.
      const spanning = relationsSpanning(id, req.body.workbookId);
      if (spanning.length) {
        const pairs = spanning.map((r) => `${r.fromTable} → ${r.toTable}`).join(", ");
        return res.status(409).json({
          error:
            `This table is linked to ${spanning.length === 1 ? "another table" : "other tables"} in its ` +
            `current workbook (${pairs}). A link can only join two tables in the same workbook, so ` +
            `moving this one would break it. Remove the link first, or move both tables together.`,
        });
      }
      const pos = Number(
        (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM sheets WHERE workbook_id = ?").get(req.body.workbookId) as any).p,
      ) + 1;
      db.prepare("UPDATE sheets SET workbook_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?")
        .run(req.body.workbookId, pos, id);
    }

    if (req.body?.budgetUsd !== undefined) {
      const raw = req.body.budgetUsd;
      // null clears the cap; a number sets it. A negative or non-numeric value is rejected rather
      // than coerced — silently turning "-5" into no cap would remove a limit the user was setting.
      if (raw === null) {
        db.prepare("UPDATE sheets SET budget_usd = NULL WHERE id = ?").run(id);
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          res.status(400).json({ error: "A budget has to be a positive amount, or empty for no limit." });
          return;
        }
        db.prepare("UPDATE sheets SET budget_usd = ? WHERE id = ?").run(n, id);
      }
    }

    // The three settings that live on the sheet row and name something else: the column that labels a
    // row, the view the table opens on, and what the rows are. Each refuses a target that is not on
    // this table rather than storing it, because the read path resolves an unusable pointer to null —
    // so a stored bad value would read back as "not set" and look identical to a save that failed.
    // All three record the same undo kind.
    if (req.body?.primaryColumnId !== undefined) {
      const before = getSheet(id)?.primaryColumnId ?? null;
      const raw = req.body.primaryColumnId;
      const next = raw === null ? null : String(raw);
      try {
        setPrimaryColumn(id, next);
      } catch (e: any) {
        return res.status(400).json({ error: String(e?.message ?? "That column is not on this table.") });
      }
      if (before !== next) {
        record(id, "sheet.setting", next ? "Change the row label" : "Clear the row label", {
          sheetId: id, field: "primary_column_id",
          from: before == null ? null : Number(before), to: next == null ? null : Number(next),
        });
      }
    }

    if (req.body?.defaultViewId !== undefined) {
      const before = getSheet(id)?.defaultViewId ?? null;
      const raw = req.body.defaultViewId;
      const next = raw === null ? null : String(raw);
      try {
        setDefaultView(id, next == null ? null : Number(next));
      } catch (e: any) {
        return res.status(400).json({ error: String(e?.message ?? "That view is not on this table.") });
      }
      if (before !== next) {
        record(id, "sheet.setting", next ? "Change which view this table opens on" : "Open this table on all rows", {
          sheetId: id, field: "default_view_id",
          from: before == null ? null : Number(before), to: next == null ? null : Number(next),
        });
      }
    }

    if (req.body?.kind !== undefined) {
      if (!isSheetKind(req.body.kind)) {
        return res.status(400).json({ error: "A table is people, companies, or generic." });
      }
      const before = getSheet(id)?.kind ?? "generic";
      const next = req.body.kind;
      setSheetKind(id, next);
      if (before !== next) {
        record(id, "sheet.setting", `Say these rows are ${next === "generic" ? "neither people nor companies" : next}`, {
          sheetId: id, field: "kind", from: before, to: next,
        });
      }
    }

    res.json({ sheet: getSheet(id) });
  }));

  /**
   * Soft delete. This is what the UI uses.
   *
   * `trashTable` existed in the store from the start but was never routed, so the only reachable
   * removal was the hard DELETE below — irreversible, on a table that may hold a million rows that
   * took 25 seconds to import.
   */
  app.post("/api/sheets/:id/trash", wrap((req, res) => {
    trashTable(param(req, "id"));
    res.json({ ok: true });
  }));

  app.post("/api/sheets/:id/restore", wrap((req, res) => {
    restoreTable(param(req, "id"));
    res.json({ sheet: getSheet(param(req, "id")) });
  }));

  // Hard delete. Not reachable from the UI on purpose — the trash is.
  app.delete("/api/sheets/:id", wrap((req, res) => {
    deleteSheet(param(req, "id"));
    res.json({ ok: true });
  }));

  // The grid's read path. `limit` is capped so a client cannot ask for a million rows in one go and
  // take the process down with it. An optional `view` applies that view's saved filter, so the grid
  // and a scoped run are drawing from the identical predicate.
  app.get("/api/sheets/:id/rows", wrap((req, res) => {
    const offset = Math.max(0, Number(req.query.offset ?? 0) | 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) | 0));
    const sheetId = param(req, "id");

    const win = readWindow(sheetId, offset, limit, readOptionsFrom(req, sheetId));

    // Per-row aggregate status for the gutter badge — computed for the visible window only.
    if (req.query.rowStatus === "1" && win.rows.length > 0) {
      const statuses = rowStatuses(win.rows.map((r) => Number(r.id)));
      return res.json({
        ...win,
        rowStatus: Object.fromEntries([...statuses].map(([k, v]) => [String(k), v])),
      });
    }
    res.json(win);
  }));

  // Every row id in the table, in position order. Backs the header's "select all rows" checkbox: the
  // grid is virtualized and holds only a window, so it cannot gather them itself. Offered only for the
  // whole table — a narrowed view's select-all is a scope question this deliberately does not answer.
  app.get("/api/sheets/:id/row-ids", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const ids = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as Array<{ id: number }>)
      .map((r) => Number(r.id));
    res.json({ ids });
  }));

  /**
   * Per-column completion stats for the header bars.
   *
   * `budget` bounds how long this may spend recomputing, because a sheet of stale million-row
   * columns is seconds of work. Columns it cannot afford to refresh come back flagged `computing`
   * with their previous numbers, so the header shows a slightly old value rather than flashing empty.
   */
  app.get("/api/sheets/:id/column-stats", wrap((req, res) => {
    const sheetId = param(req, "id");
    // Budget 0: this request computes NOTHING. A single column costs ~400ms on a million rows, and
    // the budget is only checked between columns, so any nonzero budget overshoots by a full
    // column. Everything unknown is computed by the background warmer and pushed over SSE as it
    // lands — so the header paints immediately and fills in, instead of blocking on a cold sheet.
    const stats = getSheetColumnStats(sheetId, Number(req.query.budget ?? 0));
    if (stats.some((s) => s.computing)) warmSheetStats(sheetId);
    res.json({ stats });
  }));

  // ───────────────────────────────────────────────────── the table wizard

  /**
   * One round of the create-table interview.
   *
   * The whole transcript comes from the client each time. The alternative — a server-side session —
   * would mean state to expire, to clean up and to get wrong on a reload, for a conversation that
   * is four messages long and belongs to whoever is looking at it.
   */
  app.post("/api/wizard/step", wrap(async (req, res) => {
    const turns: Turn[] = (Array.isArray(req.body?.turns) ? req.body.turns : [])
      .filter((t: any) => t && (t.role === "user" || t.role === "wizard") && typeof t.text === "string")
      .slice(-20);
    if (turns.length === 0) return res.status(400).json({ error: "Describe the table you want first." });
    res.json(await nextStep(turns, { model: req.body?.model ?? null }));
  }));

  app.post("/api/wizard/apply", wrap((req, res) => {
    const plan = req.body?.plan as TablePlan | undefined;
    if (!plan || !Array.isArray(plan.columns) || plan.columns.length === 0) {
      return res.status(400).json({ error: "There is no plan to build." });
    }
    const workbookId = typeof req.body?.workbookId === "string" ? req.body.workbookId : null;
    res.json(applyPlan(plan, { workbookId }));
  }));

  // ───────────────────────────────────────────────────── the assistant

  /**
   * The conversation so far. Read from the engine rather than rebuilt by the client, because the
   * client no longer holds it — the panel used to lose the whole transcript on close.
   */
  app.get("/api/sheets/:id/assistant/messages", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    res.json({ messages: loadConversation(sheetId) });
  }));

  /** Start over. Explicit, because the only other way to lose a transcript should be trashing its table. */
  app.delete("/api/sheets/:id/assistant/messages", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    res.json({ removed: clearConversation(sheetId) });
  }));

  app.post("/api/sheets/:id/assistant", wrap(async (req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "Ask something first." });

    // The history comes from the STORE, not from the request. The client used to send the whole
    // transcript back on every turn, which meant the model's context was whatever the browser
    // happened to be holding — and after a reload that was nothing at all, so turn six arrived with
    // no memory of turns one to five while the user could still read them on screen.
    const prior: Message[] = loadConversation(sheetId).map((t) => ({ role: t.role, text: t.text }));
    const userTurn = appendTurn(sheetId, { role: "user", text });

    // Streamed as newline-delimited JSON, because the answer is no longer one call. It plans, then
    // checks itself against the request, then improves — up to a few rounds — and a single spinner
    // over all of that reads as a hang. A `step` line names each stage as it starts, then exactly one
    // terminal line: `done` with the reply and actions, or `error` with the reason. Once the first
    // byte is out the status is already 200, so a failure after that rides in an `error` line rather
    // than a status code.
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no"); // no proxy may collect the steps into one lump
    res.flushHeaders?.();
    const line = (obj: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

    // Closing the panel drops the connection; that abort reaches all the way down to the model calls,
    // so a loop the user walked away from stops spending time on their behalf.
    const canceller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) canceller.abort(); });

    try {
      const reply = await askAssistant(sheetId, [...prior, { role: "user" as const, text }].slice(-20), {
        onStep: (s) => line({ type: "step", phase: s.phase, label: s.label, round: s.round }),
        signal: canceller.signal,
      });
      const assistantTurn = appendTurn(sheetId, { role: "assistant", text: reply.reply, actions: reply.actions });
      line({ type: "done", reply: reply.reply, actions: reply.actions, dropped: reply.dropped, userTurnId: userTurn, turnId: assistantTurn });
    } catch (e) {
      // The question does not stay in the transcript if it was never answered. Left there it reads as
      // asked-and-ignored, and asking again would send the failed turn to the model as context.
      db.prepare("DELETE FROM assistant_messages WHERE id = ?").run(userTurn);
      line({ type: "error", error: e instanceof Error ? e.message : String(e) });
    }
    if (!res.writableEnded) res.end();
  }));

  /** Apply ONE approved action. One at a time, so a good suggestion and a wrong one stay separable. */
  app.post("/api/sheets/:id/assistant/apply", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const action = req.body?.action as Action | undefined;
    if (!action?.kind) return res.status(400).json({ error: "There is no change to apply." });

    // Checked through the SAME parse the proposal went through, on the object that ARRIVED rather
    // than on the one that was offered — they are not the same object, because this one has been
    // through the browser. `assistant.ts` says in as many words that this is where that happens, and
    // it was not happening: the route handed the body straight to `applyAction`, so an instruction
    // longer than the 8,000-character cap, a mode nothing recognises and a column id that does not
    // exist all went through. "Ask the assistant" was the way around every limit the hand-built
    // PATCH enforces.
    const [checked] = parseReply({ reply: "applying", actions: [action] }, sheetId).actions;
    if (!checked) {
      return res.status(400).json({ error: "That change does not fit this table any more — ask again." });
    }
    const said = applyAction(sheetId, checked);
    // Recorded against the turn it belongs to, so re-opening the panel shows it as applied instead
    // of offering to do it a second time. Optional in the body: an older client that does not send
    // the ids still applies the change, it just does not remember afterwards.
    const turnId = Number(req.body?.turnId);
    const actionIndex = Number(req.body?.actionIndex);
    if (Number.isInteger(turnId) && Number.isInteger(actionIndex)) {
      markApplied(sheetId, turnId, actionIndex, said);
    }
    res.json({ said });
  }));

  /** What the assistant can see. Exposed so the UI can show it — no hidden context. */
  app.get("/api/sheets/:id/assistant/context", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    res.json({ context: describeTable(sheetId) });
  }));

  // ───────────────────────────────────────────────────── workspace

  /** What is inside a folder — or the root. Ships the breadcrumb so the client makes no second trip. */
  app.get("/api/workspace", wrap((req, res) => {
    const folderId = typeof req.query.folder === "string" && req.query.folder ? req.query.folder : null;
    if (folderId && !getFolder(folderId)) return res.status(404).json({ error: "Folder not found" });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) return res.json({ entries: visible(req, searchWorkspace(q), (e: any) => e?.kind === "workbook" ? String(e.id) : e?.kind === "table" ? workbookOfSheet(String(e.id)) : null), path: [], folderId: null, query: q });

    const view = String(req.query.view ?? "files");
    const entryWorkbook = (e: any): string | null =>
      e?.kind === "workbook" ? String(e.id) : e?.kind === "table" ? workbookOfSheet(String(e.id)) : null;

    if (view === "starred") return res.json({ entries: visible(req, listStarred(), entryWorkbook), path: [], folderId: null });
    if (view === "recent") return res.json({ entries: visible(req, listRecent(), entryWorkbook), path: [], folderId: null });

    // Inside a workbook: its tables, and the path that got here. Navigating INTO a file is the
    // second half of a file browser; without it a workbook is a row you cannot open.
    const workbookId = typeof req.query.workbook === "string" && req.query.workbook ? req.query.workbook : null;
    if (workbookId) {
      const wb = getWorkbook(workbookId);
      if (!wb) return res.status(404).json({ error: "Workbook not found" });
      const folder = (db.prepare("SELECT folder_id FROM workbooks WHERE id = ?").get(workbookId) as any)?.folder_id ?? null;
      return res.json({
        entries: listWorkbook(workbookId),
        path: [
          ...breadcrumb(folder).map((f) => ({ kind: "folder", id: f.id, name: f.name })),
          { kind: "workbook", id: wb.id, name: wb.name },
        ],
        folderId: folder,
        workbookId,
      });
    }

    res.json({
      entries: visible(req, listFolder(folderId), entryWorkbook),
      path: breadcrumb(folderId).map((f) => ({ kind: "folder", id: f.id, name: f.name })),
      folderId,
    });
  }));

  /** Root-first path to a table: folders, its workbook, then itself. One request, one breadcrumb. */
  app.get("/api/sheets/:id/path", wrap((req, res) => {
    res.json({ path: pathToSheet(param(req, "id")) });
  }));

  app.post("/api/folders", wrap((req, res) => {
    const parentId = typeof req.body?.parentId === "string" && req.body.parentId ? req.body.parentId : null;
    if (parentId && !getFolder(parentId)) return res.status(404).json({ error: "Folder not found" });
    res.json({ folder: createFolder(String(req.body?.name ?? "New folder"), parentId) });
  }));

  app.patch("/api/folders/:id", wrap((req, res) => {
    const id = param(req, "id");
    if (!getFolder(id)) return res.status(404).json({ error: "Folder not found" });
    if (typeof req.body?.name === "string") renameFolder(id, req.body.name);
    res.json({ folder: getFolder(id) });
  }));

  app.post("/api/folders/:id/trash", wrap((req, res) => {
    res.json(trashFolder(param(req, "id")));
  }));

  /** Move a folder, workbook or loose table. One route, because they move the same way. */
  app.post("/api/workspace/move", wrap((req, res) => {
    const kind = String(req.body?.kind);
    if (kind !== "folder" && kind !== "workbook" && kind !== "table") {
      return res.status(400).json({ error: "Unknown kind of item." });
    }
    const folderId = typeof req.body?.folderId === "string" && req.body.folderId ? req.body.folderId : null;
    if (folderId && !getFolder(folderId)) return res.status(404).json({ error: "Folder not found" });
    moveEntry(kind, String(req.body?.id ?? ""), folderId);
    res.json({ ok: true });
  }));

  app.post("/api/workspace/star", wrap((req, res) => {
    const kind = String(req.body?.kind);
    if (kind !== "folder" && kind !== "workbook" && kind !== "table") {
      return res.status(400).json({ error: "Unknown kind of item." });
    }
    setStarred(kind, String(req.body?.id ?? ""), !!req.body?.starred);
    res.json({ ok: true });
  }));

  // ───────────────────────────────────────────────────── workbooks

  app.get("/api/workbooks", wrap((req, res) =>
    res.json({
      workbooks: visible(req, listWorkbooks(), (w: any) => w.id),
      // Templates carry no rows, so there is nothing in one to restrict — but a template MADE from a
      // restricted workbook is still that workbook by another name, so it is filtered the same way.
      templates: visible(req, listTemplates(), (w: any) => w.id),
    })));

  app.post("/api/workbooks", wrap((req, res) => {
    const wb = createWorkbook(String(req.body?.name ?? "Untitled workbook").trim() || "Untitled workbook", me(req)?.id ?? null);
    if (typeof req.body?.folderId === "string" && req.body.folderId) {
      moveEntry("workbook", wb.id, req.body.folderId);
    }
    // Every new file gets its first tab. A workbook with no tables is a row in the browser that
    // opens onto nothing, which is the one state a file browser must never produce.
    const sheet = createSheet(String(req.body?.tableName ?? "Table 1").trim() || "Table 1", wb.id);
    res.json({ workbook: wb, sheet });
  }));

  app.patch("/api/workbooks/:id", wrap((req, res) => {
    const id = param(req, "id");
    if (!getWorkbook(id)) return res.status(404).json({ error: "Workbook not found" });
    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      db.prepare("UPDATE workbooks SET name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(req.body.name.trim(), id);
    }
    res.json({ workbook: getWorkbook(id) });
  }));

  /** Archive a workbook. Its tables go with it — they have no meaning outside the file. */
  app.post("/api/workbooks/:id/trash", wrap((req, res) => {
    const id = param(req, "id");
    if (!getWorkbook(id)) return res.status(404).json({ error: "Workbook not found" });
    db.prepare("UPDATE workbooks SET archived = 1 WHERE id = ?").run(id);
    db.prepare("UPDATE sheets SET deleted_at = datetime('now') WHERE workbook_id = ? AND deleted_at IS NULL").run(id);
    res.json({ ok: true });
  }));

  app.get("/api/workbooks/:id", wrap((req, res) => {
    const wb = getWorkbook(param(req, "id"));
    if (!wb) return res.status(404).json({ error: "Workbook not found" });
    res.json({ workbook: wb, tables: listTables(wb.id) });
  }));

  // ───────────────────────────────────────────────────── duplicate, templatize, share

  /**
   * Copying a workbook with its rows can be a very large write, and it is a write nobody watches —
   * unlike a run, there is no progress to look at. So the size is answered BEFORE the copy, and the
   * screen asks with the real number in the sentence rather than "this may take a while".
   */
  app.get("/api/workbooks/:id/copy-size", wrap((req, res) => {
    const id = param(req, "id");
    if (!getWorkbook(id)) return res.status(404).json({ error: "Workbook not found" });
    const n = db.prepare(
      `SELECT COUNT(*) AS c FROM rows
        WHERE sheet_id IN (SELECT id FROM sheets WHERE workbook_id = ? AND deleted_at IS NULL)`,
    ).get(id) as any;
    res.json({ rows: Number(n?.c ?? 0), tables: listTables(id).length });
  }));

  app.post("/api/workbooks/:id/duplicate", wrap((req, res) => {
    const id = param(req, "id");
    if (!getWorkbook(id)) return res.status(404).json({ error: "Workbook not found" });
    const out = duplicateWorkbook(id, {
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      withRows: !!req.body?.withRows,
    });
    if (typeof req.body?.folderId === "string" && req.body.folderId) {
      moveEntry("workbook", out.workbook.id, req.body.folderId);
    }
    res.json(out);
  }));

  app.post("/api/workbooks/:id/templatize", wrap((req, res) => {
    const id = param(req, "id");
    if (!getWorkbook(id)) return res.status(404).json({ error: "Workbook not found" });
    res.json(templatizeWorkbook(id, typeof req.body?.name === "string" ? req.body.name : undefined));
  }));

  app.post("/api/templates/:id/use", wrap((req, res) => {
    const t = getWorkbook(param(req, "id"));
    if (!t) return res.status(404).json({ error: "Template not found" });
    const out = useTemplate(t.id, typeof req.body?.name === "string" ? req.body.name : undefined);
    if (typeof req.body?.folderId === "string" && req.body.folderId) {
      moveEntry("workbook", out.workbook.id, req.body.folderId);
    }
    res.json(out);
  }));

  // Deleting a template is `POST /api/workbooks/:id/trash` — a template IS a workbook, and archiving
  // one is exactly what removing it from the gallery means. A second route doing the same thing
  // under a different name is one more path to keep in step for no behaviour anyone gains.

  /**
   * The file you send someone.
   *
   * Downloaded rather than shown, and named after the workbook, because the thing being produced is
   * an artefact to keep — a JSON blob rendered into a browser tab is one the user then has to save
   * by hand and name themselves.
   */
  /**
   * What would leave with the file that the person sending it might not mean to send.
   *
   * Asked BEFORE the download, for the same reason a send is dry-run before it writes: the file is
   * the point of no return. Once it is in a chat message, a key inside it has to be rotated, not
   * deleted. This is a read of the workbook's own columns and returns names, never values.
   */
  app.get("/api/workbooks/:id/export-check", wrap((req, res) => {
    const wb = getWorkbook(param(req, "id"));
    if (!wb) return res.status(404).json({ error: "Workbook not found" });
    res.json({ secrets: literalSecretsIn(wb.id), droppedRelations: droppedRelationsIn(wb.id) });
  }));

  app.get("/api/workbooks/:id/export.json", wrap((req, res) => {
    const wb = getWorkbook(param(req, "id"));
    if (!wb) return res.status(404).json({ error: "Workbook not found" });
    const doc = exportWorkbook(wb.id);
    const safe = wb.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60) || "workbook";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.ferrum.json"`);
    res.send(JSON.stringify(doc, null, 2));
  }));

  /**
   * What a file would create, WITHOUT creating it.
   *
   * The same ordering argument as checking a column template before applying it: a file that arrived
   * from someone else may carry scripts, and "read what is in it, then decide" is only possible if
   * reading does not already require importing.
   */
  app.post("/api/workbooks/import/preview", wrap((req, res) => {
    const d = req.body?.doc;
    if (!d || typeof d !== "object" || d.format !== "ferrum.workbook") {
      return res.status(400).json({ error: "That file is not a Ferrum workbook." });
    }
    const tables = Array.isArray(d.tables) ? d.tables : [];
    const scripts: Array<{ table: string; column: string; hook: string; intent: string; code: string }> = [];
    let columns = 0;
    for (const t of tables) {
      for (const c of t.columns ?? []) {
        columns++;
        for (const s of c.scripts ?? []) {
          scripts.push({
            table: String(t.name ?? ""), column: String(c.name ?? ""),
            hook: String(s.hook ?? ""), intent: String(s.intent ?? ""), code: String(s.code ?? ""),
          });
        }
      }
    }
    res.json({
      name: String(d.name ?? "Imported workbook"),
      description: d.description ?? null,
      version: Number(d.version ?? 0),
      exportedAt: d.exportedAt ?? null,
      tables: tables.map((t: any) => ({ name: String(t.name ?? ""), columns: (t.columns ?? []).length })),
      relations: (d.relations ?? []).length,
      columns,
      scripts,
    });
  }));

  app.post("/api/workbooks/import", wrap((req, res) => {
    const out = importWorkbook(req.body?.doc, typeof req.body?.name === "string" ? req.body.name : undefined);
    if (typeof req.body?.folderId === "string" && req.body.folderId) {
      moveEntry("workbook", out.workbook.id, req.body.folderId);
    }
    res.json(out);
  }));

  // ───────────────────────────────────────────────────── views

  app.get("/api/sheets/:id/views", wrap((req, res) =>
    res.json({ views: listViews(param(req, "id")) })));

  app.post("/api/sheets/:id/views", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    res.json({ view: createView(sheetId, String(req.body?.name ?? "New view"), req.body ?? {}) });
  }));

  app.patch("/api/views/:id", wrap((req, res) => {
    const v = updateView(Number(param(req, "id")), req.body ?? {});
    if (!v) return res.status(404).json({ error: "View not found" });
    res.json({ view: v });
  }));

  app.delete("/api/views/:id", wrap((req, res) => {
    const id = Number(param(req, "id"));
    // Snapshot before removing. A view is one small record, so this is a full capture rather than a
    // flag — and a view someone spent time building is exactly the kind of thing deleted by
    // accident from a menu.
    const before = db.prepare("SELECT * FROM views WHERE id = ?").get(id) as any;
    if (!before) return res.status(404).json({ error: "View not found" });
    deleteView(id);
    record(String(before.sheet_id), "view.delete", `Delete view "${before.name}"`, { view: before });
    res.json({ ok: true });
  }));

  // ───────────────────────────────────────────────────── run scoping
  //
  // Resolve-only endpoint. The UI calls this to render the confirm dialog BEFORE anything is
  // enqueued, so the number the user approves is produced by the same predicate the run will use.

  app.post("/api/sheets/:id/resolve-scope", wrap(async (req, res) => {
    const resolved = resolveScope(param(req, "id"), req.body ?? {});
    // The cost rides along with the row count, because they are the same question. The dialog was
    // showing rows, columns and cells and NO money — so a run was approved without the user ever
    // being told what it would spend, which is the one thing the dialog exists to prevent.
    const columns = resolved.columnIds.map((id) => getColumn(id)).filter((c) => !!c);
    const cost = await estimateRun(columns, resolved.rowCount, (req.body ?? {}).useStrongModel === true);

    /**
     * The two things about a run that are worth being told BEFORE it starts.
     *
     * Both are facts only the server has, and both are silent failures otherwise: you find out you
     * overwrote a column of good answers by noticing they changed, and you find out a paid column
     * had no gate when the bill arrives.
     */
    const warnings: Array<{ kind: string; count?: number; atLeast?: boolean; names?: string[] }> = [];
    const scopeBody = (req.body ?? {}) as {
      rowIds?: unknown[]; filter?: unknown; viewId?: unknown; statuses?: unknown[];
      limit?: unknown; fromRow?: unknown; toRow?: unknown; search?: unknown;
      overwriteEdited?: unknown;
    };
    // Whether the run about to be approved will replace hand-typed cells. It changes the number
    // below, and it has to: the count exists to say how much is about to be overwritten, so leaving
    // hand edits out of it while the run replaces them would understate exactly the destructive part.
    const willOverwriteEdited = scopeBody.overwriteEdited === true;

    if (resolved.columnIds.length > 0 && resolved.rowCount > 0) {
      /**
       * How many values this run would replace.
       *
       * Counted two different ways, because the obvious way is unaffordable. Asking the cells table
       * directly is a scan of rows × columns: on the million-row bench sheet that is six million
       * index entries and it put **3.8 seconds** into a dialog that has to feel instant — and,
       * because the engine is one thread, three point eight seconds of the whole app being deaf.
       *
       * Whole sheet — the common case — is answered from the per-column stats cache, which is
       * already maintained for the progress bars and costs nothing to read.
       *
       * A narrowed scope has no cached answer, so it gets a BOUNDED probe: stop counting at 5,000
       * and say "at least". A number nobody needs to the unit is not worth a full scan, and the
       * decision the warning informs is the same at 5,000 as at 500,000.
       */
      //
      // `search` counts as a narrowing like any other. Leaving it out of this test meant a run over
      // a searched grid took the whole-sheet branch and reported the whole COLUMN's filled cells —
      // "this will overwrite 1,000,000 values" for a search matching three rows. A warning that
      // overstates by five orders of magnitude is a warning people learn to dismiss.
      const wholeSheet =
        !(scopeBody.rowIds?.length) && !scopeBody.filter && scopeBody.viewId == null &&
        !(scopeBody.statuses?.length) && scopeBody.limit == null &&
        !(typeof scopeBody.search === "string" && scopeBody.search.trim()) &&
        scopeBody.fromRow == null && scopeBody.toRow == null;

      let count = 0;
      let atLeast = false;

      if (wholeSheet) {
        for (const id of resolved.columnIds) {
          const s = getColumnStats(id, param(req, "id"));
          const filled = (s.byStatus.done ?? 0) + (s.byStatus.not_found ?? 0);
          // Hand edits taken off when the run is going to leave them alone. This branch counted
          // every filled cell as overwritable however the run was configured — an overstatement
          // while edits are protected, and an understatement once the new option lets them be
          // replaced. `pinned` is absent on stats cached by an older build, and reads as 0, which
          // is exactly the behaviour that preceded it.
          //
          // A lower bound rather than an exact figure: a pinned cell might be `empty`, in which case
          // it was never in `filled` and this takes off one too many. Erring downward here is the
          // safe direction — the number beside it is already labelled "up to".
          count += willOverwriteEdited ? filled : Math.max(0, filled - (s.pinned ?? 0));
        }
      } else {
        const CAP = 5000;
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT 1 FROM cells
                WHERE column_id IN (${resolved.columnIds.map(() => "?").join(",")})
                  ${willOverwriteEdited ? "" : "AND pinned = 0"}
                  AND status IN ('done', 'not_found')
                  AND row_id IN (SELECT r.id FROM (${resolved.sql}) r)
                LIMIT ${CAP + 1})`,
          )
          .get(...resolved.columnIds, ...resolved.params) as any;
        count = Number(row?.n ?? 0);
        if (count > CAP) { count = CAP; atLeast = true; }
      }

      if (count > 0) warnings.push({ kind: "overwrite", count, atLeast });
    }

    // Paid columns with no approved gate. The condition is the cheapest control in the product and
    // the easiest to never get round to, so the moment money is about to be spent is the moment to
    // mention it.
    const ungated = columns
      .filter((c) => (c.kind === "ai" || c.kind === "agent") && !c.conditionScriptId)
      .map((c) => c.name);
    if (ungated.length > 0) warnings.push({ kind: "ungated", names: ungated });

    /**
     * Columns that will skip every single row, because they were never finished.
     *
     * Every lane already refuses these politely at run time — a blank prompt skips rather than
     * errors — but nothing said so BEFORE the run. A column with no instruction was offered here as
     * an ordinary priced run, and then produced nothing on every row, with the only explanation
     * buried one cell at a time.
     *
     * A warning rather than a block: a mixed run where one of five columns is half set up is a
     * perfectly reasonable thing to start, and refusing it would be the app deciding for the user.
     */
    const notReady = columns
      .map((c) => ({ name: c.name, why: notReadyReason(c) }))
      .filter((x) => x.why !== null)
      .map((x) => `${x.name} — ${x.why}`);
    if (notReady.length > 0) warnings.push({ kind: "unconfigured", names: notReady });

    res.json({
      rowCount: resolved.rowCount,
      columnIds: resolved.columnIds,
      summary: resolved.summary,
      cost,
      warnings,
    });
  }));

  // ───────────────────────────────────────────────────── columns

  app.post("/api/sheets/:id/columns", wrap((req, res) => {
    const sheetId = param(req, "id");
    // Checked rather than left to the foreign key. Unguarded, an unknown or trashed table id came
    // back as a raw SQLITE_CONSTRAINT — a 500 reading "something went wrong inside Ferrum" for what
    // is an ordinary "that table is gone" on a stale tab.
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    // Both are rejected rather than coerced, for the same reason the PATCH route rejects them: an
    // unrecognised mode is a column no executor ever picks up, and an unrecognised type drives
    // coercion, sorting and the filter operators offered for it.
    if (req.body?.kind !== undefined && !isColumnKind(req.body.kind)) {
      return res.status(400).json({ error: `Unknown column mode "${String(req.body.kind)}".` });
    }
    if (req.body?.valueType !== undefined && !isValueType(req.body.valueType)) {
      return res.status(400).json({ error: `Unknown data type "${String(req.body.valueType)}".` });
    }
    /**
     * Anything this route cannot set is REFUSED, never quietly dropped.
     *
     * A column is created bare and then configured by PATCH, which is where the real checks live —
     * a model is validated against the catalogue there, and duplicating that here would be two
     * copies of a rule that decides what a run costs.
     *
     * A silent drop is what would make that dangerous. Accepting `model` here and ignoring it
     * answers 200 with a column on `auto`, so a column meant for a free local model points at a paid
     * one while the caller has every reason to think otherwise, and the way you find out is the bill.
     * A 400 that names the field cannot do that.
     */
    const notHere = ["prompt", "model", "config", "description", "width", "color", "runCondition"]
      .filter((f) => req.body?.[f] !== undefined);
    if (notHere.length) {
      const one = notHere.length === 1;
      return res.status(400).json({
        error:
          `A new column is created bare, so ${notHere.join(", ")} cannot be set here — and ` +
          `${one ? "was" : "were"} NOT applied. Create the column, then PATCH /api/columns/:id ` +
          `to set ${one ? "it" : "them"}.`,
      });
    }
    const col = addColumn(sheetId, {
      name: String(req.body?.name ?? "New column"),
      kind: req.body?.kind,
      valueType: req.body?.valueType,
    });
    res.json({ column: col });
  }));

  /**
   * Copy a column, definition and all, and drop the copy beside the original.
   *
   * The right shape for "I want another one of these, slightly different" — which on a paid column
   * is also the safe shape, because the copy arrives empty and runs on your say-so rather than
   * inheriting a sheet's worth of values that were never checked.
   */
  app.post("/api/columns/:id/duplicate", wrap((req, res) => {
    const made = duplicateColumn(param(req, "id"));
    if (!made) return res.status(404).json({ error: "Column not found" });
    res.json({ column: made });
  }));

  // One column on its own. The editor drawer needs this after an AI setup writes several fields at
  // once: re-reading the whole sheet to find out what one column now holds is a round trip over
  // every column on the sheet to answer a question about one of them.
  app.get("/api/columns/:id", wrap((req, res) => {
    const col = getColumn(param(req, "id"));
    if (!col) return res.status(404).json({ error: "Column not found" });
    res.json({ column: col });
  }));

  app.patch("/api/columns/:id", wrap(async (req, res) => {
    const id = param(req, "id");
    // Every field change on this route captures its BEFORE value, so each is individually
    // reversible. Read once up front: the later writes would otherwise see each other's changes and
    // a multi-field PATCH would record the wrong starting point.
    const before = getColumn(id);
    if (!before) return res.status(404).json({ error: "Column not found" });

    if (typeof req.body?.name === "string") {
      const next = req.body.name.trim();
      renameColumn(id, next);
      if (next !== before.name) {
        record(before.sheetId, "column.rename", `Rename "${before.name}" to "${next}"`,
          { columnId: Number(id), from: before.name, to: next });
      }
    }
    /**
     * Presentation, and NOT recorded as an undo step.
     *
     * Everything else on this route is reversible because it changes what a column means. Width and
     * colour change how it is drawn, and the drag grip commits one on every release — putting those
     * in the undo log would bury the edit you actually want to take back under a run of "column
     * resized" entries, which is what makes an undo stack useless.
     */
    if (req.body?.width !== undefined) {
      setColumnWidth(id, req.body.width == null ? null : Number(req.body.width));
    }
    if (req.body?.color !== undefined) {
      setColumnColor(id, req.body.color == null ? null : String(req.body.color));
    }
    if (req.body?.valueType !== undefined) {
      // Rejected rather than coerced: an unrecognised type would be written straight into the column
      // and then drive coercion, sorting and the filter operators offered for it.
      if (!isValueType(req.body.valueType)) {
        res.status(400).json({ error: `Unknown data type "${String(req.body.valueType)}".` });
        return;
      }
      setColumnValueType(id, req.body.valueType);
      record(before.sheetId, "column.field", `Set "${before.name}" to ${req.body.valueType}`,
        { columnId: Number(id), field: "value_type", from: before.valueType, to: req.body.valueType });
    }
    if (req.body?.enumValues !== undefined) {
      // The allowed values of an enum column. Normalised, not stored as sent: a duplicate spelling or
      // a blank option silently changes what a valid answer is, so the rule lives in one tested place
      // and both the model prompt and coercion read the cleaned list. A non-array is the one shape
      // refused outright — everything else (blanks, dupes, an over-long paste) is cleaned, not
      // rejected, so filling this in never fails on a technicality.
      const { values, error } = normalizeEnumValues(req.body.enumValues);
      if (error) { res.status(400).json({ error }); return; }
      setColumnEnumValues(id, values);
      record(before.sheetId, "column.field", `Set the options for "${before.name}"`,
        { columnId: Number(id), field: "enum_values", from: before.enumValues ?? [], to: values });
    }
    if (req.body?.format !== undefined) {
      // How a currency/percent column is shown. Normalised in one tested place (a valid ISO code,
      // clamped decimals), so a junk descriptor cannot reach the grid formatter. Presentation, not
      // recorded as an undo step, for the same reason width and colour are not.
      setColumnFormat(id, normalizeFormat(req.body.format));
    }
    if (req.body?.kind !== undefined) {
      // The lane is what a column costs. An unrecognised one written straight through would either
      // never be picked up by any executor — a column that silently does nothing forever — or land
      // the row on a more expensive lane than the user chose.
      if (!isColumnKind(req.body.kind)) {
        res.status(400).json({ error: `Unknown column mode "${String(req.body.kind)}".` });
        return;
      }
      setColumnKind(id, req.body.kind);
      record(before.sheetId, "column.field", `Set how "${before.name}" runs`,
        { columnId: Number(id), field: "kind", from: before.kind, to: req.body.kind });
    }
    if (req.body?.model !== undefined) {
      const next = String(req.body.model);
      // Checked against the catalogue, not free text. A typo'd model id is accepted by nothing and
      // would fail once per row at run time, after the run had already started spending on the rows
      // that came before it.
      // A local model id is not in the hosted catalogue and never will be — validated by parsing
      // instead, which is also the check that catches a malformed one.
      if (next !== "auto" && !isLocalModel(next)) {
        const models = await listModels().catch(() => []);
        // An empty catalogue means the price list was unreachable — not that the model is wrong. It
        // is accepted, because refusing every model whenever OpenRouter is briefly down would be a
        // worse failure than accepting one unverified id.
        if (models.length > 0 && !models.some((m) => m.id === next)) {
          res.status(400).json({ error: `No model called "${next}" on OpenRouter.` });
          return;
        }
      }
      setColumnModel(id, next);
      record(before.sheetId, "column.field", `Set the model for "${before.name}"`,
        { columnId: Number(id), field: "model", from: before.model, to: next });
    }
    /**
     * The cheap model to try first, before the one above.
     *
     * Validated exactly like `model` — a typo'd id here would fail on every row and then escalate,
     * so the column would appear to work while silently paying full price and double the latency,
     * which is the least detectable way for this feature to be broken.
     *
     * An empty string turns it off, and is the only way to turn it off. Refusing to accept "" would
     * make the setting one-way.
     */
    if (req.body?.firstModel !== undefined) {
      const next = String(req.body.firstModel).trim();
      if (next) {
        if (next === "auto") {
          res.status(400).json({ error: `"auto" is not a first model — name the cheap model you want tried.` });
          return;
        }
        // The same model twice would ask the identical question of the identical model and bill for
        // the identical answer. Refused here rather than quietly ignored at run time, so the setting
        // never claims to be doing something it is not.
        const strong = before.model && before.model !== "auto" ? before.model : null;
        if (strong && next === strong) {
          res.status(400).json({
            error: `"${next}" is already this column's model, so trying it first would just run it twice.`,
          });
          return;
        }
        if (!isLocalModel(next)) {
          const models = await listModels().catch(() => []);
          if (models.length > 0 && !models.some((m) => m.id === next)) {
            res.status(400).json({ error: `No model called "${next}" on OpenRouter.` });
            return;
          }
        }
      }
      setColumnFirstModel(id, next);
      record(before.sheetId, "column.field", `Set the first model for "${before.name}"`,
        { columnId: Number(id), field: "first_model", from: before.firstModel ?? null, to: next || null });
    }
    if (req.body?.prompt !== undefined) {
      // Capped. A prompt is sent on EVERY row, so its length is multiplied by the sheet — a pasted
      // ten-thousand-word brief is not a prompt, it is a bill.
      const next = String(req.body.prompt);
      if (next.length > 8000) {
        res.status(400).json({ error: "That instruction is too long. It is sent once per row, so keep it under 8,000 characters." });
        return;
      }
      setColumnPrompt(id, next);
      record(before.sheetId, "column.field", `Change the instruction for "${before.name}"`,
        { columnId: Number(id), field: "prompt", from: before.prompt ?? null, to: next.trim() ? next : null });
    }
    if (req.body?.send !== undefined) {
      // Validated here rather than at run time. A destination that does not exist, or a mapping onto
      // a column that was deleted, would otherwise be discovered by a run that had already started
      // writing — and this is the one lane whose mistakes land in a table nobody is looking at.
      //
      // The STORED text is read before and after, not `before.sendConfig`, because the undo entry is
      // replayed as `UPDATE columns SET send_config = ?` and a bound object is not a value SQLite
      // takes. Recording `{from: null, to: null}` would make undo AND redo clear the column
      // outright: one click erasing the destination, the mapping, the conflict rule and the cap.
      const sendBefore = storedSendConfig(id);
      const raw = req.body.send;
      if (raw === null) {
        setColumnSendConfig(id, null);
      } else {
        const cfg = { ...DEFAULT_SEND, ...(raw as Partial<SendConfig>) } as SendConfig;
        if (cfg.targetSheetId) {
          if (!getSheet(cfg.targetSheetId)) {
            res.status(400).json({ error: "That destination table no longer exists." });
            return;
          }
          if (cfg.targetSheetId === before.sheetId) {
            res.status(400).json({ error: "A table cannot send into itself — that would keep adding to the rows it is reading." });
            return;
          }
          const targetCols = new Set(listColumns(cfg.targetSheetId).map((c) => Number(c.id)));
          for (const key of Object.keys(cfg.mapping ?? {})) {
            if (!targetCols.has(Number(key))) delete (cfg.mapping as Record<string, unknown>)[key];
          }
        }
        setColumnSendConfig(id, cfg as unknown as Record<string, unknown>);
      }
      record(before.sheetId, "column.field", `Change the destination for "${before.name}"`,
        { columnId: Number(id), field: "send_config", from: sendBefore, to: storedSendConfig(id) });
    }
    if (req.body?.rateLimitPerMin !== undefined) {
      // Clamped rather than refused: a negative or absurd number is a typo, and the nearest sensible
      // reading of it is obvious. 0 is the honest way to say "no limit" and is the default.
      const n = Math.max(0, Math.min(100_000, Math.floor(Number(req.body.rateLimitPerMin) || 0)));
      db.prepare("UPDATE columns SET rate_limit_per_min = ?, updated_at = datetime('now') WHERE id = ?").run(n, Number(id));
      record(before.sheetId, "column.field", `Set the rate limit for "${before.name}"`,
        { columnId: Number(id), field: "rate_limit_per_min", from: before.rateLimitPerMin ?? 0, to: n });
    }
    if (req.body?.waitSeconds !== undefined) {
      // One hour is the ceiling. Past that it is not a pipeline step, it is a scheduled run — which
      // this app has, and which survives a restart where a held-open wait does not.
      const n = Math.max(0, Math.min(3600, Math.floor(Number(req.body.waitSeconds) || 0)));
      db.prepare("UPDATE columns SET wait_seconds = ?, updated_at = datetime('now') WHERE id = ?").run(n, Number(id));
      record(before.sheetId, "column.field", `Set the wait for "${before.name}"`,
        { columnId: Number(id), field: "wait_seconds", from: before.waitSeconds ?? 0, to: n });
    }
    if (req.body?.validation !== undefined) {
      const raw = req.body.validation;
      // `null` clears them. Distinguished from an absent key, which means "leave them alone" — the
      // editor sends the whole column, so a missing key must never be read as "delete the rules".
      if (raw === null) {
        db.prepare("UPDATE columns SET validation = NULL, updated_at = datetime('now') WHERE id = ?").run(Number(id));
      } else {
        const set = { rules: Array.isArray(raw?.rules) ? raw.rules : [], onFail: raw?.onFail === "warn" ? "warn" : "reject" } as RuleSet;
        // REFUSED, not stored-and-ignored. A rule that cannot be evaluated passes every value, which
        // on screen is indistinguishable from a rule that is working — the worst possible failure
        // for a feature whose entire job is to refuse things.
        const problem = rulesProblem(set);
        if (problem) return res.status(400).json({ error: problem });
        db.prepare("UPDATE columns SET validation = ?, updated_at = datetime('now') WHERE id = ?")
          .run(set.rules.length === 0 ? null : JSON.stringify(set), Number(id));
      }
      record(before.sheetId, "column.field", `Change the rules for "${before.name}"`,
        { columnId: Number(id), field: "validation", from: before.validation ? JSON.stringify(before.validation) : null, to: storedValidation(id) });
    }
    if (req.body?.waterfall !== undefined) {
      /**
       * Saved only if it PARSES BACK to what was sent.
       *
       * A waterfall decides what gets called and in what order, so a step the reader will silently
       * drop is a step that stops running with nothing on screen to say so — and the next row falls
       * through to the provider behind it and is charged for it. Round-tripping through the same
       * reader the engine uses means the editor cannot save something the engine will not run.
       */
      // Read as STORED TEXT before the write, not off `before.waterfall`, for the reason the send
      // config records right above: the undo entry is replayed as `UPDATE columns SET
      // waterfall_json = ?`, and a bound object is not a value SQLite takes.
      const waterfallBefore = storedWaterfall(id);
      const raw = req.body.waterfall;
      if (raw === null) {
        setColumnWaterfall(id, null);
      } else {
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        const { waterfall, dropped } = parseWaterfall(text);
        if (dropped.length > 0) {
          res.status(400).json({ error: `This waterfall was not saved. ${dropped.join(" ")}` });
          return;
        }
        // The NORMALIZED form is stored, not the raw text: what the engine will run and what the
        // editor will show back are then the same object, rather than two readings of one string.
        setColumnWaterfall(id, JSON.stringify(waterfall));
      }
      record(before.sheetId, "column.field", `Change the steps for "${before.name}"`,
        { columnId: Number(id), field: "waterfall_json", from: waterfallBefore, to: storedWaterfall(id) });
    }
    if (req.body?.description !== undefined) {
      // Capped, but generously: this is read by people, never sent to a model, so its only cost is
      // the room it takes in a tooltip.
      const next = String(req.body.description ?? "").slice(0, 2000);
      setColumnDescription(id, next);
      record(before.sheetId, "column.field", `Describe "${before.name}"`,
        { columnId: Number(id), field: "description", from: before.description ?? null, to: next.trim() ? next.trim() : null });
    }
    if (req.body?.lookup !== undefined) {
      const l = (req.body.lookup ?? {}) as { relationId?: unknown; sourceColumnId?: unknown };
      try {
        setLookup(Number(id), Number(l.relationId), Number(l.sourceColumnId));
      } catch (e) {
        // 400 with the reason, not a 500. Every one of these is a choice the user can correct on the
        // screen they are looking at — "that link has been removed", "that field was deleted".
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      record(before.sheetId, "column.field", `Point "${before.name}" at another table`,
        { columnId: Number(id), field: "lookup", from: null, to: { relationId: Number(l.relationId), sourceColumnId: Number(l.sourceColumnId) } });
    }
    if (req.body?.rollup !== undefined) {
      const r = (req.body.rollup ?? {}) as Record<string, unknown>;
      try {
        setRollup(
          Number(id),
          Number(r.relationId),
          r.fn as never,
          r.sourceColumnId == null ? null : Number(r.sourceColumnId),
          typeof r.separator === "string" ? r.separator : undefined,
        );
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      record(before.sheetId, "column.field", `Change what "${before.name}" calculates`,
        { columnId: Number(id), field: "rollup", from: null, to: { relationId: Number(r.relationId), fn: r.fn } });
    }
    /**
     * Which tools this column's agent may call.
     *
     * There was NO WAY TO SET THIS. `allowed_tools` has been in the schema from the first migration,
     * the executor reads it, the estimate reads it, the savings ledger reads it, the live cost
     * preview reads it — and nothing in the entire product ever wrote it. It defaults to `[]`, the
     * executor falls back to `["fetch_url"]`, and `buildToolset` only attaches `web_search` when the
     * name is in the list.
     *
     * So no agent column could search the web. Twenty-odd search backends, the per-search budget, the
     * domain filters, the context-size control — all of it configured HOW a search would run, and the
     * tool was never handed to the model. Confirmed against the live database: two agent columns, and
     * not one row in `columns` with web_search in it.
     *
     * Validated against the names `buildToolset` actually knows. An unknown name is silently dropped
     * there, so accepting one here would store a setting that does nothing and looks like it does.
     */
    if (req.body?.allowedTools !== undefined) {
      const BUILT_IN = ["fetch_url", "web_search"];
      const raw: string[] = (Array.isArray(req.body.allowedTools) ? req.body.allowedTools : []).map(String);

      /**
       * A connected app's tools are named `mcp:<serverId>:<tool>`.
       *
       * Checked against the registry rather than against a list in this file, because the set is not
       * knowable here: it is whatever the apps the user registered happen to offer, and it changes
       * when one of them is updated. The APP has to exist; the tool name is not verified, because
       * doing so would mean connecting on every save, and a tool the server has since dropped is
       * already handled — `mcpToolsFor` simply does not build it, and the loop refuses a name it
       * does not have.
       */
      const bad = raw.filter((t) => {
        if (BUILT_IN.includes(t)) return false;
        const parsed = parseMcpToolName(t);
        return !parsed || !getMcpServer(parsed.serverId);
      });
      if (bad.length > 0) {
        res.status(400).json({ error: `No tool called ${bad.map((t) => `"${t}"`).join(", ")}.` });
        return;
      }
      // Deduped and ordered, so two columns with the same tools compare equal — a template and the
      // column it came from must not differ by the order somebody happened to click. Built-ins keep
      // their registry order; the rest sort by name, since there is no natural order to inherit.
      const chosen = new Set(raw);
      const next = [
        ...BUILT_IN.filter((t) => chosen.has(t)),
        ...[...chosen].filter((t) => !BUILT_IN.includes(t)).sort(),
      ];
      setColumnAllowedTools(id, next);
      record(before.sheetId, "column.field", `Change what "${before.name}" is allowed to do`,
        { columnId: Number(id), field: "allowed_tools", from: before.allowedTools ?? [], to: next });
    }
    if (req.body?.mcpServers !== undefined) {
      // Every id must be a registered app. An unknown one would store a permission that grants
      // nothing and reads as though it grants something.
      const raw: string[] = (Array.isArray(req.body.mcpServers) ? req.body.mcpServers : []).map(String);
      const bad = raw.filter((s) => !getMcpServer(s));
      if (bad.length > 0) {
        res.status(400).json({ error: "That connected app is not set up." });
        return;
      }
      const next = [...new Set(raw)].sort();
      setColumnMcpServers(id, next);
      record(before.sheetId, "column.field", `Change which apps "${before.name}" can use`,
        { columnId: Number(id), field: "mcp_servers", from: before.mcpServers ?? [], to: next });
    }
    /**
     * The ceiling on ONE CELL, in dollars.
     *
     * Enforced since the beginning (`agent/executor.ts`, default $0.05) and until now settable only
     * by editing the database. A limit you cannot change is not much of a limit: the default is
     * generous for a classification and miserly for a research agent, and somebody hitting it had no
     * way to raise it and no way to find out why the cell refused.
     *
     * `0` means NO cap and is the executor's existing meaning, so it is allowed here even though it
     * is the opposite of what a zero usually means in a limit field. The UI spells that out; this
     * route only refuses what the executor cannot act on.
     */
    if (req.body?.maxBudgetUsd !== undefined) {
      const raw = req.body.maxBudgetUsd;
      const usd = typeof raw === "number" ? raw : Number.NaN;
      if (!Number.isFinite(usd) || usd < 0) {
        res.status(400).json({
          error: "The limit for one cell has to be a number of dollars, zero or more. Zero means no limit.",
          code: "bad_max_budget",
        });
        return;
      }
      setColumnMaxBudget(id, usd);
      record(before.sheetId, "column.field", `Change the per-cell limit on "${before.name}"`,
        { columnId: Number(id), field: "max_budget_usd", from: before.maxBudgetUsd ?? null, to: usd });
    }
    /**
     * The auto-run ceiling FIRST, so a request that sets both arrives at the switch with its limit
     * already stored. The other order leaves a window — however short — where the column is armed and
     * uncapped, and `flush` reads the ceiling at fire time.
     *
     * Validated rather than coerced. `Number("")` is 0 and `Number(null)` is 0, and 0 here would
     * read as a ceiling of nothing, which stops every run instead of allowing every run. Null is the
     * only way to say "no ceiling", and it has to be sent deliberately.
     */
    if (req.body?.autoRunBudgetUsd !== undefined) {
      const raw = req.body.autoRunBudgetUsd;
      if (raw === null) {
        setColumnAutoRunBudget(id, null);
      } else {
        const usd = typeof raw === "number" ? raw : Number.NaN;
        if (!Number.isFinite(usd) || usd <= 0) {
          res.status(400).json({
            error: "A spending limit has to be a number above zero. Send null to remove it.",
            code: "bad_auto_run_budget",
          });
          return;
        }
        setColumnAutoRunBudget(id, usd);
      }
      record(before.sheetId, "column.field", `Change the auto-run limit on "${before.name}"`,
        { columnId: Number(id), field: "auto_run_budget_usd", from: before.autoRunBudgetUsd ?? null, to: raw });
    }
    if (req.body?.autoRun !== undefined) {
      const on = !!req.body.autoRun;
      /**
       * A column that bills per row MAY start itself.
       *
       * Refusing this outright would protect the wrong thing. Filling new rows as they arrive is the
       * reason people turn the switch on, and a tool that cannot do it is worse at the job than the
       * ones it replaces.
       *
       * The bound is `auto_run_budget_usd` instead, handed to each firing as its own run budget. The
       * switch is the deliberate act; the ceiling is what keeps it from becoming an open-ended one
       * once the person who flipped it has moved on. What is still refused, elsewhere, is a spend
       * nobody chose at all: nothing escalates to a dearer model on its own.
       *
       * The limit is not required, so it is not demanded here. The settings panel offers one and
       * shows what a firing costs; a person who reads that and chooses no limit has chosen.
       */
      setColumnAutoRun(id, on);
      record(before.sheetId, "column.field", `${on ? "Turn on" : "Turn off"} auto-run for "${before.name}"`,
        {
          columnId: Number(id), field: "auto_run", from: before.autoRun ? 1 : 0, to: on ? 1 : 0,
          // In the audit line because "who let this column start spending, and with what ceiling" is
          // one question, and answering half of it later means reading two records and hoping they
          // are about the same moment.
          limitUsd: req.body?.autoRunBudgetUsd !== undefined ? req.body.autoRunBudgetUsd : (before.autoRunBudgetUsd ?? null),
        });
    }
    if (req.body?.toIndex !== undefined) {
      const to = Number(req.body.toIndex);
      if (!Number.isInteger(to) || to < 0) {
        res.status(400).json({ error: "A column can only move to a whole position." });
        return;
      }
      const order = listColumns(before.sheetId).map((c) => Number(c.id));
      const from = order.indexOf(Number(id));
      moveColumn(id, to);
      if (from !== to) {
        record(before.sheetId, "column.field", `Move "${before.name}"`,
          { columnId: Number(id), field: "position", from, to });
      }
    }
    if (req.body?.frozen !== undefined) {
      const on = !!req.body.frozen;
      setColumnFrozen(id, on);
      record(before.sheetId, "column.field", `${on ? "Pin" : "Unpin"} "${before.name}"`,
        { columnId: Number(id), field: "frozen", from: before.frozen ? 1 : 0, to: on ? 1 : 0 });
    }
    if (req.body?.http !== undefined) {
      // Normalized on save, not on run. A bad method or a malformed header name would otherwise be
      // discovered once per row, mid-run, having already spent whatever the earlier rows cost.
      try {
        setColumnHttpConfig(id, req.body.http === null ? null : (normalizeHttpConfig(req.body.http) as never));
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    if (req.body?.mcp !== undefined) {
      // Same reasoning as the http branch above: a tool name or an argument map that cannot work is
      // the column's fault, and finding out once per row mid-run means finding out after paying.
      try {
        setColumnMcpConfig(id, req.body.mcp === null ? null : (normalizeMcpConfig(req.body.mcp) as never));
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    if (req.body?.agent !== undefined) {
      // Validated, not stored as sent. These values are forwarded to a paid API, so an unrecognised
      // engine or a negative result count would either be silently ignored by OpenRouter — leaving
      // the user believing they configured something — or rejected mid-run, per row.
      try {
        setColumnAgent(id, req.body.agent === null ? null : normalizeAgentSettings(req.body.agent));
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }

    /**
     * Re-derive the dependency edges from the fields that carry references.
     *
     * `rebuildDeps` was called from exactly ONE place — saving a generated script — so every prompt,
     * request and send configuration written through this route left `column_deps` holding whatever
     * a script save had last put there, which for most columns is nothing at all.
     *
     * That is not a stale cache. Run ORDER is `topoDepths` over those edges, so a send column
     * configured here came out at depth 0 and ran before the columns it reads: it wrote a table of
     * nulls, and because its match key resolved to null too, the later correct run could not upsert
     * those rows and duplicated the destination instead. The same silence applies to a prompt — its
     * column never went stale when the column it references changed.
     */
    if (req.body?.prompt !== undefined || req.body?.send !== undefined || req.body?.http !== undefined || req.body?.mcp !== undefined) {
      rebuildDeps(before.sheetId, Number(id));
    }
    res.json({ column: getColumn(id) });
  }));

  app.delete("/api/columns/:id", wrap((req, res) => {
    const id = param(req, "id");
    const col = getColumn(id);
    if (!col) return res.status(404).json({ error: "Column not found" });
    deleteColumn(id);
    // Recorded AFTER the delete so the stored timestamp is the one actually written — a redo has to
    // restore the same deleted_at, not a fresh one, or the two directions drift apart.
    const deletedAt = (db.prepare("SELECT deleted_at FROM columns WHERE id = ?").get(Number(id)) as any)?.deleted_at;
    record(col.sheetId, "column.delete", `Delete column "${col.name}"`, { columnId: Number(id), deletedAt });
    res.json({ ok: true });
  }));

  // ───────────────────────────────────────────────────── webhook sources
  //
  // The delivery endpoint deliberately does NOT live under /api. Everything under /api is the app
  // talking to its own engine; this is a stranger posting data, and giving it a path of its own is
  // what keeps "which routes are unauthenticated" a question with a one-word answer.

  app.get("/api/sheets/:id/sources", wrap((req, res) => {
    const sheetId = param(req, "id");
    res.json({
      sources: listSources(sheetId).map((s) => ({ ...s, url: `${req.protocol}://${req.get("host")}/hook/${s.token}` })),
    });
  }));

  app.post("/api/sheets/:id/sources", wrap((req, res) => {
    const sheetId = param(req, "id");
    // A source is a live, unauthenticated address. Minting one for a table that is not there would
    // leave a token accepting deliveries into nothing — and the delivery endpoint answers 404 for
    // unknown and disabled tokens alike, so nobody posting to it would ever find out why.
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const src = createSource(sheetId, String(req.body?.name ?? ""));
    res.json({ source: { ...src, url: `${req.protocol}://${req.get("host")}/hook/${src.token}` } });
  }));

  app.patch("/api/sources/:id", wrap((req, res) => {
    const src = updateSource(Number(param(req, "id")), {
      name: req.body?.name,
      enabled: req.body?.enabled,
      mapping: req.body?.mapping,
      keyPath: req.body?.keyPath,
      itemsPath: req.body?.itemsPath,
    });
    if (!src) return res.status(404).json({ error: "Source not found" });
    res.json({ source: { ...src, url: `${req.protocol}://${req.get("host")}/hook/${src.token}` } });
  }));

  app.post("/api/sources/:id/rotate", wrap((req, res) => {
    const src = rotateToken(Number(param(req, "id")));
    if (!src) return res.status(404).json({ error: "Source not found" });
    res.json({ source: { ...src, url: `${req.protocol}://${req.get("host")}/hook/${src.token}` } });
  }));

  app.delete("/api/sources/:id", wrap((req, res) => {
    deleteSource(Number(param(req, "id")));
    res.json({ ok: true });
  }));

  app.get("/api/sources/:id/deliveries", wrap((req, res) => {
    res.json({ deliveries: listDeliveries(Number(param(req, "id")), 20) });
  }));

  /**
   * A delivery.
   *
   * Two responses only: 202 when it landed, 404 when the token is unknown, disabled, or belongs to a
   * source that cannot store anything. That last grouping is deliberate — a distinct "this token
   * exists but is switched off" tells anyone probing which tokens are real.
   *
   * A body that is not JSON is still RECORDED before being refused, because "the sender is posting
   * form-encoded" is exactly the sort of thing you can only diagnose by seeing what arrived.
   */
  app.post("/hook/:token", wrap((req, res) => {
    const source = findByToken(param(req, "token"));
    if (!source || !source.enabled) return res.status(404).json({ error: "Not found" });

    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      deliver({ ...source, mapping: {} }, null, raw);
      return res.status(400).json({ error: "Body must be JSON." });
    }

    const out = deliver(source, parsed, raw);
    // Same door as a CSV import: rows arrived without passing through a cell-write path.
    if (out.ok) noteRowsArrived(source.sheetId);
    // 202, not 200: the rows are written, but a sender should not read this as "and everything
    // downstream has run" — nothing has, and auto-run is what decides whether it will.
    res.status(out.ok ? 202 : 400).json(out);
  }));

  /**
   * How many destination tables a proposal is shown.
   *
   * A ceiling because the list is sent on every setup call and each entry carries its column names;
   * a workspace with hundreds of tables would spend most of the prompt on tables nobody mentioned.
   * Whatever is left out is COUNTED and said, never dropped silently.
   */
  const SEND_TARGETS_SHOWN = 40;

  // ───────────────────────────────────────────────────── AI setup
  //
  // Describe what you want; the column configures itself. Two routes rather than one, deliberately:
  // `propose` decides and returns, `apply` writes. Nothing a model produced reaches the column
  // without the user having seen the list of changes and pressed a button.

  app.post("/api/columns/:id/ai-setup", wrap(async (req, res) => {
    const id = param(req, "id");
    const col = getColumn(id);
    if (!col) return res.status(404).json({ error: "Column not found" });

    const columns = listColumns(col.sheetId);
    // What the table actually contains — fill rates, samples spread across the sheet, and the errors
    // already there. This replaced one sample row, which could not tell a 96%-filled column from a
    // 4%-filled one and so produced proposals that referenced columns with nothing in them.
    const evidence = gatherEvidence(col.sheetId);

    // The other tables, so a `send` column is proposable at all. It is the largest feature in the
    // app and was invisible to this route: no destination list went in, and `send` was missing from
    // the list of modes that could come back.
    //
    // EVERY table, not the ones in this workbook. The hand-built Send screen is handed
    // `listSheets()` and lets you pick any table in the workspace, so showing the model only its
    // workbook siblings made the assistant able to propose LESS than the user can do by hand — and
    // it failed silently, as "there is no table called that", which reads like the model got the
    // name wrong rather than like it was never shown the table.
    const allSheets = listSheets().filter((s) => s.id !== col.sheetId);
    const siblings = allSheets.slice(0, SEND_TARGETS_SHOWN).map((s) => ({
      id: s.id,
      name: s.name,
      // Needed to tell a linkable table from a merely sendable one: a relation requires both tables
      // to be in the same workbook, and a send does not.
      workbookId: s.workbookId ?? null,
      columns: listColumns(s.id).map((c) => ({ id: Number(c.id), name: c.name })),
    }));

    // No local catch, because answering 400 with the raw exception text is exactly what `wrap` was
    // written to replace: a driver fault or a TypeError inside the provider layer would be reported
    // to the user as if THEY had sent something invalid, its internals echoed into the response, and
    // — because it looks like an ordinary rejection — nothing logged. A refusal this module throws
    // on purpose still comes back as a 400
    // with its own sentence, because that is what `statusOf` does with a plain Error.
    const proposal = await proposeSetup({
      column: col,
      columns,
      evidence,
      siblings,
      // Said rather than hidden. A truncated list that claims to be the whole workspace turns "that
      // table is not in the list" into "that table does not exist", and the user is then told to
      // pick a destination that the model was never shown.
      moreSheets: Math.max(0, allSheets.length - siblings.length),
      selfWorkbookId: getSheet(col.sheetId)?.workbookId ?? null,
      intent: String(req.body?.intent ?? ""),
      docsUrl: req.body?.docsUrl ? String(req.body.docsUrl) : undefined,
      area: req.body?.area as SetupArea | undefined,
    });
    res.json({ proposal });
  }));

  app.post("/api/columns/:id/ai-setup/apply", wrap((req, res) => {
    const id = param(req, "id");
    const before = getColumn(id);
    if (!before) return res.status(404).json({ error: "Column not found" });

    const p = (req.body?.proposal ?? {}) as Record<string, any>;
    const applied: string[] = [];

    try {
      // One transaction. A half-applied proposal — the mode switched but the request not written —
      // leaves a column that runs on a lane it has no configuration for, and the user has no way to
      // tell which half landed.
      tx(() => {
        if (p.kind !== undefined) {
          if (!isColumnKind(p.kind)) throw new Error(`Unknown column mode "${String(p.kind)}".`);
          setColumnKind(id, p.kind);
          record(before.sheetId, "column.field", `Set how "${before.name}" runs`,
            { columnId: Number(id), field: "kind", from: before.kind, to: p.kind });
          applied.push("kind");
        }
        if (p.valueType !== undefined) {
          if (!isValueType(p.valueType)) throw new Error(`Unknown data type "${String(p.valueType)}".`);
          setColumnValueType(id, p.valueType);
          record(before.sheetId, "column.field", `Set "${before.name}" to ${p.valueType}`,
            { columnId: Number(id), field: "value_type", from: before.valueType, to: p.valueType });
          applied.push("valueType");
        }
        if (typeof p.prompt === "string" && p.prompt.trim()) {
          setColumnPrompt(id, p.prompt);
          record(before.sheetId, "column.field", `Change the instruction for "${before.name}"`,
            { columnId: Number(id), field: "prompt", from: before.prompt ?? null, to: p.prompt });
          applied.push("prompt");
        }
        if (p.enumValues !== undefined) {
          // An enum column's allowed values — the change this route used to have nowhere to put, so a
          // correct "add Biotechnology to the list" diagnosis had to be sent to the editor by hand.
          // Normalised the same way the hand-edited PATCH normalises it, since the proposal made a
          // round trip through the browser and is input like any other.
          const { values, error } = normalizeEnumValues(p.enumValues);
          if (error) throw new Error(error);
          setColumnEnumValues(id, values);
          record(before.sheetId, "column.field", `Set the options for "${before.name}"`,
            { columnId: Number(id), field: "enum_values", from: before.enumValues ?? [], to: values });
          applied.push("enumValues");
        }
        if (p.http) {
          // Re-normalized on the way in. The proposal came back over HTTP and could have been edited
          // in the browser between proposing and applying, so it is validated like any other input
          // rather than trusted because this server produced it a moment ago.
          //
          // Through `safeHttp`, not the plain normalizer, for the same reason the proposal itself
          // goes through it: the settings that decide whether a request can reach this machine, and
          // how many times a failure is paid for again, are carried over from what the user already
          // had. Normalizing raw here left the one gap where a model-authored `allowPrivate: true`
          // could still land on a column.
          setColumnHttpConfig(id, safeHttp(p.http, normalizeHttpConfig(before.httpConfig ?? DEFAULT_HTTP)) as never);
          applied.push("http");
        }
        if (p.search) {
          setColumnAgent(id, normalizeAgentSettings({ search: { ...(before.agent as any)?.search, ...p.search } }));
          applied.push("search");
        }
        if (p.send) {
          // The destination is re-checked against the real workspace, not trusted because a proposal
          // named it. The proposal made a round trip through the browser, and a send pointed at a
          // table that has since been deleted would write rows into nothing and report success.
          const target = getSheet(String(p.send.targetSheetId ?? ""));
          if (!target) throw new Error("That destination table no longer exists. Pick one on the Send screen.");

          const targetCols = new Set(listColumns(target.id).map((c) => Number(c.id)));
          const hereCols = new Set(listColumns(before.sheetId).map((c) => Number(c.id)));
          const mapping: Record<string, { from: "row"; columnId: number }> = {};
          for (const [targetId, sourceId] of Object.entries(p.send.mapping ?? {})) {
            // Both ends checked. A mapping naming a column that has been deleted since the proposal
            // would silently drop that field, and a send that quietly copies less than it said it
            // would is the kind of wrong that is only noticed in the destination table weeks later.
            if (!targetCols.has(Number(targetId)) || !hereCols.has(Number(sourceId))) {
              throw new Error("A column in that mapping no longer exists. Open the Send screen and check it.");
            }
            mapping[String(targetId)] = { from: "row", columnId: Number(sourceId) };
          }
          if (Object.keys(mapping).length === 0) throw new Error("That send has nothing to copy.");

          setColumnSendConfig(id, {
            ...DEFAULT_SEND,
            targetSheetId: target.id,
            method: p.send.method === "per_item" ? "per_item" : "row",
            listColumnId: p.send.listColumnId != null ? Number(p.send.listColumnId) : undefined,
            mapping,
            keySource: p.send.keyColumnId != null ? { from: "row", columnId: Number(p.send.keyColumnId) } : undefined,
            // Never "upsert" without a key: with nothing to match on every policy inserts, so storing
            // upsert would have the Send screen promise an idempotency it cannot deliver.
            onConflict: p.send.keyColumnId != null ? "upsert" : "insert",
          } as never);
          applied.push("send");
        }

        /**
         * A proposed link.
         *
         * The RELATION is reused when an equivalent one already exists and created only when it does
         * not. Building a second relation between the same two columns every time a proposal is
         * accepted would leave a workbook full of duplicates that all mean the same thing, each with
         * its own key index to maintain — and the health figures split across them.
         *
         * Ids were resolved by `resolveLink` against the real workspace before this ran; anything it
         * could not find became a sentence in `missing` rather than an id, so there is nothing here
         * that a model chose.
         */
        if (p.link) {
          const l = p.link;
          const existing = listRelations(before.sheetId).find(
            (r) => r.fromSheetId === before.sheetId
              && Number(r.fromColumnId) === Number(l.fromColumnId)
              && r.toSheetId === String(l.toSheetId)
              && Number(r.toColumnId) === Number(l.toColumnId),
          );
          const relation = existing ?? createRelation({
            fromSheetId: before.sheetId,
            fromColumnId: Number(l.fromColumnId),
            toSheetId: String(l.toSheetId),
            toColumnId: Number(l.toColumnId),
            cardinality: "many_to_one",
            matchMode: l.matchMode as never,
          });
          // An existing relation's match mode is left ALONE. It is shared by every column reading
          // through it, so loosening it here to suit one proposal would quietly change how every
          // other one of them matches.
          const kindNow = p.kind ?? before.kind;
          if (kindNow === "rollup") {
            setRollup(Number(id), Number(relation.id), (l.rollup ?? "count") as never,
              l.bringBackColumnId != null ? Number(l.bringBackColumnId) : null);
          } else {
            if (l.bringBackColumnId == null) throw new Error("That link has no field to bring back. Pick one on the Linked table screen.");
            setLookup(Number(id), Number(relation.id), Number(l.bringBackColumnId));
          }
          applied.push("link");
        }

        /**
         * Proposed steps.
         *
         * Saved through the same reader the engine uses, so the editor cannot end up holding a step
         * the engine would drop. Every step arrives DISABLED except where it needs nothing further:
         * an http step has no address yet and a script step has no rule yet, and a waterfall that
         * switched those on would run a column whose steps all fail, on every row, the moment it is
         * next run — while reporting itself configured.
         */
        if (p.waterfall?.length) {
          const steps = (p.waterfall as WaterfallStepProposal[]).map((s, i) => ({
            id: `s${i + 1}${Math.random().toString(36).slice(2, 8)}`,
            name: String(s.name),
            kind: s.kind,
            enabled: s.kind === "ai" || s.kind === "agent",
            config: s.prompt && (s.kind === "ai" || s.kind === "agent") ? { prompt: String(s.prompt) } : {},
            accept: s.accept,
            costUsd: null,
          }));
          const { waterfall, dropped } = parseWaterfall(JSON.stringify({ steps, accept: { kind: "non_empty" } }));
          if (dropped.length > 0) throw new Error(`Those steps could not be saved. ${dropped.join(" ")}`);
          setColumnWaterfall(id, JSON.stringify(waterfall));
          applied.push("waterfall");
        }
      });
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }

    // Same re-derivation the hand-built PATCH does: a proposal's prompt and request carry
    // `{{col:N}}` references, and until the edges exist the column runs at depth 0 — before the
    // columns it reads. `saveScript` below rebuilds again from the whole column, which is a repeat
    // of the same work rather than a different answer.
    if ((typeof p.prompt === "string" && p.prompt.trim()) || p.http) {
      rebuildDeps(before.sheetId, Number(id));
    }

    // Generated CODE is deliberately NOT applied here. It goes through the same review-and-approve
    // gate as any other generated script — saved unapproved, shown in the editor, and unable to run
    // until a person has read it. An AI setup path that quietly approved its own code would be a way
    // around the one gate that exists to stop that.
    let script = null;
    if (p.script?.code) {
      // The hook decides WHICH slot this code lands in, and getting it wrong is not cosmetic: a
      // predicate saved as the transform replaces the rule that produces the column's value. Only
      // the two hooks the proposal can legitimately carry are accepted.
      const hook = p.script.hook === "condition" ? "condition" : "transform";
      script = saveScript({
        sheetId: before.sheetId,
        columnId: Number(id),
        hook,
        runtime: p.script.runtime ?? "js",
        intent: String(p.script.intent ?? ""),
        code: String(p.script.code),
      });
      applied.push(hook);
    }

    res.json({ column: getColumn(id), applied, script });
  }));

  /**
   * Create ONE of the follow-on columns a proposal said were needed first.
   *
   * Its own route, and one column per call, because these are accepted individually. A proposal that
   * says "you also need Domain and Headcount" is two suggestions, and the good one should not have
   * to arrive with the bad one. Nothing runs — the column is created empty, like any other.
   */
  app.post("/api/columns/:id/ai-setup/also", wrap((req, res) => {
    const id = param(req, "id");
    const anchor = getColumn(id);
    if (!anchor) return res.status(404).json({ error: "Column not found" });

    const c = (req.body?.column ?? {}) as Record<string, unknown>;
    const name = String(c.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "That column has no name." });
    if (!isColumnKind(c.kind)) return res.status(400).json({ error: `Unknown column mode "${String(c.kind)}".` });
    const valueType = isValueType(c.valueType) ? c.valueType : "text";

    // Checked here as well as when the proposal was built. The two moments are minutes apart and the
    // user may have created it by hand in between, and two columns with one name is the mess this is
    // meant to prevent rather than cause.
    const existing = listColumns(anchor.sheetId);
    if (existing.some((x) => x.name.trim().toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `This table already has a column called "${name}".` });
    }

    const others = existing;
    const out = tx(() => {
      const col = addColumn(anchor.sheetId, { name, kind: c.kind as never, valueType });
      if (typeof c.prompt === "string" && c.prompt.trim() && (c.kind === "ai" || c.kind === "agent")) {
        setColumnPrompt(col.id, storeRefs(c.prompt, others));
      }
      // Without this the new column runs at depth 0 — before the columns its prompt reads, against
      // empty values, on a lane that bills.
      rebuildDeps(anchor.sheetId, Number(col.id));
      record(anchor.sheetId, "column.create", `Add column "${col.name}"`,
        { columnIds: [Number(col.id)], deletedAt: String((db.prepare("SELECT datetime('now') AS t").get() as any).t) });
      return col;
    });

    res.json({ column: getColumn(out.id) });
  }));

  // ───────────────────────────────────────────────────── what this prompt will cost

  /**
   * Price the prompt being TYPED, on the model currently chosen, at three scales.
   *
   * The cost of a column was only ever visible in the run confirmation — after the prompt was
   * written, the model picked, and the decision effectively made. But the prompt IS the cost: it is
   * re-sent on every row, and on the agent lane on every turn of every row, so a sentence added
   * while drafting is multiplied by the sheet. Someone typing a paragraph they could have typed in a
   * line has no way to see the difference until they are looking at a total.
   *
   * Three scales rather than one because the number that matters depends on the table, and the point
   * is the SHAPE: a prompt that costs a fiftieth of a cent per row is nothing at 1,000 rows and real
   * money at 100,000. One figure invites reading it as small.
   *
   * Charges nothing and calls no model — it reads the published price list, which is free.
   */
  app.post("/api/columns/:id/estimate-prompt", wrap(async (req, res) => {
    const col = getColumn(param(req, "id"));
    if (!col) return res.status(404).json({ error: "Column not found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = (body.kind === "agent" || body.kind === "ai" ? body.kind : col.kind) as string;
    if (kind !== "ai" && kind !== "agent") {
      // Every other lane is free per row or bills a third party, and inventing a token cost for one
      // would be worse than saying nothing.
      return res.json({ pricedLane: false, kind });
    }

    // What is on screen right now, falling back to what is saved — the caller may be pricing an
    // unsaved draft, which is the entire reason this route exists.
    const promptText = typeof body.prompt === "string" ? body.prompt : (col.prompt ?? "");
    const requested = typeof body.model === "string" && body.model ? body.model : (col.model ?? "auto");
    const modelId = requested === "auto" ? effectiveDefaultModel() : requested;

    let models: CatalogModel[] = [];
    let reachable = true;
    try { models = await listModels(); } catch { reachable = false; }

    // Search settings come from the BODY when the caller sends them, so the figure moves as the
    // sliders move. Reading only the saved column would mean the number lagged one save behind every
    // change — on the lane where the setting being changed is the expensive one.
    const liveSearch = (body.search ?? null) as { enabled?: boolean; maxResults?: number } | null;
    const savedSearchOn = (col.allowedTools ?? []).includes("web_search");
    const searchOn = kind === "agent" && (liveSearch?.enabled ?? savedSearchOn);
    const maxResults = Number(
      liveSearch?.maxResults ?? (col.agent as any)?.search?.maxResults ?? 5,
    );

    const priced = models.find((m) => m.id === modelId) ?? null;
    // The model's own published rate when it has one — they range from $0.0025 to $0.035 a call,
    // nearly a factor of fifteen — otherwise the per-results-count rate.
    const perSearch = searchOn ? priced?.webSearchPerCall ?? searchCostUsd(maxResults) : 0;

    // Turns are live too: they are the other half of what a search-enabled row can cost, since each
    // turn is a chance to search again AND re-sends the whole conversation.
    const turns = kind === "agent"
      ? Math.max(1, Number(body.maxTurns ?? (col.maxTurns > 0 ? col.maxTurns : 6)))
      : 1;

    const row = perRowCost({
      kind,
      modelId,
      promptText,
      sheetId: col.sheetId,
      columnId: Number(col.id),
      turns,
      searchPerCall: perSearch,
      // The engine stops at MAX_TOOL_CALLS or at the turn limit, whichever comes first. Quoting a
      // flat 16 regardless made a 2-turn column look eight times more expensive than it can be.
      maxSearches: searchOn ? Math.min(turns, MAX_TOOL_CALLS) : 0,
      models,
    });

    res.json({
      pricedLane: true,
      kind,
      model: modelId,
      modelName: priced?.name ?? modelId,
      local: isLocalModel(modelId),
      unpriced: row.unpriced,
      // Told apart on purpose: "this model has no published price" and "the price list could not be
      // read" look identical in a blank figure and mean different things.
      priceListUnavailable: !reachable,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      // The two halves, apart. On the agent lane they are not the same order of magnitude and they
      // are moved by different controls — blended into one figure, someone shortens a prompt to save
      // a hundredth of a cent while a search setting on another tab costs fifty times that.
      tokensUsd: row.tokensUsd,
      searchUsd: row.searchUsd,
      searchOn,
      searches: row.searches,
      perSearchUsd: row.perSearchUsd,
      maxResults,
      turns,
      perRow: row.perRow,
      // The actual row count too, so the panel can show what THIS table would cost alongside the
      // reference scales — the only one of the four that is not hypothetical.
      sheetRows: countRows(col.sheetId),
      scales: [1, 1_000, 100_000].map((rows) => ({ rows, total: row.perRow * rows })),
    });
  }));

  // ───────────────────────────────────────────────────── column history

  /**
   * What this column has actually done: the runs that touched it, and the code versions behind them.
   *
   * The History tab existed and was a hardcoded paragraph — *"Run history appears here once this
   * column has run"* — that fetched nothing and rendered nothing. Measured on a column that had just
   * processed 60,000 rows twice: the same sentence, which reads as "you have not run it yet" rather
   * than "this screen was never built". A tab that describes a feature it does not have is worse than
   * one that says it is empty, because the user goes looking for what they did wrong.
   *
   * Everything below was already being recorded; nothing new is written to serve it.
   */
  /**
   * The first few real values in a column, for the preview shown when a reference is hovered.
   *
   * This is what makes a reference checkable without leaving the editor. `/Domain` tells you the
   * name you picked; the values tell you whether that column actually holds domains — which is the
   * question that matters before a prompt runs over a million rows.
   *
   * In POSITION order and bounded, so it is an index scan of a few rows rather than a count of the
   * table. Values are truncated here rather than in the browser: a column can hold a whole API
   * response, and a preview must never ship a megabyte per hovered chip.
   */
  app.get("/api/columns/:id/preview", wrap((req, res) => {
    const id = Number(param(req, "id"));
    const col = getColumn(id);
    if (!col) return res.status(404).json({ error: "Column not found" });
    const limit = Math.max(1, Math.min(20, Number(req.query.limit ?? 10)));
    const rows = db
      .prepare(
        `SELECT r.position AS pos, c.value_text AS v
           FROM (SELECT id, position FROM rows WHERE sheet_id = ? ORDER BY position LIMIT ?) r
           LEFT JOIN cells c ON c.row_id = r.id AND c.column_id = ?
          ORDER BY r.position`,
      )
      .all(col.sheetId, limit, id) as any[];
    res.json({
      values: rows.map((r) => ({
        row: Number(r.pos) + 1,
        value: r.v == null ? null : String(r.v).slice(0, 160),
      })),
    });
  }));

  app.get("/api/columns/:id/history", wrap((req, res) => {
    const id = param(req, "id");
    const col = getColumn(id);
    if (!col) return res.status(404).json({ error: "Column not found" });

    // Runs are stored per SHEET, with the columns they resolved to inside scope_json — so a run that
    // touched this column is found by looking there rather than by a column_id it does not carry.
    // Bounded to the recent ones: this is a history panel, not an audit export.
    const rows = db
      .prepare(
        `SELECT id, status, total, done_c, error_c, skipped_c, cost_usd, budget_usd,
                created_at, started_at, finished_at, pause_reason, scope_json
           FROM runs WHERE sheet_id = ? ORDER BY created_at DESC LIMIT 200`,
      )
      .all(col.sheetId) as Array<Record<string, unknown>>;

    const runs = rows
      .filter((r) => {
        try {
          const ids = (JSON.parse(String(r.scope_json ?? "{}")) as { resolvedColumnIds?: number[] }).resolvedColumnIds;
          return Array.isArray(ids) && ids.map(Number).includes(Number(id));
        } catch {
          return false;
        }
      })
      .slice(0, 25)
      .map((r) => ({
        id: String(r.id),
        status: String(r.status),
        total: Number(r.total ?? 0),
        done: Number(r.done_c ?? 0),
        errors: Number(r.error_c ?? 0),
        skipped: Number(r.skipped_c ?? 0),
        costUsd: Number(r.cost_usd ?? 0),
        budgetUsd: r.budget_usd == null ? null : Number(r.budget_usd),
        startedAt: r.started_at == null ? null : String(r.started_at),
        finishedAt: r.finished_at == null ? null : String(r.finished_at),
        pauseReason: r.pause_reason == null ? null : String(r.pause_reason),
      }));

    // The distinct failures on this column, which is the question someone opens this tab to answer.
    // Grouped: 84 rows failing one way is one problem, not 84 lines to scroll.
    const failures = (
      db
        .prepare(
          `SELECT error_msg, COUNT(*) AS n FROM cells
            WHERE column_id = ? AND status = 'error' AND error_msg IS NOT NULL
            GROUP BY error_msg ORDER BY n DESC LIMIT 5`,
        )
        .all(Number(id)) as Array<{ error_msg: string; n: number }>
    ).map((f) => ({
      // Redacted on the way OUT as well as on the way in. These rows predate the redaction fix, so a
      // key written before today would otherwise be served to the browser by a route added after it.
      message: redactSecrets(String(f.error_msg)).slice(0, 300),
      rows: Number(f.n),
    }));

    // Code versions, so "which rule produced these values" has an answer. Approval state included
    // because an unapproved version is the usual reason a column stopped running.
    const scripts = (
      db
        .prepare(
          `SELECT id, hook, version, hash, approved_at, created_at, runtime
             FROM scripts WHERE column_id = ? ORDER BY version DESC LIMIT 10`,
        )
        .all(Number(id)) as Array<Record<string, unknown>>
    ).map((s) => ({
      id: Number(s.id),
      hook: String(s.hook),
      version: Number(s.version),
      hash: String(s.hash),
      runtime: String(s.runtime),
      approvedAt: s.approved_at == null ? null : String(s.approved_at),
      createdAt: String(s.created_at),
    }));

    res.json({ runs, failures, scripts });
  }));

  // ───────────────────────────────────────────────────── setup model
  //
  // Which model DESIGNS a column, as opposed to which model runs it on every row. Two settings, not
  // one; see setup/setupModel.ts for why sharing them is close to backwards.

  /**
   * The price list is loaded before the estimate is read, not taken from whatever is cached.
   *
   * Prices live in a process-lifetime cache, so the FIRST read after the engine starts finds it empty
   * — and an empty cache is indistinguishable from "this model has no published price". Settings
   * would have opened saying "price unknown" for a model whose price is perfectly well known. The
   * list needs no key and spends nothing, so this costs one request, once.
   */
  const withEstimate = async (s: ReturnType<typeof getSetupSettings>) => {
    await listModels().catch(() => {});
    return { ...s, estimateUsd: estimateSetupCost(s.model === "auto" ? DEFAULT_MODEL : s.model) };
  };

  app.get("/api/settings/setup-model", wrap(async (_req, res) => {
    res.json(await withEstimate(getSetupSettings()));
  }));

  app.patch("/api/settings/setup-model", wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = setSetupSettings({
      model: body.model === undefined ? undefined : String(body.model),
      freeOnly: body.freeOnly === undefined ? undefined : !!body.freeOnly,
    });
    res.json(await withEstimate(s));
  }));

  /**
   * Which model every `auto` column runs on.
   *
   * The counterpart to setup-model, and the one that was missing. `auto` resolved to a hardcoded
   * constant that nothing could change, so a model running on this machine could be detected, listed
   * and chosen column by column — but never made the default. On a product whose argument is that
   * the free lane should be the easy one, the free lane was the only one you had to opt into a
   * column at a time.
   *
   * `effective` is returned alongside the stored choice because the two can differ: "auto" resolves
   * to the engine's pick, and a chosen model that the provider has since retired falls back. A screen
   * that showed only the stored value would keep displaying a model that is not the one running.
   */
  app.get("/api/settings/run-model", wrap(async (_req, res) => {
    await listModels().catch(() => {});
    res.json({ model: getDefaultModelSetting(), effective: effectiveDefaultModel() });
  }));

  app.patch("/api/settings/run-model", wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    setDefaultModelSetting(body.model === undefined ? "auto" : String(body.model));
    await listModels().catch(() => {});
    res.json({ model: getDefaultModelSetting(), effective: effectiveDefaultModel() });
  }));

  /**
   * Where Ollama and LM Studio live, and whether anything answered there.
   *
   * `detected` is per runtime rather than a single total, because "LM Studio is running and Ollama is
   * not" is the common case and one combined count cannot say it. Without that split, a user who has
   * corrected the Ollama address has no way to tell whether the correction worked.
   */
  app.get("/api/settings/local-runtimes", wrap(async (_req, res) => {
    const found = await discoverLocalModels().catch(() => []);
    // Read AFTER the discovery, from the cache that discovery just filled — so the count and the
    // reason beside it come from the same probe. Two probes a second apart can disagree, because
    // LM Studio evicts an idle model.
    const reach = localReach();
    res.json({
      runtimes: localRuntimes().map((r) => ({
        id: r.id,
        label: r.label,
        note: r.note,
        needsKey: r.needsKey,
        // Whether a key is stored. Never the key, and never a masked copy of it.
        hasKey: r.hasKey,
        url: r.baseUrl,
        defaultUrl: defaultLocalUrl(r.id),
        isDefault: r.baseUrl === defaultLocalUrl(r.id),
        detected: found.filter((m) => m.runtime === r.id).length,
        // WHY there are none, when there are none. "Nothing is listening here" and "it is running
        // and holding no model" need different sentences, because the next action is different.
        reach: reach[r.id] ?? "off",
        models: found.filter((m) => m.runtime === r.id).map((m) => ({ id: m.id, name: m.name })),
      })),
    });
  }));

  app.patch("/api/settings/local-runtimes/:id", wrap(async (req, res) => {
    const id = param(req, "id");
    // Asks the list rather than naming two ids, so a runtime added after Ollama and LM Studio gets an
    // address field the server will actually accept.
    if (!isLocalRuntimeId(id)) { res.status(400).json({ error: "Unknown runtime." }); return; }
    const url = String((req.body ?? {}).url ?? "");
    const saved = setLocalUrl(id, url);
    // Re-probed straight away and reported, so pressing Save answers "did that work?" in the same
    // round trip rather than leaving the user to guess and re-open the screen.
    //
    // FORCED. This route is what the Check button calls, and discovery caches for 30 seconds — so
    // pressing Check within half a minute of loading the screen replayed the cached answer without
    // going near the address. The user starts their runtime, presses Check, and is told the same
    // thing as before by a probe that never ran. Check has to actually check.
    const found = await discoverLocalModels(true).catch(() => []);
    res.json({
      id,
      url: saved?.baseUrl ?? "",
      defaultUrl: defaultLocalUrl(id),
      // Set when what was typed is not what will be used: an address that is not local is refused,
      // and silently ignoring it would be the worst outcome on the one lane advertised as private.
      rejected: !!url.trim() && saved?.baseUrl !== url.trim().replace(/\/+$/, ""),
      detected: found.filter((m) => m.runtime === id).length,
      // So the answer to "did that work?" can name what actually happened rather than only whether
      // a count came back above zero. A running server holding no model is not a failed address.
      reach: localReach()[id] ?? "off",
    });
  }));

  /**
   * A token for a local runtime that needs one.
   *
   * Only two do — LiteLLM behind a master key, and AnythingLLM, which issues one from its own
   * settings. Without this they probe as "not running" however correctly they are set up, because
   * both refuse an unauthenticated model list.
   *
   * Not verified before storing, unlike a hosted provider's key. The re-probe in the response IS the
   * verification, and it is a better one: it answers whether models can actually be seen, rather than
   * whether a credential parses.
   */
  app.put("/api/settings/local-runtimes/:id/key", wrap(async (req, res) => {
    if (!provenLocal(req)) return refuseUnproven(res);
    const id = param(req, "id");
    if (!isLocalRuntimeId(id)) return res.status(400).json({ error: "Unknown runtime." });

    const key = String((req.body ?? {}).key ?? "").trim();
    if (key) saveSecret({ name: localSecretName(id), value: key, category: MODEL_KEY_CATEGORY });
    else deleteSecret(localSecretName(id));

    // Forces a re-probe: the cached list was gathered without the key and would report zero.
    const found = await discoverLocalModels(true).catch(() => []);
    res.json({
      id,
      hasKey: !!key,
      detected: found.filter((m) => m.runtime === id).length,
    });
  }));

  // ───────────────────────────────────────────────────── usage and cost

  /**
   * What a table, a workbook or the whole workspace has spent, and on what.
   *
   * One request returns the totals and every breakdown, rather than five requests returning parts of
   * one answer — they are read off the same small table, and a screen that fetches them separately is
   * a screen where the total and its own breakdown can disagree while you look at them.
   */
  /**
   * Every speed limit in the workspace, and how close each one is to it.
   *
   * The limits already existed — one per column, set on the column editor, obeyed by the pacer. What
   * did not exist was anywhere to SEE them. A limit you set six weeks ago on a column in a table you
   * have not opened since is a limit you no longer know about, and the first you hear of it is a run
   * that is mysteriously slow. Equally invisible is the inverse, and it is the more expensive one: a
   * paid column with NO limit, which is the column that will earn you a 429 or a bill.
   *
   * So this lists BOTH, and it lists the unlimited paid ones first — the gaps are the point.
   *
   * "Used" is counted from `cell_attempts`, not from a pacer. A Pacer is per-run and in memory: it
   * knows nothing between runs, nothing across two runs at once, and nothing at all after a restart.
   * The attempts table is what actually happened, so this number survives all three.
   */
  app.get("/api/limits", wrap((req, res) => {
    // Scoped to ONE table by default, because that is where it is opened from — the table's own
    // menu, beside its schedules and its restore points. A screen reached from a table that
    // silently listed every column in the workspace is the ambiguity this parameter removes: the
    // caller says which it wants and the answer says which it gave.
    const sheetId = typeof req.query.sheet === "string" && req.query.sheet ? req.query.sheet : null;
    const rows = db.prepare(`
      SELECT c.id, c.name, c.kind, c.rate_limit_per_min AS limitPerMin, c.wait_seconds AS waitSeconds,
             s.id AS sheetId, s.name AS sheetName,
             (SELECT COUNT(*) FROM cell_attempts a
               WHERE a.column_id = c.id
                 AND a.started_at >= datetime('now', '-60 seconds')) AS usedLastMinute,
             (SELECT MAX(a.started_at) FROM cell_attempts a WHERE a.column_id = c.id) AS lastRunAt
        FROM columns c
        JOIN sheets s ON s.id = c.sheet_id
       WHERE c.deleted_at IS NULL AND s.deleted_at IS NULL
         -- POSITIONAL, bound twice. The named form (a colon-prefixed name, called with an object)
         -- did not bind at all here: the clause evaluated as though nothing was passed, every row
         -- came back, and the screen labelled that "This table". A filter that silently fails open
         -- is the worst kind on a screen whose whole job is to say which set you are looking at.
         AND (? IS NULL OR s.id = ?)
         AND (c.rate_limit_per_min > 0 OR c.wait_seconds > 0 OR c.kind IN ('ai','agent','http','mcp','waterfall'))
       ORDER BY s.name, c.position
    `).all(sheetId, sheetId) as any[];

    res.json({
      // Echoed back, so the screen labels itself from what the server actually did rather than from
      // what it believes it asked for.
      scope: sheetId ? "table" : "workspace",
      limits: rows.map((r) => ({
        columnId: String(r.id),
        columnName: r.name,
        kind: r.kind,
        sheetId: r.sheetId,
        sheetName: r.sheetName,
        limitPerMin: Number(r.limitPerMin ?? 0),
        waitSeconds: Number(r.waitSeconds ?? 0),
        usedLastMinute: Number(r.usedLastMinute ?? 0),
        lastRunAt: r.lastRunAt ?? null,
        // Named on the server so the screen cannot invent its own definition of "a paid column" —
        // it is the same set `autoRun` gates on.
        paid: ["ai", "agent", "http", "mcp", "waterfall"].includes(String(r.kind)),
      })),
    });
  }));

  app.get("/api/usage", wrap((req, res) => {
    const raw = String(req.query.scope ?? "workspace");
    const scope = raw === "table" || raw === "workbook" ? raw : "workspace";
    const id = typeof req.query.id === "string" && req.query.id ? req.query.id : null;
    if (scope !== "workspace" && !id) {
      res.status(400).json({ error: "That report needs a table or workbook to be about." });
      return;
    }
    const from = typeof req.query.from === "string" ? req.query.from : null;
    res.json({
      report: usageReport(scope, id, {
        from,
        to: typeof req.query.to === "string" ? req.query.to : null,
      }),
      /**
       * What was NOT spent, alongside what was.
       *
       * The two belong on one screen: a bill without the work it declined to buy tells only half the
       * story, and it is the half that makes this tool look expensive.
       *
       * Only for a table or the whole workspace. Savings are recorded per sheet, and a workbook is a
       * set of sheets — summing them would need a join this route does not have, and a figure that
       * silently covered only some of a workbook's tables would be worse than none.
       */
      savings: scope === "workbook" ? null : savingsFor(scope === "table" ? id : null, from),
    });
  }));

  // ───────────────────────────────────────────────────── connected apps (MCP)

  /**
   * The registered MCP servers.
   *
   * Returned whole, because unlike a key there is no secret in one: credentials travel as
   * `{{secret:Name}}` references and are resolved when a call is built, so what is stored here is
   * the reference and never the value.
   */
  app.get("/api/mcp/servers", wrap((_req, res) => res.json({ servers: listMcpServers() })));

  /**
   * Register or update one.
   *
   * Gated on `provenLocal` like the provider-key routes, and this is the most important gate in the
   * app: a stdio server is a command this machine will run. A request that did not come from the app
   * running on this computer must never be able to add one.
   */
  app.post("/api/mcp/servers", wrap((req, res) => {
    if (!provenLocal(req)) return refuseUnproven(res);
    try {
      const existing = req.body?.id ? String(req.body.id) : undefined;
      res.json({ server: saveMcpServer(req.body, existing && getMcpServer(existing) ? existing : undefined) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }));

  app.delete("/api/mcp/servers/:id", wrap((req, res) => {
    if (!provenLocal(req)) return refuseUnproven(res);
    res.json({ deleted: deleteMcpServer(param(req, "id")) });
  }));

  /**
   * Connect, and ask the server what it can do.
   *
   * The same shape as checking a provider key: it proves the thing is reachable AND returns the
   * catalogue, so a column's tool list is what the server actually offers rather than something
   * typed from memory. A pool of one, closed straight afterwards — this is a settings screen, not a
   * run, and leaving a spawned process behind for a button press would be a leak per click.
   */
  app.post("/api/mcp/servers/:id/tools", wrap(async (req, res) => {
    if (!provenLocal(req)) return refuseUnproven(res);
    const id = param(req, "id");
    if (!getMcpServer(id)) return res.status(404).json({ error: "No such connected app." });
    const pool = new McpPool();
    try {
      res.json({ ok: true, tools: await pool.listTools(id) });
    } catch (e) {
      // 200 with ok:false, not a 500. A server that is switched off is an ordinary answer to
      // "is this working?", and the screen shows the reason rather than a failed request.
      res.json({ ok: false, error: e instanceof Error ? e.message : String(e), tools: [] });
    } finally {
      await pool.closeAll();
    }
  }));

  // ───────────────────────────────────────────────────── saved keys

  /**
   * The keys, MASKED. There is deliberately no route that returns a value.
   *
   * Not even to the screen that set it: a route that can return a key is a route that can leak one,
   * and no screen needs the value back — recognising which key is stored only takes its ends.
   */
  app.get("/api/secrets", wrap((_req, res) =>
    res.json({ secrets: listSecrets(), categories: listCategories() })));

  app.post("/api/secrets", wrap((req, res) => {
    // Every other key-write route carries this guard and this one did not, which made it the way
    // around all of them: `providerKeyFor` reads every non-OpenRouter provider's key out of this
    // store, so writing a secret named after a provider is exactly the "changes which account
    // Ferrum spends against" action the guard exists for.
    if (!provenLocal(req)) return refuseUnproven(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    res.json({
      secret: saveSecret({
        name: String(b.name ?? ""),
        value: b.value === undefined ? undefined : String(b.value),
        category: b.category === undefined ? undefined : String(b.category),
        note: b.note === undefined ? undefined : String(b.note),
      }),
    });
  }));

  app.delete("/api/secrets/:name", wrap((req, res) => {
    // The mirror of the guard on save: deleting a provider's key stops the runs that depend on it,
    // and deleting one a column refers to by name turns every row into an error on its next run.
    if (!provenLocal(req)) return refuseUnproven(res);
    deleteSecret(decodeURIComponent(param(req, "name")));
    res.json({ ok: true });
  }));

  /**
   * Which columns refer to a key, before deleting it.
   *
   * Deleting a key that something still uses turns every one of that column's rows into an error on
   * its next run, and the error arrives hours later with nothing pointing back at this screen. So
   * the answer is available while the decision is still being made.
   */
  app.get("/api/secrets/:name/usage", wrap((req, res) => {
    const name = decodeURIComponent(param(req, "name")).trim().toLowerCase();
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.sheet_id, s.name AS sheet_name
           FROM columns c JOIN sheets s ON s.id = c.sheet_id
          WHERE c.deleted_at IS NULL AND s.deleted_at IS NULL AND c.http_config IS NOT NULL`,
      )
      .all() as any[];
    const used = rows
      .filter((r) => secretNamesIn(String(r.http_config ?? "")).some((n) => n.toLowerCase() === name))
      .map((r) => ({ columnId: Number(r.id), column: String(r.name), sheetId: String(r.sheet_id), sheet: String(r.sheet_name) }));
    res.json({ used });
  }));

  // ───────────────────────────────────────────────────── column templates

  app.get("/api/column-templates", wrap((_req, res) =>
    res.json({ templates: listColumnTemplates() })));

  app.post("/api/columns/:id/save-template", wrap((req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    res.json({
      template: saveColumnTemplate(Number(param(req, "id")), {
        name: typeof b.name === "string" ? b.name : undefined,
        description: typeof b.description === "string" ? b.description : undefined,
        category: typeof b.category === "string" ? b.category : undefined,
      }),
    });
  }));

  app.patch("/api/column-templates/:id", wrap((req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    res.json({
      template: updateColumnTemplate(Number(param(req, "id")), {
        name: typeof b.name === "string" ? b.name : undefined,
        description: typeof b.description === "string" ? b.description : undefined,
        category: typeof b.category === "string" ? b.category : undefined,
      }),
    });
  }));

  app.delete("/api/column-templates/:id", wrap((req, res) => {
    deleteColumnTemplate(Number(param(req, "id")));
    res.json({ ok: true });
  }));

  /**
   * What this template would find here — asked BEFORE anything is created.
   *
   * The gallery calls it as you hover, so "this table has no Website" is on screen while the choice
   * is still a choice. Applying first and reading the warning afterwards is the wrong order when the
   * column that lands may be a paid one.
   */
  app.get("/api/column-templates/:id/check", wrap((req, res) => {
    const sheetId = String(req.query.sheetId ?? "");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    res.json(checkColumnTemplate(Number(param(req, "id")), sheetId));
  }));

  app.post("/api/column-templates/:id/apply", wrap((req, res) => {
    const sheetId = String((req.body ?? {}).sheetId ?? "");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const name = typeof (req.body ?? {}).name === "string" ? (req.body as any).name : undefined;
    res.json(applyColumnTemplate(Number(param(req, "id")), sheetId, name));
  }));

  // ───────────────────────────────────────────────────── scheduled runs

  app.get("/api/sheets/:id/schedules", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    res.json({ schedules: listSchedules(sheetId) });
  }));

  app.post("/api/sheets/:id/schedules", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    // Created switched OFF regardless of what was asked for — see schedules.ts. Turning it on is a
    // separate request, so a form cannot start spending money by being submitted.
    res.json({
      schedule: createSchedule({
        sheetId,
        name: typeof b.name === "string" ? b.name : "",
        cadence: b.cadence,
        scope: (b.scope ?? {}) as any,
        force: !!b.force,
        budgetUsd: b.budgetUsd as any,
      }),
    });
  }));

  app.patch("/api/schedules/:id", wrap(async (req, res) => {
    const id = Number(param(req, "id"));
    const before = getSchedule(id);
    if (!before) return res.status(404).json({ error: "That schedule no longer exists." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateSchedule>[1] = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.cadence !== undefined) patch.cadence = b.cadence;
    if (b.scope !== undefined) patch.scope = b.scope as any;
    if (b.force !== undefined) patch.force = !!b.force;
    if (b.budgetUsd !== undefined) patch.budgetUsd = b.budgetUsd as any;
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;

    /**
     * Switching a schedule on is the moment somebody decides to spend on a timer.
     *
     * A schedule MAY run a paid column — unlike auto-run, because a cadence is an instruction the
     * user wrote rather than a reaction to somebody else's import. But it is a decision, and a
     * decision needs the number in front of it: this refuses until confirmed and hands back the
     * columns that bill and what one firing would cost, so the switch is never flipped blind.
     *
     * Checked against the schedule AS IT WILL BE, not as it was. Enabling and re-scoping in the same
     * request is one call, and reading the old scope would price a schedule that is about to stop
     * existing.
     */
    if (patch.enabled === true && !before.enabled) {
      const next = { sheetId: before.sheetId, scope: (patch.scope ?? before.scope) as never };
      const paid = paidColumnsOf(next);
      if (paid.length > 0 && b.confirmPaid !== true) {
        // Priced through the same resolver and estimator a Run confirmation uses, so the number here
        // and the number there cannot disagree about the same work.
        let perFiring: number | null = null;
        let rowCount = 0;
        try {
          const resolved = resolveScope(before.sheetId, (patch.scope ?? before.scope) ?? {});
          rowCount = resolved.rowCount;
          const cols = resolved.columnIds.map((c) => getColumn(c)).filter((c) => !!c);
          const cost = await estimateRun(cols, resolved.rowCount);
          perFiring = cost.incomplete ? null : cost.total;
        } catch {
          // An unpriceable schedule is still allowed to be switched on — the user is told the cost is
          // unknown rather than being blocked by a price list that happens to be unreachable.
          perFiring = null;
        }
        return res.status(409).json({
          error:
            `This schedule spends money every time it runs. ${paid.length === 1 ? `"${paid[0]}" bills` : `${paid.length} of its columns bill`} per row.`,
          code: "schedule_would_spend",
          paidColumns: paid,
          rowCount,
          // Null means "could not be priced", never zero — a zero here would read as free.
          estimatedUsdPerFiring: perFiring,
          cadence: before.cadence,
        });
      }
    }

    res.json({ schedule: updateSchedule(id, patch) });
  }));

  app.delete("/api/schedules/:id", wrap((req, res) => {
    deleteSchedule(Number(param(req, "id")));
    res.json({ ok: true });
  }));

  /**
   * Fire one schedule now, without waiting for its clock.
   *
   * The "does this actually do what I think" button, and the reason it exists is that a schedule you
   * cannot test is a schedule you find out about tomorrow morning. It goes through the SAME runner
   * the ticker uses — a preview that took a different path would prove nothing about the real one.
   */
  app.post("/api/schedules/:id/run", wrap((req, res) => {
    const s = getSchedule(Number(param(req, "id")));
    if (!s) return res.status(404).json({ error: "That schedule no longer exists." });
    try {
      res.json({ runId: runScheduleNow(s) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }));

  // ───────────────────────────────────────────────────── relations

  /**
   * Every link this table takes part in, with its health.
   *
   * The health travels WITH the list rather than behind a second request, because "linked" on its own
   * is not the useful fact — "linked, and 340 of your 2,000 rows found nothing" is. A screen that
   * only says a link exists leaves that discovery to happen one empty column at a time.
   */
  /**
   * One shape for a relation, wherever it is returned.
   *
   * Both create and list go through here. Answering a create with the bare record would leave the
   * client's type claiming a `health` that is absent on exactly that response, and reading it would
   * throw at the one moment the user most wants the number.
   */
  const decorate = (r: ReturnType<typeof listRelations>[number], sheetId: string) => {
    const otherId = r.fromSheetId === sheetId ? r.toSheetId : r.fromSheetId;
    return {
      ...r,
      side: r.fromSheetId === sheetId ? "from" : "to",
      otherSheetId: otherId,
      otherSheetName: getSheet(otherId)?.name ?? "a deleted table",
      health: relationHealth(r.id),
    };
  };

  app.get("/api/sheets/:id/relations", wrap((req, res) => {
    const sheetId = param(req, "id");
    res.json({ relations: listRelations(sheetId).map((r) => decorate(r, sheetId)) });
  }));

  app.post("/api/relations", wrap((req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const created = createRelation({
        fromSheetId: String(b.fromSheetId ?? ""),
        fromColumnId: Number(b.fromColumnId),
        toSheetId: String(b.toSheetId ?? ""),
        toColumnId: Number(b.toColumnId),
        cardinality: b.cardinality === "one_to_one" ? "one_to_one" : "many_to_one",
        // Was dropped here, so a link asked for as `exact` was silently built as `normalized` — and
        // the health reported back described a stricter rule than the one actually stored. Left
        // unvalidated on purpose: `createRelation` already falls back for anything it does not
        // recognise, and duplicating that check here is how the two definitions drift apart.
        matchMode: b.matchMode as never,
      });
      // Decorated from the pointing table's point of view, which is the table that asked.
      res.json({ relation: decorate(created, created.fromSheetId) });
    } catch (e) {
      // Every refusal here is actionable on the screen that asked — same workbook, not itself, not a
      // duplicate. A 500 would turn a correctable choice into a fault.
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }));

  /**
   * Change how strictly a link matches.
   *
   * Answers with the NEW health, because that is the only reason anyone touches this control: the
   * question is "does loosening it find more of my rows", and making them go and look afterwards is
   * how a setting gets changed blindly. The rebuild happens inside `setMatchMode`.
   */
  app.patch("/api/relations/:id", wrap((req, res) => {
    const id = Number(param(req, "id"));
    const mode = (req.body ?? {}).matchMode;
    try {
      const relation = setMatchMode(id, mode);
      res.json({ relation: decorate(relation, relation.fromSheetId), health: relationHealth(id) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }));

  app.get("/api/relations/:id/health", wrap((req, res) => {
    res.json({ health: relationHealth(Number(param(req, "id"))) });
  }));

  /**
   * Re-index both sides.
   *
   * Needed because a key column can be filled by paths that do not go through a run — a CSV import,
   * a webhook delivery, a hand edit — and only a run maintains the index incrementally.
   */
  app.post("/api/relations/:id/rebuild", wrap((req, res) => {
    const id = Number(param(req, "id"));
    const counts = rebuildRelationKeys(id);
    res.json({ counts, health: relationHealth(id) });
  }));

  app.delete("/api/relations/:id", wrap((req, res) => {
    const id = Number(param(req, "id"));
    // Named, because deleting a link silently breaks every column reading through it and the count
    // is the only warning anyone gets.
    const readers = lookupColumnsFor(id).length;
    deleteRelation(id);
    res.json({ ok: true, columnsAffected: readers });
  }));

  // ───────────────────────────────────────────────────── undo

  app.get("/api/sheets/:id/undo", wrap((req, res) => {
    res.json(undoState(param(req, "id")));
  }));

  app.post("/api/sheets/:id/undo", wrap((req, res) => {
    const sheetId = param(req, "id");
    const out = undo(sheetId);
    // The new state rides back with the result, so the buttons relabel in the same round trip rather
    // than flickering through a stale label until a follow-up request lands.
    res.json({ ...out, state: undoState(sheetId) });
  }));

  app.post("/api/sheets/:id/redo", wrap((req, res) => {
    const sheetId = param(req, "id");
    const out = redo(sheetId);
    res.json({ ...out, state: undoState(sheetId) });
  }));

  // ───────────────────────────────────────────────────── models

  /**
   * The model catalogue with prices.
   *
   * Free in both senses: no API key, no tokens. This is OpenRouter's published price sheet, so it
   * can be read before anything has been spent — which is the point, since it is what the cost
   * estimates are built from.
   */
  app.get("/api/models", wrap(async (_req, res) => {
    try {
      // Local runtimes are probed alongside the hosted list, so the picker offers them without the
      // user having to know they need looking for. They are priced at zero because they ARE zero —
      // the trade is time, not money, and the picker says so.
      const [models, localModels, direct] = await Promise.all([
        listModels(),
        discoverLocalModels(),
        // Never rejects — a vendor that cannot be reached contributes nothing rather than emptying
        // the picker, which is the same degradation the catalogue failure below already makes.
        directModelsForPicker().catch(() => []),
      ]);
      const local = localModels.map((m) => ({
        id: m.id,
        name: `${m.name} (${m.runtimeLabel})`,
        inputPerM: 0,
        outputPerM: 0,
        contextLength: 0,
        // Assumed capable: a local runtime does not advertise tool support per model, and refusing
        // to offer them on agent columns would hide every local model from the lane where "free"
        // matters most. A model that cannot call tools fails visibly on a preview row.
        tools: true,
        free: true,
        local: true,
      }));
      // Priced as UNKNOWN, not as zero. No vendor here publishes a machine-readable rate, so the
      // picker says so; a zero would be read as free by a person and by the cost estimate alike.
      const bought = direct.map((m) => ({
        id: m.id,
        name: m.name,
        inputPerM: 0,
        outputPerM: 0,
        contextLength: 0,
        tools: m.tools,
        free: false,
        priced: false,
        direct: m.provider,
      }));
      res.json({
        models: [...local, ...models, ...bought],
        defaultModel: effectiveDefaultModel(),
        ageMs: catalogAge(),
        localCount: local.length,
        directCount: bought.length,
      });
    } catch (e) {
      // 200 with an explicit failure, not a 500: the picker degrades to "type a model id" and the
      // estimate says it could not price the run, rather than the drawer failing to open.
      res.json({ models: [], defaultModel: DEFAULT_MODEL, error: e instanceof Error ? e.message : String(e) });
    }
  }));

  // ───────────────────────────────────────────────────── duplicates

  app.get("/api/sheets/:id/dedupe", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    // Config only. The count is its own request because counting is the expensive half: on a
    // million-row table it is a full pass, and shipping it with every settings read made opening
    // the screen — and every change made on it — wait for a scan nobody had asked for yet.
    res.json({ config: getDedupe(sheetId) });
  }));

  /** The count, on its own. Slow by nature, so the screen asks for it separately and says so. */
  app.get("/api/sheets/:id/dedupe/preview", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    res.json({ preview: previewDedupe(sheetId) });
  }));

  app.patch("/api/sheets/:id/dedupe", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const config = setDedupe(sheetId, {
      columnIds: Array.isArray(req.body?.columnIds) ? req.body.columnIds.map(Number) : undefined,
      keep: req.body?.keep === "newest" ? "newest" : req.body?.keep === "oldest" ? "oldest" : undefined,
      auto: req.body?.auto === undefined ? undefined : !!req.body.auto,
    });
    // Saved and answered immediately. The new count follows on its own request, so changing a
    // setting is instant no matter how big the table is.
    res.json({ config });
  }));

  /** Removes rows. Separate from the PATCH on purpose: changing a setting must never delete data. */
  app.post("/api/sheets/:id/dedupe/run", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    const cfg = getDedupe(sheetId);
    if (cfg.columnIds.length === 0) {
      return res.status(400).json({ error: "Pick at least one column to match on first." });
    }
    const report = applyDedupe(sheetId, cfg);
    // Deliberately NOT recorded as an undo step. The undo machinery snapshots ONE row; a dedupe
    // removes thousands, and offering an Undo button that cannot put them back would be worse than
    // offering none. The guard is the preview and the confirmation before it runs, and the UI says
    // so in those words.
    res.json({ report, rowCount: countRows(sheetId) });
  }));

  // ───────────────────────────────────────────────────── rows

  /**
   * Add empty rows at the end of a sheet.
   *
   * Bounded, because this is a click: "add rows" that accepts an arbitrary count is one stray
   * keystroke away from a million-row insert nobody asked for. Bulk arrival has its own doors —
   * CSV import and webhook delivery — which are built for it.
   */
  app.post("/api/sheets/:id/rows", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });
    // REFUSED above the ceiling, not silently trimmed. Asking for 20,000 rows returned 200 with 100
    // rows and nothing to say so — the caller believes it has 20,000 and every count it derives from
    // then is wrong. A cap that lies about itself is worse than a smaller cap that does not.
    //
    // The ceiling exists because this path builds a cell per column per row in one synchronous
    // transaction; bulk loading belongs in the CSV importer, which streams and commits in batches.
    // The message says so rather than leaving the caller to guess at a number.
    const asked = Number(req.body?.count ?? 1) || 1;
    if (asked > ADD_ROWS_MAX) {
      return res.status(400).json({
        error: `That is more rows than this can add at once (${asked.toLocaleString()}, limit ${ADD_ROWS_MAX.toLocaleString()}). Import a CSV for a load that size — it streams instead of doing it all in one go.`,
      });
    }
    const count = Math.max(1, Math.floor(asked));
    const columnIds = listColumns(sheetId).map((c) => Number(c.id));
    const added = insertRows(
      sheetId,
      Array.from({ length: count }, () => ({ values: {} })),
      nextRowPosition(sheetId),
      columnIds,
    );
    const deduped = autoDedupe(sheetId);
    // The ids that were just created, so "+ Row" and "add 500 rows" can be taken back. Read AFTER
    // the dedupe, which may have removed some of them again — an undo that tried to delete a row the
    // dedupe already took would fail on the one entry the user most wants to work.
    const addedIds = (db
      .prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY id DESC LIMIT ?")
      .all(sheetId, added) as Array<{ id: number }>).map((r) => Number(r.id)).reverse();
    if (addedIds.length > 0) {
      record(sheetId, "rows.add", added === 1 ? "Add a row" : `Add ${added.toLocaleString()} rows`,
        { sheetId, rowIds: addedIds });
    }
    res.json({ ok: true, added, rowCount: countRows(sheetId), deduped });
  }));

  app.delete("/api/rows/:id", wrap((req, res) => {
    // Snapshot FIRST. A row and its thirty cells are small enough to capture outright, and the
    // restore reuses the original row id so a fan-out's back-reference still points somewhere real.
    const snap = snapshotRow(Number(param(req, "id")));
    const sheetId = deleteRow(param(req, "id"));
    if (!sheetId || !snap) return res.status(404).json({ error: "Row not found" });
    record(sheetId, "row.delete", "Delete row", snap);
    res.json({ ok: true, sheetId });
  }));

  // Delete many rows in one go — the checkbox selection in the grid. POST, not DELETE, because the
  // ids travel in the body and a DELETE body is stripped by enough proxies to be unreliable.
  app.post("/api/sheets/:id/rows/delete", wrap((req, res) => {
    const sheetId = param(req, "id");
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    if (ids.length === 0) return res.status(400).json({ error: "No rows were selected." });
    // Snapshot FIRST, and only rows that actually belong to THIS sheet — a crafted id from another
    // table is dropped here rather than deleted, and the snapshots are what Undo restores from.
    type RowSnap = NonNullable<ReturnType<typeof snapshotRow>>;
    const snaps = ids
      .map((id: number) => snapshotRow(id))
      .filter((s: RowSnap | null) => !!s && String(s.row.sheet_id) === sheetId) as RowSnap[];
    if (snaps.length === 0) return res.status(404).json({ error: "None of those rows are in this table." });
    const removed = deleteRows(sheetId, snaps.map((s) => Number(s.row.id)));
    record(sheetId, "rows.delete", `Delete ${removed} row${removed === 1 ? "" : "s"}`, { rows: snaps });
    res.json({ ok: true, deleted: removed });
  }));

  // Delete many columns in one go — the checkbox selection on the headers. Soft-deleted, exactly like
  // the single-column route, so Undo is one UPDATE and the cells are never touched.
  app.post("/api/sheets/:id/columns/delete", wrap((req, res) => {
    const sheetId = param(req, "id");
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    if (ids.length === 0) return res.status(400).json({ error: "No columns were selected." });
    type Col = NonNullable<ReturnType<typeof getColumn>>;
    const cols = ids
      .map((id: number) => getColumn(id))
      .filter((c: Col | undefined | null) => !!c && String(c.sheetId) === sheetId) as Col[];
    if (cols.length === 0) return res.status(404).json({ error: "None of those columns are in this table." });
    const liveIds = cols.map((c) => Number(c.id));
    const deletedAt = deleteColumns(sheetId, liveIds);
    if (!deletedAt) return res.status(409).json({ error: "Those columns were already removed." });
    record(sheetId, "column.delete", `Delete ${liveIds.length} column${liveIds.length === 1 ? "" : "s"}`, { columnIds: liveIds, deletedAt });
    res.json({ ok: true, deleted: liveIds.length });
  }));

  // ───────────────────────────────────────────────────── cells

  // A cell's id is its "<rowId>:<columnId>" pair — see the key-design note in db.ts.
  const cellRef = (req: Request) => {
    const parsed = parseCellId(param(req, "id"));
    if (!parsed) throw new Error("Malformed cell id");
    return parsed;
  };

  app.get("/api/cells/:id", wrap((req, res) => {
    const { rowId, columnId } = cellRef(req);

    // A cell that has never run has no row in `cells`. That is not a 404.
    //
    // It would be the wrong answer to the wrong question. "Never run" is a STATE of a cell that exists —
    // every row has a value for every column, even if that value is nothing yet — not a missing
    // resource. The 404 made the details panel show "could not load this cell" for the single
    // commonest reason anyone opens it: to ask why the cell is empty.
    //
    // Still a real 404 when the row or the column genuinely does not exist, which is the case the
    // status code is actually for.
    const col = getColumn(columnId);
    const rowExists = !!db.prepare("SELECT 1 FROM rows WHERE id = ?").get(rowId);
    if (!col || !rowExists) return res.status(404).json({ error: "Cell not found" });

    const cell = getCell(rowId, columnId) ?? {
      id: `${rowId}:${columnId}`,
      sheetId: col.sheetId,
      rowId: String(rowId),
      columnId: String(columnId),
      status: "empty" as const,
      value: null,
      valueText: null,
      stale: false,
      pinned: false,
      rev: 0,
      attempt: 0,
    };
    const rows = db
      .prepare(
        `SELECT id, attempt, status, model, started_at, finished_at, cost_usd, duration_ms,
                rendered_prompt, error_type, error_msg, script_hash, num_turns, raw_result
           FROM cell_attempts WHERE row_id = ? AND column_id = ? ORDER BY attempt DESC LIMIT 20`,
      )
      .all(rowId, columnId) as any[];

    // Scrubbed on the way out, both of them.
    //
    // These two fields are the only ones here built from text this app did not write. An error is a
    // provider's response body quoted verbatim, and a rejected request frequently echoes the
    // credential it rejected. A rendered prompt is the instruction with the row's values already
    // substituted, so a column whose prompt names a key resolves it into the stored string.
    //
    // Both were returned raw. That was survivable only for as long as nothing displayed them — the
    // panel fetched this array and dropped it — which is not a protection, it is an accident about
    // to be undone by the screen that reads them.
    const attempts = rows.map((a) => ({
      ...a,
      error_msg: a.error_msg ? redactSecrets(String(a.error_msg)) : a.error_msg,
      rendered_prompt: a.rendered_prompt ? redactSecrets(String(a.rendered_prompt)) : a.rendered_prompt,
      // Scrubbed here as well as at write time. It is the model's own envelope, so it can quote
      // anything it was shown — including a value from a row that carried a credential.
      raw_result: a.raw_result ? redactSecrets(String(a.raw_result)) : a.raw_result,
    }));

    res.json({ cell, attempts });
  }));

  app.put("/api/cells/:id", wrap((req, res) => {
    const { rowId, columnId } = cellRef(req);
    const v = req.body?.value;
    const col = getColumn(columnId);

    /**
     * A column that produces its own value is not typed into by accident.
     *
     * Guarded HERE and not inside `setCellValue`, for two reasons. `setCellValue` is the hand-edit
     * primitive — it exists to pin a cell — and policy inside a store function is policy nobody
     * reading the route can see. And undo restores a cell through its own SQL, which must NEVER be
     * refused: guarding at the route makes that independence deliberate rather than a lucky
     * consequence of undo not calling this function.
     *
     * 409 rather than 400: the request is perfectly well formed, the STATE forbids it. `wrap` turns
     * a thrown Error into a 400, which the grid could not tell apart from a malformed cell id — and
     * it has to tell them apart, because one of them offers an override and the other is a bug.
     */
    if (col && col.editable === false && req.body?.override !== true) {
      return res.status(409).json({
        error: `"${col.name}" is filled in by a run, not by hand.`,
        code: "cell_locked",
        lockedReason: col.lockedReason ?? null,
        columnKind: col.kind,
        // Every locked column can be overridden one cell at a time. Stated in the response rather
        // than assumed by the client, so a future column that genuinely cannot be can say so.
        canOverride: true,
      });
    }
    const override = col?.editable === false && req.body?.override === true;

    /**
     * The column's own rules, after the type has already had its say.
     *
     * REFUSED here rather than written and marked, when the rule set says `reject` — a hand edit has
     * somebody sitting in front of it who can fix the value, which is the one moment where refusing
     * is more useful than recording. A `warn` set writes the value; see `onFail`.
     *
     * 422 rather than 400: the request is well formed and the VALUE is what is wrong, and the grid
     * has to tell that apart from a malformed cell id the same way it does for a locked column.
     */
    if (col?.validation && col.validation.onFail === "reject") {
      const problem = checkValue(v == null ? null : String(v), col.validation);
      if (problem) {
        return res.status(422).json({ error: problem, code: "rule_failed", columnName: col.name });
      }
    }

    const prev = db.prepare("SELECT status, value_text, value_json, pinned FROM cells WHERE row_id = ? AND column_id = ?")
      .get(rowId, columnId) as any;

    setCellValue(rowId, columnId, v == null || v === "" ? null : String(v));

    const now = db.prepare("SELECT status, value_text, value_json, pinned FROM cells WHERE row_id = ? AND column_id = ?")
      .get(rowId, columnId) as any;
    // Only when something actually changed. Recording a no-op edit fills the undo stack with entries
    // that appear to do nothing when used, which is worse than having no entry.
    if (col && prev && now && (prev.value_text !== now.value_text || prev.status !== now.status)) {
      // Labelled as an override when it was one. The undo list said "Edit ⟨name⟩" for everything,
      // and of all the entries in it, the one that replaced a computed value by hand is the one
      // someone is most likely to come back looking for.
      record(col.sheetId, "cell.edit", `${override ? "Override" : "Edit"} "${col.name}"`, {
        rowId, columnId,
        before: { status: prev.status, valueText: prev.value_text, valueJson: prev.value_json, pinned: prev.pinned },
        after: { status: now.status, valueText: now.value_text, valueJson: now.value_json, pinned: now.pinned },
      });

      // Anything reading this cell now holds an answer computed from the OLD value. Only on a real
      // change — marking cells out of date because someone retyped the same text would be noise.
      // Row-scoped: editing row 5 says nothing about row 6.
      markDownstreamStale(col.sheetId, Number(columnId), [Number(rowId)]);
      // Relations are a second, cross-table graph that `column_deps` cannot see. A hand edit is the
      // MOST likely way a key gets corrected — someone fixing a domain by hand is the everyday case —
      // so leaving this off the edit path would let the match index rot in exactly the situation it
      // was built for, while the lookup went on showing the old company's value.
      noteRelationChange(col.sheetId, Number(columnId), [Number(rowId)]);
      // A hand edit is the clearest case for a column that keeps itself up to date.
      noteUpstreamChange(col.sheetId, Number(columnId), [Number(rowId)]);
    }
    res.json({ cell: getCell(rowId, columnId) });
  }));

  /**
   * Write a BLOCK of cells at once — what a paste from Excel or Sheets is.
   *
   * Not a loop over `PUT /api/cells/:id` on the client. A 200×5 paste is a thousand cells, and a
   * thousand requests is a thousand transactions, a thousand undo entries, a thousand SSE bursts and
   * a partial result whenever one of them fails in the middle. Here it is ONE transaction, ONE undo
   * entry, and either all of it lands or none of it does.
   *
   * Two things arrive together because a paste does both: `newRows` for a block that runs off the
   * bottom of the table (Excel grows the sheet, and a paste that silently discarded its last forty
   * rows would be the worst kind of quiet), and `edits` for the cells that land on rows already
   * there. They share the undo entry, so one Undo takes back the whole paste including the rows it
   * created — two entries would mean undoing a paste twice and getting an odd half-state in between.
   */
  app.post("/api/sheets/:id/cells/bulk", wrap((req, res) => {
    const sheetId = param(req, "id");
    if (!getSheet(sheetId)) return res.status(404).json({ error: "Sheet not found" });

    const edits = Array.isArray(req.body?.edits) ? (req.body.edits as any[]) : [];
    const newRows = Array.isArray(req.body?.newRows) ? (req.body.newRows as any[]) : [];
    const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim() : "Paste";

    const cols = new Map(listColumns(sheetId).map((c) => [Number(c.id), c]));

    // REFUSED above the ceiling, never trimmed — the same trade as adding rows. A paste that writes
    // 100,000 of the 250,000 cells it was given and answers 200 is a table the user believes is
    // filled in, and they find out where it stopped by reading it.
    const total = edits.length + newRows.length * cols.size;
    if (total > BULK_CELLS_MAX) {
      return res.status(400).json({
        error:
          `That paste is ${total.toLocaleString()} cells, and this path does ${BULK_CELLS_MAX.toLocaleString()} at a time. ` +
          "Save it as a CSV and import it — that route streams instead of doing it all in one go.",
      });
    }

    // Every locked column is checked BEFORE anything is written, and the refusal names them.
    // Checking per-cell inside the loop would write the editable half of a paste and then stop, and
    // a half-applied paste is harder to reason about than a refused one.
    const locked = new Set<string>();
    for (const e of edits) {
      const c = cols.get(Number(e?.columnId));
      if (!c) return res.status(400).json({ error: "That paste names a column that is not on this table." });
      if (c.editable === false) locked.add(c.name);
    }
    if (locked.size > 0) {
      return res.status(409).json({
        code: "cell_locked",
        error:
          `Nothing was pasted, because ${[...locked].map((n) => `"${n}"`).join(", ")} ` +
          `${locked.size === 1 ? "is" : "are"} filled in by a run, not by hand. Move the block so it misses ` +
          `${locked.size === 1 ? "that column" : "those columns"}, or override the cells one at a time.`,
      });
    }

    /**
     * Rules are checked over the WHOLE block before a single cell is written.
     *
     * Same trade as the locked-column check above it: writing the valid half of a paste and refusing
     * the rest leaves a table the user believes carries the block they pasted. The message names the
     * count and the first offender, because "3 values break the rules on Country" is actionable and
     * "invalid value" is not.
     */
    const broken: string[] = [];
    for (const e of edits) {
      const c = cols.get(Number(e?.columnId));
      if (!c?.validation || c.validation.onFail !== "reject") continue;
      const problem = checkValue(e?.value == null ? null : String(e.value), c.validation);
      if (problem) broken.push(`"${c.name}": ${problem}`);
    }
    if (broken.length > 0) {
      return res.status(422).json({
        code: "rule_failed",
        error:
          broken.length === 1
            ? `Nothing was pasted. ${broken[0]}`
            : `Nothing was pasted, because ${broken.length.toLocaleString()} values break their column's rules. The first: ${broken[0]}`,
      });
    }

    const editableIds = [...cols.values()].filter((c) => c.editable !== false).map((c) => Number(c.id));
    const allIds = [...cols.keys()];

    const before = db.prepare(
      "SELECT status, value_text, value_json, pinned, error_type, error_msg, stale FROM cells WHERE row_id = ? AND column_id = ?",
    );
    const after = db.prepare(
      "SELECT status, value_text, value_json, pinned, error_type, error_msg, stale FROM cells WHERE row_id = ? AND column_id = ?",
    );

    const changed: any[] = [];
    const touchedByColumn = new Map<number, number[]>();
    let addedRowIds: number[] = [];

    tx(() => {
      if (newRows.length > 0) {
        const startId = Number(
          (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM rows").get() as any).m,
        );
        insertRows(
          sheetId,
          newRows.map((r: any) => ({ values: Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [String(k), String(v ?? "")])) })),
          nextRowPosition(sheetId),
          allIds,
          // Pinned, because these came from a person. The rows this paste LANDS in go through
          // `setCellValue` below, which pins; without the same answer here one paste produced two
          // pin states and the first row of a pasted block behaved differently from the rest.
          true,
        );
        addedRowIds = (
          db.prepare("SELECT id FROM rows WHERE sheet_id = ? AND id > ? ORDER BY id").all(sheetId, startId) as any[]
        ).map((r) => Number(r.id));
      }

      for (const e of edits) {
        const rowId = Number(e?.rowId);
        const columnId = Number(e?.columnId);
        if (!Number.isInteger(rowId) || !Number.isInteger(columnId)) continue;
        const prev = before.get(rowId, columnId) as any;
        if (!prev) continue; // the row went away between the copy and the paste
        const value = e?.value == null || e.value === "" ? null : String(e.value);
        setCellValue(rowId, columnId, value);
        const now = after.get(rowId, columnId) as any;
        if (!now || (prev.value_text === now.value_text && prev.status === now.status)) continue;
        changed.push({
          rowId, columnId,
          before: { status: prev.status, valueText: prev.value_text, valueJson: prev.value_json, pinned: prev.pinned, errorType: prev.error_type, errorMsg: prev.error_msg, stale: prev.stale },
          after: { status: now.status, valueText: now.value_text, valueJson: now.value_json, pinned: now.pinned, errorType: now.error_type, errorMsg: now.error_msg, stale: now.stale },
        });
        const list = touchedByColumn.get(columnId);
        if (list) list.push(rowId); else touchedByColumn.set(columnId, [rowId]);
      }

      if (changed.length > 0 || addedRowIds.length > 0) {
        record(sheetId, "cells.bulk", label, { sheetId, cells: changed, addedRowIds });
      }
    });

    // AFTER the transaction, not inside it. Each of these fans out into its own reads and writes —
    // dependency walks, relation reindexing, an auto-run trigger — and holding the write lock open
    // across all of them for a thousand-cell paste is how the engine stalls everything else.
    for (const [columnId, rowIds] of touchedByColumn) {
      markDownstreamStale(sheetId, columnId, rowIds);
      noteRelationChange(sheetId, columnId, rowIds);
      noteUpstreamChange(sheetId, columnId, rowIds);
    }
    if (addedRowIds.length > 0) noteRowsArrived(sheetId);

    res.json({
      written: changed.length,
      rowsAdded: addedRowIds.length,
      rowCount: countRows(sheetId),
      // Named so the client can put the same sentence on the undo bar the menu would have.
      undoLabel: changed.length > 0 || addedRowIds.length > 0 ? label : null,
      editableColumnIds: editableIds,
    });
  }));

  app.post("/api/cells/:id/unpin", wrap((req, res) => {
    const { rowId, columnId } = cellRef(req);
    unpinCell(rowId, columnId);
    res.json({ cell: getCell(rowId, columnId) });
  }));

  /**
   * Undo an override — put this one cell back to whatever fills it.
   *
   * The way back from the warning the override dialog gives, and the thing that makes an override a
   * decision rather than a one-way door.
   *
   * Two shapes, because the lanes differ in what "back" can mean. A derived column can be restored
   * exactly and for nothing: the answer is still sitting in its source and re-reading it is free. Any
   * other lane has to RUN to know what belongs there, and running spends — so this unpins, marks the
   * cell out of date, and says `needsRun` rather than quietly starting something that costs money.
   */
  app.post("/api/cells/:id/restore", wrap((req, res) => {
    const { rowId, columnId } = cellRef(req);
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });

    if (refreshDerivedCell(col.sheetId, columnId, rowId)) {
      return res.json({ cell: getCell(rowId, columnId), needsRun: false });
    }

    unpinCell(rowId, columnId);
    // Marked out of date rather than emptied. Throwing the value away would leave a blank cell and
    // no way to see what had been there, which is a worse answer than a value flagged as no longer
    // yours — and on a paid lane the run that would replace it is one the user has to authorise.
    db.prepare("UPDATE cells SET stale = 1, rev = rev + 1 WHERE row_id = ? AND column_id = ?")
      .run(rowId, columnId);
    markCellsDirty([`${rowId}:${columnId}`]);
    res.json({ cell: getCell(rowId, columnId), needsRun: true });
  }));

  /**
   * Work out why one cell failed, and propose the change that would stop it.
   *
   * A sibling of `/ai-setup` rather than another `area` on it, because the inputs are opposite: that
   * route takes an intent the user typed and knows nothing about any row; this one takes no user
   * text at all and is built entirely from one failure. But it DELEGATES — it assembles a
   * SetupRequest and hands it to the same `proposeSetup`, so it goes through the free-only/model
   * guard and the proposal shaping unavoidably. A new AI surface that reached the provider directly
   * would be exactly the bypass those exist to prevent.
   *
   * It returns the same `{ proposal }` shape, so the existing setup panel renders it unchanged, and
   * APPLY goes to the existing `/ai-setup/apply` — keeping that route's re-normalisation of the
   * proposed request, which is what stops a model quietly turning private addresses back on. No
   * second apply surface, and no second place for that guard to be forgotten.
   */
  app.post("/api/cells/:id/fix", wrap(async (req, res) => {
    const { rowId, columnId } = cellRef(req);
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });

    const cell = getCell(rowId, columnId);
    if (!cell || cell.status !== "error") {
      return res.status(400).json({ error: "This cell has not failed, so there is nothing to diagnose." });
    }

    // The same table that decides what the panel offers decides what this route will do, so the
    // button and the endpoint can never disagree about whether a model could help.
    const facts = errorFacts((cell.errorType ?? null) as never, col.kind);
    if (!facts.aiCanHelp) {
      // 400 and NOT A TOKEN SPENT. Charging for a proposal whose only possible content is "fix your
      // key" is precisely the failure this whole feature exists to stop.
      return res.status(400).json({
        error: `${facts.cause} ${facts.todo}`,
        code: "ai_cannot_help",
        fixWhere: facts.fixWhere,
      });
    }

    const columns = listColumns(col.sheetId);

    // The prompt as it actually went out for THIS row, newest attempt that recorded one. Already
    // redacted at write time; redacted again here for the same reason the details route does it.
    const promptRow = db
      .prepare(
        `SELECT rendered_prompt FROM cell_attempts
          WHERE row_id = ? AND column_id = ? AND rendered_prompt IS NOT NULL
          ORDER BY attempt DESC LIMIT 1`,
      )
      .get(rowId, columnId) as { rendered_prompt: string } | undefined;

    const attemptsHere = Number(
      (db.prepare("SELECT COUNT(*) n FROM cell_attempts WHERE row_id = ? AND column_id = ?")
        .get(rowId, columnId) as { n: number }).n,
    );

    // This row's other values, by NAME — the same names the prompt's references use, so the model can
    // connect "nothing in /Website" to the blank beside it. Ids would be noise.
    const values = db
      .prepare("SELECT column_id, value_text FROM cells WHERE row_id = ? AND value_text IS NOT NULL")
      .all(rowId) as Array<{ column_id: number; value_text: string }>;
    const byId = new Map(columns.map((c) => [String(c.id), c.name]));
    const inputs = values
      .filter((v) => String(v.column_id) !== String(columnId) && byId.has(String(v.column_id)))
      .map((v) => ({ name: byId.get(String(v.column_id))!, value: redactSecrets(String(v.value_text)) }));

    const evidence = gatherEvidence(col.sheetId);
    const mine = evidence?.columns.find((c) => String(c.id) === String(columnId));

    const intent = buildFixIntent({
      columnName: col.name,
      kind: col.kind,
      purpose: col.description ?? null,
      errorType: cell.errorType ?? null,
      errorMsg: cell.errorMsg ? redactSecrets(String(cell.errorMsg)) : null,
      attemptsHere,
      // The whole column's split, so a proposal fixes the cause behind most of the failures rather
      // than the one row that happened to be clicked.
      columnErrorTypes: mine?.errorTypes ?? [],
      renderedPrompt: promptRow?.rendered_prompt ? redactSecrets(String(promptRow.rendered_prompt)) : null,
      inputs,
    });

    const allSheets = listSheets().filter((s) => s.id !== col.sheetId);
    const proposal = await proposeSetup({
      column: col,
      columns,
      evidence,
      siblings: allSheets.slice(0, SEND_TARGETS_SHOWN).map((s) => ({
        id: s.id,
        name: s.name,
        columns: listColumns(s.id).map((c) => ({ id: Number(c.id), name: c.name })),
      })),
      moreSheets: Math.max(0, allSheets.length - SEND_TARGETS_SHOWN),
      intent,
      // Straight from the same table, so there is no second mapping to drift. `aiCanHelp` is true
      // here, and every class for which that holds names an area.
      area: (facts.area ?? undefined) as SetupArea | undefined,
    });

    // The diagnosis is what the panel shows ABOVE the proposal — the plain sentence, so someone can
    // decide whether the proposal is even answering the right question before reading the diff.
    res.json({ diagnosis: { cause: facts.cause, todo: facts.todo, errorType: cell.errorType ?? null }, proposal });
  }));

  // ───────────────────────────────────────────────────── scripts
  //
  // The generate → review → approve → run flow. Two routes below execute code that has NOT been
  // approved. "The UI's normal path always goes through assertRunnable" is true of a RUN and of
  // nothing else, so stating it plainly:
  //
  //   `dry-run` runs the stored, unapproved script on a handful of rows. That is deliberate and is
  //   the whole point of the review screen — you cannot sensibly be asked to approve code you have
  //   not been allowed to try. The code it runs is the code on screen, the row count is clamped, and
  //   a real run still refuses it until it is approved.
  //
  //   `run-direct` runs code straight out of the request body with no script row, no review and no
  //   gate at all. It is the benchmark harness's path, it is not reachable from the UI, and it is
  //   OFF unless FERRUM_DEV_SCRIPTS says otherwise.

  app.get("/api/columns/:id/scripts", wrap((req, res) =>
    res.json({ scripts: listScripts(Number(param(req, "id"))) })));

  app.post("/api/columns/:id/scripts", wrap((req, res) => {
    const columnId = Number(param(req, "id"));
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });
    const saved = saveScript({
      sheetId: col.sheetId,
      columnId,
      hook: req.body?.hook ?? "transform",
      runtime: req.body?.runtime ?? "js",
      intent: String(req.body?.intent ?? ""),
      code: String(req.body?.code ?? ""),
      rationale: req.body?.rationale,
    });
    // A script with errors is still returned so the review UI can show them inline against the code.
    res.json(saved);
  }));

  app.post("/api/scripts/:id/approve", wrap((req, res) => {
    const out = approveScript(Number(param(req, "id")), String(req.body?.hash ?? ""));
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ ok: true, script: getScript(Number(param(req, "id"))) });
  }));

  /**
   * Take the run condition off a column.
   *
   * Distinct from revoking the script's approval, and the difference is not academic. Revoking
   * leaves `condition_script_id` pointing at an unapproved script, and the gate calls
   * assertRunnable — so the next run of that column fails outright rather than running ungated. That
   * refusal is correct (a condition nobody approved must never silently let a paid run through), but
   * it makes "turn the condition off" mean "break this column" unless the pointer is cleared too.
   *
   * The script row stays. It is history, it is cheap, and someone turning a gate off for one run
   * usually wants it back.
   */
  app.delete("/api/columns/:id/condition", wrap((req, res) => {
    const id = param(req, "id");
    const col = getColumn(id);
    if (!col) return res.status(404).json({ error: "Column not found" });
    db.prepare("UPDATE columns SET condition_script_id = NULL, updated_at = datetime('now') WHERE id = ?").run(Number(id));
    if (col.conditionScriptId) {
      record(col.sheetId, "column.field", `Remove the run condition from "${col.name}"`,
        { columnId: Number(id), field: "condition_script_id", from: Number(col.conditionScriptId), to: null });
    }
    res.json({ column: getColumn(id) });
  }));

  app.post("/api/scripts/:id/revoke", wrap((req, res) => {
    revokeApproval(Number(param(req, "id")));
    res.json({ ok: true });
  }));

  /** Dry-run against a few rows, before committing to the whole column. */
  app.post("/api/scripts/:id/dry-run", wrap(async (req, res) => {
    const script = getScript(Number(param(req, "id")));
    if (!script) return res.status(404).json({ error: "Script not found" });
    const col = getColumn(Number(script.columnId));
    if (!col) return res.status(404).json({ error: "Column not found" });

    // Clamped here as well as in the UI. A dry run is a synchronous request with no progress and no
    // cancel, so an unbounded `limit` — from a stale client or a hand-rolled call — would hold the
    // connection open across the whole sheet and be indistinguishable from the server hanging.
    const asked = Number(req.body?.limit ?? 3);
    const limit = Number.isFinite(asked) ? Math.max(1, Math.min(TRY_MAX_ROWS, Math.floor(asked))) : 3;

    const rowIds = (db
      .prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position LIMIT ?")
      .all(col.sheetId, limit) as any[]).map((r) => Number(r.id));

    const out = await runScriptColumn({
      sheetId: col.sheetId, columnId: Number(script.columnId),
      refColumnIds: script.refs.map(Number),
      code: script.code, runtime: script.runtime, hook: script.hook as "transform" | "condition",
      rowIds,
    });
    res.json(out);
  }));

  /**
   * Execute supplied code with no script row, no review and no approval. OFF by default.
   *
   * This is the benchmark harness's path (`scripts/bench-script.mjs`, `scripts/test-injection.mjs`)
   * and it is the one route in the product that breaks rule 1 of `scripts.ts` — nothing runs
   * unreviewed. It was reachable on a running engine with no gate whatsoever: a POST carrying
   * `runtime: "powershell"` spawned a process, which is remote code execution the moment anything
   * else on this machine can reach the port.
   *
   * The Host and Origin guards at the top of this file already stop a web page reaching it, so the
   * remaining exposure is any other process on the box — but "no other process is hostile" is not a
   * property this app can assert, and a benchmark endpoint is not worth asserting it for. So it is
   * opt-in, and a MISSING variable means off, never on.
   */
  const devScriptsEnabled = process.env.FERRUM_DEV_SCRIPTS === "1";

  app.post("/api/scripts/run-direct", wrap(async (req, res) => {
    if (!devScriptsEnabled) {
      return res.status(403).json({
        error:
          "Running code that has not been reviewed is switched off. This endpoint exists for the " +
          "benchmark scripts; start the engine with FERRUM_DEV_SCRIPTS=1 if that is what you are doing.",
      });
    }

    const sheetId = String(req.body?.sheetId ?? "");
    // Clamped and re-emitted as an integer. It is interpolated into the statement rather than bound,
    // so a non-numeric value would reach SQLite as `LIMIT NaN` and come back as a raw driver error.
    const asked = Number(req.body?.limit);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(TRY_MAX_ROWS, Math.floor(asked)) : null;
    const rowIds = (db
      .prepare(`SELECT id FROM rows WHERE sheet_id = ? ORDER BY position${limit ? " LIMIT " + limit : ""}`)
      .all(sheetId) as any[]).map((r) => Number(r.id));

    const out = await runScriptColumn({
      sheetId,
      columnId: Number(req.body?.columnId),
      refColumnIds: (req.body?.refColumnIds ?? []).map(Number),
      code: String(req.body?.code ?? ""),
      runtime: req.body?.runtime ?? "js",
      hook: req.body?.hook ?? "transform",
      rowIds,
    });
    res.json(out);
  }));

  // ───────────────────────────────────────────────────── runs
  //
  // Starting a run is a POST that returns immediately with the run record; execution continues in
  // the background and reports over SSE. A large run must not be held open on an HTTP request.

  app.post("/api/sheets/:id/runs", wrap((req, res) => {
    // FAILS CLOSED on a scope it does not recognise.
    //
    // This read `req.body?.scope ?? {}` while /resolve-scope — the route that answers the very same
    // "which rows and columns" question, and whose number the user approves — reads the body FLAT.
    // Two shapes for one concept, and the mismatch was silent: a body this route did not understand
    // became `{}`, which means no narrowing at all, which means every runnable column over every
    // row. Measured: a request naming ONE script column ran an HTTP column forty times as well.
    //
    // So the most expensive possible interpretation was the default, on the one route where being
    // wrong spends money, and the confirmation the user agreed to was not binding on what ran.
    // Both shapes are accepted now, the way `force` already was.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nested = body.scope;
    if (nested != null && (typeof nested !== "object" || Array.isArray(nested))) {
      return res.status(400).json({ error: "`scope` has to be an object describing which rows to run." });
    }
    const flat = { ...body };
    // `budgetUsd` is a run SETTING, not part of the scope — left in `flat` it would be handed to the
    // scope resolver as an unknown key.
    delete flat.scope; delete flat.concurrency; delete flat.budgetUsd;
    const scope = (nested as Record<string, unknown> | undefined) ?? flat;

    // Refused rather than ignored. A ceiling that silently fails to apply is worse than none: the
    // person who typed it stops watching precisely because they set it.
    const rawBudget = body.budgetUsd;
    if (rawBudget != null && rawBudget !== "" && !(Number.isFinite(Number(rawBudget)) && Number(rawBudget) > 0)) {
      return res.status(400).json({ error: "`budgetUsd` has to be an amount above zero, or left out entirely." });
    }

    const { run, resolved } = createRun({
      sheetId: param(req, "id"),
      scope,
      force: !!req.body?.force,
      budgetUsd: rawBudget == null || rawBudget === "" ? null : Number(rawBudget),
      // Read from BOTH places, because the two ends already disagree about `force` for the same
      // reason: the client sends run options inside the scope object, and this route reads them at
      // the top level. Accepting only one would make the checkbox a no-op depending on which path
      // sent it — the exact failure `force` had, fixed once and worth not repeating.
      overwriteEdited: req.body?.overwriteEdited === true || (scope as any)?.overwriteEdited === true,
      // Who is spending. Null on a single-user install; on a shared one it is what makes the bill
      // answerable to a person rather than to a timestamp.
      startedBy: me(req)?.id ?? null,
    });

    // Fire and forget. Failures land on the run record and the SSE stream rather than a response the
    // client is no longer waiting for.
    void executeRun(run.id, resolved, { concurrency: Number(req.body?.concurrency) || undefined })
      .catch((e) => {
        console.error("[run]", run.id, e);
        db.prepare("UPDATE runs SET status = 'failed', pause_reason = ?, finished_at = datetime('now') WHERE id = ?")
          .run(String(e instanceof Error ? e.message : e).slice(0, 500), run.id);
        emitRun(getRun(run.id));
      });

    res.json({ run, summary: resolved.summary, rowCount: resolved.rowCount });
  }));

  /**
   * Run a spread-out handful of rows for real, so the rest can be forecast from measurement.
   *
   * The same route shape as a run, because it IS a run — the sample's answers are written to their
   * cells and kept. Paying for ten rows and then discarding them to "keep the sample clean" would be
   * the one thing a person sampling to save money would not want.
   */
  app.post("/api/sheets/:id/sample", wrap((req, res) => {
    const sheetId = param(req, "id");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = ((body.scope as Record<string, unknown> | undefined) ?? {}) as RunScope;

    const rows = body.rows == null ? DEFAULT_SAMPLE_ROWS : Number(body.rows);
    if (!Number.isFinite(rows) || rows < 1) {
      return res.status(400).json({ error: "`rows` has to be a whole number of rows above zero." });
    }

    const pick = sampleRowIds(sheetId, scope, rows);
    if (pick.rowIds.length === 0) {
      return res.status(400).json({ error: "Nothing matches that selection, so there is nothing to sample." });
    }

    // The sample runs on ITS ids, and remembers the size of the set they came from. Re-resolving the
    // original scope at forecast time would be the obvious alternative and is wrong: a filter can
    // match a different number of rows by then, and the forecast would divide the sample's cost by a
    // set it never sampled.
    const { run, resolved } = createRun({
      sheetId,
      scope: { ...scope, rowIds: pick.rowIds, limit: undefined, fromRow: undefined, toRow: undefined },
      sampleOfRows: pick.ofRows,
      overwriteEdited: body.overwriteEdited === true,
      // A sample exists to find out what a row costs, so it must not skip the rows whose cost it is
      // measuring. Without this the unchanged-input short circuit hands back a free re-run of cells
      // that already have answers, and the forecast reads $0 per row for a column that bills on
      // every one.
      force: true,
      startedBy: me(req)?.id ?? null,
    });

    void executeRun(run.id, resolved).catch((e) => {
      console.error("[sample]", run.id, e);
    });

    res.json({
      run,
      rowIds: pick.rowIds,
      ofRows: pick.ofRows,
      stride: pick.stride,
      summary: resolved.summary,
    });
  }));

  /**
   * What the sample measured, and what it says the rest will cost.
   *
   * Readable while the run is still going — the numbers are simply over however many cells have
   * finished, and a projection from four rows is refused by the same rule that refuses one from a
   * finished run of four.
   */
  app.get("/api/runs/:id/forecast", wrap(async (req, res) => {
    const f = await forecastWithEstimate(param(req, "id"));
    if (!f) return res.status(404).json({ error: "Run not found" });
    res.json({ forecast: f, run: getRun(param(req, "id")) });
  }));

  app.get("/api/sheets/:id/runs", wrap((req, res) =>
    res.json({ runs: listRuns(param(req, "id"), Number(req.query.limit ?? 15)) })));

  app.get("/api/runs/:id", wrap((req, res) => {
    const run = getRun(param(req, "id"));
    if (!run) return res.status(404).json({ error: "Run not found" });
    res.json({ run });
  }));

  app.post("/api/runs/:id/cancel", wrap((req, res) => {
    cancelRun(param(req, "id"));
    res.json({ run: getRun(param(req, "id")) });
  }));

  app.post("/api/runs/:id/pause", wrap((req, res) => {
    pauseRun(param(req, "id"), "paused by you");
    res.json({ run: getRun(param(req, "id")) });
  }));

  app.post("/api/runs/:id/resume", wrap((req, res) => {
    resumeRun(param(req, "id"));
    res.json({ run: getRun(param(req, "id")) });
  }));

  // ───────────────────────────────────────────────────── promote a model column to a rule
  //
  // Two routes, same shape as AI setup and for the same reason: one measures and returns, the other
  // writes. Nothing here switches a column on its own — a promoted rule replaces the model on every
  // future row, so being wrong is not a one-off but a wrong value from now on, in a column nobody
  // re-checks because it used to be right.

  app.post("/api/columns/:id/promote", wrap(async (req, res) => {
    const id = Number(param(req, "id"));
    const col = getColumn(id);
    if (!col) return res.status(404).json({ error: "Column not found" });
    const out = await proposePromotion(col.sheetId, id);
    if ("error" in out) return res.status(400).json(out);
    res.json({ promotion: out });
  }));

  app.post("/api/columns/:id/promote/accept", wrap((req, res) => {
    const id = Number(param(req, "id"));
    const col = getColumn(id);
    if (!col) return res.status(404).json({ error: "Column not found" });

    const code = String(req.body?.code ?? "").trim();
    if (!code) return res.status(400).json({ error: "There is no rule to accept." });

    /**
     * The verdict is re-derived HERE, never taken from the request.
     *
     * The client sends back the code it was shown, and a client could send back anything. Grading is
     * cheap — it runs JavaScript over a few dozen rows — so it is done again rather than trusted,
     * which also closes the window where the column changed between the proposal and the button.
     */
    const { examples } = gatherExamples(col.sheetId, id);
    if (examples.length < MIN_EXAMPLES) {
      return res.status(400).json({ error: "There are no longer enough answered rows to check this rule against." });
    }

    const saved = saveScript({
      sheetId: col.sheetId, columnId: id, hook: "transform", runtime: "js",
      intent: String(req.body?.how ?? `Reproduces what the model was doing in "${col.name}".`),
      code,
      rationale: String(req.body?.summary ?? ""),
    });
    if (saved.errors?.length) return res.status(400).json({ error: saved.errors.join(" ") });

    /**
     * Saved, and NOT approved. Approval is a separate deliberate act on the rule screen, where the
     * code is on display — this is generated code that is about to run on every row of the table,
     * and a route that both wrote it and blessed it would be the one place in the app where nobody
     * read it. The column also stays on the model until it is approved, so nothing breaks in
     * between.
     */
    res.json({
      script: saved.script,
      next: "Read the rule on the Rule screen and approve it. The column keeps using the model until you do.",
    });
  }));

  // ───────────────────────────────────────────────────── restore points

  app.get("/api/sheets/:id/snapshots", wrap((req, res) =>
    res.json({ snapshots: listSnapshots(param(req, "id")) })));

  app.post("/api/runs/:id/restore", wrap((req, res) => {
    const runId = param(req, "id");
    const run = getRun(runId);
    // Refused while the run is still working, and NOT merely discouraged: restore is a bulk write
    // over the same cells the run's executor is writing right now, so the two would race per row and
    // the value that survived would be whichever landed last. Stopping the run first is the user's
    // decision to make, and it is one sentence away.
    if (run && (run.status === "running" || run.status === "cancelling" || run.status === "pending")) {
      return res.status(409).json({
        error: "That run is still going. Stop it first, then put the old values back — restoring " +
          "underneath a run that is still writing would leave some rows old and some new.",
      });
    }
    res.json({ result: restoreSnapshot(runId), snapshot: getSnapshot(runId) });
  }));

  // ───────────────────────────────────────────────────── JSON columns and fan-out

  /** What fields does this JSON column actually contain? Sampled from real values. */
  app.get("/api/columns/:id/json-fields", wrap((req, res) => {
    const columnId = Number(param(req, "id"));
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });
    res.json({ fields: discoverJsonFields(col.sheetId, columnId) });
  }));

  /** Expand selected paths into sibling columns. Deterministic, so this costs nothing per row. */
  /** Fill a column that already exists from one field of this JSON column. */
  app.post("/api/columns/:id/map-field", wrap((req, res) => {
    const columnId = Number(param(req, "id"));
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });
    const path = String(req.body?.path ?? "").trim();
    const targetColumnId = Number(req.body?.targetColumnId);
    if (!path || !Number.isInteger(targetColumnId)) {
      return res.status(400).json({ error: "Say which field, and which column to put it in." });
    }
    res.json(mapJsonField(col.sheetId, columnId, path, targetColumnId));
  }));

  app.post("/api/columns/:id/expand", wrap((req, res) => {
    const columnId = Number(param(req, "id"));
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });
    const fields = Array.isArray(req.body?.fields) ? req.body.fields : [];
    if (fields.length === 0) return res.status(400).json({ error: "Pick at least one field to expand." });
    res.json(expandJsonColumn(col.sheetId, columnId, fields));
  }));

  /** Recompute derived children after their source changed. */
  // ───────────────────────────────────────────────────── search backends

  /**
   * Every engine that can search, built-in and user-described, with what each one costs.
   *
   * The price is reported alongside whether it CAME FROM the user, because a figure someone typed
   * and a figure this app shipped are different claims and the screen has to say which it is
   * showing — a stale list price presented as fact is how a budget comes to enforce the wrong
   * ceiling.
   */
  app.get("/api/search/backends", wrap((_req, res) => {
    const secretNames = new Set(listSecrets().map((s) => s.name.trim().toLowerCase()));
    res.json({
      chosen: chosenBackend(),
      backends: BACKENDS.map((b) => ({
        ...b,
        perSearchUsd: perSearchUsd(b.id),
        priceIsCustom: priceIsCustom(b.id),
        hasKey: b.id === "openrouter"
          ? providerKeyStatus("openrouter").present
          : secretNames.has(b.secretName.trim().toLowerCase()),
      })),
      custom: listCustom().map((c) => ({ ...c, perSearchUsd: customPerSearchUsd(c) })),
      // Pre-described engines. Adding one copies its description into an editable engine of your
      // own, which is why they are not a third kind of thing: a preset IS a custom engine, filled in.
      presets: SEARCH_PRESETS,
    });
  }));

  /** Add a pre-described engine as an editable one of your own. */
  app.post("/api/search/presets/:key", wrap((req, res) => {
    const p = preset(param(req, "key"));
    if (!p) return res.status(404).json({ error: "No such engine." });
    const { key, signupUrl, secretNames, note, ...spec } = p;
    res.json({ engine: saveCustom(spec) });
  }));

  app.post("/api/search/backend", wrap((req, res) => {
    setChosenBackend(String(req.body?.id ?? ""));
    res.json({ chosen: chosenBackend() });
  }));

  app.post("/api/search/price", wrap((req, res) => {
    const id = String(req.body?.id ?? "");
    const raw = req.body?.usd;
    setPerSearchUsd(id, raw == null || raw === "" ? null : Number(raw));
    res.json({ id, perSearchUsd: perSearchUsd(id), priceIsCustom: priceIsCustom(id) });
  }));

  app.post("/api/search/custom", wrap((req, res) => {
    res.json({ engine: saveCustom(req.body ?? {}) });
  }));

  app.delete("/api/search/custom/:id", wrap((req, res) => {
    const id = param(req, "id");
    deleteCustom(id);
    // A deleted engine that was the chosen one leaves searching pointed at nothing, so the choice
    // falls back rather than becoming a dangling id that silently disables the lane.
    if (chosenBackend() === id) setChosenBackend("openrouter");
    res.json({ ok: true, chosen: chosenBackend() });
  }));

  /**
   * Run one real query against a described engine, before it is used on a column.
   *
   * A response path that is subtly wrong returns zero results on every row, silently, and is
   * indistinguishable from a question nobody could answer. So this returns the parsed hits — and,
   * when the path finds nothing, the raw response, which is the only thing that makes the mistake
   * visible.
   */
  app.post("/api/search/custom/try", wrap(async (req, res) => {
    const spec = req.body?.engine;
    if (!spec?.url) return res.status(400).json({ error: "Fill in the web address first." });
    const query = String(req.body?.query ?? "").trim() || "openrouter pricing";
    res.json(await tryCustom(spec, query));
  }));

  /**
   * Why is this column empty?
   *
   * On demand rather than on the header, because it reads the cells table and the header repaints
   * during a run. Asked once, when someone wants the answer.
   */
  app.get("/api/columns/:id/blanks", wrap((req, res) => {
    res.json(explainBlanks(Number(param(req, "id"))));
  }));

  app.post("/api/columns/:id/refresh-derived", wrap((req, res) => {
    const columnId = Number(param(req, "id"));
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });
    res.json({ rows: refreshChildren(col.sheetId, columnId) });
  }));

  /**
   * The fields inside a LIST column's items, plus what a fan-out would produce.
   *
   * Separate from `/json-fields` because an array has no fields of its own — its items do. This is
   * what lets the fan-out screen offer real field names instead of asking for hand-typed paths.
   */
  /**
   * WHERE inside this column is the list?
   *
   * The sibling of list-fields, and it has to come first: the fields of a list cannot be discovered
   * until the list has been found. `SendConfig.listPath` was read by the writer from the day fan-out
   * shipped and could not be set from anywhere, so a column holding `{company, contacts: [...]}` was
   * only explodable by pointing at the whole cell — which is an object, not a list, so the fan-out
   * wrote one row holding the object and read as broken.
   */
  app.get("/api/columns/:id/list-paths", wrap((req, res) => {
    const columnId = Number(param(req, "id"));
    if (!getColumn(columnId)) return res.status(404).json({ error: "Column not found" });
    res.json({ paths: discoverListPaths(columnId) });
  }));

  app.get("/api/columns/:id/list-fields", wrap((req, res) => {
    const columnId = Number(param(req, "id"));
    const col = getColumn(columnId);
    if (!col) return res.status(404).json({ error: "Column not found" });

    const cap = Math.max(1, Math.min(1000, Number(req.query.cap ?? 50)));
    const listPath = typeof req.query.path === "string" ? req.query.path : "";
    const rowIds = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? LIMIT ?")
      .all(col.sheetId, LIST_FIELD_SAMPLE_ROWS) as any[]).map((r) => Number(r.id));
    const sheetRows = countRows(col.sheetId);
    res.json({
      fields: discoverListItemFields(columnId, 50, 200, listPath),
      ...countListItems(columnId, rowIds, cap, listPath),
      cap,
      // What the counts above are OVER. The screen says "sampled N of M rows" from these, because a
      // partial count presented as a total is a number somebody plans a fan-out against.
      sampledRows: rowIds.length,
      sheetRows,
      sampled: sheetRows > rowIds.length,
    });
  }));

  /**
   * What would a `send` column write, without writing it?
   *
   * The same dry run the modal had, moved to where the configuration now lives. It resolves through
   * `buildWriteItems` + `planWrite` — the identical path the run takes — so the preview cannot
   * promise 400 rows and then perform 40,000.
   *
   * Bounded to the first N rows by default: a preview of a million-row send would be a full
   * materialisation of the write it is trying to avoid, and the answer to "is my mapping right" is
   * visible in five rows.
   */
  app.post("/api/columns/:id/send/preview", wrap((req, res) => {
    const col = getColumn(param(req, "id"));
    if (!col) return res.status(404).json({ error: "Column not found" });

    const cfg = { ...DEFAULT_SEND, ...((col.sendConfig ?? {}) as Partial<SendConfig>) } as SendConfig;

    const limit = Math.max(1, Math.min(1000, Number(req.body?.limit ?? 200)));
    const scope = { ...(req.body?.scope ?? {}), limit };
    const resolved = resolveScope(col.sheetId, scope);
    const rowIds = (db.prepare(resolved.sql).all(...resolved.params) as any[]).map((r) => Number(r.id));

    /**
     * The destination check, the empty-mapping check and the run-condition caveat, from the one
     * helper the runner uses.
     *
     * One resolver, not two inline `if`s answering a different question than the run does. A preview
     * reporting the UNGATED row count for a column behind a run condition, never mentioning the
     * condition at all, shows a send that will write two rows as four. `resolveSendScope`
     * empties `rowIds` whenever it has an error, so a caller that renders the errors and carries on
     * still writes nothing.
     */
    const scoped = resolveSendScope(cfg, rowIds, { conditionScriptId: col.conditionScriptId ?? null });
    const source = getSheet(col.sheetId);
    if (scoped.errors.length > 0) {
      return res.json({
        inserts: 0, updates: 0, skips: 0, preview: [],
        errors: scoped.errors, warnings: scoped.warnings,
        sampledRows: 0, sheetRows: source?.rowCount ?? 0,
      });
    }

    // The source table's name is what finds the back-reference column, so leaving it out described a
    // write with no link back — which is not the write the run performs.
    const plan = planWrite(buildWriteItems(cfg, scoped.rowIds), targetOf(cfg, source?.name ?? "Source"));
    res.json({
      ...plan,
      warnings: [...plan.warnings, ...scoped.warnings],
      sampledRows: scoped.rowIds.length,
      sheetRows: source?.rowCount ?? 0,
    });
  }));

  /**
   * Plan a write into another table. Always callable before applying — writing elsewhere is the one
   * operation that creates data where the user is not looking, so the numbers come first.
   */
  app.post("/api/sheets/:id/write-target/plan", wrap((req, res) => {
    const target = req.body?.target;
    if (!target?.targetSheetId) return res.status(400).json({ error: "No target table specified." });
    // Same refusal the apply route below makes, so planning cannot describe a write that applying
    // would refuse — and so a plan is never drawn against a table that is in the trash.
    assertTargetExists(target);
    res.json(planWrite(legacyWriteItems(param(req, "id"), req.body), target));
  }));

  app.post("/api/sheets/:id/write-target/apply", wrap((req, res) => {
    const body = req.body ?? {};
    const target = body.target;
    if (!target?.targetSheetId) return res.status(400).json({ error: "No target table specified." });

    /**
     * The destination has to still be there.
     *
     * This route takes its target from the REQUEST rather than from a column's stored configuration,
     * so it never went through `targetOf` and never had the check `targetOf` performs. A trashed
     * table keeps its id, its columns and its rows, so every statement below succeeds against it:
     * the write reports success, creates a back-reference column inside the trash, and puts the
     * records somewhere nobody will look. Fail closed — a missing destination is a refusal.
     */
    assertTargetExists(target);

    // Create the back-reference before the first write, so rows are never orphaned — retrofitting it
    // later leaves everything already written without a parent.
    if (body.withBackRef) {
      const src = getSheet(param(req, "id"));
      target.backRefColumnId = ensureBackRefColumn(target.targetSheetId, src?.name ?? "Source");
    }
    res.json(applyWrite(legacyWriteItems(param(req, "id"), body), target));
  }));

  /**
   * Turn a source column's cells into write items, exploding lists when asked.
   *
   * The per-row cap is enforced here rather than in the writer: one row holding a 10,000-element
   * array would otherwise silently become 10,000 records in the target table.
   */
  function legacyWriteItems(sheetId: string, body: any): WriteItem[] {
    const sourceColumnId = Number(body?.sourceColumnId);
    const perItem = body?.fanOut === "per_item";
    /**
     * One row over here becomes one row over there.
     *
     * The ordinary case, and the one a column-only design cannot express: if every mode starts from
     * a source COLUMN and explodes what is inside it, "send these rows to that table" — which is what
     * anyone means by sending table data — has no path through at all.
     */
    const rowMode = body?.fanOut === "row";
    const cap = Math.max(1, Number(body?.cap ?? 50));

    const resolved = resolveScope(sheetId, body?.scope ?? {});
    const rowIds = (db.prepare(resolved.sql).all(...resolved.params) as any[]).map((r) => Number(r.id));
    if (rowIds.length === 0) return [];

    const cells = rowMode
      ? []
      : (db
          .prepare(
            `SELECT row_id, value_json, value_text FROM cells
              WHERE column_id = ? AND row_id IN (${rowIds.map(() => "?").join(",")})`,
          )
          .all(sourceColumnId, ...rowIds) as any[]);

    // Only the columns the mapping actually asks for.
    //
    // Reading every column of every row would be the easy version and the wrong one: a fan-out over
    // a wide sheet would pull thirty values per row to use two of them, on a path whose whole job is
    // to stay usable at fifty thousand items.
    const wanted = new Set<number>();
    for (const entry of Object.values((body?.target?.mapping ?? {}) as Record<string, unknown>)) {
      if (entry && typeof entry === "object" && (entry as any).from === "row") {
        wanted.add(Number((entry as any).columnId));
      }
    }
    // The match key is a value like any other, and if it is not read here it resolves to null for
    // every row — which turns a careful upsert into a silent full duplication of the destination.
    const keySrc = body?.target?.keySource;
    if (keySrc && keySrc.from === "row") wanted.add(Number(keySrc.columnId));

    const rowValues = new Map<number, Record<string, string | null>>();
    if (wanted.size > 0) {
      const ids = [...wanted];
      for (const r of db
        .prepare(
          `SELECT row_id, column_id, value_text FROM cells
            WHERE row_id IN (${rowIds.map(() => "?").join(",")})
              AND column_id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...rowIds, ...ids) as any[]) {
        const bag = rowValues.get(Number(r.row_id)) ?? {};
        bag[String(r.column_id)] = r.value_text ?? null;
        rowValues.set(Number(r.row_id), bag);
      }
    }

    const listPath = String(body?.listPath ?? "");
    const items: WriteItem[] = [];

    // Row mode has no cell to explode: the row IS the item, and every mapped value comes off it.
    if (rowMode) {
      for (const rowId of rowIds) {
        items.push({ sourceRowId: rowId, value: null, rowValues: rowValues.get(rowId) });
      }
      return items;
    }

    for (const c of cells) {
      let parsed: unknown = c.value_text;
      try { parsed = JSON.parse(c.value_json ?? c.value_text); } catch { /* keep the raw text */ }
      if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* keep */ } }
      // The list is not always the whole cell. Resolved with the SAME path the discovery used, so
      // what gets written cannot be a different list than the one whose fields were mapped.
      if (listPath) parsed = getPath(parsed, listPath);
      const rowId = Number(c.row_id);
      const bag = rowValues.get(rowId);
      if (!perItem) {
        if (parsed != null) items.push({ sourceRowId: rowId, value: parsed, rowValues: bag });
        continue;
      }
      for (const item of toList(parsed).slice(0, cap)) {
        // Every item from one row shares that row's values — which is the point: five contacts
        // exploded out of one company all carry that company.
        items.push({ sourceRowId: rowId, value: item, rowValues: bag });
      }
    }
    return items;
  }

  // ───────────────────────────────────────────────────── csv

  /**
   * Take a file from the browser and hold it somewhere the importer can read.
   *
   * The import path has always taken a FILE PATH, which is the right shape for the engine — the
   * importer streams a million rows off disk rather than holding them in memory — and the wrong
   * shape for a person, because a browser cannot tell you where a file lives. So the browser sends
   * the bytes, this writes them down, and everything downstream is unchanged.
   *
   * Written under the app's own temp directory, never to a path the request chooses. The name is
   * generated; the one the user picked is kept only for display.
   */
  app.post("/api/csv/upload", wrap(async (req, res) => {
    mkdirSync(TMP_DIR, { recursive: true });
    sweepStagedUploads();
    const path = join(TMP_DIR, `upload-${randomUUID()}.csv`);

    // STREAMED to disk, not buffered. `express.raw` held the whole upload in memory, which capped it
    // at what a single Buffer can hold and made a file the size of the ones this tool exists for — a
    // 10 GB list — impossible before it ever reached the parser. Piping the request straight to a file
    // keeps memory flat whatever the size, so there is no ceiling here: the free space on the disk is
    // the only limit. Everything downstream already streams — the preview reads a 64 KB head and the
    // import parses row by row — so nothing after this loads the file whole either.
    try {
      await pipeline(req, createWriteStream(path));
    } catch {
      rmSync(path, { force: true });
      return res.status(400).json({ error: "That file could not be read all the way through." });
    }

    const bytes = existsSync(path) ? statSync(path).size : 0;
    if (bytes === 0) {
      rmSync(path, { force: true });
      return res.status(400).json({ error: "That file came through empty." });
    }

    // Previewed in the same call: the answer to "did that work" and the answer to "what is in it"
    // are the same question, and two round trips to learn a file is Windows-1252 is one too many.
    try {
      res.json({ path, bytes, preview: await previewCsv(path) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }));

  // Both CSV routes take a PATH, not a file, because the upload already streamed the bytes to disk
  // and re-posting a 700 MB file to import it would be absurd. That makes the path itself the
  // attack surface: unguarded, `{"path":"C:\\Users\\me\\.ssh\\id_rsa"}` reads any file this process
  // can reach, and the import route turns it into rows you can then read back out of a sheet.
  // Anything outside the staging directory is refused. The error deliberately does not distinguish
  // "outside the staging directory" from "not there", since telling a caller which of the two it was
  // hands them a file-existence oracle for the rest of the disk.
  const stagedPath = (raw: unknown): string | null => {
    const p = String(raw ?? "");
    if (!p) return null;
    return isUnder(TMP_DIR, p) && existsSync(p) ? p : null;
  };

  app.post("/api/csv/preview", wrap(async (req, res) => {
    const path = stagedPath(req.body?.path);
    if (!path) return res.status(400).json({ error: "File not found" });
    res.json(await previewCsv(path));
  }));

  app.post("/api/sheets/:id/import", wrap(async (req, res) => {
    const path = stagedPath(req.body?.path);
    if (!path) return res.status(400).json({ error: "File not found" });
    const id = param(req, "id");

    // Streamed as newline-delimited JSON so the modal can show the row count climbing instead of a
    // spinner that says nothing on a file with millions of rows. A `progress` line now and then while
    // it runs, then exactly one terminal line: `done` with the result, or `error` with the reason.
    // Once the first byte is out the status is already 200, so a failure AFTER that is carried in an
    // `error` line rather than a status code — the client reads the last line to know which it was.
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no"); // no proxy may collect the progress into one lump
    const line = (obj: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

    // The Cancel button aborts the fetch, which drops this connection. `close` firing before the
    // response has ended is that abort — so the import is told to stop, and it rolls back everything
    // it wrote. A `close` AFTER `res.end()` is just the normal end of a finished response.
    const canceller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) canceller.abort(); });

    let lastPing = 0;
    try {
      const result = await importCsv(id, path, {
        delimiter: req.body?.delimiter,
        encoding: req.body?.encoding,
        hasHeader: req.body?.hasHeader,
        mappings: req.body?.mappings,
        dedupeOnIndex: req.body?.dedupeOnIndex,
        // Asked for explicitly or not at all. Its sibling is the `override` flag on a single cell
        // edit; this is the same decision taken once for a whole file, so it is never inferred.
        overwriteComputed: req.body?.overwriteComputed === true,
        signal: canceller.signal,
        onProgress: (rows) => {
          // Throttled: a fast import calls this every batch, and a line per batch on a ten-million
          // row file is tens of thousands of writes to say nothing new. At most one every 200ms.
          const now = Date.now();
          if (now - lastPing < 200) return;
          lastPing = now;
          line({ type: "progress", rows });
        },
      });
      // Rows arrived, so anything set to keep itself up to date has work. The settings panel has
      // always promised this reacts "on an import"; until the trigger existed it did not.
      noteRowsArrived(id);
      line({ type: "done", result: { ...result, rowCount: countRows(id) } });
    } catch (e) {
      // A cancel already rolled the rows back inside importCsv; there is usually no client left to
      // tell, but if there is, name it plainly rather than as an error.
      if (e instanceof ImportCancelled) { noteRowsArrived(id); line({ type: "cancelled" }); }
      else line({ type: "error", error: e instanceof Error ? e.message : String(e) });
    }
    if (!res.writableEnded) res.end();
  }));

  app.get("/api/sheets/:id/export.csv", wrap((req, res) => {
    // Checked FIRST. Exporting a table that is gone otherwise answers 200 with a five-byte file — a
    // byte-order mark and a blank line — which opens cleanly in any spreadsheet and contains
    // nothing. "Your table is empty" and "your table no longer exists" are different facts and the
    // difference is one a person has to be told, not left to infer from an empty window.
    const sheet = getSheet(param(req, "id"));
    if (!sheet) return res.status(404).json({ error: "That table no longer exists." });

    // The export narrows to the SAME rows the grid is showing.
    //
    // Parsed by `readOptionsFrom` — the rows endpoint's own parser — rather than by a second reading
    // of the query string, for the reason that function exists: two parsers drift, and a drifted
    // export is a file with the wrong rows in it that looks exactly like a file with the right ones.
    // So the client appends the identical `view`/`filter`/`status`/`q` it already sends the grid.
    //
    // `sort` is deliberately not honoured: the export has always been in position order, and a
    // sorted export and an unsorted one containing the same rows are the same file to everything
    // downstream, while re-sorting a million rows to produce it is not free.
    const strictFilter = String(req.query.filter ?? "").trim();
    if (strictFilter) {
      // The grid tolerates an unreadable filter by narrowing nothing — showing too many rows is the
      // better failure there, because the user can see them. Here the extra rows leave in a file, so
      // this refuses instead. Same reasoning as `resolveScope`, applied one layer earlier because
      // `readOptionsFrom` swallows the parse error before the scope ever sees it.
      try {
        JSON.parse(strictFilter);
      } catch {
        return res.status(400).json({
          error:
            "That export was not started, because the filter could not be read. Exporting anyway " +
            "would have written every row rather than the ones you filtered to.",
        });
      }
    }

    const read = readOptionsFrom(req, param(req, "id"));
    const narrowed = read.filter != null || (read.search ?? "").trim() !== "";

    const csv = exportCsv(param(req, "id"), {
      columnIds: req.query.columns ? String(req.query.columns).split(",") : undefined,
      includeMeta: req.query.meta === "1",
      // Undefined when nothing narrows, so an ordinary whole-table export keeps the keyset read path
      // it has always used rather than paying for a scope resolution that selects everything.
      scope: narrowed
        ? { filter: read.filter ?? undefined, search: read.search ?? undefined }
        : undefined,
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${(sheet?.name ?? "sheet").replace(/[^\w.-]+/g, "_")}.csv"`);
    // PIPED, not res.send(). exportCsv streams now — a million-row export used to build the whole
    // file as one JS string first, which is the export dying on the sheets most worth exporting.
    // res.send() would not have thrown on the stream object; it falls through to res.json() and
    // ships ~800 bytes of the stream's internals with a text/csv header, and tsc cannot catch it
    // because res.send takes `any`. A silently wrong download is worse than a failed one.
    csv.on("error", (e: Error) => {
      // Headers are already out, so there is no status code left to send. End the response rather
      // than leaving the browser on an open socket waiting for a body that will never arrive.
      console.error("[export]", e);
      res.destroy(e);
    });
    csv.pipe(res);
  }));

  // ───────────────────────────────────────────────────── static web client

  // ───────────────────────────────────────────────────── errors
  //
  // Express's default error handler returns an HTML page. For an API that is worse than useless: a
  // malformed request body produced `<!DOCTYPE html>` where every caller expects JSON, so the real
  // error was hidden behind a parse failure in the client. Anything under /api answers in JSON.

  /**
   * The delivery endpoint needs one of its own, and it must say LESS.
   *
   * Nothing was mounted on `/hook`, so a body over the size limit fell straight through to Express's
   * default handler: an HTML page carrying a stack trace with absolute filesystem paths, returned to
   * an unauthenticated stranger. The STATUS is kept, because a sender has to be able to tell "too
   * big" from "malformed"; the text is fixed, because nothing about this machine is that caller's
   * business.
   */
  app.use("/hook", (err: any, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status ?? err?.statusCode ?? 400);
    const tooBig = err?.type === "entity.too.large" || status === 413;
    res.status(status >= 400 && status < 600 ? status : 400).json({
      error: tooBig
        ? `That delivery was larger than ${Math.round(MAX_BODY_BYTES / 1024)} KB and was not read.`
        : "That delivery could not be accepted.",
    });
  });

  app.use("/api", (err: any, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status ?? err?.statusCode ?? 400);
    const message =
      err?.type === "entity.parse.failed"
        ? "The request body was not valid JSON."
        : String(err?.message ?? "Request failed");
    res.status(status >= 400 && status < 600 ? status : 400).json({ error: message });
  });

  const webDist = join(process.cwd(), "web", "dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback for client-side routes, without swallowing unmatched /api paths.
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
  }

  return app;
}
