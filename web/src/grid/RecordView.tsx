// One row, as a page.
//
// A thirty-column table is unreadable a row at a time: the values you want to compare are 4,000px
// apart and you scroll sideways past twenty-eight you do not care about to see them together. That
// is the everyday complaint about a wide sheet, and no amount of pinning fixes it — pinning helps
// you keep your place, not see a whole record.
//
// So this is the transpose: the columns become a vertical list of labelled fields, and the record
// fits on one screen.
//
// KEYED ON POSITION IN THE CURRENT VIEW, not on a row id. That single decision is what makes
// previous/next inherit the grid's filter and its sort for nothing — page 40 of a filtered, sorted
// view is whatever `readRows` says it is, and the record page cannot drift from the grid it was
// opened out of. Keying on ids would have meant a second ordering here, maintained by hand, that is
// wrong the moment anything is filtered.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Column } from "../api.ts";
import { cellStore } from "../store/cellStore.ts";
import { STATUS_META } from "../types.ts";
import { ColumnKindIcon } from "../ui/ColumnKindIcon.tsx";
import { columnBadge } from "../ui/columnBadge.ts";
import { IconCaretDown, IconCaretUp, IconExpand } from "../ui/Icon.tsx";
import type { GridView } from "../view.ts";
import "./RecordView.css";

interface Field {
  column: Column;
  value: string;
  status: string;
  pinned: boolean;
  stale: boolean;
}

interface Props {
  sheetId: string;
  columns: Column[];
  /** 0-based index in the CURRENT view. The gutter shows this + 1. */
  position: number;
  /** Rows in the current view, for "3 of 1,204" and for bounding the arrows. */
  total: number;
  /** The grid's narrowing, so this page reads the same rows in the same order. */
  view: GridView;
  onGo: (position: number) => void;
  onClose: () => void;
  /** Open the cell detail panel — where the error, the attempts and the cost live. */
  onOpenCell: (cellId: string) => void;
  onNotice: (message: string) => void;
  canWrite: boolean;
  /**
   * The column that NAMES this row. Costs no extra request — the whole row is already loaded, so
   * this is a lookup in `fields`. Null falls back to the position count alone, which is what this
   * header showed for every row of every table before there was a way to say otherwise.
   */
  primaryColumnId?: string | null;
}

