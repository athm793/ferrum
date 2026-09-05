// The run confirmation.
//
// This dialog exists because a run is the only thing in the app that spends money, and the number it
// shows is produced by the SERVER resolving the same predicate the run will use — never by counting
// what the client happens to have loaded. On a million-row sheet the client holds about two
// thousand rows, so a client-side count would be confidently, silently wrong.

import { useEffect, useState } from "react";
import { IconPlay } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { SampleForecast, type Forecast } from "./SampleForecast.tsx";
import { pricingVerdict } from "./pricingVerdict.ts";
import "./SampleForecast.css";
// Imported by nothing until now, so every rule in it was inert — including the one reserving the
// hint's height to stop the dialog resizing on tick. Found by looking at the rendered dialog: the
// checkbox label and its hint ran together as one line of text, because the flex column that
// separates them lives in this file.
import "./ConfirmRun.css";

export interface RunScopeRequest {
  columnIds?: number[];
  rowIds?: number[];
  viewId?: number;
  statuses?: string[];
  limit?: number;
  /** 1-based, inclusive — the numbers on the row gutter. */
  fromRow?: number;
  toRow?: number;
  force?: boolean;
}

interface Props {
  sheetId: string;
  scope: RunScopeRequest;
  /** What the user picked, e.g. "Run on the filtered rows" — shown as the dialog's title. */
  title: string;
  onCancel: () => void;
  onStarted: (runId: string) => void;
}

/** Mirrors ColumnCost in src/estimate.ts. Every field there has to be read here or it is inert. */
interface ColumnCost {
  columnId: number;
  name: string;
  kind: string;
  model: string | null;
  perRow: number;
  /** A waterfall's other end: what it costs if the first step usually answers. See ColumnCost. */
  bestPerRow?: number;
  bestTotal?: number;
  /** Steps whose price nobody declared, by name — named rather than counted as zero. */
  unpricedSteps?: string[];
  /** Fan-out: the sampled item distribution — average, worst (cap-bounded), and the cap itself. */
  fanOutItems?: number;
  fanOutMaxItems?: number;
  fanOutCap?: number;
  total: number;
  unpriced?: boolean;
  /** This column bills a third party — an HTTP endpoint or an MCP provider — at a rate we cannot see. */
  external?: boolean;
  /** The host it calls, so the warning can name it. */
  host?: string;
  /** How many requests it will make: one per row. */
  requests?: number;
}

interface Resolved {
  rowCount: number;
  columnIds: number[];
  summary: string;
  cost?: {
    total: number;
    columns: ColumnCost[];
    incomplete: boolean;
    free: boolean;
    external?: boolean;
    /**
     * Whether the published price list could be read at all. See RunCost in src/estimate.ts.
     *
     * Absent on a response from an older engine, and read as TRUE there — which is exactly the
     * behaviour that preceded it, so an out-of-date server cannot accidentally unlock the gate below.
     */
    catalogueReachable?: boolean;
  };
  /** Facts about this run only the server knows. See the resolve-scope route. */
  warnings?: Array<{ kind: string; count?: number; atLeast?: boolean; names?: string[] }>;
}

/** Above this, a run gets an explicit "this is large" callout rather than a plain confirm. */
const LARGE_RUN = 5000;

/** Above this the run has to be typed out, not just clicked. */
const EXPENSIVE_USD = 25;

/** Rows a sample runs. Mirrors DEFAULT_SAMPLE_ROWS in src/sample.ts. */
const SAMPLE_ROWS = 10;

/**
 * Below this many rows, sampling is not offered.
 *
 * Running ten of thirty rows to find out about the other twenty is not a saving, it is a third of
 * the job done in a dialog. The offer only makes sense when the sample is small relative to what it
 * predicts.
 */
const WORTH_SAMPLING = 50;

