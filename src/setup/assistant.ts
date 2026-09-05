// The table assistant — the conversational surface over everything else in the app.
//
// Clay calls theirs Sculptor. The parts worth copying are the parts that are hard: it is
// CONVERSATIONAL and ITERATIVE rather than one-shot, it can look at the table's actual state to
// answer questions and diagnose failures, and — the important one — it works against a sandbox that
// is published only when the user says so.
//
// That last property maps exactly onto the propose-then-apply pattern the column setup already
// uses, so it is not a new idea here, just a wider one. The assistant never writes to the table. It
// returns a REPLY plus, optionally, a list of proposed ACTIONS. Each action is one thing the user
// could have done by hand, rendered in the words of the screen that would have done it, and applied
// only on approval — individually, so a good suggestion and a bad one in the same answer do not
// have to be accepted together.
//
// ── What it is allowed to see ────────────────────────────────────────────────────────────────────
//
// Column names, modes, types, prompts, per-column completion and error counts, the errors' own
// messages, and a handful of sample values. Enough to say "the Industry column is failing on 84
// rows because the request is missing an API key" — which is the actual job — without shipping the
// contents of a million-row table into a prompt.
//
// ── What it is not allowed to do ─────────────────────────────────────────────────────────────────
//
// Run anything. Spend anything. Delete anything. There is no action kind here that removes a row, a
// column or a table, and none that starts a run: an assistant that can start a paid run from a
// sentence is one bad interpretation away from an expensive afternoon. It proposes the column; the
// user runs it, through the same confirmation every other run goes through.

import { sanitize } from "../agent/loop.ts";
import { designCall, resolveSetupProvider, SETUP_TIMEOUT_MS } from "./setupModel.ts";
import { gatherEvidence, describeEvidence } from "./evidence.ts";
import { PROPOSABLE_KINDS } from "./aiSetup.ts";
import { db, tx } from "../db.ts";
import { addColumn, getSheet, listColumns, readWindow } from "../store.ts";
import { setColumnHttpConfig, setColumnKind, setColumnPrompt, setColumnValueType } from "../store.ts";
import { DEFAULT_HTTP, normalizeHttpConfig } from "../http/httpColumn.ts";
import { safeHttp, storeRefs, refsToStored } from "./aiSetup.ts";
import { parseRefNodes, serializeRefNodes } from "../refNodes.ts";
import { rebuildDeps } from "../refs.ts";
import { record } from "../undo.ts";
import { setConfig as setDedupe, preview as previewDedupe } from "../dedupe.ts";
import { isColumnKind, isValueType } from "../types.ts";
import type { ColumnKind, ValueType } from "../types.ts";

/**
 * Ceiling on a prompt, mirroring the one on PATCH /api/columns/:id.
 *
 * A prompt is sent on EVERY row, so its length is multiplied by the sheet. The hand-built path has
 * refused an over-long one from the start; an answer arriving through a model must clear the same
 * bar, or the cheapest way past the cap is to ask the assistant to write it.
 */
const MAX_PROMPT = 8000;

export interface Message {
  role: "user" | "assistant";
  text: string;
}

/**
 * One proposed change.
 *
 * Every kind here has a hand-built equivalent in the UI, and applying one does exactly what that
 * screen does. Nothing destructive is expressible.
 */
export type Action =
  | { kind: "add_column"; name: string; columnKind: ColumnKind; valueType: ValueType; prompt?: string; http?: Record<string, unknown>; why: string }
  | { kind: "set_prompt"; columnId: number; prompt: string; why: string }
  | { kind: "set_mode"; columnId: number; columnKind: ColumnKind; valueType?: ValueType; why: string }
  | { kind: "set_dedupe"; columnNames: string[]; keep: "oldest" | "newest"; why: string };

export interface AssistantReply {
  /** What it says. Plain English, no markdown headings — this renders in a chat bubble. */
  reply: string;
  actions: Action[];
  /**
   * Changes it proposed that this table cannot accept, and which were therefore not offered.
   *
   * Counted rather than dropped in silence. A dropped action is invisible in the transcript while
   * the sentence above it still describes the change — so the panel read as an assistant that says
   * what it is about to do and then does nothing, which is exactly what it looked like from outside.
   * The number gives the panel something true to say: it tried, and the change did not fit.
   */
  dropped: number;
}

