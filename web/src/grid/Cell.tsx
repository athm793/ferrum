// One grid cell.
//
// THE ZERO-CLS CONTRACT: every cell, in every state, is the same three-slot box at a fixed height —
// a 16px status slot, a min-width:0 truncating value area, and a 20px action slot that is present
// but hidden at rest. Both edge slots are always in the DOM at fixed size, so a cell moving
// empty -> queued -> running -> done cannot shift a single pixel of anything around it.
//
// Each cell subscribes to ITS OWN key in the store, so one arriving value re-renders one leaf.

import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { cellStore, clock, type CellRecord } from "../store/cellStore.ts";
import { STATUS_META } from "../types.ts";
import { formatDisplay, type ValueFormat } from "@shared/valueFormat.ts";
import { parseListValue, LIST_CHIPS_SHOWN } from "./listValue.ts";
import type { ValueType } from "@shared/types.ts";
import { IconPlay, IconStop, IconExpand, IconAlert, IconStale, IconPencilMark } from "../ui/Icon.tsx";
import "./Cell.css";

interface Props {
  rowId: string;
  columnId: string;
  /** A pixel number, or the `var(--cw-<id>, Npx)` form the grid uses so a resize drag can move the
   *  column without re-rendering a thousand cells. */
  width: number | string;
  /** 1-based position in the grid's columns, gutter included. Announced as aria-colindex. */
  colIndex: number;
  /**
   * `"<rowPosition>:<columnIndex>"`. How the grid finds this cell in the DOM to move focus onto it,
   * which a ref cannot do — the cell it wants may not have been rendered by the virtualizer yet.
   */
  cellKey: string;
  /**
   * The ONE cell in the whole grid that is in the tab order (roving tabindex). Every other cell is
   * -1, so Tab enters the grid once and the arrow keys do the moving from there.
   */
  active?: boolean;
  /**
   * Inside the selected range.
   *
   * Distinct from `active`, which is the ONE cell with focus. A range has one active cell and any
   * number of selected ones, and the two are drawn differently on purpose: the active cell keeps its
   * ring so you can still see where typing will go.
   */
  selected?: boolean;
  /** Which edges of this cell sit on the outside of the selection, so the range is drawn as one box
   *  with a continuous border rather than as a grid of individually-outlined cells. */
  edges?: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  /** This is the bottom-right corner of the selection, and so carries the fill handle. */
  fillCorner?: boolean;
  /**
   * Pointer moved over here with the button still down — extend the drag.
   *
   * Only the EXTEND half lives on the cell. Starting a selection is handled by the scrollport's
   * mousedown, because a row the virtualizer has not filled in yet renders as a skeleton rather
   * than as a `Cell`, and a drag that began on one would otherwise do nothing at all.
   */
  onSelectOver?: () => void;
  /** Pointer went down on the fill handle. */
  onFillStart?: () => void;
  /** Receives the trigger's rect so the detail popover can anchor without the cell owning one. */
  onOpen?: (cellId: string, rect: DOMRect) => void;
  /**
   * This cell is being typed into.
   *
   * The grid owns which cell is editing, not the cell — otherwise moving between cells with the
   * keyboard would need every cell to know about every other one. `seed` is the text to start
   * from: the current value when editing was opened deliberately, or the character that was typed
   * when it started by typing over the cell.
   */
  editing?: boolean;
  seed?: string;
  onCommit?: (value: string, move: "down" | "right" | "none") => void;
  onCancelEdit?: () => void;
  /** Start editing this cell. */
  onEdit?: () => void;
  /**
   * The column's data type and display descriptor, so a currency/percent cell shows "$29.00" / "29%"
   * rather than the bare number the engine stores. DISPLAY ONLY — the value edited, sorted, filtered
   * and copied is always the stored number; formatting is the last step before the pixels.
   *
   * Both are stable references off the columns array, so they do not defeat the cell's memo.
   */
  valueType?: ValueType;
  format?: ValueFormat;
}

const EMPTY: CellRecord = { id: "", status: "empty", value: null, rev: -1 };