function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function ConfirmRun({ sheetId, scope, title, onCancel, onStarted }: Props) {
  const [resolved, setResolved] = useState<Resolved | null>(null);
  /**
   * Two errors, not one, and keeping them apart is the whole fix.
   *
   * There used to be a single `error`. Anything that set it replaced the dialog's entire body — row
   * count, cost breakdown, warnings, all of it — and disabled the primary button, and nothing
   * anywhere ever cleared it. So one refusal from the start route, such as "no OpenRouter key is
   * configured", left the dialog permanently dead: you could go and add the key, come back, and the
   * only control that still worked was Cancel. From the user's side that is "I pressed Run and
   * nothing happened", which is precisely how it was reported.
   *
   * `scopeError` — we could not work out WHAT this run covers. There is genuinely nothing to show,
   * so it replaces the body and blocks the run.
   * `startError` — the run could not be STARTED. Everything above it is still true and still worth
   * reading, so it appears above the buttons and Run stays live to be pressed again.
   */
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  /**
   * Replace cells the user typed in, rather than leaving them alone.
   *
   * Off every time the dialog opens, never remembered. A setting that persists is one somebody turns
   * on for ten rows in the morning and forgets before running two hundred thousand in the afternoon
   * — and this is the one option in here whose mistake destroys work rather than costing money.
   */
  const [overwriteEdited, setOverwriteEdited] = useState(false);
  /**
   * The sample run, once one has been started. Its presence is what switches this dialog from
   * "here is what we think it costs" to "here is what it cost".
   *
   * The dialog stays open across it deliberately. A sample that closed the dialog and reported back
   * later would leave the decision it exists to inform on a different screen from the answer.
   */
  const [sampleRunId, setSampleRunId] = useState<string | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [sampling, setSampling] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/sheets/${sheetId}/resolve-scope`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Sent with the scope: it changes how many cells the warning below says will be replaced,
          // and a count that ignored it would understate exactly the destructive part.
          body: JSON.stringify({ ...scope, overwriteEdited }),
        }).then((r) => r.json());
        if (!live) return;
        if (res.error) setScopeError(res.error);
        // Cleared on every success, so a scope that failed once and now resolves does not leave the
        // dialog showing a stale reason for a problem that has gone.
        else { setScopeError(null); setResolved(res); }
      } catch (e) {
        if (live) setScopeError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, [sheetId, scope, overwriteEdited]);

  const start = async () => {
    setStarting(true);
    // Cleared as the retry begins. Without this the reason the LAST attempt failed sits above a
    // button that is now working on a new one.
    setStartError(null);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, overwriteEdited }),
      }).then((r) => r.json());
      if (res.error) { setStartError(res.error); setStarting(false); return; }
      onStarted(res.run.id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  /**
   * Start the sample.
   *
   * The sample's own row ids are chosen by the SERVER, from the same scope this dialog resolved.
   * Picking them here would mean picking from the rows the browser happens to hold — the first
   * couple of thousand — which is the systematic bias the whole feature exists to avoid.
   */
  const startSample = async () => {
    setSampling(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/sample`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, rows: SAMPLE_ROWS, overwriteEdited }),
      }).then((r) => r.json());
      if (res.error) { setStartError(res.error); setSampling(false); return; }
      setSampleRunId(res.run.id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setSampling(false);
    }
  };

  const large = (resolved?.rowCount ?? 0) >= LARGE_RUN;
  const cost = resolved?.cost;

  /**
   * Every column that spends anything — including the ones we cannot price.
   *
   * Not `kind === "ai" || kind === "agent"`, which leaves an http or mcp column out of the breakdown
   * entirely. The engine runs those as spend lanes, and leaving them off the one screen that lists
   * what a run will cost is how a million billed requests reach a confirmation that mentions nothing
   * but two model columns.
   */
  const spending = (cost?.columns ?? []).filter(
    (c) => c.kind === "ai" || c.kind === "agent" || c.external,
  );

  /**
   * Requests this run makes to somebody else's service, at a rate this app cannot see.
   *
   * Priced at nothing is not the same as costing nothing. Collapsing the two into one answer shows
   * an http run over a million rows as "free" and skips the gate below.
   */
  const externalColumns = (cost?.columns ?? []).filter((c) => c.external);
  // Called out individually: a waterfall is the one lane whose cost is a RANGE rather than a figure.
  const waterfalls = (cost?.columns ?? []).filter((c) => c.kind === "waterfall" && (c.total > 0 || (c.unpricedSteps?.length ?? 0) > 0));
  // Fan-out is the other lane whose cost is a range — items per row is a distribution, the cap
  // bounds it, and both ends are sampled rather than known.
  const fanoutColumns = (cost?.columns ?? []).filter((c) => c.fanOutItems != null && c.total > 0);
  const externalRequests = externalColumns.reduce((n, c) => n + (c.requests ?? 0), 0);
  const externalHosts = [...new Set(externalColumns.map((c) => c.host).filter(Boolean))] as string[];

  // An unpriced model is not a licence to proceed quietly — but the two reasons it happens need
  // opposite answers, and this used to give them the same one. See pricingVerdict.ts.
  const { unpriced, blocked: pricingBlocked, unknownCatalogue } = pricingVerdict(cost);

  /**
   * A big spend has to be TYPED, not clicked.
   *
   * The gap between a $4 run and a $4,000 one is a filter setting, and both are the same click in
   * the same place. Above the threshold the primary button is inert until the amount is typed back —
   * which cannot be done by muscle memory, and forces the number to actually be read.
   *
   * A large external run gets the same gate on the number it DOES have. There are no dollars to
   * type for an endpoint whose rate only the user knows, but "one request per row, a million rows"
   * is the fact that decides it, and it was passing through on a single click.
   */
  /**
   * The figure the gate below is set against — MEASURED once a sample has produced one.
   *
   * The estimate is what we have before anything runs, and once ten real rows have been priced it
   * is the weaker number. Leaving the gate on the estimate would mean a run the sample just showed
   * to be five times more expensive than predicted still passing on a single click, because the
   * prediction is what the threshold was compared against.
   */
  const measuredTotal =
    forecast?.projection ? forecast.spent + forecast.projection.likely : null;
  const gateTotal = measuredTotal ?? cost?.total ?? 0;

  const expensive = gateTotal >= EXPENSIVE_USD;
  const externalHeavy = !expensive && externalRequests >= LARGE_RUN;
  /**
   * A run with NO estimate at all takes the same gate, on the row count.
   *
   * This is the price list being unreachable rather than a bad model, so the run is allowed — but
   * "we cannot tell you what this costs" is the last thing that should pass on a single click, and
   * the row count is the only number anybody has.
   */
  const unestimated = unknownCatalogue && !expensive && !externalHeavy;
  const requiredPhrase = expensive
    ? String(Math.round(gateTotal))
    : externalHeavy
      ? String(externalRequests)
      : unestimated
        ? String(resolved?.rowCount ?? 0)
        : "";
  const phraseOk = !requiredPhrase || confirmText.trim().replace(/^\$/, "").replace(/,/g, "") === requiredPhrase;

  /**
   * Whether sampling is worth offering at all.
   *
   * Only on a run that SPENDS and is big enough for ten rows to predict the rest. A free run has
   * nothing to forecast, and offering to sample a forty-row job is offering to do a quarter of it in
   * a dialog. An unpriced run is excluded because it cannot be started either way.
   */
  const canSample =
    !!resolved &&
    !sampleRunId &&
    !unpriced &&
    resolved.rowCount >= WORTH_SAMPLING &&
    !!cost &&
    (!cost.free || externalColumns.length > 0);

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      footNote={resolved && resolved.rowCount === 0 ? "Nothing matches this selection." : ""}
      /* Beside the button that failed, and everything the dialog already worked out stays on screen
         behind it. Fix whatever this names — in another tab if you have to — and press Run again. */
      notice={
        startError ? (
          <div className="cc-modal__error" role="alert">
            <strong>That did not start.</strong> {startError}
          </div>
        ) : null
      }
      footer={
        <>
          <button className="cc-btn" onClick={onCancel}>Cancel</button>
          {/* Beside the primary action rather than buried in the body: it is the cheaper of the two
              things this dialog can do, and it should be as easy to reach as the expensive one. */}
          {canSample && (
            <button className="cc-btn" onClick={startSample} disabled={sampling || starting}>
              {sampling ? "Starting…" : `Sample ${SAMPLE_ROWS} rows first`}
            </button>
          )}
          <button
            className="cc-btn cc-btn--primary"
            onClick={start}
            /* `startError` is deliberately NOT here. A run that failed to start is the one case where
               the button must stay alive — that is what leaves the user somewhere to go after they
               have fixed whatever the message named. */
            disabled={starting || !resolved || resolved.rowCount === 0 || !!scopeError || pricingBlocked || !phraseOk}
            /* Every reason this button can be dead is named on it.
               Two of them were not: an empty selection and a run already starting both left the
               primary action greyed with nothing to say, which is the same "am I stuck or is it
               working?" question the column drawer's footer used to raise. */
            title={
              starting ? "Starting the run…"
              : !resolved ? "Working out how many rows this covers…"
              : resolved.rowCount === 0 ? "Nothing matches this selection, so there is nothing to run."
              : scopeError ? "This cannot start until the problem above is fixed."
              : pricingBlocked ? "One of these columns uses a model with no published price, so this run cannot be estimated."
              : !phraseOk
                ? `Type ${requiredPhrase} to confirm ${
                    expensive ? "this amount" : unestimated ? "this many rows" : "this many billed requests"
                  }.`
              : startError ? "Try starting the run again."
              : "Start the run. You can pause or cancel it from the strip at the top."
            }
          >
            <IconPlay />
            {resolved
              ? cost && !cost.free && cost.total > 0
                ? `Run ${resolved.rowCount.toLocaleString()} ${resolved.rowCount === 1 ? "row" : "rows"} · ${usd(cost.total)}`
                : `Run ${resolved.rowCount.toLocaleString()} ${resolved.rowCount === 1 ? "row" : "rows"}`
              : "Run"}
          </button>
        </>
      }
    >
      {scopeError ? (
        <div className="cc-modal__error" role="alert">{scopeError}</div>
      ) : !resolved ? (
        // Fixed-height placeholder, so resolving does not resize the dialog under the cursor.
        <div className="cc-modal__resolving">
          <span className="cc-skel" style={{ width: "60%" }} />
          <span className="cc-skel" style={{ width: "40%" }} />
        </div>
      ) : (
        <>
          <div className="cc-modal__stat">
            <span className="cc-modal__stat-label">Rows</span>
            <span className="cc-modal__stat-value mono">{resolved.rowCount.toLocaleString()}</span>
          </div>
          <div className="cc-modal__stat">
            <span className="cc-modal__stat-label">Columns</span>
            <span className="cc-modal__stat-value mono">{resolved.columnIds.length}</span>
          </div>
          <div className="cc-modal__stat">
            <span className="cc-modal__stat-label">Cells</span>
            <span className="cc-modal__stat-value mono">
              {(resolved.rowCount * resolved.columnIds.length).toLocaleString()}
            </span>
          </div>

          {/* Money is the LAST stat and the emphasised one, because it is the number the decision
              actually turns on. A script-only run says so outright rather than showing "$0.00",
              which reads as a failed estimate.

              "free" is reserved for a run where NOTHING bills. A run that calls somebody else's API
              once per row is priced at zero here and is not free, so it says what it actually is:
              the model side costs this much, and the endpoint's side is theirs to state. */}
          <div className="cc-modal__stat cc-modal__stat--cost">
            <span className="cc-modal__stat-label">Estimated cost</span>
            <span className="cc-modal__stat-value mono">
              {!cost
                ? "—"
                : unpriced
                  ? "unknown"
                  : cost.free
                    ? "free"
                    : externalColumns.length > 0
                      ? cost.total > 0 ? `${usd(cost.total)} + their rate` : "their rate"
                      : usd(cost.total)}
            </span>
          </div>

          {/* A waterfall's range, said out loud.
              The figure above is the WORST case, because the question a spend warning answers is
              "could this exceed what I am willing to spend". On its own that is so pessimistic
              nobody presses the button on a job that will really cost a fifth of it — so the other
              end goes beside it rather than in a tooltip. */}
          {waterfalls.map((c) => (
            <p key={c.columnId} className="cc-modal__note">
              <strong>{c.name}</strong> tries its steps in order: about{" "}
              <strong>{usd(c.bestTotal ?? 0)}</strong> if the first one usually answers, up to{" "}
              <strong>{usd(c.total)}</strong> if every row falls all the way through.
              {(c.unpricedSteps?.length ?? 0) > 0 && (
                <> Not counted: {c.unpricedSteps!.join(", ")} — no price set, so the real total is higher.</>
              )}
            </p>
          ))}

          {/* A fan-out's range, said out loud — same reason as the waterfall's. The figure above is
              the sampled WORST case; the sampled average is what the run will really spend, and the
              multiplier is named so the number is checkable instead of trusted. */}
          {fanoutColumns.map((c) => (
            <p key={`fo-${c.columnId}`} className="cc-modal__note">
              <strong>{c.name}</strong> runs once per item of a list: about{" "}
              <strong>{usd(c.bestTotal ?? 0)}</strong> at the sampled average (~
              {Math.round((c.fanOutItems ?? 0) * 10) / 10} items a row), up to{" "}
              <strong>{usd(c.total)}</strong> at the busiest ({c.fanOutMaxItems} items, cap{" "}
              {c.fanOutCap}).
            </p>
          ))}

          {/* Per column, so it is obvious WHICH column is the expensive one — on a mixed run the
              total alone does not tell you that one web-search column is the whole bill, and it
              certainly does not tell you that a third column is posting a million times to an API
              you pay for separately. */}
          {spending.length > 0 && (
            <ul className="cc-modal__breakdown">
              {spending.map((c) => (
                <li key={c.columnId}>
                  <span className="cc-modal__bd-name truncate">{c.name}</span>
                  <span className="cc-modal__bd-model mono truncate">
                    {c.external ? c.host ?? "an external service" : c.model}
                  </span>
                  <span className="cc-modal__bd-cost mono">
                    {c.external ? "their rate" : c.unpriced ? "no price" : usd(c.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Directly under the estimate it corrects. The arithmetic figure above and the measured
              one here answer the same question, and putting them anywhere but next to each other
              would leave someone comparing across a scroll. */}
          {sampleRunId && (
            <SampleForecast runId={sampleRunId} onDone={setForecast} />
          )}

          <p className="cc-modal__summary">{resolved.summary}</p>

          {/* Two different problems, two different sentences. The old single message told everyone
              to "pick a model with a price" — advice that is impossible to follow in the second case,
              because while the price list is unreachable no model has one. */}
          {pricingBlocked && (
            <div className="cc-modal__warn" role="alert">
              A column here uses a model with no published price, so this run cannot be costed. Pick
              a model with a price on the column's Mode tab before running it.
            </div>
          )}

          {unknownCatalogue && (
            <div className="cc-modal__warn" role="alert">
              <strong>The price list could not be read</strong>, so this run has no cost estimate.
              Nothing is wrong with the columns — either no OpenRouter key is set yet, or the
              provider did not answer. The run can still go ahead and will be billed at whatever the
              models actually charge.
            </div>
          )}

          {/* Named before the gate below it, so the number being typed has already been explained.
              The engine bills nothing for these and the service does — which is exactly the shape
              of cost that gets discovered on an invoice rather than on this screen. */}
          {externalColumns.length > 0 && !pricingBlocked && (
            <div className="cc-modal__warn">
              <strong>
                {externalRequests.toLocaleString()}{" "}
                {externalRequests === 1 ? "request" : "requests"} to{" "}
                {externalHosts.length === 1
                  ? externalHosts[0]
                  : externalHosts.length > 1
                    ? `${externalHosts.length} services`
                    : "an external service"}
              </strong>{" "}
              — one per row, per column. Whatever that service charges is on top of the figure above
              and cannot be seen from here. Retries multiply it; a run condition is the only thing
              that reduces it.
            </div>
          )}

          {/* Gated on `pricingBlocked`, not on `unpriced`. Those were the same thing until the price
              list got its own answer — and with the old test this box disappeared in exactly the
              state that now needs it, leaving a button demanding a phrase with nowhere to type it. */}
          {requiredPhrase && !pricingBlocked && (
            <div className="cc-modal__warn">
              <p>
                {expensive ? (
                  <>
                    {/* "Measured" once a sample has priced real rows, because by then it is no
                        longer an estimate and calling it one understates how much it is worth
                        reading. */}
                    This run {measuredTotal != null ? "measures at" : "is estimated at"}{" "}
                    <strong>{usd(gateTotal)}</strong>. Type <strong>{requiredPhrase}</strong> to
                    confirm you have read that.
                  </>
                ) : unestimated ? (
                  <>
                    This run covers <strong>{requiredPhrase}</strong> rows and there is no cost
                    estimate for it. Type <strong>{requiredPhrase}</strong> to confirm you are
                    starting it anyway.
                  </>
                ) : (
                  <>
                    This run makes <strong>{externalRequests.toLocaleString()}</strong> billed
                    requests. Type <strong>{requiredPhrase}</strong> to confirm you have read that.
                  </>
                )}
              </p>
              <input
                className="cc-input"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                aria-label={`Type ${requiredPhrase} to confirm`}
                placeholder={requiredPhrase}
                autoFocus
              />
            </div>
          )}

          {/* Off by default, every time, and never remembered — see the state declaration.
              Deliberately placed ABOVE the overwrite warning, so the number in that warning is read
              after this has been decided rather than before. */}
          <label className="cc-modal__opt">
            <input
              type="checkbox"
              checked={overwriteEdited}
              onChange={(e) => setOverwriteEdited(e.target.checked)}
            />
            <span>
              <strong>Also replace cells I typed in myself</strong>
              <span className="cc-modal__opthint">
                {overwriteEdited
                  ? "Your edits in these rows will be overwritten and will stop being marked as yours."
                  : "Normally a run leaves your own edits alone. Tick this to hand them back to the column."}
              </span>
            </span>
          </label>

          {/* Two things worth being told before a run rather than after it. Both are silent
              otherwise: you notice an overwrite because values changed, and you notice a missing
              gate when the bill arrives. */}
          {(resolved.warnings ?? []).map((w) =>
            w.kind === "overwrite" ? (
              <div key="overwrite" className="cc-modal__warn">
                {/* "Up to", and "at least" when the count was bounded — the number is a bound in
                    both paths, and claiming a precision it does not have is how a warning stops
                    being believed. */}
                <strong>
                  {w.atLeast ? "At least " : "Up to "}
                  {w.count!.toLocaleString()} {w.count === 1 ? "cell" : "cells"} already{" "}
                  {w.count === 1 ? "has" : "have"} a value
                </strong>{" "}
                and will be replaced by whatever this run produces.{" "}
                {overwriteEdited
                  ? "That includes the ones you typed in yourself — they will stop being marked as yours."
                  : "Cells you typed in yourself are left alone."}{" "}
                To fill only the gaps, run “rows that never ran” instead.
              </div>
            ) : w.kind === "ungated" ? (
              <div key="ungated" className="cc-modal__warn">
                <strong>
                  {w.names!.length === 1 ? `"${w.names![0]}" has` : `${w.names!.length} paid columns have`}{" "}
                  no run condition
                </strong>
                , so every row in this run is paid for. A condition is free, runs before anything is
                spent, and lives on the column's “When to run” tab.
              </div>
            ) : w.kind === "unconfigured" ? (
              /* A column that was never finished skips every row it touches. The engine has always
                 handled this gracefully — a skip, not an error — but it said so one cell at a time,
                 after the run. On a large run that is a long wait for nothing with no explanation
                 until you open a cell. */
              <div key="unconfigured" className="cc-modal__warn">
                <strong>
                  {w.names!.length === 1 ? "One column is not set up yet" : `${w.names!.length} columns are not set up yet`}
                </strong>
                , so every row of {w.names!.length === 1 ? "it" : "them"} will be skipped and nothing
                spent on {w.names!.length === 1 ? "it" : "them"}:
                <ul className="cc-modal__warnlist">
                  {w.names!.map((n) => <li key={n}>{n}</li>)}
                </ul>
              </div>
            ) : null,
          )}

          {large && (
            <div className="cc-modal__warn">
              That is a large run. It will keep going in the background and you can pause or
              cancel it at any point — rows that finish keep their values.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