const SYSTEM = `You are the assistant inside a spreadsheet tool where every column is either typed in, a rule, an HTTP request, or an AI prompt.

You help with four things:
  building a table — proposing the columns that answer the user's question
  enrichment — choosing which columns should look something up, and writing what they ask
  reading the table — answering questions about what is in it and what state it is in
  troubleshooting — explaining why a column is failing, from the error messages you are shown

How to answer:
  Be brief and concrete. Two or three sentences, then the actions.
  Propose actions ONLY when the user is asking for a change. A question gets an answer, not edits.
  Prefer the cheapest column that does the job. A value that can be typed or derived should not be
  an AI prompt, and an AI prompt with no need to look anything up on the web should not be an agent.
  Never claim to have run, changed or deleted anything. You propose; the user applies.
  If you do not have enough information, say what you would need and ask for it.

Referencing columns in a prompt — this is not formatting, it changes what runs:
  When a prompt should use another column's value, write it as /Column name — a leading slash and
  the column's exact name (they are listed for you above). Do this for EVERY column the prompt reads,
  including columns another column will fill in later.
  /Company industry is replaced with that row's real industry before the model sees it, AND the
  column is set to run AFTER the columns it references. Merely naming a column in prose — "use the
  company industry", or "Use: Full name, Company industry, Value Proposition" — does neither: no
  value is put in, and the column can run before those columns are filled, so it works on blanks.
  Wrong:  Write a cold email. Use: Full name, Company industry, Value Proposition.
  Right:  Write a cold email to /Full name, whose company is in /Company industry. Open with the
          angle in /Value Proposition.
  So when the user asks for a column that "reads every column", the prompt must actually reference
  each of those columns with /, not list their names.

Adding a column (add_column):
  Put the new column's name in the "name" field. "columnNames" is only for a dedupe rule and is
  ignored here — a name left there means the column is created with no name, so it is not created.
  If the column is "ai" or "agent", it MUST include its "prompt" in the same action, written with
  /references as above. Adding the column and setting its instruction are ONE action, not two. An ai
  or agent column with no prompt does nothing on every row, so it is refused rather than created.

A change you describe in words is a change that does not happen. The words are not wired to anything
— only the actions array is — so:
  If you are proposing a change, it MUST be in the actions array. Describing it in the reply and
  leaving actions empty produces a message that promises something and a screen where nothing can be
  clicked.
  Never write in the future tense about a change: not "I'll add a column", not "let me set that up",
  not "I'm going to change". Say what the action does, in the present, and let the action carry it.
  If you cannot express what you want as one of the four kinds above, say plainly that this is not
  something you can set up here, and what the user would do by hand instead.`;

const TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply"],
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "why"],
        properties: {
          kind: { type: "string", enum: ["add_column", "set_prompt", "set_mode", "set_dedupe"] },
          why: { type: "string", description: "One line, in the user's terms, on what this achieves." },
          name: { type: "string", description: "add_column: the new column's name. Goes HERE, not in columnNames." },
          columnId: { type: "number", description: "set_prompt / set_mode: the id of the existing column to change." },
          // Derived, not written out again. This list was the third hand-maintained copy of the
          // column kinds and, like the other two, it had gone stale: `send` existed in the product
          // and in none of them, so the assistant could not propose the largest feature in the app.
          columnKind: { type: "string", enum: PROPOSABLE_KINDS },
          valueType: {
            type: "string",
            enum: ["text", "number", "boolean", "url", "email", "enum", "json", "date", "datetime", "currency", "percent", "phone", "array"],
          },
          prompt: { type: "string" },
          http: { type: "object", additionalProperties: true },
          columnNames: { type: "array", items: { type: "string" }, maxItems: 4 },
          keep: { type: "string", enum: ["oldest", "newest"] },
        },
      },
    },
  },
} as const;

/**
 * What the table currently looks like, as text.
 *
 * Counts and error messages rather than data. A per-column error summary is what turns "my column
 * is broken" into an answer, and it is three aggregates rather than a scan of the rows.
 */