function elapsedLabel(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const Cell = memo(function Cell({
  rowId, columnId, width, colIndex, cellKey, active, selected, edges, fillCorner,
  onSelectOver, onFillStart, onOpen, editing, seed, onCommit, onCancelEdit, onEdit,
  valueType, format,
}: Props) {
  const subscribe = useCallback(
    (l: () => void) => cellStore.subscribeCell(rowId, columnId, l),
    [rowId, columnId],
  );
  const getSnapshot = useCallback(
    () => cellStore.getCell(rowId, columnId) ?? EMPTY,
    [rowId, columnId],
  );
  const cell = useSyncExternalStore(subscribe, getSnapshot);

  const meta = STATUS_META[cell.status];
  const isRunning = cell.status === "running";

  return (
    <div
      className={
        `cc-cell cc-cell--${meta.tone}${meta.band ? " cc-cell--band" : ""}${editing ? " cc-cell--editing" : ""}` +
        // The range is one box, drawn from the outside edges of the cells on its perimeter. Giving
        // every selected cell its own outline instead draws a grid of little boxes, which reads as
        // "these cells are each selected" rather than "this block is selected" — and at 400 rows it
        // is a wall of lines.
        (selected ? " cc-cell--sel" : "") +
        (selected && edges?.top ? " cc-cell--sel-t" : "") +
        (selected && edges?.right ? " cc-cell--sel-r" : "") +
        (selected && edges?.bottom ? " cc-cell--sel-b" : "") +
        (selected && edges?.left ? " cc-cell--sel-l" : "")
      }
      style={{ width }}
      role="gridcell"
      aria-colindex={colIndex}
      data-cc-cell={cellKey}
      tabIndex={active ? 0 : -1}
      data-status={cell.status}
      // A single click SELECTS. Opening the detail popover is a reasonable call while a cell cannot
      // be typed into, but the moment cells are editable, a click that
      // throws a panel over the grid makes the grid unusable for the thing a grid is for. Details
      // stay one keystroke (Space) and one click (the expand icon) away, both labelled.
      // `buttons`, not a React state flag: this fires on every cell the pointer crosses, and reading
      // the live button mask means a pointerup that happened over the header — or outside the window
      // entirely — cannot leave the grid stuck in a drag.
      onPointerEnter={(e) => { if (e.buttons === 1) onSelectOver?.(); }}
      onDoubleClick={() => onEdit?.()}
    >
      {/* The status slot shows the STATUS. Only ever that.
          It must not also serve as the hand-typed marker or the stale marker, both of which REPLACED
          the glyph — so the two states most worth knowing about a cell were the two that hid what
          the cell had actually done. A cell could be an error and show a hand. Those moved to the
          corner, where they sit alongside the status instead of standing in for it.
          Reserved width even when empty, so a state change costs no layout shift. */}
      <span className="cc-cell__status">
        <span aria-hidden="true"><StatusGlyph status={cell.status} /></span>
      </span>

      <span className="cc-cell__value truncate">
        {editing
          ? <CellInput seed={seed ?? ""} onCommit={onCommit} onCancel={onCancelEdit} />
          : isRunning ? <Elapsed startedAt={cell.startedAt} /> : <Value cell={cell} valueType={valueType} format={format} />}
      </span>

      {/* What is true of this cell ALONGSIDE its status, in the corner.
          A corner mark rather than words in the cell: the cell is for the value, and a value with an
          explanation appended to it is a value nobody can copy, sort or trust. The words live one
          click away in the details panel, where there is room to say what to do about them. */}
      {(cell.pinned || cell.stale) && !editing && (
        <span className="cc-cell__marks" aria-hidden="true">
          {cell.pinned && (
            <span className="cc-cell__mark cc-cell__mark--hand" title={handTitle(cell)}><IconPencilMark size={12} /></span>
          )}
          {cell.stale && (
            <span className="cc-cell__mark cc-cell__mark--stale" title={staleTitle(cell)}><IconStale size={10} /></span>
          )}
        </span>
      )}

      {/* The same two facts, for anything that cannot see a corner. `aria-hidden` on the marks and a
          live description here rather than a title on each: a screen reader reading "edited by you"
          in the middle of the value is worse than reading it after. */}
      {(cell.pinned || cell.stale) && (
        <span className="cc-sr-only">
          {cell.pinned ? handTitle(cell) : ""} {cell.stale ? staleTitle(cell) : ""}
        </span>
      )}

      {/* One button, one meaning. It used to render three different labels — "Cancel this cell",
          "Open details", "Run this cell" — that all called the same handler, so two of the three
          were untrue whichever way it was wired. It opens the detail popover; the action that fits
          the cell's state lives in there, where it is labelled by what it will actually do. */}
      <span className="cc-cell__action">
        <button
          className="hk-icon-btn cc-cell__btn"
          title="Cell details"
          aria-label="Cell details"
          // Part of the roving tab order, not outside it.
          //
          // It was hidden with `visibility: hidden`, which took it out of the tab order and made
          // the `:focus-within` rule that reveals it unreachable — a closed loop. Opacity fixed the
          // reveal but would have put all 440 rendered buttons into the tab order at once. Tied to
          // the active cell instead, the grid costs two tab stops however many cells are on screen.
          tabIndex={active ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation();
            // The id is DERIVED, not taken from the record.
            //
            // A cell that has never run has no row in the database, so the store falls back to a
            // placeholder whose id is "" — and `if (cell.id)` then made this button do nothing. The
            // panel was unreachable on precisely the cells whose emptiness needs explaining, which
            // is most of what anyone opens it for. Both halves of the id are already props here.
            onOpen?.(cell.id || `${rowId}:${columnId}`, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        >
          <IconExpand />
        </button>
      </span>

      {/* The fill handle: drag the corner of a selection to copy it down the column.

          A div rather than a button, and aria-hidden, because it is a pointer affordance with a
          full keyboard equivalent already in place — select a range with Shift+arrows and paste, or
          copy and paste. A tab stop per selection that does nothing on Enter would be a worse
          keyboard experience, not a better one.

          `stopPropagation` on the pointerdown: without it the cell beneath starts a NEW selection
          on the same event and the range being filled from is destroyed the instant the drag
          begins. */}
      {fillCorner && !editing && (
        <div
          className="cc-cell__fill"
          aria-hidden="true"
          title="Drag down to fill"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onFillStart?.(); }}
        />
      )}
    </div>
  );
});

/**
 * Why a hand-typed cell has to be marked.
 *
 * A typed value PINS the cell, and a pinned cell is never overwritten by a run. That is the right
 * behaviour — nobody wants their correction thrown away by the next run — but unmarked it produces
 * the worst kind of confusion: a column that fills every row except a few, with no reason visible
 * anywhere, and a user pressing Run again and again on cells that will never change.
 */
const handTitle = (cell: CellRecord): string =>
  cell.pinned
    // "Clear the cell to let the column fill it again" was the old second half, and it was never
    // true: clearing goes through the same write, so it re-pins the cell with an empty value and the
    // column still leaves it alone. The way back is the details panel, which is where it now points.
    ? "Typed in by hand. A run will leave this alone — open the details to give it back to the column."
    : "";

/**
 * Why a stale cell says so.
 *
 * Two different situations wear this flag, and the difference decides what to do about it. An
 * ordinary cell is stale because something it reads changed after it ran, and a re-run fixes it. A
 * cell somebody typed over is stale because what they typed no longer matches what the column
 * produces — nothing is broken, the two have simply diverged, and the fix is to choose between them.
 */
const staleTitle = (cell: CellRecord): string =>
  cell.pinned
    ? "Your value no longer matches what this column produces. Open the details to compare or restore."
    : "Out of date — something this cell reads changed after it ran.";

/**
 * The thing you actually type in.
 *
 * Uncontrolled, with the starting text as `defaultValue`. A controlled input here would push a
 * state change through the grid on every keystroke, and the grid re-renders a few hundred cells.
 *
 * Enter commits and moves DOWN, Tab commits and moves RIGHT, Escape abandons — the spreadsheet
 * conventions, because anything else is wrong to everyone who has used one. Blur commits too: a
 * click somewhere else is not an instruction to throw the typing away.
 */
function CellInput(
  { seed, onCommit, onCancel }:
  { seed: string; onCommit?: (v: string, move: "down" | "right" | "none") => void; onCancel?: () => void },
) {
  const done = useRef(false);
  /** Commit or cancel exactly once. Enter fires a blur on its way out, which would commit twice. */
  const finish = (fn: () => void) => { if (done.current) return; done.current = true; fn(); };

  /**
   * Commit what was typed when this box is REMOVED rather than left.
   *
   * Removing a focused element from the DOM does not fire blur in any browser, and the grid is
   * virtualized: a wheel spin that carries the edited row out of the window unmounts this input, so
   * the blur that was supposed to save the text never happens and the text is gone — silently, in
   * the one place in the product where losing a keystroke is unforgivable. Same shape as
   * `useAutosave`: the live value and the handler in refs, flushed from the unmount cleanup.
   *
   * Guarded on the text having CHANGED, not only on `done`. React runs an extra
   * mount → cleanup → mount pass in development, and flushing an untouched box on that pass would
   * burn the one-shot `done` flag and leave the real Enter, Tab and blur doing nothing at all.
   */
  const initial = useRef(seed);
  const latest = useRef(seed);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => () => {
    if (done.current || latest.current === initial.current) return;
    done.current = true;
    commitRef.current?.(latest.current, "none");
  }, []);

  /**
   * Grow to fit what is being typed.
   *
   * An <input> does NOT size to its value — its intrinsic width comes from the `size` attribute, so
   * `width: max-content` in the stylesheet did nothing and the box stayed at the column's width
   * however long the text got. Editing a URL in a 180px column then meant seeing twenty characters
   * of it at a time.
   *
   * Measured from scrollWidth, which is the width the content actually wants, and reset to nothing
   * first so the box can SHRINK again when text is deleted rather than only ever getting wider.
   */
  const fit = (el: HTMLInputElement | null) => {
    if (!el) return;
    el.style.width = "";
    const want = el.scrollWidth + 4;
    if (want > el.clientWidth) el.style.width = `${Math.min(want, 520)}px`;
  };

  return (
    <input
      className="cc-cell__edit"
      defaultValue={seed}
      autoFocus
      spellCheck={false}
      aria-label="Cell value"
      ref={fit}
      onInput={(e) => { latest.current = e.currentTarget.value; fit(e.currentTarget); }}
      onFocus={(e) => {
        fit(e.currentTarget);
        // Opened by typing a character: the caret goes after it rather than selecting it, so the
        // next keystroke continues the word instead of replacing it.
        const el = e.currentTarget;
        if (seed.length <= 1) el.setSelectionRange(el.value.length, el.value.length);
        else el.select();
      }}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(() => onCommit?.(e.currentTarget.value, "none"))}
      onKeyDown={(e) => {
        // Stopped here so the grid's own arrow/Enter handling does not also fire — inside an input,
        // Left and Right belong to the caret.
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(() => onCommit?.(e.currentTarget.value, "down")); }
        else if (e.key === "Tab") { e.preventDefault(); finish(() => onCommit?.(e.currentTarget.value, "right")); }
        else if (e.key === "Escape") { e.preventDefault(); finish(() => onCancel?.()); }
      }}
    />
  );
}

