// Prompt Studio — the column editor drawer.
//
// Right-docked, resizable, and deliberately WITHOUT a backdrop, so the grid stays live and visible
// behind it. That is not a style choice: the dry-run writes real values into real cells for real
// rows, and watching that happen is the single most useful moment in the product. A modal would
// hide it.
//
// Four tabs rather than four stacked sections, per the house rule against stacking heavy sections.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Column, type Sheet } from "../api.ts";
import { type RefOption } from "./RefMenu.tsx";
import { RefField } from "./RefField.tsx";
import { findRefs, toDisplay } from "./refs.ts";
import { brokenRefs, cyclePathsFrom } from "./refGraph.ts";
import { IconPlay, IconExpand } from "../ui/Icon.tsx";
import { ColumnKindIcon } from "../ui/ColumnKindIcon.tsx";
import { columnBadge, sourceNameOf } from "../ui/columnBadge.ts";
import { Modal } from "../ui/Modal.tsx";
import { SearchSettings, DEFAULT_SEARCH, type WebSearchSettings } from "./SearchSettings.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { RuleSettings } from "./RuleSettings.tsx";
import { EnumOptions } from "./EnumOptions.tsx";
import { FormatFields } from "./FormatFields.tsx";
import type { RuleSet } from "@shared/validate.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { LookupSettings } from "./LookupSettings.tsx";
import { HttpSettings, DEFAULT_HTTP, type HttpConfig } from "./HttpSettings.tsx";
import { McpSettings, DEFAULT_MCP, type McpConfig } from "./McpSettings.tsx";
import { AgentTools } from "./AgentTools.tsx";
import { SendSettings, DEFAULT_SEND, type SendConfig } from "./SendSettings.tsx";
import { WaterfallSettings } from "./WaterfallSettings.tsx";
import { PromoteRule } from "./PromoteRule.tsx";
import { PaceSettings, DEFAULT_AT_A_TIME } from "./PaceSettings.tsx";
import { FanoutSettings, type FanoutValue } from "./FanoutSettings.tsx";
import type { Waterfall } from "@shared/waterfall.ts";
import { AiSetup } from "./AiSetup.tsx";
import { RunSettings } from "./RunSettings.tsx";
import { useAutosave } from "../ui/useAutosave.ts";
import { basisFor } from "./cost.ts";
import { resolveModel, useModelCatalog } from "./models.ts";
import { ColumnHistory } from "./ColumnHistory.tsx";
import { PromptCost } from "./PromptCost.tsx";
import "./ColumnEditor.css";

type Tab = "mode" | "rule" | "prompt" | "request" | "tool" | "destination" | "link" | "steps" | "output" | "search" | "when" | "runs";

const TAB_LABEL: Record<Tab, string> = {
  mode: "Mode",
  rule: "Rule",
  prompt: "Instruction",
  request: "Request",
  tool: "Tool",
  destination: "Destination",
  link: "Linked table",
  steps: "Steps",
  output: "Output",
  search: "Search",
  when: "When to run",
  runs: "History",
};

/**
 * Which screens this column actually has.
 *
 * A tab per lane rather than one list with half of it inert. A script column has no instruction and
 * an AI column has no code, and offering both to both is how a user writes a prompt into a box that
 * compiles it as JavaScript.
 */
function tabsFor(kind: Column["kind"]): Tab[] {
  // A send column has no output type to pick — its cell records what happened to that row, and
  // nothing about the destination is a data type of this column.
  if (kind === "send") return ["mode", "destination", "when", "runs"];
  // A lookup has no output type to pick and no rule to write: the value comes across as it is, and
  // WHERE it comes from is the only decision. Its data type follows the field it reads.
  if (kind === "lookup" || kind === "rollup") return ["mode", "link", "when", "runs"];
  // A waterfall has no single request, prompt or rule of its own — every one of those belongs to a
  // STEP. Its own screens are the ordered list and what the answer is coerced to.
  if (kind === "waterfall") return ["mode", "steps", "output", "when", "runs"];
  // A wait has no output to shape and no rule to write: how long it holds a row is its whole
  // configuration, and that lives on the Mode tab beside the lane that needs it.
  if (kind === "wait") return ["mode", "when", "runs"];
  if (kind === "http") return ["mode", "request", "output", "when", "runs"];
  // An MCP column has no request of its own to write and no rule: which app, which tool, and what
  // goes into it is the whole configuration.
  if (kind === "mcp") return ["mode", "tool", "output", "when", "runs"];
  if (kind === "ai" || kind === "agent") return ["mode", "prompt", "output", "search", "when", "runs"];
  return ["mode", "rule", "output", "when", "runs"];
}

/**
 * The ceiling on a try.
 *
 * Not a limit on how much you can run — Run covers the whole sheet — but a try is ONE synchronous
 * HTTP request with no progress and no cancel, so it has to finish in a time a held-open request can
 * survive. Ten thousand rows of a JS transform is well inside that; a million is not, and would look
 * exactly like the app having hung. The server enforces the same number.
 */
const TRY_MAX = 10_000;
const clampTry = (n: number) => (Number.isFinite(n) ? Math.max(1, Math.min(TRY_MAX, Math.floor(n))) : 1);

/**
 * How long the drawer stays mounted after Close, so its exit can play.
 *
 * Matches the duration in ColumnEditor.css. The drawer had a 200ms entrance and NO exit — measured
 * at 7ms from click to removal — so the app's most-used panel was the one overlay that popped out of
 * existence. Modal and Popover both already do this; the rule is stated at Popover.css:16.
 */
const EXIT_MS = 160;

interface Props {
  sheetId: string;
  column: Column;
  columns: Column[];
  /** Every table, so a send column can pick where it writes. */
  sheets: Sheet[];
  /** Drives the cost estimate on the Mode tab — the whole point of which is to be about THIS sheet. */
  rowCount: number;
  onClose: () => void;
  onSaved: () => void;
  /**
   * Reports whether closing right now would throw away unsaved work (an unsaved rule, a typed-but-
   * unsaved AI setup). The parent uses it so that opening ANOTHER panel over this one asks first,
   * instead of unmounting the drawer and discarding the rule silently.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Hands the drawer's OWN guarded close up to the parent — the same one the ✕ and a click-outside
   * use, which shows the discard prompt when there is unsaved work. Registered on mount, cleared on
   * unmount, so the parent can route a "close this to open that" through the guard rather than around
   * it.
   */
  bindRequestClose?: (close: (() => void) | null) => void;
}

interface SavedScript {
  id: string;
  hash: string;
  code: string;
  runtime: string;
  approvedAt: string | null;
  version: number;
}