export function describeTable(sheetId: string): string {
  const sheet = getSheet(sheetId);
  if (!sheet) return "That table no longer exists.";

  // Shared with the setup panel rather than built a second way here. A second implementation runs
  // its own aggregate query PER COLUMN and takes examples from row 1 only; the shared one does the
  // counts
  // in one query, samples from four places in the sheet, and reports a fill RATE — which is the fact
  // that decides whether referencing a column is a good idea, and neither surface had it.
  const ev = gatherEvidence(sheetId);
  if (!ev) return "That table no longer exists.";

  const lines: string[] = [describeEvidence(ev)];

  // What the rows are, when somebody has said. This is the reader `sheets.kind` was waiting for:
  // both proposal surfaces (the assistant and the setup panel) describe the table through this
  // function, so a table marked "people" steers column suggestions toward names, titles and
  // emails without a word from the user. The kind was settable for a long time before anything
  // read it back; a setting that changes nothing is a setting that lies.
  if (sheet.kind && sheet.kind !== "generic") {
    lines.push(`These rows are ${sheet.kind}.`);
  }

  // Ids, which the description deliberately omits — the model needs them to target set_prompt and
  // set_mode at a specific column, and they are meaningless to the user reading the reply.
  const columns = listColumns(sheetId);
  lines.push("", "Column ids, for targeting a change:");
  for (const c of columns) {
    const bits = [`- [${c.id}] "${c.name}"`];
    if (c.prompt) bits.push(`instruction: ${String(c.prompt).slice(0, 160)}`);
    lines.push(bits.join(" · "));
  }

  const dd = previewDedupe(sheetId);
  if (dd.duplicates > 0) {
    lines.push("", `Duplicate rows under the current rule: ${dd.duplicates.toLocaleString()}.`);
  }

  return lines.join("\n");
}

/**
 * `opts.model` is gone on purpose.
 *
 * It came straight off the request body, so a caller could name any model and the free-only guard —
 * the setting whose whole promise is that designing a column cannot produce a charge — would never
 * see it. The assistant is a design surface like the setup panel, so it uses the same setup model,
 * chosen in Settings, subject to the same guard. Nothing in the app was passing it.
 */
/**
 * One thing the assistant is doing right now, streamed to the panel while it works.
 *
 * The panel used to show a single spinner for the whole wait, which on a multi-step answer is a long
 * blank stare at nothing. These name each step as it happens — planning, checking against the
 * request, improving — so a longer wait reads as work rather than a hang.
 */
export interface AssistantStep {
  phase: "draft" | "check" | "revise" | "done";
  label: string;
  round?: number;
}

export interface AskOptions {
  onStep?: (step: AssistantStep) => void;
  signal?: AbortSignal;
}

// The most self-checking any one answer does. A first draft is followed by up to this many
// review-and-improve rounds; the loop stops the moment a review is satisfied, so this is a ceiling,
// not a count.
const MAX_REVIEW_ROUNDS = 3;

/**
 * Does this ask deserve the full loop, or one quick check?
 *
 * The cost of a review is a whole extra model call, and on the free setup model that is seconds of
 * wait. A one-line "add a column that finds the industry" does not need three of them; "read every
 * column and write a personalized email" — broad, and the kind a first draft half-finishes — does.
 * So the depth is chosen from the shape of the request rather than applied flat.
 */
export function isComplexAsk(userText: string, draft: AssistantReply): boolean {
  if (draft.actions.length > 1) return true;
  if (userText.length > 140) return true;
  return /\b(every|all|each|entire|whole|comprehensive|and then|as well as)\b/i.test(userText)
    || /hyper[- ]?personaliz/i.test(userText);
}

/** The proposal, as text the reviewer reads. JSON so a reference in a prompt survives verbatim. */
function renderProposal(reply: string, actions: Action[]): string {
  const out = [`Its reply to the user: ${reply}`, "", "The actions it proposes:"];
  if (actions.length === 0) out.push("(none)");
  else actions.forEach((a, i) => out.push(`${i + 1}. ${JSON.stringify(a)}`));
  return out.join("\n");
}