/** Done deliberately has NO glyph: a green tick on 150,000 cells is noise, and the presence of a
 *  value is already the signal. The audit affordance lives on hover instead. */
function StatusGlyph({ status }: { status: CellRecord["status"] }) {
  // A `stale` flag used to short-circuit this and render a dot INSTEAD of the status, so an
  // out-of-date error rendered as neither one. Stale is a corner mark now, and this answers only
  // the question it is named for.
  switch (status) {
    case "queued":
    case "blocked":
      return <span className="cc-glyph cc-glyph--ring" />;
    case "running":
      // A spinner on a genuinely in-progress operation is functional, not decorative — the ban is on
      // decorative "live" pulses. Under reduced motion the CSS stops the rotation and the elapsed
      // timer carries the liveness signal instead.
      return <span className="cc-glyph cc-glyph--arc" />;
    case "error":
      return <IconAlert />;
    case "skipped":
    // Same dash as skipped: both mean "this cell was not run", which is exactly what a stopped cell
    // is. An alert glyph here would read as a failure the user needs to investigate.
    case "cancelled":
      return <span className="cc-glyph cc-glyph--dash" />;
    default:
      return null;
  }
}

function Elapsed({ startedAt }: { startedAt?: number }) {
  const now = useSyncExternalStore(
    useCallback((l: () => void) => clock.subscribe(l), []),
    () => clock.now,
  );
  if (!startedAt) return <span className="cc-cell__meta">Running</span>;
  return <span className="cc-cell__meta mono">{elapsedLabel(startedAt, now)}</span>;
}