export function RecordView({
  sheetId, columns, position, total, view, onGo, onClose, onOpenCell, onNotice, canWrite,
  primaryColumnId,
}: Props) {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [rowId, setRowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every load so a slow response for a row you have already navigated away from cannot
  // paint over the row you are looking at now. Holding rows in flight by index is not enough —
  // arrowing down five times fires five requests that can land in any order.
  const load = useRef(0);

  useEffect(() => {
    const ticket = ++load.current;
    setFields(null);
    setError(null);
    // Grouping stripped: this `position` is the row's own place in the VIEW, and the grouped
    // endpoint paginates in DISPLAY space — headers interleaved — where the same number names a
    // different line. The record page reads rows, never display slots.
    api.readRows(sheetId, position, 1, { ...view, groupBy: null })
      .then((win) => {
        if (ticket !== load.current) return;
        const row = win.rows[0];
        if (!row) { setError("That row is not there any more."); return; }
        setRowId(row.id);
        setFields(
          columns.map((c) => {
            const cell = row.cells[c.id] as { s?: string; v?: string | null; pinned?: unknown; stale?: unknown } | undefined;
            return {
              column: c,
              // Only a `done` cell has a value worth showing. An error's message belongs in the cell
              // panel, not in the field where the value goes — printing it here would put the word
              // "error" in a box that looks exactly like the one holding real data.
              value: cell && cell.s === "done" ? String(cell.v ?? "") : "",
              status: cell?.s ?? "empty",
              pinned: !!cell?.pinned,
              stale: !!cell?.stale,
            };
          }),
        );
      })
      .catch(() => { if (ticket === load.current) setError("Could not read that row."); });
  }, [sheetId, position, view, columns]);

  const save = useCallback(async (field: Field, next: string) => {
    if (!rowId || next === field.value) return;
    const before = field.value;
    setFields((f) => f?.map((x) => (x.column.id === field.column.id ? { ...x, value: next, pinned: true, status: next ? "done" : "empty" } : x)) ?? null);
    try {
      const res = await fetch(`/api/cells/${rowId}:${field.column.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        // Put it back. An edit that was refused must not stay on screen looking accepted — the same
        // rule the grid follows, for the same reason.
        setFields((f) => f?.map((x) => (x.column.id === field.column.id ? { ...x, value: before } : x)) ?? null);
        onNotice(String(body?.error ?? "That change was not saved."));
        return;
      }
      // The grid is still mounted behind this page and holds the same cell. Told directly rather
      // than left to the live stream, so going back shows what you just typed.
      cellStore.applyDeltas([{
        i: `${rowId}:${field.column.id}`,
        r: (cellStore.getCell(rowId, field.column.id)?.rev ?? 0) + 1,
        s: next ? "done" : "empty",
        v: next || null,
      }]);
    } catch {
      setFields((f) => f?.map((x) => (x.column.id === field.column.id ? { ...x, value: before } : x)) ?? null);
      onNotice("That change was not saved — the engine did not answer.");
    }
  }, [rowId, onNotice]);

  const first = position <= 0;
  const last = position >= total - 1;

  // Alt+Up / Alt+Down step through records. Alt rather than the bare arrows because the fields on
  // this page are text boxes, and an arrow key inside one has to keep moving the caret.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "ArrowDown" && !last) { e.preventDefault(); onGo(position + 1); }
      else if (e.key === "ArrowUp" && !first) { e.preventDefault(); onGo(position - 1); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [position, first, last, onGo, onClose]);

  // The row's name, read out of the fields already on screen. Blank is treated as no label rather
  // than as an empty one, so a row whose name cell has not been filled in yet falls back to its
  // position instead of rendering a gap where a title should be.
  const label = primaryColumnId
    ? (fields?.find((f) => String(f.column.id) === String(primaryColumnId))?.value ?? "").trim() || null
    : null;

  return (
    <div className="cc-rec">
      <header className="cc-rec__head">
        <button className="cc-btn cc-btn--ghost" onClick={onClose}>← Back to the table</button>
        {/* The row's own name, when the table says which column holds it. Truncated rather than
            wrapped: a long company name must not grow the header and shift everything under it. */}
        {label && <span className="cc-rec__label truncate" title={label}>{label}</span>}
        <span className="cc-rec__count mono">
          Row {(position + 1).toLocaleString()} of {total.toLocaleString()}
        </span>
        <div className="cc-rec__nav">
          <button
            className="hk-icon-btn"
            disabled={first}
            onClick={() => onGo(position - 1)}
            aria-label="Previous row"
            title={first ? "This is the first row" : "Previous row  ·  Alt+↑"}
          >
            <IconCaretUp />
          </button>
          <button
            className="hk-icon-btn"
            disabled={last}
            onClick={() => onGo(position + 1)}
            aria-label="Next row"
            title={last ? "This is the last row" : "Next row  ·  Alt+↓"}
          >
            <IconCaretDown />
          </button>
        </div>
      </header>

      <div className="cc-rec__body">
        {error && <p className="cc-rec__error">{error}</p>}

        {/* Skeleton at the real shape and the real field count, so arriving data cannot shift the
            page. One row per column, at the height a filled field will be. */}
        {!fields && !error && (
          <div className="cc-rec__fields" aria-busy="true">
            {columns.map((c) => (
              <div className="cc-rec__field" key={c.id}>
                <div className="cc-rec__label"><span className="cc-skel" style={{ width: "60%" }} /></div>
                <div className="cc-rec__value"><span className="cc-skel" style={{ width: `${35 + ((c.id.length * 17) % 45)}%` }} /></div>
              </div>
            ))}
          </div>
        )}

        {fields && (
          <div className="cc-rec__fields">
            {fields.map((f) => {
              const locked = f.column.editable === false;
              const meta = STATUS_META[f.status as keyof typeof STATUS_META];
              return (
                <div className="cc-rec__field" key={f.column.id}>
                  <div className="cc-rec__label">
                    {/* Through `columnBadge`, not the raw kind. The badge vocabulary is smaller
                        than the kind union on purpose — several kinds share one mark — and it is
                        the same mapping the grid header and the cell panel use, so a column cannot
                        wear one icon here and another there. */}
                    <ColumnKindIcon kind={columnBadge(f.column).kind} title={columnBadge(f.column).title} />
                    <span className="truncate" title={f.column.description ?? f.column.name}>{f.column.name}</span>
                  </div>

                  <div className="cc-rec__value">
                    {locked || !canWrite ? (
                      /* Read-only, and it SAYS which. A field you cannot type into that looks
                         exactly like one you can is the same complaint as a dead button. */
                      <div
                        className="cc-rec__ro"
                        title={
                          locked
                            ? (f.column.lockedReason ?? `"${f.column.name}" is filled in by a run, not by hand.`)
                            : "Your account is read-only."
                        }
                      >
                        {f.value || <span className="cc-rec__empty">{meta && f.status !== "empty" ? meta.label : "Empty"}</span>}
                      </div>
                    ) : (
                      <AutoText value={f.value} onCommit={(v) => void save(f, v)} label={f.column.name} />
                    )}
                  </div>

                  <div className="cc-rec__marks">
                    {f.stale && <span className="cc-rec__mark" title="The value it was computed from has changed.">stale</span>}
                    {f.pinned && <span className="cc-rec__mark" title="Typed in by hand. A run will leave this alone.">by hand</span>}
                    <button
                      className="hk-icon-btn"
                      title="Cell details"
                      aria-label={`Details for ${f.column.name}`}
                      disabled={!rowId}
                      onClick={() => rowId && onOpenCell(`${rowId}:${f.column.id}`)}
                    >
                      <IconExpand />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A field that looks the same whether you are reading it or writing it.
 *
 * A borderless auto-growing textarea rather than an input in a box: a record page is mostly reading,
 * and a screen of thirty bordered boxes reads as a form to be filled in rather than as a record to
 * be looked at. It grows with its content, so a three-paragraph AI answer is all there instead of
 * hidden inside one scrolling line.
 *
 * Committed on blur and on Ctrl+Enter, NOT on every keystroke: a write here pins the cell and marks
 * everything downstream of it stale, and doing that per character would be thousands of writes and
 * a dependency graph recomputing under the cursor. Escape abandons.
 */
function AutoText({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Follows the prop when the RECORD changes underneath it — arrowing to the next row reuses this
  // component, and without this it would show the previous row's value in an editable box.
  useEffect(() => { setText(value); }, [value]);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(grow, [text]);

  return (
    <textarea
      ref={ref}
      className="cc-rec__input"
      rows={1}
      value={text}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); setText(value); (e.target as HTMLTextAreaElement).blur(); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onCommit(text); }
      }}
    />
  );
}