const CRITIC_SYSTEM = `Another assistant proposed a change to a spreadsheet. Review it against the user's ORIGINAL request, before it is shown to them, and either approve it or return a corrected version.

Judge only these, in order:
  Scope — does it do everything the user asked, and nothing they did not? "Reads every column" means the prompt must reference the columns that matter, not two of them.
  References — every column a prompt uses is written as /Column name, spelled exactly, never named in prose. A column named without the leading slash is not referenced at all: its value is never put in, and the column runs before that column is filled.
  Shape — an ai or agent column carries its prompt; every column has a name; the mode suits the task.

Rules:
  If the proposal is already right, set complete to true and change nothing. Do not rewrite a good proposal for the sake of it.
  If it is wrong, set complete to false and return the corrected reply and the FULL corrected list of actions, fixing only what is wrong and keeping the same action kinds and column ids.
  Refer to a column in a prompt as /Column name — the column names are listed above.`;

const CRITIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["complete"],
  properties: {
    complete: { type: "boolean", description: "true if the proposal already satisfies the request and needs no change." },
    assessment: { type: "string", description: "One line: what was missing or wrong, or why it is already fine." },
    reply: { type: "string", description: "The corrected reply to the user — only when complete is false." },
    actions: TOOL_SCHEMA.properties.actions,
  },
} as const;

/** One review pass. Returns whether the proposal is complete, and a correction when it is not. */
async function critique(
  provider: Parameters<typeof designCall>[0],
  model: string,
  sheetId: string,
  userReq: string,
  current: AssistantReply,
  signal?: AbortSignal,
): Promise<{ complete: boolean; reply?: string; actions?: unknown[] }> {
  const lines = [
    describeTable(sheetId),
    "",
    `The user's request: ${sanitize(userReq, 3000)}`,
    "",
    renderProposal(current.reply, current.actions),
  ];
  const res = await designCall(
    provider,
    model,
    {
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content: lines.join("\n") },
      ],
      tools: [{ name: "review", description: "Approve, or return a corrected proposal.", parameters: CRITIC_SCHEMA as never }],
      maxTokens: 1600,
      temperature: 0,
      signal: signal ?? AbortSignal.timeout(SETUP_TIMEOUT_MS),
    },
    "review",
  );
  const a = res.args as { complete?: unknown; reply?: unknown; actions?: unknown };
  return {
    complete: !!a.complete,
    reply: typeof a.reply === "string" ? a.reply : undefined,
    actions: Array.isArray(a.actions) ? a.actions : undefined,
  };
}

/**
 * `opts.model` is gone on purpose.
 *
 * It came straight off the request body, so a caller could name any model and the free-only guard —
 * the setting whose whole promise is that designing a column cannot produce a charge — would never
 * see it. The assistant is a design surface like the setup panel, so it uses the same setup model,
 * chosen in Settings, subject to the same guard.
 *
 * ── It answers, then checks its own answer ──────────────────────────────────────────────────────
 *
 * A first draft is a first draft: on a broad ask it half-finishes — names columns instead of
 * referencing them, misses one the user wanted, forgets a prompt. So a proposed CHANGE is reviewed
 * against the original request and improved, up to a few rounds, stopping the moment a review is
 * satisfied. A plain question is answered once — there is nothing to check it against. Every round
 * is bounded and fails safe: a review that errors, times out, or would leave nothing to apply keeps
 * the draft rather than losing it, so the loop can only match or beat the single-shot answer.
 */