export function ColumnEditor({ sheetId, column, columns, sheets, rowCount, onClose, onSaved, onDirtyChange, bindRequestClose }: Props) {
  // Mode first, and it opens there on a column that has not been decided yet. The mode is the
  // expensive decision — landing on the code editor first invites writing a rule for a column that
  // should have been a search, or worse, leaving a fresh column on whatever the default was.
  const [tab, setTab] = useState<Tab>("mode");
  const [kind, setKind] = useState(column.kind);
  const [kindError, setKindError] = useState<string | null>(null);
  const [model, setModel] = useState<string>((column as any).model ?? "auto");
  /** The cheap model tried first, or "" when the column just uses the one above. */
  const [firstModel, setFirstModel] = useState<string>((column as any).firstModel ?? "");
  /**
   * The per-cell ceiling, as typed.
   *
   * A string rather than a number because "" and "0" are different answers here and `Number("")` is
   * 0 — which is the value that means NO ceiling. Parsing on save keeps an empty box from silently
   * removing the limit the moment somebody clears it to retype.
   */
  const [cellCap, setCellCap] = useState<string>(
    column.maxBudgetUsd == null ? "0.05" : String(column.maxBudgetUsd),
  );
  /** 0 = no limit. See PaceSettings. */
  const [rateLimit, setRateLimit] = useState<number>(Number(column.rateLimitPerMin ?? 0));
  const [waitSecs, setWaitSecs] = useState<number>(Number(column.waitSeconds ?? 0));
  /** Fan-out: the prompt runs once per item of the source column's list. See FanoutSettings. */
  const [fanout, setFanout] = useState<FanoutValue>({
    on: column.fanOut === "per_item",
    sourceId: column.fanOutSource ?? null,
    cap: column.fanOutCap ?? null,
  });
  /** Whether the agent is handed the web_search tool at all. See the Search tab. */
  const [webSearch, setWebSearch] = useState<boolean>(
    ((column as any).allowedTools ?? []).includes("web_search"),
  );
  const [intent, setIntent] = useState("");
  const [code, setCode] = useState("");
  const [runtime, setRuntime] = useState<"js" | "powershell" | "bash">("js");
  const [valueType, setValueType] = useState(column.valueType);
  const [enumValues, setEnumValues] = useState<string[]>(column.enumValues ?? []);
  const [enumError, setEnumError] = useState<string | null>(null);
  const [format, setFormat] = useState<{ currency?: string; decimals?: number }>(column.format ?? {});
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedScript | null>(null);
  const [samples, setSamples] = useState<Record<string, string | null>>({});
  const [dryRun, setDryRun] = useState<{ processed: number; errors: number; ms: number } | null>(null);
  // How many rows a try covers. Three is a starting point, not a limit — three rows is not enough to
  // see whether a rule holds up on the messy middle of a real sheet.
  const [tryRows, setTryRows] = useState(3);
  // A try on a model/HTTP/MCP column — unlike a rule dry-run, this one spends and fills the cells for
  // real. Its own busy flag and note, kept apart from the rule footer's dry-run state.
  const [trying, setTrying] = useState(false);
  const [tryNote, setTryNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the existing rule has come back yet. Save stays disabled until it has: saving into an
  // editor that has not finished loading would write a blank rule over a working one.
  const [loaded, setLoaded] = useState(false);

  const rootRef = useRef<HTMLElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Kept mounted through the exit animation, then handed back to the parent to unmount.
  const [leaving, setLeaving] = useState(false);
  const exitTimer = useRef<number | null>(null);
  useEffect(() => () => { if (exitTimer.current != null) clearTimeout(exitTimer.current); }, []);

  /** Play the exit, then close. Idempotent — a second Escape during the exit must not queue another. */
  const dismiss = useCallback(() => {
    if (exitTimer.current != null) return;
    setLeaving(true);
    exitTimer.current = window.setTimeout(onClose, EXIT_MS);
  }, [onClose]);

  // The published rates, shared with the model picker. The estimate has to be built from the model
  // this column will actually run on — pricing every column at one hardcoded model was several times
  // out in both directions depending on what was picked.
  const catalog = useModelCatalog();

  // Search settings save on change, like the data type and unlike the script. They are configuration
  // rather than work in progress, so there is nothing to lose by closing the drawer — which is why
  // they stay out of the unsaved-changes check below.
  const [search, setSearch] = useState<WebSearchSettings>(
    () => ({ ...DEFAULT_SEARCH, ...((column.agent as any)?.search ?? {}) }),
  );
  const [searchError, setSearchError] = useState<string | null>(null);

  // The HTTP request definition. Saved on change like the search settings and the data type: this
  // drawer's Save belongs to the generated script, and a second Save meaning something else in the
  // same footer is how a user ends up believing they saved one thing when they saved the other.
  const [http, setHttp] = useState<HttpConfig>(
    () => ({ ...DEFAULT_HTTP, ...(((column as any).httpConfig ?? {}) as Partial<HttpConfig>) }),
  );

  // The MCP call definition, saved the same way for the same reason.
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcp, setMcp] = useState<McpConfig>(
    () => ({ ...DEFAULT_MCP, ...(((column as any).mcpConfig ?? {}) as Partial<McpConfig>) }),
  );
  const [httpError, setHttpError] = useState<string | null>(null);
  const [waterfallError, setWaterfallError] = useState<string | null>(null);
  /** Set once a generated rule has been saved, so the Rule screen says what to do next with it. */
  const [promoted, setPromoted] = useState<string | null>(null);

  // Where a send column writes. Saved on change like the request and the search settings — this
  // drawer's Save belongs to the generated script, and a second Save meaning something else in the
  // same footer is how a user ends up believing they saved one thing when they saved the other.
  const [send, setSend] = useState<SendConfig>(
    () => ({ ...DEFAULT_SEND, ...(((column as any).sendConfig ?? {}) as Partial<SendConfig>) }),
  );
  const [sendError, setSendError] = useState<string | null>(null);

  // The instruction an `ai` or `agent` column runs on every row.
  //
  // This had no editor at all: the engine read it, skipped the cell when it was empty, and nothing
  // in the app could fill it — so every model column reported "this column has no prompt yet"
  // forever, and the Rule tab it was sent to compiles what you type as JavaScript.
  const [prompt, setPrompt] = useState(column.prompt ?? "");
  const [promptError, setPromptError] = useState<string | null>(null);
  /**
   * The column this drawer is editing no longer exists.
   *
   * A distinct state from an ordinary save error, because the remedy is different: there is nothing
   * to retry and nothing to fix in the field, so the only honest thing the screen can do is say so
   * and get out of the way.
   */
  const [gone, setGone] = useState(false);
  /** Whether the heading is currently an editor. Opened by double-clicking it. */
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [autoRun, setAutoRun] = useState(!!column.autoRun);

  /**
   * The instruction field's wrapper, used only to answer "is the caret in there right now?".
   *
   * See `savePrompt` below: the server's canonical text is adopted after a save, and repainting a
   * field somebody is typing in would move their caret mid-sentence.
   */
  const promptFieldRef = useRef<HTMLDivElement>(null);

  /**
   * The last thing typed, so a finished save knows whether it is still the current one.
   *
   * The hint under the field used to read `prompt !== promptSaved`, which worked only while the
   * saved text was byte-identical to the typed text. It is not: the server canonicalizes a
   * plain-text reference into a real one, so the moment `promptSaved` holds the truth that
   * comparison is permanently unequal and the field says "Saving…" forever.
   */
  const promptLatest = useRef(column.prompt ?? "");
  const [promptDirty, setPromptDirty] = useState(false);

  /**
   * A correction from the server waiting for the caret to leave. See `savePrompt` and `adoptStored`.
   *
   * `sent` is what produced it, so it can be discarded if the field has moved on since — applying a
   * correction to text that has since been rewritten would undo the rewrite.
   */
  const promptCanonical = useRef<{ sent: string; stored: string } | null>(null);

  /** Apply a held correction, once the field is no longer being typed in. */
  const adoptStored = useCallback(() => {
    const pending = promptCanonical.current;
    if (!pending) return;
    promptCanonical.current = null;
    if (promptLatest.current !== pending.sent) return;
    promptLatest.current = pending.stored;
    setPrompt(pending.stored);
  }, []);

  const savePrompt = useCallback(async (next: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: next }),
      }).then((r) => r.json());
      if (res.error) {
        // A column can disappear while its editor is open — deleted from the grid in another tab,
        // or taken with the table it lived on. That is not a save failure to retry; there is
        // nothing left to save into, and every keystroke after it would fail the same way.
        //
        // Said in plain words with a way out, instead of showing the engine's own "Column not
        // found" over a footer that goes on claiming "Saving…" for as long as the drawer is open.
        if (/not found/i.test(String(res.error))) setGone(true);
        else setPromptError(res.error);
        return;
      }
      setPromptError(null);
      /**
       * What the SERVER stored, not what we sent.
       *
       * The two are routinely different and the difference is a feature: type `/Company` as plain
       * text and the server canonicalizes it into a real reference before storing. Recording `next`
       * meant the field said "Saved." for a version the database did not hold, and the cost estimate
       * beside it was calculated on the wrong text — right again only after a reload.
       *
       * Falls back to `next` if the response does not carry the column, so an older engine behaves
       * exactly as before rather than showing a permanent "Saving…".
       */
      const stored = typeof res.column?.prompt === "string" ? res.column.prompt : next;
      // Re-seeding the visible field is what makes the chip appear in place of the text that was
      // typed — but only when nobody is typing in it. RefField adopts an outside change by
      // repainting its whole content, and a repaint mid-edit destroys the caret.
      //
      // The common case is that somebody IS typing: this autosaves a moment after the keys stop, so
      // the correction almost always arrives while the caret is still in the field. Held until they
      // leave rather than dropped — dropping it is what left the field showing text the database
      // does not hold until the next reload.
      if (stored !== next) {
        if (promptFieldRef.current?.contains(document.activeElement)) {
          promptCanonical.current = { sent: next, stored };
        } else {
          setPrompt(stored);
          promptLatest.current = stored;
        }
      }
      // Only if nothing has been typed since this save left. Otherwise a newer save is already on
      // its way and the field is genuinely still unsaved.
      if (promptLatest.current === next || promptLatest.current === stored) setPromptDirty(false);
      onSaved();
    } catch {
      setPromptError("Could not reach the engine to save the instruction.");
    } finally {
      setBusy(false);
    }
  }, [column.id, onSaved]);

  // Settles shortly after typing stops rather than on blur alone. Someone who writes an instruction
  // and goes straight to Run has never blurred anything, and that is the worst moment to lose it.
  const promptSave = useAutosave<string>(useCallback((v: string) => void savePrompt(v), [savePrompt]));

  /**
   * Pull everything back from the column after an AI setup writes it.
   *
   * One apply can change the mode, the type, the instruction and the whole request at once, so
   * every piece of local state in this drawer has to be re-seeded from what was actually saved —
   * not from what was proposed. Anything less leaves a screen showing the values from before the
   * change it just made.
   */
  const reloadFromColumn = useCallback(async () => {
    try {
      const res = await fetch(`/api/columns/${column.id}`).then((r) => r.json());
      const c = res.column;
      if (!c) return;
      setKind(c.kind);
      setValueType(c.valueType);
      setEnumValues(c.enumValues ?? []);
      setFormat(c.format ?? {});
      setModel(c.model ?? "auto");
      setPrompt(c.prompt ?? "");
      promptLatest.current = c.prompt ?? "";
      setPromptDirty(false);
      setAutoRun(!!c.autoRun);
      setHttp({ ...DEFAULT_HTTP, ...((c.httpConfig ?? {}) as Partial<HttpConfig>) });
      setMcp({ ...DEFAULT_MCP, ...(((c as any).mcpConfig ?? {}) as Partial<McpConfig>) });
      if (c.agent?.search) setSearch({ ...DEFAULT_SEARCH, ...c.agent.search });
      // The generated code, if the setup wrote one — saved unapproved, so the Rule tab has to show
      // it for review rather than the user discovering it on the next run.
      const scripts = await fetch(`/api/columns/${column.id}/scripts`).then((r) => r.json());
      const current = (scripts.scripts ?? []).find((s: any) => s.hook === "transform");
      if (current) { setSaved(current); setCode(current.code ?? ""); setIntent(current.intent ?? ""); }
    } catch { /* the drawer still works; it is showing what it last read */ }
    onSaved();
  }, [column.id, onSaved]);

  const saveSend = async (next: SendConfig) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ send: next }),
      }).then((r) => r.json());
      // The server refuses a destination that no longer exists, and a table sending into itself.
      // Its answer arrives as an error rather than by silently rewriting what was picked.
      if (res.error) { setSendError(res.error); return; }
      setSendError(null);
      onSaved();
    } catch {
      setSendError("Could not reach the engine to save the destination.");
    } finally {
      setBusy(false);
    }
  };

  const saveMcp = async (next: McpConfig) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcp: next }),
      }).then((r) => r.json());
      if (res.error) { setMcpError(res.error); return; }
      setMcpError(null);
      // Not echoed back, for the reason saveHttp gives below: the server drops an argument whose
      // name is still blank, which is what a row is one keystroke after you add it.
      onSaved();
    } catch {
      setMcpError("Could not reach the engine to save this call.");
    } finally {
      setBusy(false);
    }
  };

  const saveHttp = async (next: HttpConfig) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ http: next }),
      }).then((r) => r.json());
      // The server normalizes and can refuse — an interpolated host with private addresses allowed,
      // a malformed header name. Its answer replaces what was typed so the two cannot drift apart.
      if (res.error) { setHttpError(res.error); return; }
      setHttpError(null);
      // The server's normalized answer is NOT echoed back into the form. It drops a parameter or
      // header whose name is still blank, and a blank name is what a row has one keystroke after you
      // add it — so echoing it wiped every new row on sight and Add header did nothing at all. The
      // form keeps what was typed; the server's opinion arrives as an error when it has one.
      onSaved();
    } catch {
      setHttpError("Could not reach the engine to save the request.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Save the steps.
   *
   * The server's normalized answer IS taken back here, unlike the HTTP form above, and the difference
   * is deliberate: a half-typed header is a normal intermediate state, but a step the reader would
   * drop is not — the server refuses it outright rather than normalizing it, so there is nothing to
   * wipe and everything to gain from the two ends agreeing on the exact saved shape.
   */
  const [ruleError, setRuleError] = useState<string | null>(null);

  /** Rules save on every change, like the type above them — there is no Save button on this tab. */
  const saveRules = async (next: RuleSet | null) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // `null` CLEARS. An absent key means "leave them alone", and the two must not be confused —
        // removing the last rule has to actually remove it.
        body: JSON.stringify({ validation: next }),
      }).then((r) => r.json());
      if (res.error) { setRuleError(res.error); return; }
      setRuleError(null);
      onSaved();
    } catch {
      setRuleError("Could not reach the engine to save the rules.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Save the enum options, and adopt the list the SERVER stored rather than the one sent.
   *
   * The server cleans the list — trims, drops blanks, removes case-insensitive duplicates keeping
   * the first spelling. Keeping what we sent would leave the editor showing options the database does
   * not hold (a trailing blank, a duplicate) until a reload, exactly the "Saved but not really"
   * problem the prompt field had. The editor re-seeds from `enumValues` only when no row is focused,
   * so adopting the cleaned list cannot jump a caret mid-word.
   */
  const saveEnumValues = async (next: string[]) => {
    setEnumValues(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enumValues: next }),
      }).then((r) => r.json());
      if (res.error) { setEnumError(res.error); return; }
      setEnumError(null);
      if (Array.isArray(res.column?.enumValues)) setEnumValues(res.column.enumValues);
      else if (res.column) setEnumValues([]);
      onSaved();
    } catch {
      setEnumError("Could not reach the engine to save the options.");
    } finally {
      setBusy(false);
    }
  };

  /** Save the currency/percent display descriptor, adopting the server's cleaned version. */
  const saveFormat = async (next: { currency?: string; decimals?: number }) => {
    setFormat(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: next }),
      }).then((r) => r.json());
      if (res.error) return;
      if (res.column) setFormat(res.column.format ?? {});
      onSaved();
    } catch {
      /* the descriptor stays on screen for this session rather than snapping back */
    } finally {
      setBusy(false);
    }
  };

  const saveWaterfall = async (next: Waterfall) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waterfall: next }),
      }).then((r) => r.json());
      if (res.error) { setWaterfallError(res.error); return; }
      setWaterfallError(null);
      onSaved();
    } catch {
      setWaterfallError("Could not reach the engine to save the steps.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Change the lane. Optimistic, and reverted on failure rather than left showing a mode the server
   * refused — a column that displays "web search" while the engine still has it on "reads the row"
   * is the exact confusion this tab exists to remove.
   */
  const pickMode = async (next: Column["kind"], preset?: { fireAndForget: boolean }) => {
    const previous = kind;
    setKind(next);
    setBusy(true);
    try {
      await api.setColumnKind(column.id, next);
      // "Call an API" and "Send it somewhere" are the same lane with one setting different, so the
      // card also writes that setting. Without this, picking "Send it somewhere" would land on a
      // column still configured to keep the reply — and the card would then read as the other one.
      if (preset) {
        const merged = { ...http, ...preset };
        setHttp(merged);
        await saveHttp(merged);
      }
      // A model that cannot call tools cannot drive a web-searching column — every row of a paid run
      // fails on it, and the picker has to leave it out of its list, which is how a column ended up
      // showing "Engine default" while storing something else. Moving into this lane drops back to
      // the engine default rather than carrying an unusable choice across.
      //
      // Only once the catalogue has actually answered: if it has not, nothing is known about the
      // stored model, and the run confirmation already refuses a model it cannot price.
      if (next === "agent" && model !== "auto" && !catalog.loading && !catalog.error && catalog.models.length > 0) {
        if (!catalog.models.some((m) => m.id === model && m.tools)) await pickModel("auto");
      }
      // Deliberately STAYS on the Mode tab.
      //
      // Jumping straight to the screen the new mode needs sounds helpful and is not: the card's
      // explanation — what the mode does, what it costs, what it cannot do — only appears once the
      // card is selected, so jumping away makes the guide text flash and vanish before it can be
      // read. The one thing you clicked to learn about was the one thing you were not
      // allowed to see. The next step is now an explicit button under the list, so reading first and
      // moving on second are two separate decisions.
      setKindError(null);
      onSaved();
    } catch (e) {
      setKind(previous);
      setKindError(e instanceof Error ? e.message : "Could not save the mode.");
    } finally {
      setBusy(false);
    }
  };

  const saveSearch = async (next: WebSearchSettings) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: { search: next } }),
      }).then((r) => r.json());
      // The server validates and normalizes — a pasted URL comes back as a bare domain — so its
      // answer replaces what was typed rather than the two drifting apart.
      if (res.error) { setSearchError(res.error); return; }
      setSearchError(null);
      const saved = (res.column?.agent as any)?.search;
      if (saved) setSearch({ ...DEFAULT_SEARCH, ...saved });
      onSaved();
    } catch {
      setSearchError("Could not reach the engine to save these settings.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Is there work here that closing would throw away?
   *
   * This is what separates "click outside to dismiss" from "click outside to lose the rule you just
   * wrote". Typed-but-unsaved code counts; code that matches the saved version does not, and neither
   * does an empty editor you opened and never touched.
   *
   * The data type is deliberately NOT part of this — it persists the moment you pick it, so there is
   * nothing to lose. Including it would also have pinned the drawer permanently dirty, because the
   * `column` prop is a snapshot taken when the drawer opened and never sees the update.
   */
  const dirty =
    loaded &&
    (code.trim() !== (saved?.code ?? "").trim() ||
      (intent.trim() !== "" && !saved));

  /**
   * Whether this lane has a rule at all.
   *
   * The footer is the rule's workflow — write it, save it, approve it, try it — and it used to be
   * rendered whatever the column was. On an AI column there is no rule, so Save had nothing to save
   * and Try had nothing approved to try: both were permanently disabled, neither said why, and the
   * prompt beside them was already autosaving.
   */
  const hasRule = tabsFor(kind).includes("rule");

  /** Renaming the column from its own heading — the one title in the app that could not be. */
  const renameTitle = useCallback(async (next: string) => {
    const name = next.trim();
    if (!name || name === column.name) return;
    try {
      await api.renameColumn(String(column.id), name);
      onSaved();
    } catch (e) {
      setErrors([e instanceof Error ? e.message : "Could not rename this column."]);
    }
  }, [column.id, column.name, onSaved]);
  /** The one autosaved field the footer can see the state of. */
  const settingsSaving = promptDirty && !promptError;

  // A drawer that cannot be dismissed the way every other drawer can is the defect; a drawer that
  // discards a script on a stray click is a worse one. So: dismiss freely when clean, ask when not.
  const requestClose = useCallback(() => {
    // Already on its way out: a click landing during the exit must not re-open the discard prompt.
    if (exitTimer.current != null) return;
    if (dirty) { setConfirmDiscard(true); return; }
    dismiss();
  }, [dirty, dismiss]);

  // Keep the parent informed whether there is work to lose, and lend it this drawer's guarded close,
  // so opening a sibling panel over this one goes through the discard prompt instead of unmounting
  // the drawer and dropping an unsaved rule without a word.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    bindRequestClose?.(requestClose);
    return () => bindRequestClose?.(null);
  }, [bindRequestClose, requestClose]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el || el.contains(e.target as Node)) return;
      // Anything portalled — the reference menu, a popover, a confirm dialog — is visually inside
      // this drawer but is NOT a DOM descendant of it. Treating those clicks as "outside" would
      // close the drawer the moment you picked a column reference from its own menu.
      if ((e.target as HTMLElement).closest?.(".cc-pop, .cc-modal-scrim")) return;
      requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      // The reference menu owns Escape while it is open, and stops propagation itself.
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [requestClose]);

  /**
   * The two clock settings — the speed limit and the wait.
   *
   * Optimistic like everything else here, and reverted from the server's answer rather than trusted:
   * both are clamped server-side, so typing 99999 seconds must come back as 3600 on screen instead of
   * leaving a number the engine will never honour sitting in the field.
   */
  const savePace = async (patch: { rateLimitPerMin?: number; waitSeconds?: number }) => {
    const previousRate = rateLimit;
    const previousWait = waitSecs;
    if (patch.rateLimitPerMin !== undefined) setRateLimit(patch.rateLimitPerMin);
    if (patch.waitSeconds !== undefined) setWaitSecs(patch.waitSeconds);
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => r.json());
      if (res.error) { setRateLimit(previousRate); setWaitSecs(previousWait); setKindError(res.error); return; }
      if (res.column) {
        setRateLimit(Number(res.column.rateLimitPerMin ?? 0));
        setWaitSecs(Number(res.column.waitSeconds ?? 0));
      }
      setKindError(null);
      onSaved();
    } catch {
      setRateLimit(previousRate);
      setWaitSecs(previousWait);
      setKindError("Could not save that.");
    } finally {
      setBusy(false);
    }
  };

  /** Fan-out config. Optimistic with revert, like every settings control in this drawer. */
  const saveFanout = async (next: FanoutValue) => {
    const previous = fanout;
    setFanout(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fanOut: next.on ? "per_item" : null,
          fanOutSource: next.on ? next.sourceId : null,
          fanOutCap: next.on ? next.cap : null,
        }),
      }).then((r) => r.json());
      if (res.error) { setFanout(previous); setErrors([String(res.error)]); return; }
      onSaved();
    } catch {
      setFanout(previous);
      setErrors(["Could not reach the engine to save the fan-out setting."]);
    } finally {
      setBusy(false);
    }
  };

  /** Same optimistic-with-revert shape as the mode: the picker must never show a model the engine refused. */
  const pickModel = async (next: string) => {
    const previous = model;
    setModel(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: next }),
      }).then((r) => r.json());
      if (res.error) { setModel(previous); setKindError(res.error); return; }
      setKindError(null);
      onSaved();
    } catch {
      setModel(previous);
      setKindError("Could not save the model.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the agent the web_search tool, or take it away.
   *
   * `fetch_url` is kept either way. It is what lets a column read a page the row already names, it
   * costs nothing beyond the tokens, and dropping it alongside search would quietly break the columns
   * that were relying on the old `["fetch_url"]` fallback.
   */
  const toggleWebSearch = async (on: boolean) => {
    const previous = webSearch;
    setWebSearch(on);
    setBusy(true);
    try {
      // Whatever connected-app tools this column has been granted are kept. The list is written as
      // one array, so sending the built-ins alone would revoke every app tool as a side effect of
      // ticking a box about the web.
      const apps = (column.allowedTools ?? []).filter((t) => t.startsWith("mcp:"));
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowedTools: [...(on ? ["fetch_url", "web_search"] : ["fetch_url"]), ...apps],
        }),
      }).then((r) => r.json());
      if (res.error) { setWebSearch(previous); setSearchError(res.error); return; }
      setSearchError(null);
      onSaved();
    } catch {
      setWebSearch(previous);
      setSearchError("Could not save that.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * The cheap model tried before the one above, or "" to turn that off.
   *
   * The server does the refusing — the same model in both slots, an unknown id, "auto" — because it
   * is the only side that can see the catalogue, and a client that decided for itself would answer
   * differently from the thing that actually runs.
   */
  /**
   * Save the per-cell ceiling.
   *
   * On blur rather than on every keystroke: typing "0.25" passes through "0", "0.2" — and "0" means
   * no ceiling, so a per-keystroke save would briefly uncap the column and, if the user stopped
   * there, leave it uncapped.
   */
  const saveCellCap = async () => {
    const raw = cellCap.trim();
    // An empty box is not an instruction. Put the stored value back rather than guessing at one.
    if (!raw) { setCellCap(column.maxBudgetUsd == null ? "0.05" : String(column.maxBudgetUsd)); return; }
    const usd = Number(raw);
    if (!Number.isFinite(usd) || usd < 0) { setKindError("The limit for one cell has to be a number, zero or more."); return; }
    if (usd === column.maxBudgetUsd) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxBudgetUsd: usd }),
      }).then((r) => r.json());
      if (res.error) { setKindError(res.error); return; }
      setKindError(null);
      onSaved();
    } catch {
      setKindError("Could not save the limit for one cell.");
    } finally {
      setBusy(false);
    }
  };

  const pickFirstModel = async (next: string) => {
    const previous = firstModel;
    setFirstModel(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstModel: next }),
      }).then((r) => r.json());
      if (res.error) { setFirstModel(previous); setKindError(res.error); return; }
      setKindError(null);
      onSaved();
    } catch {
      setFirstModel(previous);
      setKindError("Could not save the first model.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Load the column's existing rule.
   *
   * Without this the drawer opened EMPTY on a column that already had a saved, approved script —
   * the code box blank, the status pill reading "Not saved", and Try disabled until you re-typed and
   * re-saved something you had already written. Worse, hitting Save on that blank editor would have
   * been a silent regression of a working column.
   *
   * `hook: transform` only, matching what Save writes. Conditions live on the same column under a
   * different hook and belong to a screen that does not exist yet — loading one into the transform
   * editor would show the wrong code and then overwrite the right one.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/columns/${column.id}/scripts`).then((r) => r.json());
        if (cancelled) return;
        // Ordered by version DESC, so the first transform is the current one.
        const current = (res.scripts ?? []).find((s: any) => s.hook === "transform");
        if (!current) { setLoaded(true); return; }
        setSaved(current);
        setCode(current.code ?? "");
        setIntent(current.intent ?? "");
        if (current.runtime) setRuntime(current.runtime);
      } catch {
        // The editor still works — you can write a new rule. It just could not show the old one, and
        // saying so is better than presenting a blank box as though there were nothing here.
        if (!cancelled) setErrors(["Could not load this column's saved rule. Saving will replace it."]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [column.id]);

  // The tab list depends on the mode, so a mode change can delete the tab you are standing on — an
  // AI setup that switches a script column to an API call is exactly that. Without this the body
  // renders nothing at all and the drawer looks broken.
  useEffect(() => {
    const allowed = tabsFor(kind);
    if (!allowed.includes(tab)) setTab(allowed[1] ?? "mode");
  }, [kind, tab]);

  // Real sample values for the reference menu — fetched once per column set.
  useEffect(() => {
    void (async () => {
      try {
        const win = await api.readRows(sheetId, 0, 5);
        const first = win.rows.find((r) => Object.values(r.cells).some((c: any) => c.v));
        if (first) {
          const out: Record<string, string | null> = {};
          for (const [colId, cell] of Object.entries(first.cells)) out[colId] = (cell as any).v ?? null;
          setSamples(out);
        }
      } catch { /* the menu still works without samples, it is just less useful */ }
    })();
  }, [sheetId]);

  /**
   * The columns that cannot be referenced from here because they already read this one.
   *
   * RefMenu has been able to disable an option and name the loop since it was written — `cyclePath`
   * is in its props and its header comment promises it — and nothing ever computed one. So the menu
   * offered every column including the ones that close a loop, and the user found out afterwards
   * from a server error on a script, or never at all on a prompt, where nothing re-derives the
   * dependency edges.
   */
  const cyclePaths = useMemo(() => cyclePathsFrom(String(column.id), columns), [column.id, columns]);

  const refOptions: RefOption[] = useMemo(() => {
    const others: RefOption[] = columns
      .filter((c) => c.id !== column.id)
      .map((c) => ({
        column: c,
        sample: samples[c.id] ? String(samples[c.id]).slice(0, 40) : null,
        cyclePath: cyclePaths.get(String(c.id)),
      }));
    // The column being edited is listed but disabled — hiding it would make the user think it
    // vanished, rather than understanding why it cannot be referenced.
    return [...others, { column, sample: null, isSelf: true }];
  }, [columns, column, samples, cyclePaths]);

  /**
   * Everything wrong with the references this column's own text carries.
   *
   * Checked HERE, before a save, rather than reported after one. The script route does reject an
   * unresolvable reference and a cycle — but only for a script, and only once it has written the
   * row and rolled it back. The INSTRUCTION goes through a PATCH that validates nothing at all, so
   * a prompt holding a reference to a deleted column ran, per row, against a literal. `src/refs.ts`
   * states the cost of that plainly: it looks fine on row 1 and quietly poisons all 1,000,000.
   */
  const refProblems = useMemo(() => {
    // Only the text this column's MODE actually uses. A column switched off a model lane keeps its
    // old prompt in the database, and complaining about a reference in a box that is no longer on
    // screen would block a save with no way to unblock it.
    const sources: Array<readonly [string, string]> =
      kind === "ai" || kind === "agent" ? [["instruction", prompt]]
      : kind === "http" ? [["request", JSON.stringify(http)]]
      : kind === "send" ? []
      : [["rule", intent]];

    const out: string[] = [];
    for (const [where, text] of sources) {
      for (const b of brokenRefs(text, columns)) {
        out.push(
          `The ${where} refers to ${b.label}, which is not a column on this table` +
          (b.suggestion ? `. Did you mean /${b.suggestion}?` : ". Type / to pick a column, or delete it."),
        );
      }
      for (const r of findRefs(text, columns)) {
        const path = r.columnId ? cyclePaths.get(r.columnId) : undefined;
        if (path) out.push(`The ${where} refers to /${r.name}, which already reads this column: ${path}.`);
      }
    }
    return [...new Set(out)];
  }, [kind, intent, prompt, http, columns, cyclePaths]);

  /** What the rule reads as, with every reference resolved to today's column name. */
  const readable = useMemo(() => toDisplay(intent, columns), [intent, columns]);

  /**
   * What the mode cards are priced against.
   *
   * The model this column will actually run on, resolved through the same catalogue the picker
   * shows and the same "auto means the engine default" rule the server's estimate uses. Until the
   * list answers there is no rate, and the cards say "—" rather than borrowing one.
   */
  const basis = useMemo(() => {
    const m = resolveModel(catalog, model);
    return basisFor(
      search.maxResults,
      m ? { label: m.name, inputPerM: m.inputPerM, outputPerM: m.outputPerM, local: m.local } : null,
    );
  }, [catalog, model, search.maxResults]);

  const save = async () => {
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch(`/api/columns/${column.id}/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook: "transform", runtime, intent, code }),
      }).then((r) => r.json());
      // `errors` is the compiler's list; `error` is the route refusing outright — a 404 for a column
      // that has gone answers with the second and no first, so reading only the list took the
      // "nothing wrong, it saved" branch on a save that never happened, kept `res.script` (undefined)
      // and dropped the footer to "unsaved" with nothing said.
      if (res.error) {
        if (/not found/i.test(String(res.error))) setGone(true);
        else setErrors([String(res.error)]);
        return;
      }
      setErrors(res.errors ?? []);
      if ((res.errors ?? []).length === 0) {
        setSaved(res.script);
        setDryRun(null);
        onSaved();
      }
    } catch {
      setErrors(["Could not reach the engine to save this rule."]);
    } finally {
      setBusy(false);
    }
  };

  /**
   * The type picker writes immediately rather than waiting for Save.
   *
   * Save on this drawer means "save the script", and the type is not part of a script — leaving the
   * picker to piggyback on it made a control that visibly changed state and persisted nothing. It is
   * optimistic so the selection cannot lag behind the click, and reverts on failure rather than
   * leaving the UI showing a type the server rejected.
   */
  const setType = async (t: typeof valueType) => {
    const previous = valueType;
    setValueType(t);
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valueType: t }),
      }).then((r) => r.json());
      if (res.error) { setValueType(previous); setErrors([res.error]); return; }
      setErrors([]);
      onSaved();
    } catch {
      setValueType(previous);
      setErrors(["Could not reach the engine to save the data type."]);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!saved) return;
    setBusy(true);
    try {
      // The hash we reviewed is sent back. If the stored bytes changed since this panel rendered
      // them, the server refuses — you cannot approve code you did not read.
      const res = await fetch(`/api/scripts/${saved.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: saved.hash }),
      }).then((r) => r.json());
      if (res.error) setErrors([res.error]);
      else setSaved(res.script);
    } catch {
      setErrors(["Could not reach the engine to approve this rule."]);
    } finally {
      setBusy(false);
    }
  };

  const runDry = async () => {
    if (!saved) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/scripts/${saved.id}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: tryRows }),
      }).then((r) => r.json());
      if (res.error) setErrors([res.error]);
      else { setDryRun(res); onSaved(); }
    } catch {
      setErrors(["Could not reach the engine to try this rule."]);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Run this column on the first few rows, for real, and let them fill in the grid.
   *
   * The point is to see the ACTUAL output — the email, the extracted value — on real rows, and to
   * iterate: tweak the instruction, try again, watch it change. So unlike the rule dry-run this
   * spends and writes, and unlike the run dialog's sample it is about the answer, not the cost. It
   * reuses the ordinary run pipeline scoped to rows 1..N, so the cells stream into the grid live.
   */
  const runTry = async () => {
    setTrying(true);
    setTryNote(null);
    try {
      // The newest instruction is what gets tried. Blur has usually flushed it already, but a click
      // straight from the field can beat the save — so the latest is persisted here before the run,
      // or the try would quietly run the previous prompt and the edit would look like it did nothing.
      if (kind === "ai" || kind === "agent") await savePrompt(promptLatest.current);
      const res = await fetch(`/api/sheets/${sheetId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: { columnIds: [Number(column.id)], fromRow: 1, toRow: tryRows } }),
      }).then((r) => r.json());
      if (res.error) { setTryNote(res.error); return; }
      setTryNote(`Running the first ${tryRows} ${tryRows === 1 ? "row" : "rows"} — they fill in the grid as they finish.`);
      onSaved();
    } catch {
      setTryNote("Could not reach the engine to try this column.");
    } finally {
      setTrying(false);
    }
  };

  return (
    <aside
      className={`cc-drawer${leaving ? " cc-drawer--leaving" : ""}`}
      role="dialog"
      aria-label={`Edit column ${column.name}`}
      ref={rootRef}
    >
      <header className="cc-drawer__head">
        {/* The same mark the grid header and the mode picker use for this kind.
            This panel is where you land after clicking a column's header, so arriving without the
            mark you just clicked on breaks the thread — and it is the one place with room to say
            what the mark means, at the moment someone is looking at exactly that column. */}
        {(() => {
          const b = columnBadge(column, sourceNameOf(column, columns));
          return <ColumnKindIcon kind={b.kind} title={b.title} />;
        })()}
        {/* Renamable here, like every other name in the app.
            The sheet name two inches away renames on double-click and so does the workbook, and this
            one — attached to the thing you are currently editing — was the only title that did not.
            Renaming is safe by construction: prompts and rules store column ids, never names. */}
        {renamingTitle ? (
          <input
            className="cc-drawer__titleinput"
            defaultValue={column.name}
            autoFocus
            aria-label={`Rename ${column.name}`}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => { setRenamingTitle(false); void renameTitle(e.target.value); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
              if (e.key === "Escape") { e.preventDefault(); setRenamingTitle(false); }
            }}
          />
        ) : (
          <h2
            className="cc-drawer__title truncate"
            title={`${column.name} — double-click to rename`}
            onDoubleClick={() => setRenamingTitle(true)}
          >
            {column.name}
          </h2>
        )}
        {/*
          The pill describes the RULE, so it only belongs on a lane that has one.

          On an AI column it read "Not saved" forever — there was no rule to save — directly above a
          prompt that was saving itself. Two statements about the same column, in view at once,
          saying opposite things.
        */}
        {hasRule && (
          <span className={`cc-pill ${!loaded ? "cc-pill--idle" : saved?.approvedAt ? "cc-pill--done" : saved ? "cc-pill--queued" : "cc-pill--idle"}`}>
            {!loaded ? "Loading…" : saved?.approvedAt ? "Approved" : saved ? "Needs review" : "Not saved"}
          </span>
        )}
        <button className="hk-icon-btn" onClick={requestClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>

      <nav className="cc-tabs" role="tablist">
        {tabsFor(kind).map((t) => {
          // Every tab OPENS. Disabling the Search tab on a non-agent column with only a tooltip to
          // explain why means clicking it does nothing, which reads as the app being broken rather
          // than as a deliberate state. A control you can see and cannot use is a dead end, so the
          // tab opens and says what to do, with the button to do it.
          const inactive = t === "search" && kind !== "agent";
          return (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              title={inactive ? "These apply once this column is set to search the web." : undefined}
              className={`cc-tab${tab === t ? " cc-tab--on" : ""}${inactive ? " cc-tab--inactive" : ""}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
              {/* A dot, not a word: a label that changes length would shift every tab beside it.
                  Without it, "does this column have a condition?" could only be answered by opening
                  the tab — and a gate that decides what you spend should be visible from outside. */}
              {t === "when" && column.conditionScriptId && (
                <span className="cc-tab__dot" aria-label="has a condition" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="cc-drawer__body">
        {/* Shown on every tab, because it disables the footer on every tab. A reference that
            resolves to nothing does not fail — it runs, per row, against a literal — so this is a
            refusal rather than a note, and it names the column it probably meant. */}
        {refProblems.length > 0 && (
          <div className="cc-errors" role="alert">
            {refProblems.map((p) => <div key={p} className="cc-errors__row">{p}</div>)}
          </div>
        )}

        {/* On every configuration screen, not just one. The thing a person knows is what they want
            the column to contain — which screen that maps to is the app's problem, not theirs, and a
            "describe it" box that exists on one tab is a box nobody finds. */}
        {/* Not on Destination: the setup model configures modes, prompts, rules and requests — it
            EVERY configuration screen has it, Destination, Linked table and Steps included. Leaving
            those three out would mean the three hardest lanes to configure by hand were the three
            with no help, and the user filling in a form about relations, cardinality and match modes
            unaided. History is the only tab
            without one, because there is nothing on it to configure. */}
        {/* Not on "rule": that screen's OWN field is a describe-it box (below), and rendering this
            above it put two boxes asking for the same sentence on the same screen — you typed the
            rule in English at the top, and the field that stores the rule in English sat underneath
            it, empty, asking again. "History" is the other exclusion, because there is nothing on it
            to configure. */}
        {/* Not on the Tool tab. Configuring an MCP column means naming a registered app, one of its
            tools and that tool's arguments, and the assistant is shown none of the three — see
            EXCLUDED_KINDS in src/setup/aiSetup.ts. Offering the button anyway would promise help it
            cannot give. */}
        {tab !== "runs" && tab !== "rule" && tab !== "tool" && (
          <AiSetup
            columnId={column.id}
            // "When to run" is the run CONDITION — a rule about which rows, not about the value —
            // so it maps to its own area rather than to a tab name the server has never heard of.
            area={tab === "when" ? "condition" : tab}
            // A button, not a strip. It is on every one of these screens by design, and a bordered
            // section on every one of them is nine copies of the same chrome above the fields
            // somebody actually came to fill in.
            asButton
            showDocsUrl={tab === "request"}
            // `/` works here too. It is the box most likely to need a column reference — "use
            // /Website to look up the industry" — and it was the one box in the drawer where
            // typing a slash did nothing at all.
            columns={columns}
            refOptions={refOptions}
            placeholder={
              // No "rule" case: that tab renders its own AiSetup as the screen's field, with its own
              // placeholder. The typechecker flagged this branch as unreachable the moment the two
              // were merged, which is the check working.
              tab === "request"
                ? "Look up this company in Clearbit using their website and give me the industry"
                // These two must not read as the field BESIDE them. A placeholder repeating the
                // example in its own instruction box word for word shows two boxes asking the same
                // thing while only one of them runs on your rows. A
                // placeholder is the main thing anyone reads before typing; it has to say which job
                // this box does. Both now describe SETTING THE COLUMN UP, not the per-row question.
                : tab === "prompt"
                ? "Set this up to flag decision-makers from the job title, on the cheapest model that can do it"
                : tab === "search"
                ? "This column needs to read the company's pricing page, so turn on web search and keep it to a few results"
                : tab === "output"
                ? "This column should hold a price in dollars"
                : tab === "destination"
                ? "Send qualified leads into the CRM table, matching on email so re-running updates them"
                : tab === "link"
                ? "Get the industry from the Companies table, matching on domain"
                : tab === "steps"
                ? "Find a work email — try a free guess first, then a paid provider, and only accept a real address"
                : tab === "when"
                ? "Only run this on rows where the company has more than 50 staff"
                : "Fill this column with the company's industry, using whatever is cheapest"
            }
            onApplied={() => void reloadFromColumn()}
          />
        )}

        {tab === "mode" && (
          <ModePicker
            column={{ ...column, kind }}
            // Live, not the snapshot on `column`: picking "Send it somewhere" has to light up that
            // card and not the one beside it.
            fireAndForget={http.fireAndForget}
            rowCount={rowCount}
            basis={basis}
            onPick={(m, preset) => void pickMode(m, preset)}
            model={model}
            onModelChange={(id) => void pickModel(id)}
            busy={busy}
            error={kindError}
            onOpenCondition={() => setTab("when")}
            onContinue={
              kind === "rollup" ? { label: "Pick what to calculate", go: () => setTab("link") }
              : kind === "lookup" ? { label: "Pick the table to read from", go: () => setTab("link") }
              : kind === "send" ? { label: "Pick the destination", go: () => setTab("destination") }
              : kind === "http" ? { label: "Write the request", go: () => setTab("request") }
              : kind === "ai" || kind === "agent" ? { label: "Write the instruction", go: () => setTab("prompt") }
              : kind === "script" ? { label: "Write the rule", go: () => setTab("rule") }
              : undefined
            }
          />
        )}

        {/* The clock settings, directly under the mode card that needs them. A wait column's whole
            configuration is its duration, so on that lane this is not a setting — it IS the screen. */}
        {tab === "mode" && (
          <PaceSettings
            rateLimitPerMin={rateLimit}
            waitSeconds={waitSecs}
            // Only the lanes that call something outside can be told off for going too fast. Offering
            // a speed limit on a script or a lookup would be offering to slow down free local work.
            showRate={kind === "ai" || kind === "agent" || kind === "http" || kind === "mcp" || kind === "waterfall" || kind === "send"}
            showWait={kind === "wait"}
            rowCount={rowCount}
            atATime={DEFAULT_AT_A_TIME}
            busy={busy}
            onSave={savePace}
          />
        )}

        {/* Only on the lanes that bill per row, and on the Mode tab — which is where someone is
            already looking at what this column costs, and therefore the moment the question "does it
            have to?" is worth asking. Offering it on a script or lookup column would be offering to
            replace free with free. */}
        {tab === "mode" && (kind === "ai" || kind === "agent") && (
          <PromoteRule
            columnId={column.id}
            columnName={column.name}
            onAccepted={(message) => { setPromoted(message); setTab("rule"); void reloadFromColumn(); }}
          />
        )}

        {tab === "rule" && (
          <>
            {/* Carried across from the promotion, because arriving on this screen with a rule you did
                not type and no explanation of where it came from is the confusing half of the
                feature. It also states the thing that is easy to assume wrongly: the column has NOT
                switched over yet. */}
            {promoted && (
              <p className="cc-promote__carried" role="status">
                {promoted}
                <button className="cc-linkish" onClick={() => setPromoted(null)}>Dismiss</button>
              </p>
            )}
            {/* ONE box, not two.
            
                This is the field that stores what the rule does in English, and it is also the box
                you describe the rule INTO to have it written — the same sentence serving both, which
                is why `AiSetup` has a non-collapsible controlled mode. A plain textarea with the
                generic describe-it panel stacked above it opens the screen with two identical-looking
                boxes and no way to tell which one does anything. */}
            <AiSetup
              columnId={column.id}
              area="rule"
              collapsible={false}
              title="What should this column do?"
              sub="Describe it in plain English. Saved with the rule, and used to write one."
              value={intent}
              onValueChange={setIntent}
              columns={columns}
              refOptions={refOptions}
              placeholder="Extract the root domain from /Website, lowercase it, strip www"
              onApplied={() => void reloadFromColumn()}
            />

            {intent !== readable && (
              <div className="cc-preview">
                <div className="cc-preview__label">Reads as</div>
                <code className="cc-preview__code">{readable}</code>
              </div>
            )}

            <div className="cc-field">
              {/* "Runtime" is a word from the implementation, not from the job. What this actually
                  picks is which language the rule is written in — and, because of what each one can
                  reach, how safe and how fast it is. */}
              <span className="cc-field__label">
                Written in
                <span className="cc-field__sub">what the rule is written in, and what it is allowed to touch</span>
              </span>
              <div className="cc-seg">
                {(["js", "powershell", "bash"] as const).map((r) => (
                  <button
                    key={r}
                    className={`cc-seg__btn${runtime === r ? " cc-seg__btn--on" : ""}`}
                    onClick={() => setRuntime(r)}
                  >
                    {r === "js" ? "JavaScript" : r === "powershell" ? "PowerShell" : "Bash"}
                  </button>
                ))}
              </div>
              <span className="cc-field__hint">
                {runtime === "js"
                  ? "The safe default. Runs boxed in — no files, no network, nothing but the row it was handed. Fast enough for millions of rows."
                  : "Use only when the rule genuinely needs something installed on this machine. It runs once over the whole column rather than once per row, and your row values are handed to it as data, never pasted into a command."}
              </span>
            </div>

            <label className="cc-field">
              <span className="cc-field__label">
                Code
                <span className="cc-field__sub">reviewed before it can run</span>
              </span>
              <textarea
                className="cc-code"
                rows={12}
                spellCheck={false}
                placeholder={
                  runtime === "js"
                    ? "function transform(row) {\n  return row.website;\n}"
                    : "$input | ForEach-Object { ... }"
                }
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>

            {errors.length > 0 && (
              <div className="cc-errors" role="alert">
                {errors.map((e, i) => <div key={i} className="cc-errors__row">{e}</div>)}
              </div>
            )}

            {dryRun && (
              <div className="cc-result">
                Dry run: {dryRun.processed} rows in {dryRun.ms}ms
                {dryRun.errors > 0 ? `, ${dryRun.errors} errored` : ", no errors"}. Check the grid.
              </div>
            )}
          </>
        )}

        {tab === "prompt" && (
          <>
            {/*
              A DIV, and it has to be.

              This was a `<label>`, and a `<label>` with no `for` forwards every click inside it to
              its first LABELABLE descendant — and `<button>` is labelable. Once the prompt held a
              reference chip, the first button in here was that chip's required/optional switch. So
              clicking anywhere in the prompt — to put the caret in it, to select a word — pressed
              that switch and moved focus onto it, which meant the next keystroke went to a button
              instead of into the text. The field could not be typed in at all, and the switch it was
              flipping is the one that decides whether a row is paid for.

              Measured: `label.control` resolved to `.cc-ref__toggle`. It also means the label was
              never labelling the prompt — a `<label>` cannot label a contenteditable, so the element
              bought nothing even before the chips existed. The field carries its own `aria-label`.
            */}
            <div className="cc-field" ref={promptFieldRef}>
              <span className="cc-field__label" id="cc-prompt-label">
                What should the model put in this cell?
                <span className="cc-field__sub">{fanout.on && fanout.sourceId != null ? "runs once per item of the list column" : "runs once per row"}</span>
              </span>
              <RefField
                className="cc-textarea"
                ariaLabel="What should the model put in this cell?"
                rows={6}
                placeholder={
                  kind === "agent"
                    ? "Find the cheapest plan price on /Website and give the number only"
                    : "Is /Job title a decision maker? Answer yes or no"
                }
                value={prompt}
                columns={columns}
                options={refOptions}
                onChange={(v) => {
                  setPrompt(v);
                  promptLatest.current = v;
                  setPromptDirty(true);
                  // A correction held for a value that has just been typed over is stale.
                  promptCanonical.current = null;
                  promptSave.schedule(v);
                }}
                onBlur={() => { promptSave.flush(); adoptStored(); }}
                showChips
              />
              {/* "Saving…" is only true while a save is actually in flight. Showing it for anything
                  unsaved leaves a FAILED save promising the footer it is still going, for as long as
                  the drawer stays open. */}
              <span className="cc-field__hint">
                Type <kbd>/</kbd> to put another column's value in.{" "}
                {gone ? "Not saved." : promptDirty ? (promptError ? "Not saved." : "Saving…") : "Saved."}
              </span>
            </div>

            {/* Priced against the DRAFT and the model currently picked, not what was last saved.
                The prompt is the cost — it is re-sent on every row, and on the agent lane on every
                turn of every row — so the one moment this is worth knowing is while it is being
                written, not in the confirmation after the decision has been made. */}
            <PromptCost
              columnId={String(column.id)}
              prompt={prompt}
              model={model}
              kind={kind}
              searchEnabled={kind === "agent"}
              maxResults={search.maxResults}
            />

            {promptError && <div className="cc-errors" role="alert"><div className="cc-errors__row">{promptError}</div></div>}

            {/* The column is gone. Plain words and a way out, rather than the engine's own
                "Column not found" sitting above a form that can no longer save anything. */}
            {gone && (
              <div className="cc-gone" role="alert">
                <p className="cc-gone__h">This column no longer exists.</p>
                <p className="cc-gone__p">
                  It was deleted somewhere else — from the grid, or along with the table it was on.
                  Nothing typed here can be saved to it.
                </p>
                <button className="cc-btn" onClick={dismiss}>Close</button>
              </div>
            )}

            <div className={kind === "agent" ? "cc-mode__warn" : "cc-mode__note"} role="status">
              {kind === "agent"
                ? "This column searches the web, which is the most expensive mode there is. Every row is several model calls plus the searches. If the answer is already somewhere in the row, switch to reading the row on the Mode tab."
                : "This column can only use what is already in the row. If the answer is not there, the model will produce a confident wrong value rather than an error — check the first few rows before running the sheet."}
            </div>

            <ModelPicker
              value={model}
              toolsRequired={kind === "agent"}
              onChange={(id) => void pickModel(id)}
              busy={busy}
            />

            {/* ── the cheap model that goes first ───────────────────────────
                The economics of a million rows: most rows are answered by something free, and only
                the ones it was unsure about are worth the model above.

                What it explicitly does NOT do is escalate on its own. An unsure row keeps the cheap
                answer, is marked as unsure, and waits — spending is always something you ask for. */}
            <div className="cc-field cc-first">
              <span className="cc-field__label">Try a cheaper model first</span>
              <ModelPicker
                value={firstModel || "off"}
                toolsRequired={kind === "agent"}
                onChange={(id) => void pickFirstModel(id === "off" ? "" : id)}
                busy={busy}
                offLabel="Off — always use the model above"
                label="First model"
              />
              <span className="cc-field__hint">
                {firstModel ? (
                  <>
                    Every row goes to this model first. When it answers and says it is sure, that is the
                    value and nothing else is spent. When it is not sure, the row keeps that answer, is
                    marked <strong>not sure</strong>, and waits — <em>nothing escalates on its own</em>.
                    You run the model above on those rows when you want to, and you see the cost first.
                  </>
                ) : (
                  <>
                    Point this at a local model and most rows stop costing anything. A row it is unsure
                    about is flagged rather than charged for.
                  </>
                )}
              </span>
            </div>

            {/* ── the ceiling on one cell ───────────────────────────────────
                Enforced since the beginning and, until now, changeable only by editing the database.
                A limit nobody can move is a limit that is wrong for somebody: $0.05 is generous for
                a one-line classification and mean for a research agent, and a person whose cells
                were being refused had no way to raise it and no screen that said why. */}
            <div className="cc-field">
              <span className="cc-field__label">
                Most one cell may spend
                <span className="cc-field__sub">US dollars</span>
              </span>
              <input
                className="cc-input cc-input--num"
                type="number"
                min={0}
                step="0.01"
                size={8}
                value={cellCap}
                disabled={busy}
                aria-label="The most one cell of this column may spend, in dollars"
                onChange={(e) => setCellCap(e.target.value)}
                onBlur={() => void saveCellCap()}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveCellCap(); } }}
              />
              <span className="cc-field__hint">
                {Number(cellCap) === 0 ? (
                  <>
                    <strong>No limit.</strong> A row that turns into a long research job will run until
                    it finishes. Every other ceiling still applies — the run, the table, and the
                    column if it fills itself.
                  </>
                ) : (
                  <>
                    Checked between steps, so a row that would go over stops rather than finishing and
                    billing. If the model has no published price the cell is refused rather than run
                    without a ceiling. Type <strong>0</strong> for no limit.
                  </>
                )}
              </span>
            </div>

            {/* ── fan-out: once per item of a list ─────────────────────────
                How the prompt meets a list column: once per item, in place, the answers folding
                back as a list. The candidates are the columns whose value IS a list — a text
                column is offered nowhere, because the executor refuses scalars rather than
                splitting prose on a guessed separator. The per-cell ceiling above applies to the
                ACCUMULATED items, so a cap here and a cap there are the same brake. */}
            {(kind === "ai" || kind === "agent") && (
              <FanoutSettings
                value={fanout}
                columns={columns}
                busy={busy}
                onChange={(next) => void saveFanout(next)}
              />
            )}
          </>
        )}

        {tab === "when" && (
          <RunSettings
            column={{ ...column, kind, autoRun }}
            columns={columns}
            refOptions={refOptions}
            // Only the lanes that bill per row get the loud framing. Telling someone a free rule
            // column will spend their money is how a warning stops being read.
            paid={kind === "ai" || kind === "agent"}
            onSaved={() => { void reloadFromColumn(); }}
          />
        )}

        {tab === "output" && (
          <div className="cc-field">
            <span className="cc-field__label">Data type</span>
            <div className="cc-typegrid">
              {(["text", "number", "boolean", "url", "email", "date", "currency", "percent", "phone", "enum", "json"] as const).map((t) => (
                <button
                  key={t}
                  className={`cc-type${valueType === t ? " cc-type--on" : ""}`}
                  onClick={() => void setType(t)}
                  disabled={busy}
                  aria-pressed={valueType === t}
                >
                  {t}
                </button>
              ))}
            </div>
            <span className="cc-field__hint">
              The type drives how a result is coerced and validated, how the column sorts, and which
              filter operators you get. Saved as soon as you pick it — it does not change values
              already in the column, it changes what the next run must produce.
            </span>

            {/* The options an enum is allowed to return. Only an enum HAS this second half — for
                every other type the shape is the whole constraint; for an enum the shape is "one of
                these", and until now there was no "these" to name. */}
            {valueType === "enum" && (
              <>
                {enumError && <div className="cc-modal__error" role="alert">{enumError}</div>}
                <EnumOptions value={enumValues} onChange={(next) => { void saveEnumValues(next); }} disabled={busy} />
              </>
            )}

            {/* The display half of a currency/percent column — the symbol and decimals. Only these
                two types carry it; the value stays a plain number underneath. */}
            {(valueType === "currency" || valueType === "percent") && (
              <FormatFields kind={valueType} value={format} onChange={(next) => { void saveFormat(next); }} disabled={busy} />
            )}

            {/* Rules live under the type, because they are the second half of the same question:
                the type is what shape a value must be, these are what a valid one looks like. */}
            <RuleSettings
              value={column.validation ?? null}
              onChange={(next) => { void saveRules(next); }}
              busy={busy}
              error={ruleError}
            />
          </div>
        )}

        {tab === "destination" && (
          <SendSettings
            column={column}
            columns={columns}
            refOptions={refOptions}
            sheets={sheets}
            value={send}
            onChange={(next) => { setSend(next); void saveSend(next); }}
            error={sendError}
            busy={busy}
          />
        )}

        {tab === "link" && (
          <LookupSettings
            column={column}
            columns={columns}
            sheetId={sheetId}
            sheets={sheets}
            onSaved={onSaved}
          />
        )}

        {tab === "steps" && (
          <WaterfallSettings
            value={column.waterfall ?? null}
            onChange={(next) => { void saveWaterfall(next); }}
            busy={busy}
            error={waterfallError}
          />
        )}

        {tab === "tool" && (
          <McpSettings
            column={column}
            columns={columns}
            refOptions={refOptions}
            value={mcp}
            onChange={(next) => { setMcp(next); void saveMcp(next); }}
            error={mcpError}
            busy={busy}
          />
        )}

        {tab === "request" && (
          <HttpSettings
            column={column}
            columns={columns}
            refOptions={refOptions}
            value={http}
            onChange={(next) => { setHttp(next); void saveHttp(next); }}
            error={httpError}
            busy={busy}
          />
        )}

        {tab === "search" && (
          <>
            {/* The settings are shown either way — they are real, they are saved, and hiding them
                would make the tab look empty. What changes is the banner above them, which says
                plainly that nothing here runs yet and offers the one click that changes that. */}
            {kind !== "agent" && (
              <div className="cc-inactive" role="status">
                <p className="cc-inactive__text">
                  These settings only do something when this column searches the web. Right now it is
                  set to <strong>{kind === "ai" ? "read the row" : kind === "script" ? "run a rule" : "hold typed-in values"}</strong>,
                  so nothing here will run.
                </p>
                <button
                  className="cc-btn"
                  onClick={() => void pickMode("agent")}
                  disabled={busy}
                >
                  Switch this column to web search
                </button>
              </div>
            )}
            {/* ── the switch that was missing ───────────────────────────────
                Everything below configures HOW this column would search. Until now nothing turned it
                ON: `allowed_tools` was read by the executor, the estimate, the savings ledger and the
                live cost preview, and written by nothing at all — so `web_search` was never in the
                list, `buildToolset` never attached the tool, and no agent column could search the
                web however carefully this tab was filled in.

                Framed as the expensive choice it is: this is the difference between a column that
                reads the row and one that goes and looks, and the looking is what costs. */}
            {kind === "agent" && (
              <div className="cc-agenttools__wrap">
                <p className="cc-runset__label">Connected apps</p>
                <p className="cc-runset__checkhint">
                  Tools this column may call while it works, granted one at a time. The per-cell
                  limits on the Mode tab bound what a single row can spend across all of them.
                </p>
                <AgentTools
                  columnId={column.id}
                  allowedTools={column.allowedTools ?? []}
                  disabled={busy}
                  onSaved={onSaved}
                  onError={setSearchError}
                />
              </div>
            )}
            <label className="cc-runset__check cc-searchon">
              <input
                type="checkbox"
                checked={webSearch}
                disabled={busy || kind !== "agent"}
                onChange={(e) => void toggleWebSearch(e.target.checked)}
              />
              <span>
                Let this column search the web
                <span className="cc-runset__checkhint">
                  {kind !== "agent"
                    ? "Only a web-searching column can do this. Switch the mode above first."
                    : webSearch
                      ? "The model may run searches while answering each row. Searches are billed by the search provider on top of the model, and are the expensive half of this lane — the per-cell limit on the Mode tab is what keeps a row bounded."
                      : "Off, so this column can only read the row and fetch a page it is given. It cannot go looking, whatever the settings below say."}
                </span>
              </span>
            </label>

            <SearchSettings
              value={search}
              onChange={(next) => { setSearch(next); void saveSearch(next); }}
              error={searchError}
              busy={busy}
            />

            {/* The same figure as the Instruction tab, here because on this lane the SEARCH
                settings are the expensive ones: one search costs more than a thousand tokens do,
                and a row may make one per turn. Changing results-per-search with no idea what it
                does to the bill is the gap this closes. */}
            <PromptCost
              columnId={String(column.id)}
              prompt={prompt}
              model={model}
              kind={kind}
              searchEnabled={kind === "agent"}
              maxResults={search.maxResults}
            />
          </>
        )}

        {/* Was a hardcoded paragraph promising a screen that did not exist — on a column that had
            just run 60,000 rows twice it still said "appears here once this column has run". */}
        {tab === "runs" && <ColumnHistory columnId={String(column.id)} />}
      </div>

      {/*
        The footer belongs to the RULE workflow — write it, save it, approve it, try it — and it was
        rendered for every lane.

        On an AI column there is no rule, so `code` is empty and `saved` is null: Save was disabled
        because there was nothing to save, and Try was disabled because nothing had been approved.
        Neither could ever become enabled, neither said why, and meanwhile the prompt beside them was
        saving itself and reporting "Saved." in its own hint. Three controls that look like the way
        to commit your work, permanently dead, above a field that had already committed it.
      */}
      <footer className="cc-drawer__foot">
        {hasRule ? (
          <>
            <span className="cc-foot__meta">
              {saved ? `v${saved.version} · ${saved.hash.slice(0, 8)}` : "unsaved"}
            </span>
            <div className="cc-foot__actions">
              {/* Every disabled state now names its own reason. "Blocked and silent" is the thing
                  that made this footer unreadable — a control the user cannot use and cannot find
                  out why reads as a broken app rather than as a step not reached yet. */}
              <button
                className="cc-btn"
                onClick={save}
                disabled={busy || !loaded || !code.trim() || refProblems.length > 0}
                title={
                  refProblems.length > 0 ? "Fix the reference above first."
                  : !code.trim() ? "Write the rule above first — there is nothing to save yet."
                  : "Save this rule. It still needs approving before it can run."
                }
              >
                Save
              </button>
              {saved && !saved.approvedAt && (
                <button
                  className="cc-btn cc-btn--primary"
                  onClick={approve}
                  disabled={busy}
                  title="Approve it to run — generated code runs on your rows only after you have read it."
                >
                  Approve
                </button>
              )}
              <span className="cc-try">
                <label className="cc-try__label" htmlFor="cc-try-rows">Try</label>
                <input
                  id="cc-try-rows"
                  className="cc-input cc-input--num cc-try__n"
                  type="number"
                  min={1}
                  max={TRY_MAX}
                  size={6}
                  value={tryRows}
                  disabled={busy}
                  onChange={(e) => setTryRows(clampTry(Number(e.target.value)))}
                />
                <button
                  className="cc-btn"
                  onClick={runDry}
                  disabled={busy || !saved?.approvedAt || refProblems.length > 0}
                  title={
                    refProblems.length > 0 ? "Fix the reference above first."
                    : !saved ? "Save the rule first."
                    : !saved.approvedAt ? "Approve the rule first — it has not been allowed to run yet."
                    : `Run it on ${tryRows} ${tryRows === 1 ? "row" : "rows"} without changing anything.`
                  }
                >
                  <IconPlay /> <span>{tryRows === 1 ? "row" : "rows"}</span>
                </button>
              </span>
            </div>
          </>
        ) : (
          /*
           * Every other lane autosaves. Saying so is the whole job of this bar: without it the
           * question "have my changes been kept?" had no answer anywhere except a hint under one
           * field, and the dead Save button beside it answered "no".
           */
          <>
            <span className="cc-foot__meta cc-foot__autosave">
              {tryNote ? tryNote
                : gone ? "This column is gone — nothing is being saved."
                : settingsSaving ? "Saving…"
                : "Saved. Changes here are kept as you make them."}
            </span>
            {/* Try a few rows for real, right here — the way to see the actual output (the email, the
                extracted value) and iterate on it, instead of committing to a whole run first. Only on
                the lanes where a try produces a value to look at; a `send` column would fire real
                messages, so it is deliberately not offered one. */}
            {(kind === "ai" || kind === "agent" || kind === "http" || kind === "mcp") && !gone && (
              <span className="cc-try">
                <label className="cc-try__label" htmlFor="cc-try-rows">Try</label>
                <input
                  id="cc-try-rows"
                  className="cc-input cc-input--num cc-try__n"
                  type="number"
                  min={1}
                  max={TRY_MAX}
                  size={6}
                  value={tryRows}
                  disabled={trying}
                  onChange={(e) => setTryRows(clampTry(Number(e.target.value)))}
                />
                <button
                  className="cc-btn"
                  onClick={runTry}
                  disabled={trying || rowCount === 0 || ((kind === "ai" || kind === "agent") && !prompt.trim())}
                  title={
                    rowCount === 0 ? "This table has no rows yet — add a few first."
                    : (kind === "ai" || kind === "agent") && !prompt.trim() ? "Write the instruction above first."
                    : `Run the first ${tryRows} ${tryRows === 1 ? "row" : "rows"} for real and fill them into the grid — this costs what those rows cost.`
                  }
                >
                  <IconPlay /> <span>{trying ? "Running…" : tryRows === 1 ? "row" : "rows"}</span>
                </button>
              </span>
            )}
          </>
        )}
      </footer>

      <Modal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard this rule?"
        footNote="Nothing has run yet."
        footer={
          <>
            <button className="cc-btn" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
            {/* Closes the confirm first, so the drawer's own exit plays behind an already-dismissed
                dialog rather than the two unmounting on top of each other. */}
            <button className="cc-btn cc-btn--danger" onClick={() => { setConfirmDiscard(false); dismiss(); }}>
              Discard
            </button>
          </>
        }
      >
        <p className="cc-modal__summary">
          The code for <strong>{column.name}</strong> has not been saved. Closing now loses it.
        </p>
      </Modal>
    </aside>
  );
}