/**
 * Which kind of skip this was, from the sentence the engine already wrote.
 *
 * The same two shapes `explainBlanks` matches on, deliberately — the cell and the column header must
 * never disagree about why a row is blank, and the way they would drift is by classifying the same
 * message differently in two places. Anything unrecognised keeps the honest general word.
 */
function skipWord(message?: string): string {
  if (!message) return "Skipped";
  if (/condition/i.test(message)) return "Excluded";
  if (/nothing in /i.test(message)) return "No input";
  return "Skipped";
}

function skipTitle(message?: string): string {
  if (!message) return "This row did not run, so nothing was spent on it.";
  if (/condition/i.test(message)) {
    return `${message}\n\nYour run condition excluded this row on purpose. Nothing was spent, and nothing is wrong.`;
  }
  // The actionable one, and the reason a whole column can look broken: a required reference with no
  // value skips the row rather than paying for a request about nothing.
  return `${message}\n\nRunning the column again will skip it again. Fill the column it needs, or mark that reference optional.`;
}

function Value({ cell, valueType, format }: { cell: CellRecord; valueType?: ValueType; format?: ValueFormat }) {
  if (cell.status === "queued") return <span className="cc-cell__meta">Queued</span>;
  // The message first, falling back to the class. A cell reading "timeout" names the bucket it fell
  // into; "The model stopped without answering" is the thing the user can act on.
  if (cell.status === "error") {
    return <span className="cc-cell__err" title={cell.message ?? undefined}>{cell.message ?? cell.error ?? "Error"}</span>;
  }
  // Stopped is neither a success nor a failure — it is a cell that was interrupted. Styled as muted
  // rather than red, because colouring a user's own Stop as an error teaches them they broke
  // something. The reason is on hover and in the detail drawer.
  if (cell.status === "cancelled") {
    return (
      <span className="cc-cell__meta" title={cell.message ?? "Stopped before this finished."}>
        Stopped
      </span>
    );
  }
  // "Skipped" is a process word, not an answer, and it covers two opposite situations: the row had
  // nothing to work from, or your run condition deliberately excluded it. One is a problem and the
  // other is your rule working. The engine already recorded which — it arrives on the cell as
  // `message` — and this threw it away, so the grid showed the collapsed word and the reason was
  // only visible by opening the cell. The word itself now says which.
  if (cell.status === "skipped") {
    return <span className="cc-cell__meta" title={skipTitle(cell.message)}>{skipWord(cell.message)}</span>;
  }
  if (cell.status === "blocked") {
    return (
      <span
        className="cc-cell__meta"
        title={cell.message ?? "Something this cell reads failed first. Fix that column, then run this one again."}
      >
        Blocked
      </span>
    );
  }
  // The one people re-run most and should re-run least: it already looked.
  if (cell.status === "not_found") {
    return (
      <span
        className="cc-cell__meta"
        title={
          (cell.message ? `${cell.message} ` : "") +
          "It looked and the answer genuinely is not there. Running it again will cost the same and find the same nothing."
        }
      >
        Not found
      </span>
    );
  }
  if (cell.value == null || cell.value === "") return null;

  // A list renders as chips — one per item, bounded, the rest counted. Fan-out folds its answers
  // back as a JSON list, and one long bracketed string in a 32px row is how a feature that works
  // reads like one that does not. The raw value stays on the title and in every copy.
  const list = parseListValue(cell.value);
  if (list) {
    const shownItems = list.slice(0, LIST_CHIPS_SHOWN);
    const rest = list.length - shownItems.length;
    return (
      <span className="cc-cell__list" title={cell.value}>
        {shownItems.map((item, i) => (
          <span key={i} className="cc-cell__chip">{item}</span>
        ))}
        {rest > 0 && <span className="cc-cell__chip cc-cell__chip--more">+{rest}</span>}
      </span>
    );
  }

  // The one place formatting happens. A currency/percent column shows "$29.00" / "29%"; every other
  // type is returned unchanged by formatDisplay. The title stays the RAW value, so a hover and a
  // copy both give the number rather than the decorated string.
  const shown = formatDisplay(cell.value, valueType ?? "text", format);
  return <span title={cell.value.length > 40 || shown !== cell.value ? cell.value : undefined}>{shown}</span>;
}