export async function ask(
  sheetId: string,
  history: Message[],
  opts: AskOptions = {},
): Promise<AssistantReply> {
  const onStep = opts.onStep ?? (() => {});
  const last = [...history].reverse().find((m) => m.role === "user")?.text?.trim();
  if (!last) throw new Error("Ask something first.");

  const lines = [
    describeTable(sheetId),
    "",
    "The conversation so far:",
    // Capped and sanitized: the transcript includes text the user pasted, and pasted text is where
    // "ignore the above" arrives, by accident as often as on purpose.
    ...history.slice(-12).map((m) => `${m.role === "user" ? "User" : "You"}: ${sanitize(m.text, 3000)}`),
  ];

  const { provider, model } = await resolveSetupProvider();

  onStep({ phase: "draft", label: "Planning the change" });
  // Through the shared design call, which copes with a model that cannot be FORCED to answer with a
  // tool — a capability the catalogue does not publish, and one many free models lack. Without it a
  // perfectly good free model produced a 503 and the chat said "something went wrong inside Ferrum".
  const draftRes = await designCall(
    provider,
    model,
    {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: lines.join("\n") },
      ],
      tools: [{ name: "respond", description: "Answer, and optionally propose changes.", parameters: TOOL_SCHEMA as never }],
      maxTokens: 1600,
      temperature: 0,
      signal: opts.signal ?? AbortSignal.timeout(SETUP_TIMEOUT_MS),
    },
    "respond",
  );
  let current = parseReply(draftRes.args, sheetId);

  // A question just gets answered: there is nothing to review it against, and a second call would
  // only add a wait. Only a proposed change is worth checking.
  if (current.actions.length > 0) {
    const rounds = isComplexAsk(last, current) ? MAX_REVIEW_ROUNDS : 1;
    for (let round = 1; round <= rounds; round++) {
      onStep({ phase: "check", label: "Checking it against your request", round });
      let verdict;
      try {
        verdict = await critique(provider, model, sheetId, last, current, opts.signal);
      } catch {
        // A review that errors or times out must never cost the draft — it is a real, usable answer.
        break;
      }
      if (verdict.complete) break;

      onStep({ phase: "revise", label: "Improving the proposal", round });
      const revised = parseReply({ reply: verdict.reply ?? current.reply, actions: verdict.actions ?? [] }, sheetId);
      // A review that leaves nothing to apply is worse than the draft it would replace — the draft had
      // at least one usable change. Keep the draft and stop rather than adopt an empty revision.
      if (revised.actions.length === 0) break;
      current = revised;
    }
  }

  onStep({ phase: "done", label: "Ready" });
  return current;
}

// The action verbs a column instruction opens with, and the words that end the thing it acts on.
const NAME_VERB = /\b(write|draft|compose|generate|create|make|craft|find|fetch|extract|pull|summari[sz]e|describe|classify|categori[sz]e|identify|determine|detect|calculate|compute|score|rate|rank|check|verify|validate|clean|normali[sz]e|translate|research|lookup|look up)\b/i;
const NAME_STOP = new Set(
  "to for from of in on at with about under over into as by per that which who whose whom based using and or but this these those their its your our it them".split(" "),
);
// Words that describe HOW, not WHAT — dropped so the name is the deliverable, not an adjective.
const NAME_FILLER = new Set(
  "a an the each one some hyper personalized personalised concise brief short detailed professional custom quick simple clean proper properly complete comprehensive relevant new full accurate good great nice perfect ideal truly very really well nicely tailored bespoke".split(" "),
);

/**
 * A sensible column name from the instruction, when the model gave none.
 *
 * The name of an AI column is almost always the object of its verb — "write a cold email" is the
 * "Cold Email" column, "summarise the company" is the "Company" column. This pulls that phrase out,
 * drops the adjectives that say how rather than what, and Title-Cases two or three words of it.
 * References are stripped first, so a name can never contain a `/column` or a `{{col:N}}`. Returns
 * null when nothing clean comes out — the caller then falls back to the generic default.
 */
export function deriveColumnName(prompt?: string): string | null {
  if (!prompt) return null;
  const text = prompt.replace(/\{\{[^}]*\}\}/g, " ").replace(/\/[A-Za-z][\w -]*/g, " ");
  const vm = NAME_VERB.exec(text);
  if (!vm) return null;

  const words = (text.slice(vm.index + vm[0].length).toLowerCase().match(/[a-z]+/g) ?? []);
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2) continue;                       // possessive "s", stray letters
    if (NAME_STOP.has(w)) break;                       // a preposition ends the phrase
    if (out.length === 0 && NAME_FILLER.has(w)) continue; // skip leading adjectives
    out.push(w);
    if (out.length >= 3) break;
  }
  while (out.length && NAME_FILLER.has(out[out.length - 1]!)) out.pop();
  if (out.length === 0) return null;

  const name = out.map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" ");
  return name.replace(/[^a-z]/gi, "").length >= 3 ? name.slice(0, 40) : null;
}

/**
 * Turn the model's answer into a reply and a list of actions this app will actually offer.
 *
 * Anything referring to a column that does not exist is DROPPED rather than shown. An action that
 * looks applicable and then errors on click is worse than one that was never offered — and a
 * column id the model invented is exactly that.
 *
 * This is also the validation the APPLY route runs, on the action it is handed rather than on the
 * one that was offered. The two are not the same object: what comes back on apply has been through
 * the browser, and a path that trusted it would accept a mode and a prompt length the hand-built
 * PATCH refuses.
 */
export function parseReply(raw: unknown, sheetId: string): AssistantReply {
  const a = (raw ?? {}) as any;
  const reply = String(a.reply ?? "").trim();
  if (!reply) throw new Error("The model returned an empty answer. Try again.");

  const columns = listColumns(sheetId);
  const valid = new Set(columns.map((c) => Number(c.id)));
  // Dedupe columns arrive by NAME, so they need the same existence check ids already get — and the
  // canonical spelling, so what is reported afterwards is what was actually matched.
  const byName = new Map(columns.map((c) => [c.name.trim().toLowerCase(), c.name]));
  const actions: Action[] = [];
  // Every proposal that arrives, so what did not survive the checks below can be counted rather than
  // vanishing. Each `continue` and each unmatched branch is a change the reply may already have
  // described in words.
  const offered = (Array.isArray(a.actions) ? a.actions : []).length;

  for (const r of Array.isArray(a.actions) ? a.actions : []) {
    const why = String(r?.why ?? "").trim();
    if (r?.kind === "add_column") {
      const columnKind = isColumnKind(r.columnKind) ? r.columnKind : "static";
      const prompt = r.prompt ? String(r.prompt) : undefined;
      // The two kinds whose entire job is the instruction must arrive WITH one. An AI or agent column
      // created with no prompt does nothing on every row — the exact silent no-op this panel exists to
      // prevent — so it is not offered, and is counted below like any other change that did not fit.
      const promptOk = columnKind === "ai" || columnKind === "agent"
        ? !!(prompt && prompt.trim())
        : true;
      // The name is the field the model most often gets wrong: it lands in `columnNames` (the dedupe
      // field), or on a wide table is left off altogether. Neither is a reason to throw away a column
      // that is otherwise complete — the right kind, and the instruction its kind needs. So the name
      // is salvaged from `columnNames`, and, failing that, defaulted to the same "New column" the "+"
      // button uses, which the user renames in place. Only `promptOk` still gates: a column with
      // nothing to do is refused, a nameless one is simply named.
      const name = String(r.name ?? "").trim()
        || String(r.columnNames?.[0] ?? "").trim()
        || deriveColumnName(prompt)
        || "New column";
      if (promptOk && !(prompt && prompt.length > MAX_PROMPT)) {
        actions.push({
          kind: "add_column",
          name,
          columnKind,
          valueType: isValueType(r.valueType) ? r.valueType : "text",
          prompt,
          http: r.http && typeof r.http === "object" ? r.http : undefined,
          why,
        });
      }
    } else if (
      r?.kind === "set_prompt" && valid.has(Number(r.columnId)) &&
      String(r.prompt ?? "").trim() && String(r.prompt).length <= MAX_PROMPT
    ) {
      actions.push({ kind: "set_prompt", columnId: Number(r.columnId), prompt: String(r.prompt), why });
    } else if (r?.kind === "set_mode" && valid.has(Number(r.columnId)) && isColumnKind(r.columnKind)) {
      actions.push({
        kind: "set_mode",
        columnId: Number(r.columnId),
        columnKind: r.columnKind,
        valueType: isValueType(r.valueType) ? r.valueType : undefined,
        why,
      });
    } else if (r?.kind === "set_dedupe" && Array.isArray(r.columnNames) && r.columnNames.length > 0) {
      // Only the names that resolve. A key that quietly loses one of its columns is WEAKER than the
      // one that was approved — it matches on less — and the old code then reported the whole list
      // as applied, so the transcript said something that was not true.
      const names = r.columnNames
        .map((n: unknown) => byName.get(String(n).trim().toLowerCase()))
        .filter((n: string | undefined): n is string => !!n)
        .slice(0, 4);
      if (names.length === 0) continue;
      actions.push({ kind: "set_dedupe", columnNames: names, keep: r.keep === "newest" ? "newest" : "oldest", why });
    }
  }

  return { reply, actions, dropped: Math.max(0, offered - actions.length) };
}

/**
 * Store `/Column` references AND mark every one optional.
 *
 * A stored `{{col:5}}` is REQUIRED: a row missing that column is SKIPPED and never runs. That is a
 * fine default for a hand-built column with one or two references the user chose on purpose. It is
 * the wrong default for a column the assistant fills with references to many columns at once — on a
 * real table almost every row is missing SOMETHING, so required references would skip nearly every
 * row and the column would fill in almost nothing. Marked optional (`{{col:5?}}`), the column runs on
 * whatever the row actually has, which is what someone asking for "an email from every column" means.
 */
function storeRefsOptional(display: string, columns: RefLite[]): string {
  const stored = storeRefs(display, columns);
  return serializeRefNodes(
    parseRefNodes(stored, columns).map((n) => (n.type === "ref" ? { ...n, optional: true } : n)),
  );
}
type RefLite = { id: string | number; name: string };

/**
 * Apply ONE approved action.
 *
 * One at a time on purpose: a reply can hold a good suggestion and a wrong one, and accepting them
 * together is how the wrong one gets in. Returns a plain-English account of what changed, which is
 * what the chat then shows — so the transcript records what was done, not what was offered.
 */
export function applyAction(sheetId: string, action: Action): string {
  switch (action.kind) {
    case "add_column": {
      // Read BEFORE the column exists, for two reasons: it is the list the model was shown, and a
      // prompt saying "/Headcount" on the column called Headcount would otherwise resolve into a
      // reference to itself.
      const others = listColumns(sheetId);
      return tx(() => {
        const col = addColumn(sheetId, { name: action.name, kind: action.columnKind, valueType: action.valueType });
        let note = `Added "${col.name}". Nothing has run yet — use Run when you are ready.`;

        if (action.prompt && (action.columnKind === "ai" || action.columnKind === "agent")) {
          setColumnPrompt(col.id, storeRefsOptional(action.prompt, others));
        }
        if (action.http && action.columnKind === "http") {
          try {
            // Through the SAME two filters a proposal goes through: `/Company` becomes the stored
            // reference, and the settings a language model does not get an opinion about — private
            // addresses above all — are taken from the defaults rather than from its answer.
            const cfg = safeHttp(refsToStored(action.http, others), normalizeHttpConfig(DEFAULT_HTTP));
            setColumnHttpConfig(col.id, cfg as unknown as Record<string, unknown>);
          } catch {
            setColumnKind(col.id, "static");
            note = `Added "${col.name}", but the request could not be built — it is a plain column for now.`;
          }
        }
        // The references just stored are what the run order and the stale cascade are built from, so
        // the edges have to be derived here. Without it a proposed column referencing /Company came
        // out at depth 0 — running before Company, against an empty value, on the paid lane.
        rebuildDeps(sheetId, Number(col.id));

        // Undoable, like every hand-made change. Model-authored edits were the only ones with no way
        // back, which is exactly backwards: they are the ones the user did not type.
        record(sheetId, "column.create", `Add column "${col.name}"`,
          { columnIds: [Number(col.id)], deletedAt: nowStamp() });
        // Never run here. The column exists and is ready; starting it is a spend, and a spend goes
        // through the same confirmation as every other run.
        return note;
      });
    }
    case "set_prompt": {
      const cols = listColumns(sheetId);
      const col = cols.find((c) => Number(c.id) === action.columnId);
      if (!col) return "That column no longer exists.";
      const next = storeRefsOptional(action.prompt, cols.filter((c) => Number(c.id) !== action.columnId));
      return tx(() => {
        setColumnPrompt(col.id, next);
        // A new instruction is a new set of references, so the edges are re-derived from it — the
        // same call the hand-built PATCH makes after writing a prompt.
        rebuildDeps(sheetId, Number(col.id));
        record(sheetId, "column.field", `Change the instruction for "${col.name}"`,
          { columnId: Number(col.id), field: "prompt", from: col.prompt ?? null, to: next.trim() ? next : null });
        return `Updated what "${col.name}" asks. Existing values are unchanged until it runs again.`;
      });
    }
    case "set_mode": {
      const col = listColumns(sheetId).find((c) => Number(c.id) === action.columnId);
      if (!col) return "That column no longer exists.";
      return tx(() => {
        setColumnKind(col.id, action.columnKind);
        record(sheetId, "column.field", `Set how "${col.name}" runs`,
          { columnId: Number(col.id), field: "kind", from: col.kind, to: action.columnKind });
        if (action.valueType) {
          setColumnValueType(col.id, action.valueType);
          record(sheetId, "column.field", `Set "${col.name}" to ${action.valueType}`,
            { columnId: Number(col.id), field: "value_type", from: col.valueType, to: action.valueType });
        }
        return `"${col.name}" is now ${action.columnKind}.`;
      });
    }
    case "set_dedupe": {
      const byName = new Map(listColumns(sheetId).map((c) => [c.name.trim().toLowerCase(), Number(c.id)]));
      const resolved = action.columnNames.map((n) => ({ name: n, id: byName.get(n.trim().toLowerCase()) }));
      const missing = resolved.filter((r) => r.id == null).map((r) => r.name);
      // All or nothing. Applying the subset that resolved would leave a key that matches on LESS
      // than the one that was approved — quietly weaker, and reported as if it were the whole thing.
      if (missing.length > 0) {
        return `Nothing changed: this table has no column called ${missing.map((m) => `"${m}"`).join(" or ")}.`;
      }
      setDedupe(sheetId, { columnIds: resolved.map((r) => r.id as number), keep: action.keep, auto: false });
      const p = previewDedupe(sheetId);
      return `Set to match on ${action.columnNames.join(", then ")}. ${p.duplicates.toLocaleString()} rows would be removed — nothing has been removed yet.`;
    }
  }
}

/** SQLite's own clock, so an undone creation carries the same shape of timestamp as a real delete. */
function nowStamp(): string {
  return String((db.prepare("SELECT datetime('now') AS t").get() as any).t);
}

// ─────────────────────────────────────────────────────────── the stored conversation

/**
 * One turn, as it is kept.
 *
 * The transcript is stored rather than held in the panel because the panel's own close button used
 * to destroy it — as did a reload, and as did opening another table and coming back. A conversation
 * about a table is built up over turns, so losing it costs everything said so far, not just the
 * last line.
 */
export interface StoredTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  actions: Action[];
  /** Which of those actions were applied, by index, and what each one reported. */
  applied: Record<number, string>;
}

const MAX_KEPT = 200;

export function loadConversation(sheetId: string): StoredTurn[] {
  return (db
    .prepare("SELECT id, role, text, actions_json, applied_json FROM assistant_messages WHERE sheet_id = ? ORDER BY id")
    .all(sheetId) as any[]).map((r) => ({
      id: Number(r.id),
      role: r.role,
      text: String(r.text),
      // A malformed blob degrades to "no actions" rather than throwing. A transcript that will not
      // load is worse than one turn that lost its buttons.
      actions: safeParse(r.actions_json, []),
      applied: safeParse(r.applied_json, {}),
    }));
}

export function appendTurn(
  sheetId: string,
  turn: { role: "user" | "assistant"; text: string; actions?: Action[] },
): number {
  const res = db
    .prepare("INSERT INTO assistant_messages (sheet_id, role, text, actions_json) VALUES (?, ?, ?, ?)")
    .run(sheetId, turn.role, turn.text, turn.actions?.length ? JSON.stringify(turn.actions) : null);
  // Trimmed from the front, so a table talked to all week does not grow without limit. The model
  // only ever reads the last twelve turns anyway, and the rest is there to be read by a person.
  db.prepare(
    `DELETE FROM assistant_messages
      WHERE sheet_id = ?
        AND id NOT IN (SELECT id FROM assistant_messages WHERE sheet_id = ? ORDER BY id DESC LIMIT ?)`,
  ).run(sheetId, sheetId, MAX_KEPT);
  return Number(res.lastInsertRowid);
}

/** Record that one proposal on one turn was applied, and what it reported. */
export function markApplied(sheetId: string, turnId: number, actionIndex: number, said: string): void {
  const row = db
    .prepare("SELECT applied_json FROM assistant_messages WHERE id = ? AND sheet_id = ?")
    .get(turnId, sheetId) as any;
  if (!row) return;
  const applied = safeParse<Record<number, string>>(row.applied_json, {});
  applied[actionIndex] = said;
  db.prepare("UPDATE assistant_messages SET applied_json = ? WHERE id = ?").run(JSON.stringify(applied), turnId);
}

export function clearConversation(sheetId: string): number {
  return Number(db.prepare("DELETE FROM assistant_messages WHERE sheet_id = ?").run(sheetId).changes ?? 0);
}

function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
