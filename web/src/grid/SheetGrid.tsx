// The virtualized sheet surface.
//
// Windowing is two-axis: 30 columns wide matters as much as a million rows deep. Rows are a fixed
// height (--row-h), which removes the virtualizer's measurement pass entirely — and with it both the
// re-measure jank and every source of vertical layout shift.
//
// Data is fetched in pages as the viewport moves. The client never holds the whole sheet; the store
// evicts rows it has scrolled away from.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactElement } from "react";
import { useRowWindow } from "./useRowWindow.ts";
import { api, type Column } from "../api.ts";
import { viewQuery, isNarrowed, type GridView } from "../view.ts";
import { cellStore } from "../store/cellStore.ts";
import type { CellStatus } from "../types.ts";
import { Cell } from "./Cell.tsx";
import { ColumnProgress, type ColumnStats } from "./ColumnProgress.tsx";
import { ColumnName } from "./ColumnName.tsx";
import { ContextMenu, useContextMenu, type MenuItem } from "../ui/ContextMenu.tsx";
import { Popover } from "../ui/Popover.tsx";
import { WhyEmpty } from "./WhyEmpty.tsx";
import { useSession } from "../people/SessionGate.tsx";
import { COLUMN_COLORS, colorBand, colorDot, knownColor } from "./columnColors.ts";
import { IconCaretDown, IconCaretUp, IconCheck, IconPlay, IconPlus, IconMore, IconTrash } from "../ui/Icon.tsx";
import { columnBadge, sourceNameOf } from "../ui/columnBadge.ts";
import {
  fillValues, fromClipboardText, isSingle, paintTargets, rectHas, rectOf, toClipboardText,
  type CellRef, type Rect,
} from "./selection.ts";
import { ColumnKindIcon } from "../ui/ColumnKindIcon.tsx";
import "./SheetGrid.css";

/** For the `text/html` clipboard flavour. Values are user data and go into markup, so `&` and the
 *  angle brackets are escaped — a company name containing `<b>` must not become bold in Sheets. */
const escapeHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

const ROW_H = 32;
/** Mirrors --gutter-w. A pinned column parks to the RIGHT of the row numbers, which are already sticky. */
const GUTTER_W = 56;
const PAGE = 200;
const OVERSCAN_ROWS = 8;

/**
 * One dot for everything a row's cells are saying, in the gutter beside the number.
 *
 * Subscribed to the ROW, not to the grid: a delta lands mid-run and this dot moves without a
 * refetch, because the store's cells are already the live truth. Error outranks in-flight work,
 * which outranks staleness — a row with one failure is the row you go to, whatever else it is doing.
 * The words land in the aria-label; the dot itself says only that there is something to see.
 */
function RowBadge({ rowId }: { rowId: string }) {
  const key = useSyncExternalStore(
    (l) => cellStore.subscribeRow(rowId, l),
    () => cellStore.rowBadgeKey(rowId),
  );
  const badge = cellStore.rowBadge(rowId);
  if (!key || !badge) return null;
  const cls = badge.errors > 0 ? "cc-tr__dot--err" : badge.live > 0 ? "cc-tr__dot--live" : "cc-tr__dot--stale";
  const words = [
    badge.errors > 0 ? `${badge.errors} ${badge.errors === 1 ? "error" : "errors"}` : null,
    badge.live > 0 ? `${badge.live} ${badge.live === 1 ? "cell" : "cells"} in flight` : null,
    badge.stale > 0 ? `${badge.stale} ${badge.stale === 1 ? "value" : "values"} changed upstream` : null,
  ].filter(Boolean).join(" · ");
  return <span className={`cc-tr__dot ${cls}`} aria-label={words} title={words} />;
}

interface Props {
  sheetId: string;
  columns: Column[];
  onAddColumn: () => void;
  onOpenCell: (cellId: string, rect: DOMRect) => void;
  onEditColumn?: (column: Column) => void;
  onRunColumn?: (column: Column) => void;
  /** Per-column completion, keyed by column id. */
  columnStats?: Record<string, ColumnStats>;
  /** Live per-column counts from an active run, which override the cached stats while running. */
  liveRun?: { columnIds: number[]; done: number; errors: number; skipped: number; total: number } | null;
  /** Search / status / sort. Owned by the app, because the toolbar and a run scope need it too. */
  view: GridView;
  onViewChange: (v: GridView) => void;
  /** Resolves to an error message, or null when the rename succeeded. */
  onRenameColumn: (column: Column, name: string) => Promise<string | null>;
  onDeleteColumn?: (column: Column) => void;
  onRunCell?: (cellId: string) => void;
  /** Start a run with a prepared scope — the one-click "failed only" / "never run" items. */
  onRunScope?: (column: Column, scope: Record<string, unknown>, title: string) => void;
  /** Open the row-picker for a count or a range. */
  onRunRange?: (column: Column) => void;
  /** Open the JSON field picker for a column holding objects or lists. */
  onExpandJson?: (column: Column) => void;
  /** Send this table's data into another table — whole rows, or one row per item in a list. */
  onSendToTable?: (column: Column) => void;
  /** Put a new column at this index in the visible order. */
  onInsertColumn?: (atIndex: number) => void;
  /** Copy a column's whole definition, beside the original. */
  onDuplicateColumn?: (column: Column) => void;
  /** Keep this column as a template, to add to any table later. */
  onSaveTemplate?: (column: Column) => void;
  /** Write or change the sentence saying what this column is for. */
  onDescribeColumn?: (column: Column) => void;
  /** Open the filter builder already aimed at this column. */
  onFilterColumn?: (column: Column) => void;
  /** Open deduplication with this column as the thing to match on. */
  onDedupeColumn?: (column: Column) => void;
  /** Re-extract derived children after the source changed outside a run. */
  onRefreshDerived?: (column: Column) => void;
  /** Keep a column on screen while the rest scrolls. Only a leading run of columns can be pinned. */
  onPinColumn?: (column: Column, pinned: boolean) => void;
  /** The column that names a row, and the way to change it. */
  primaryColumnId?: string | null;
  onSetPrimaryColumn?: (columnId: string | null) => void;
  /**
   * Take a column out of the grid, as a VIEW change: it never touches what runs, filters or
   * exports, and the header's hidden-columns chip is the way back.
   */
  onHideColumn?: (column: Column) => void;
  /** The columns the current view is hiding, so the header can offer them back by name. */
  hiddenColumns?: Column[];
  onUnhideColumn?: (column: Column) => void;
  onUnhideAllColumns?: () => void;
  /** Put a column at a new place in the order. `toIndex` is a position in the visible order. */
  onMoveColumn?: (column: Column, toIndex: number) => void;
  /** Add one empty row at the end of the sheet. */
  onAddRow?: () => void;
  onRunRow?: (rowId: string) => void;
  onDeleteRow?: (rowId: string) => void;
  /** Delete a checkbox-selected set of rows in one undoable step. Resolves once they are gone. */
  onDeleteRows?: (rowIds: number[]) => Promise<void>;
  /** Every row id in the table, for the header "select all rows" checkbox. The grid is virtualized,
   *  so it cannot gather them itself. */
  onSelectAllRows?: () => Promise<number[]>;
  /** Selection mode, switched from the table's ⋯ menu. The checkboxes show only when it is on —
   *  hidden otherwise, because a hover-only control is one nobody finds. */
  selectMode?: boolean;
  /** Delete a checkbox-selected set of columns in one undoable step. */
  onDeleteColumns?: (columnIds: number[]) => Promise<void>;
  /**
   * Say something brief to the user — a refused edit, a write the server rejected.
   *
   * The grid had no way to speak. Every failure inside it was swallowed, which was survivable only
   * while nothing in here could fail on purpose; a refusal the user cannot see is a grid that
   * ignores keystrokes for no stated reason.
   */
  onNotice?: (message: string) => void;
  /**
   * A paste created rows, so anything counting them is now wrong.
   *
   * The grid owns its own total and updates it, but the breadcrumb and the table tabs are different
   * React trees reading their counts from their own requests. Adding a row through the "+ Row"
   * button already refreshes both; a paste that grew the table left them showing the count from
   * before it, with nothing on screen to say the number was stale.
   */
  onRowsAdded?: () => void;
  /**
   * Open one row on its own page, by its POSITION in the current view.
   *
   * Position rather than a row id, because the record page's previous/next reads through the same
   * `readRows` call the grid does — so it inherits the filter and the sort instead of maintaining a
   * second ordering that is wrong the moment anything is narrowed.
   */
  onOpenRecord?: (position: number) => void;
  /**
   * Deliberately write over a value a column produced for itself.
   *
   * Handed up rather than handled here: the confirm is a modal the app already owns the layer for,
   * and the grid should not start rendering dialogs over itself.
   */
  onOverrideCell?: (rowId: string, column: Column, current: string) => void;
}

export function SheetGrid({
  sheetId, columns, onAddColumn, onOpenCell, onEditColumn, onRunColumn, columnStats, liveRun,
  view, onViewChange, onRenameColumn, onDeleteColumn, onRunCell, onRunRow, onDeleteRow,
  onRunScope, onRunRange, onExpandJson, onSendToTable, onRefreshDerived, onPinColumn, onMoveColumn,
  primaryColumnId, onSetPrimaryColumn,
  onHideColumn, hiddenColumns, onUnhideColumn, onUnhideAllColumns,
  onAddRow, onInsertColumn, onDuplicateColumn, onSaveTemplate, onDescribeColumn, onFilterColumn, onDedupeColumn,
  onNotice, onOverrideCell, onRowsAdded, onOpenRecord, onDeleteRows, onDeleteColumns, onSelectAllRows, selectMode,
}: Props) {
  // Only decides whether to OFFER a control. Every one of these is checked again by the server on
  // the request itself, so this is presentation, not permission.
  const { me } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);
  // The same element as `scrollRef`, held in STATE as well.
  //
  // A ref is invisible to render: anything that reads `scrollRef.current` while rendering gets null
  // on the first pass and is never told when it fills in. Passing that null to a child as a prop
  // meant the header popover silently fell back to listening for window scroll — and the grid does
  // not scroll the window, so it never dismissed. Anything a CHILD needs must go through state.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const sortCol = view.sort ? String(view.sort.columnId) : null;
  const sortDir = view.sort?.dir ?? null;
  /**
   * Widths held here for the duration of a drag, over the stored value.
   *
   * The stored width is the source of truth; this map only holds one that has been changed in this
   * session and not yet come back from the server. Before, this map was the ONLY store — so a
   * widened column held until the next reload and then silently went back, which from the outside
   * is indistinguishable from the control not working.
   */
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The column whose colour is being picked, and colours changed but not yet echoed back. */
  const [coloring, setColoring] = useState<Column | null>(null);
  /** The column whose blanks are being explained. Anchored to its header, like the colour picker. */
  const [explaining, setExplaining] = useState<Column | null>(null);
  const [colors, setColors] = useState<Record<string, string | null>>({});
  const inFlight = useRef(new Set<number>());

  // ── grouping ─────────────────────────────────────────────────
  //
  // While a grouping is active the rows endpoint answers in DISPLAY space: headers interleave with
  // rows, so offset N names "the Nth line on screen", not "the Nth row". Pages are deduped by
  // display range (a header slot holds no row, so the store's own hasRow guard cannot vouch), the
  // headers land in a side map the render reads, and each row's own VIEW position is kept so the
  // record page opens the row the user clicked rather than the line number they clicked it at.
  const grouped = view.groupBy != null;
  const headerAt = useRef(new Map<number, { label: string | null; n: number }>());
  const rowPos = useRef(new Map<number, number>());
  const loadedPages = useRef(new Set<number>());

  // Subscribe to the store's structure VERSION, not to `total` — a page of rows arriving does not
  // change the row count, so a total-based snapshot would let React bail out and leave the grid on
  // skeletons forever.
  useSyncExternalStore(
    useCallback((l: () => void) => cellStore.subscribeGlobal(l), []),
    () => cellStore.version,
  );
  const total = cellStore.total;

  const win = useRowWindow(scrollRef, total, ROW_H, OVERSCAN_ROWS);

  // The column's stored width is the fallback, NOT 180. That constant was the reason a width could
  // never survive a reload: even once the server knew, the grid did not ask.
  const colWidth = useCallback((c: Column) => widths[c.id] ?? c.width ?? 180, [widths]);

  /**
   * The rendered width of a column.
   *
   * A CSS variable with the committed width as its FALLBACK, which is what makes the resize drag
   * cost nothing: `startResize` writes `--cw-<id>` on the scrollport on every pointermove and React
   * never re-renders. It was writing that variable already and no rule anywhere read it, so the
   * live feedback the comment promised did not exist — the column only jumped to its new width on
   * release. With no variable set this computes to exactly the same pixel value as before.
   */
  const colWidthCss = useCallback((c: Column) => `var(--cw-${c.id}, ${colWidth(c)}px)`, [colWidth]);

  // A STABLE onOpen for the cells.
  //
  // <Cell> is memoized so that one arriving value re-renders one leaf. That only works if every
  // prop it gets is stable, and the app hands this grid a fresh inline arrow on every one of its
  // renders — during a run the SSE handlers re-render it continuously, so the memo comparison
  // failed for all ~900 visible cells on every frame, defeating the whole point of the external
  // store. Routing the call through a ref makes the prop identity constant for the grid's lifetime
  // without pinning a stale handler.
  const openCellRef = useRef(onOpenCell);
  openCellRef.current = onOpenCell;
  const openCell = useCallback((cellId: string, rect: DOMRect) => openCellRef.current(cellId, rect), []);

  // ── row + column multi-select, for the checkbox bulk delete ────────────────────────────────────
  //
  // Two sets keyed by ID so a selection survives the virtual scroll (a row leaving the window does
  // not leave the set), and one is emptied when the other gains a member — deleting rows and deleting
  // columns are different actions, so the bulk bar is never ambiguous about which one it would do.
  const [selRows, setSelRows] = useState<Set<number>>(new Set());
  const [selCols, setSelCols] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const rowAnchor = useRef<number | null>(null); // by POSITION, for shift-range
  const colAnchor = useRef<number | null>(null); // by column index

  const clearSelection = useCallback(() => {
    setSelRows(new Set()); setSelCols(new Set());
    rowAnchor.current = null; colAnchor.current = null;
  }, []);

  // A new sheet is a new set of rows and columns; carrying a selection across would delete the wrong
  // things. Cleared on sheet change and whenever the column set shrinks (a delete elsewhere).
  useEffect(() => { clearSelection(); }, [sheetId, clearSelection]);
  // Leaving select mode drops whatever was selected, so the boxes and the bulk bar vanish together.
  useEffect(() => { if (!selectMode) clearSelection(); }, [selectMode, clearSelection]);

  const pickRow = useCallback((pos: number, id: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setSelCols(new Set());
    setSelRows((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && rowAnchor.current != null) {
        const lo = Math.min(rowAnchor.current, pos), hi = Math.max(rowAnchor.current, pos);
        // By position across the loaded window: a visible range selects fully; rows scrolled far out
        // of the window are not in the store to resolve, which is the honest limit of a virtual grid.
        for (let p = lo; p <= hi; p++) { const r = cellStore.getRowByPosition(p); if (r) next.add(Number(r.id)); }
      } else {
        if (next.has(id)) next.delete(id); else next.add(id);
        rowAnchor.current = pos;
      }
      return next;
    });
  }, []);

  const pickCol = useCallback((index: number, id: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setSelRows(new Set());
    setSelCols((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && colAnchor.current != null) {
        const lo = Math.min(colAnchor.current, index), hi = Math.max(colAnchor.current, index);
        for (let i = lo; i <= hi; i++) { const col = columns[i]; if (col) next.add(Number(col.id)); }
      } else {
        if (next.has(id)) next.delete(id); else next.add(id);
        colAnchor.current = index;
      }
      return next;
    });
  }, [columns]);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      // Both, when both are selected — "select all rows and columns" then delete clears the table
      // to nothing. Two separate calls so each is its own undoable step.
      if (selRows.size > 0) await onDeleteRows?.([...selRows]);
      if (selCols.size > 0) await onDeleteColumns?.([...selCols]);
      clearSelection();
    } finally {
      setDeleting(false);
    }
  }, [selRows, selCols, onDeleteRows, onDeleteColumns, clearSelection]);

  // Select-all, three ways. Rows come from the server (the grid only holds a window); columns are all
  // already here. Offered for the WHOLE table only — a narrowed view's "all rows" is a scope question
  // this does not answer, so the row and combined actions are disabled with a filter or search on,
  // rather than quietly pulling in hidden rows.
  const rowTotal = cellStore.total;
  const viewNarrowed = isNarrowed(view);
  const allRowsSelected = rowTotal > 0 && selRows.size >= rowTotal;
  const allColIds = useMemo(() => columns.map((c) => Number(c.id)), [columns]);
  const allColsSelected = allColIds.length > 0 && selCols.size >= allColIds.length;
  const [selectingAll, setSelectingAll] = useState(false);

  const selectAllRows = useCallback(async () => {
    if (!onSelectAllRows) return;
    setSelectingAll(true);
    // Capture the sheet/view before the fetch: if the user switches tables or changes the view while
    // the row-id request is in flight, its result belongs to the OLD sheet and must be dropped, or a
    // different table's row ids land in this one's selection. Mirrors ensurePage's generation guard.
    const issuedFor = generation.current;
    try {
      const ids = await onSelectAllRows();
      if (generation.current !== issuedFor) return;
      setSelCols(new Set()); setSelRows(new Set(ids)); rowAnchor.current = null;
    } finally { setSelectingAll(false); }
  }, [onSelectAllRows]);

  const selectAllCols = useCallback(() => {
    setSelRows(new Set());
    setSelCols(new Set(allColIds));
    colAnchor.current = null;
  }, [allColIds]);

  const selectAllBoth = useCallback(async () => {
    if (!onSelectAllRows) return;
    setSelectingAll(true);
    const issuedFor = generation.current;
    try {
      const ids = await onSelectAllRows();
      if (generation.current !== issuedFor) return;
      setSelRows(new Set(ids)); setSelCols(new Set(allColIds));
    } finally { setSelectingAll(false); }
  }, [onSelectAllRows, allColIds]);

  // The header corner toggles all rows: select them, or clear if they are already all selected.
  const toggleAllRows = useCallback(async () => {
    if (allRowsSelected) { clearSelection(); return; }
    await selectAllRows();
  }, [allRowsSelected, clearSelection, selectAllRows]);

  // Pinned columns, kept on screen while the rest scrolls under them.
  //
  // Only a LEADING run of them can be pinned, which is not a limitation so much as the only version
  // that means anything: a sticky column with scrollable columns to its left would slide over its own
  // neighbours. So the run stops at the first unpinned column, and everything after it scrolls.
  //
  // The offsets are cumulative and include the row-number gutter, because that is already sticky at
  // left: 0 — without adding it, the first pinned column parks underneath the row numbers.
  const pinLeft = useMemo(() => {
    const out = new Map<string, number>();
    let x = GUTTER_W;
    for (const c of columns) {
      if (!c.frozen) break;
      out.set(c.id, x);
      x += colWidth(c);
    }
    return out;
  }, [columns, colWidth]);

  /** Sticky placement for a pinned column, or nothing at all for an ordinary one. */
  const pinStyle = useCallback(
    (c: Column): CSSProperties =>
      pinLeft.has(c.id) ? { position: "sticky", left: pinLeft.get(c.id), zIndex: 2 } : {},
    [pinLeft],
  );
  const totalWidth = useMemo(
    () => columns.reduce((sum, c) => sum + colWidth(c), 0),
    [columns, colWidth],
  );

  // Serialized view, so the effects below depend on its VALUE rather than on object identity — the
  // app rebuilds the view object on every render, and an identity dependency would refetch forever.
  const viewKey = viewQuery(view);

  // Which sheet+view the store currently holds rows for.
  //
  // A page request issued for the PREVIOUS sheet must not be allowed to land. Switching tables (or
  // typing in search) while a fetch is in flight would write the old table's rows into the store,
  // and because `hasRow()` would then be true for those positions, `ensurePage` would early-return
  // forever and the new sheet's page would never arrive. Every visible cell rendered the EMPTY record, with the
  // wrong row count above it. The generation is captured before the await and compared after.
  const generation = useRef(`${sheetId}\u0000${viewKey}\u0000${view.groupBy ?? ""}`);
  generation.current = `${sheetId}\u0000${viewKey}\u0000${view.groupBy ?? ""}`;

  /** Fetch the page containing `position`, unless it is already loaded or in flight. */
  const ensurePage = useCallback(
    async (position: number) => {
      const pageStart = Math.floor(position / PAGE) * PAGE;
      if (inFlight.current.has(pageStart)) return;
      if (grouped) {
        if (loadedPages.current.has(pageStart)) return;
      } else if (cellStore.hasRow(position)) return;
      const issuedFor = generation.current;
      inFlight.current.add(pageStart);
      try {
        const win = await api.readRows(sheetId, pageStart, PAGE, view);
        // Answering a question nobody is asking any more. Dropping it is the only safe move: the
        // reset effect has already cleared the store for whatever is on screen now.
        if (generation.current !== issuedFor) return;
        if (grouped) {
          const g = win as unknown as {
            total: number;
            entries?: Array<
              | { kind: "header"; label: string | null; n: number }
              | { kind: "row"; row: { id: string; position: number; cells: Record<string, any> } }
            >;
          };
          const rows: Array<{ id: string; position: number; cells: Record<string, any> }> = [];
          (g.entries ?? []).forEach((e, i) => {
            const dseq = pageStart + i;
            if (e.kind === "header") {
              headerAt.current.set(dseq, { label: e.label ?? null, n: e.n ?? 0 });
            } else if (e.row) {
              headerAt.current.delete(dseq);
              rowPos.current.set(dseq, e.row.position);
              // The row lands under its DISPLAY slot: the grid's window math is display space now.
              rows.push({ ...e.row, position: dseq });
            }
          });
          loadedPages.current.add(pageStart);
          cellStore.setTotal(g.total);
          cellStore.ingestWindow(rows);
        } else {
          cellStore.setTotal(win.total);
          cellStore.ingestWindow(win.rows);
        }
      } catch {
        /* a failed page must not wedge the grid — the next scroll retries it */
      } finally {
        inFlight.current.delete(pageStart);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheetId, viewKey, grouped],
  );

  // A view change invalidates every loaded row: position 0 of a sorted or filtered sheet is a
  // different row than position 0 was. Reset rather than merge — merging would leave rows from the
  // previous ordering interleaved with the new one, which looks like corrupted data.
  //
  // Skeletons here are correct, unlike after a mutation: the rows really are unknown until the
  // server answers.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    inFlight.current.clear();
    headerAt.current.clear();
    rowPos.current.clear();
    loadedPages.current.clear();
    cellStore.reset();
    scrollRef.current?.scrollTo({ top: 0 });
    void ensurePage(0);
    // `sheetId` is named even though `ensurePage` already closes over it. Switching tables
    // invalidates the loaded rows exactly the way a view change does, and leaving that to a
    // dependency's identity makes the most important reset in the grid an accident of how another
    // callback happens to be memoized.
  }, [sheetId, viewKey, ensurePage]);

  // Load whatever the viewport is currently over. Runs on every windowing pass, but ensurePage
  // dedupes by page so it is one fetch per page regardless of how often this fires.
  //
  // Depends on the window's BOUNDS, not on `win.indices` — that is a fresh array on every render, so
  // an identity dependency re-ran this on every keystroke and every arriving cell. The indices are a
  // contiguous run from `firstRow`, so the bounds say the same thing and only change when the window
  // actually moves.
  const winCount = win.indices.length;
  useEffect(() => {
    for (let i = win.firstRow; i < win.firstRow + winCount; i++) void ensurePage(i);
  }, [win.firstRow, winCount, ensurePage]);

  // First paint: pull page 0 so the grid has something before any scroll happens.
  useEffect(() => {
    void ensurePage(0);
  }, [ensurePage]);

  // ── right-click menus ─────────────────────────────────────────
  //
  // One menu instance for the whole grid. Per-element state would add two hooks to every cell in a
  // virtualized surface, which is the one place here where per-element cost genuinely shows.
  const ctx = useContextMenu();
  // Where the last right-click landed, so "Cell details…" opens under the cursor rather than at the
  // corner of a 180px-wide cell.
  const pointer = useRef({ x: 0, y: 0 });
  const lastPointerRect = () =>
    new DOMRect(pointer.current.x, pointer.current.y, 0, 0);

  /**
   * Does this column actually hold JSON, whatever its declared type says?
   *
   * Looks at the loaded rows rather than the schema, because the declared type is a hint and the
   * cells are the fact. An HTTP column that keeps a whole reply is `text` until someone changes it,
   * and that is exactly the column somebody wants to expand.
   *
   * Only the window in memory is examined — a few dozen rows at most — so this stays a cheap read
   * with no request behind it. A `[` or `{` first character is enough of a test: the expand screen
   * parses properly and reports honestly if it finds nothing.
   */
  const holdsJson = (c: Column): boolean => {
    for (const i of win.indices.slice(0, 24)) {
      const v = cellStore.getRowByPosition(i)?.cells[c.id]?.value;
      if (typeof v !== "string") continue;
      const t = v.trimStart();
      if (t.startsWith("{") || t.startsWith("[")) return true;
    }
    return false;
  };

  /**
   * The column header menu.
   *
   * Grouped rather than listed: this is where nearly everything you can do to a column lives, and a
   * flat run of twenty items is a menu you read every time instead of aiming at. The bands are
   * about the column itself · making more columns · running it · what is inside its values ·
   * sending it elsewhere · how it is ordered and shown · destroying it, in that order — cheapest
   * and most common first, irreversible last and alone.
   */
  const columnMenu = (c: Column): MenuItem[] => [
    { label: "Rename", hint: "dbl-click", onSelect: () => setRenaming(c.id) },
    { label: "Edit column…", onSelect: () => onEditColumn?.(c) },
    {
      label: c.description ? "Edit description…" : "Add a description…",
      // The one sentence that makes a thirty-column sheet legible to anyone who did not build it.
      title: c.description ?? "Say what this column is for. It shows on hover over the header.",
      onSelect: () => onDescribeColumn?.(c),
    },
    { separator: true },
    {
      label: "Insert column left",
      onSelect: () => onInsertColumn?.(columns.indexOf(c)),
    },
    {
      label: "Insert column right",
      onSelect: () => onInsertColumn?.(columns.indexOf(c) + 1),
    },
    {
      label: "Duplicate column",
      title: "Same settings, empty values, placed beside this one",
      onSelect: () => onDuplicateColumn?.(c),
    },
    {
      label: "Keep as a template",
      title: "Save what this column does, to add to any table later",
      onSelect: () => onSaveTemplate?.(c),
    },
    { separator: true },
    // Above the run items on purpose. It is the question you ask BEFORE deciding to run again, and
    // its usual answer is "running again will not fix this" — which on a paid column is the
    // difference between a diagnosis and a second bill for the same silence.
    {
      label: "Why is this empty?",
      disabled: c.kind === "static",
      title: c.kind === "static"
        ? "A typed-in column is empty because nothing was typed in."
        : "What happened to the rows with no value, and whether running it again would help",
      onSelect: () => setExplaining(c),
    },
    {
      label: "Run this column",
      disabled: c.kind === "static",
      title: c.kind === "static" ? "A typed-in column has nothing to run." : undefined,
      onSelect: () => onRunColumn?.(c),
    },
    // The three answers people actually want, as one click each. "Failed" and "never run" are the
    // two that save real money: on a half-finished paid column, running everything again pays a
    // second time for every row that already worked.
    {
      label: "Retry only the failed rows",
      disabled: c.kind === "static",
      onSelect: () => onRunScope?.(c, { columnIds: [Number(c.id)], statuses: ["error"], force: false }, `Retry failed rows in "${c.name}"`),
    },
    {
      label: "Run only rows that never ran",
      disabled: c.kind === "static",
      // `cancelled` counts as never-run: a cell stopped mid-flight produced no value, and leaving it
      // out would make a stopped run impossible to finish off from this menu.
      onSelect: () => onRunScope?.(c, { columnIds: [Number(c.id)], statuses: ["empty", "cancelled"], force: false }, `Run unrun rows in "${c.name}"`),
    },
    /**
     * The other half of the cheap-first setting, and the ONLY way its expensive model gets used.
     *
     * A cheap model that was not sure does not escalate on its own — it keeps its answer, marks the
     * cell, and stops. This is where somebody decides those rows are worth paying for, and it goes
     * through the ordinary run dialog, so the cost is on screen before anything is spent.
     *
     * Offered only on a column that HAS a cheap first model. Everywhere else "the rows it was not
     * sure about" names a distinction that does not exist.
     */
    ...(c.firstModel
      ? [
          {
            label: "Run the better model on the unsure rows",
            title:
              `Rows the cheap model answered without being sure. They keep their value until this ` +
              `runs — nothing has escalated on its own.`,
            onSelect: () =>
              onRunScope?.(
                c,
                { columnIds: [Number(c.id)], unsure: true, useStrongModel: true, force: true },
                `Run "${c.model ?? "the better model"}" on unsure rows in "${c.name}"`,
              ),
          } as MenuItem,
        ]
      : []),
    {
      label: "Run rows…",
      hint: "range",
      disabled: c.kind === "static",
      title: c.kind === "static" ? "A typed-in column has nothing to run." : "Pick a count or a range of rows",
      onSelect: () => onRunRange?.(c),
    },
    { separator: true },
    // Offered on any column that HOLDS JSON, not only one declared as JSON.
    //
    // Gating on the declared type alone makes these two effectively invisible. A column that keeps
    // an API's whole reply is `text` unless somebody thought to change it, so the one case that most
    // needs expanding would be the one case never offered it, and the feature would read as missing
    // rather than as hidden. The declared type is a hint; what is actually in the cells is
    // the truth, and `holdsJson` reads the truth.
    ...(c.valueType === "json" || c.valueType === "array" || holdsJson(c)
      ? [
          { label: "Expand fields into columns…", onSelect: () => onExpandJson?.(c) } as MenuItem,
          // Runs already refresh derived children automatically. This is for the other way a source
          // changes — a hand edit or a re-import — where nothing would otherwise resync them.
          { label: "Refresh columns derived from this", title: "Re-extract the fields taken out of this column", onSelect: () => onRefreshDerived?.(c) } as MenuItem,
          { separator: true } as MenuItem,
        ]
      : []),
    {
      label: "Send to another table…",
      title:
        c.valueType === "json" || c.valueType === "array" || holdsJson(c)
          ? "Send these rows, or one row per item in this list"
          : "Send these rows into another table",
      onSelect: () => onSendToTable?.(c),
    },
    { separator: true },
    { label: "Sort A → Z", onSelect: () => onViewChange({ ...view, sort: { columnId: Number(c.id), dir: "asc" } }) },
    { label: "Sort Z → A", onSelect: () => onViewChange({ ...view, sort: { columnId: Number(c.id), dir: "desc" } }) },
    {
      label: "Clear sort",
      disabled: view.sort?.columnId !== Number(c.id),
      onSelect: () => onViewChange({ ...view, sort: null }),
    },
    { label: "Filter on this column…", onSelect: () => onFilterColumn?.(c) },
    {
      label: view.groupBy === Number(c.id) ? "Stop grouping by this" : "Group by this column",
      // The ordering is part of the deal, not a side effect to hide: a group scattered across the
      // sheet is not a group. The engine forces the sort too; saying it here is what keeps the
      // menu honest about why the rows moved.
      title:
        view.groupBy === Number(c.id)
          ? "Back to one row after another."
          : "One header per value, ordered by this column, each with its size. Runs and the record page are unaffected.",
      onSelect: () =>
        onViewChange(
          view.groupBy === Number(c.id)
            ? { ...view, groupBy: null }
            : { ...view, groupBy: Number(c.id), sort: { columnId: Number(c.id), dir: "asc" } },
        ),
    },
    {
      label: "Deduplicate on this column…",
      title: "Find rows that repeat the same value here",
      onSelect: () => onDedupeColumn?.(c),
    },
    { separator: true },
    {
      label: "Move left",
      hint: "drag",
      disabled: columns.indexOf(c) <= columns.filter((x) => x.frozen).length,
      onSelect: () => onMoveColumn?.(c, columns.indexOf(c) - 1),
    },
    {
      label: "Move right",
      hint: "drag",
      disabled: columns.indexOf(c) >= columns.length - 1,
      onSelect: () => onMoveColumn?.(c, columns.indexOf(c) + 1),
    },
    // Width had exactly one route in: dragging a 5px grip that carries no role, no tabindex and no
    // key handler. These two are the keyboard path — the same idiom as Move left/right, which is
    // likewise a menu item shadowing a drag.
    {
      label: "Widen this column",
      hint: "drag",
      onSelect: () => setWidth(c.id, colWidth(c) + 40),
    },
    {
      label: "Narrow this column",
      hint: "drag",
      disabled: colWidth(c) <= 72,
      title: colWidth(c) <= 72 ? "Already at the narrowest a column goes." : undefined,
      onSelect: () => setWidth(c.id, colWidth(c) - 40),
    },
    // Colour lives with the other "how this column is drawn" items, not up beside Rename: it is the
    // least consequential thing in the menu and the ordering is cheapest-and-most-common first.
    {
      label: knownColor(c.color) ? "Change colour…" : "Colour this column…",
      title: "Mark a group of columns so they read as one block",
      onSelect: () => setColoring(c),
    },
    {
      label: "Remove the colour",
      disabled: !knownColor(c.color),
      onSelect: () => setColor(c, null),
    },
    {
      label: c.frozen ? "Unpin from the left" : "Pin to the left",
      // Only a leading run can be pinned — a sticky column with scrolling columns to its left would
      // slide over its own neighbours. So pinning a column in the middle would have to move it, and
      // silently reordering someone's sheet from a menu item labelled "Pin" is worse than saying no.
      disabled: !c.frozen && columns.indexOf(c) !== columns.filter((x) => x.frozen).length,
      title:
        !c.frozen && columns.indexOf(c) !== columns.filter((x) => x.frozen).length
          ? "Only the leftmost unpinned column can be pinned — drag this one left first."
          : "Keep this column on screen while the rest scrolls",
      onSelect: () => onPinColumn?.(c, !c.frozen),
    },
    {
      label: String(c.id) === String(primaryColumnId) ? "Stop using as the row label" : "Use as the row label",
      // A row has to be called something. Without this every record page reads "Row 3 of 1,204",
      // which says where the row is and nothing about what it is.
      disabled: c.valueType === "json" || c.valueType === "array" || c.valueType === "file",
      title:
        c.valueType === "json" || c.valueType === "array" || c.valueType === "file"
          ? "A row cannot be named by a column that holds a whole object or list."
          : "Name each row by this column — shown on the record page and offered first when another table links here",
      onSelect: () =>
        onSetPrimaryColumn?.(String(c.id) === String(primaryColumnId) ? null : String(c.id)),
    },
    { separator: true },
    {
      label: "Hide this column",
      // The grid must keep one column to its name. The "why" is the whole point: a silently
      // disabled item reads as broken, and "hide the last column" reads as a reasonable ask.
      disabled: columns.length <= 1,
      title: columns.length <= 1
        ? "This is the only column showing — hide another one first."
        : "Off the grid, still in the table. It keeps running, filtering and exporting; the chip at the end of the header brings it back.",
      onSelect: () => onHideColumn?.(c),
    },
    { label: "Delete column", danger: true, onSelect: () => onDeleteColumn?.(c) },
  ];

  /** What the hidden-columns chip at the end of the header offers. */
  const hiddenMenu = (): MenuItem[] => [
    ...(hiddenColumns ?? []).map((c) => ({
      label: `Show “${c.name}”`,
      onSelect: () => onUnhideColumn?.(c),
    } as MenuItem)),
    { separator: true },
    { label: "Show all", onSelect: () => onUnhideAllColumns?.() },
  ];

  const cellMenu = (rowId: string, c: Column, value: string | null): MenuItem[] => [
    {
      label: "Copy value",
      disabled: !value,
      onSelect: () => { void navigator.clipboard?.writeText(value ?? ""); },
    },
    { label: "Cell details…", onSelect: () => onOpenCell(`${rowId}:${c.id}`, lastPointerRect()) },
    // Only where there is something to override. On a plain typed column the cell is already
    // editable and an "override" item would be a second, stranger way to do what typing does.
    ...(c.editable === false
      ? [{
          label: "Override this value…",
          title: c.lockedReason ?? undefined,
          onSelect: () => onOverrideCell?.(rowId, c, cellStore.getCell(rowId, c.id)?.value ?? ""),
        } as MenuItem]
      : []),
    {
      label: "Run this cell",
      disabled: c.kind === "static",
      title: c.kind === "static" ? "A typed-in column has nothing to run." : undefined,
      onSelect: () => onRunCell?.(`${rowId}:${c.id}`),
    },
    { separator: true },
    { label: `Run the "${c.name}" column`, disabled: c.kind === "static", onSelect: () => onRunColumn?.(c) },
  ];

  // Takes the row's POSITION as well as its id: the record page is keyed on position in the current
  // view, which is what lets its previous/next follow the same filter and sort the grid is under.
  const rowMenu = (rowId: string, position: number): MenuItem[] => [
    { label: "Open as a record", title: "This row on its own page, one field per line", onSelect: () => onOpenRecord?.(position) },
    { label: "Run this row", onSelect: () => onRunRow?.(rowId) },
    { separator: true },
    { label: "Delete row", danger: true, onSelect: () => onDeleteRow?.(rowId) },
  ];

  // ── keyboard navigation ───────────────────────────────────────
  //
  // ROVING TABINDEX. With tabIndex={-1} on every rendered cell and a scrollport that is not
  // focusable, Tab cycles the whole page twice without ever entering the grid, and the one surface
  // this product exists for cannot be reached without a mouse. Exactly ONE cell is in the
  // tab order at a time: Tab gets you in, the arrows move from there, and the tab order past the
  // grid stays a single stop however many thousand cells are on screen.
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  /**
   * The cell being typed into, and the text it started from.
   *
   * Owned here rather than by the cell, because editing moves: Enter commits and opens the cell
   * BELOW, and a cell cannot hand editing to a sibling it knows nothing about.
   */
  const [editing, setEditing] = useState<{ row: number; col: number; seed: string } | null>(null);
  /**
   * The other corner of the selection.
   *
   * `active` is the focus; this is where the range was started from. Held separately rather than as
   * a `{from,to}` pair so that every existing caller of `moveActive` keeps working unchanged and
   * simply collapses the selection, which is what an unmodified arrow key should do.
   *
   * Null means "the selection is just the active cell".
   */
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  /** The row a fill-handle drag has reached, while the pointer is still down. */
  const [fillTo, setFillTo] = useState<number | null>(null);
  const fillFrom = useRef<Rect | null>(null);
  // Set only when a key moved the target, so the effect below steals focus in response to a
  // deliberate move and never because a value happened to arrive.
  const wantFocus = useRef(false);
  // How many render passes the focus has waited for the virtualizer. Bounded, so a row that never
  // materialises — a page whose fetch failed — cannot spin this forever.
  const focusWaits = useRef(0);

  /**
   * Everything keyed on a ROW POSITION belongs to the rows that were just thrown away.
   *
   * The grid is not remounted when the app opens another table, and nothing here was tied to the
   * sheet, so a selection, a roving focus and an open editor all survived the switch — pointing at
   * positions in a table nobody is looking at any more. Row 500 of the new table is a different
   * record, and a Delete on a carried-over Ctrl+A range goes through `writeBlock` against those
   * positions. A view change has the same problem for the same reason: filtering re-numbers every
   * row underneath the selection.
   *
   * `explaining` and `coloring` are worse than stale positions — they hold a `Column` from the old
   * table outright, so the popover would edit a column that is not on screen.
   */
  useEffect(() => {
    setActive(null);
    setAnchor(null);
    setEditing(null);
    setRenaming(null);
    setExplaining(null);
    setColoring(null);
    fillFrom.current = null;
    setFillTo(null);
    wantFocus.current = false;
  }, [sheetId, viewKey]);

  /** Is the roving target on screen? When it is not, the scrollport takes the tab stop instead —
   *  otherwise scrolling away from the focused cell would make the grid unreachable by Tab again. */
  const activeRendered =
    !!active &&
    active.row >= win.firstRow &&
    active.row < win.firstRow + win.indices.length &&
    active.col < columns.length;

  const cellAt = (row: number, col: number): HTMLElement | null =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-cc-cell="${row}:${col}"]`) ?? null;

  /**
   * Move the roving target, clamped to the sheet.
   *
   * `extend` is Shift held down: the anchor stays where it is and the range grows to the new cell.
   * Without it the selection COLLAPSES — which is why the anchor is cleared here rather than at
   * every call site. Every plain arrow key, every click, every commit-and-move goes through this,
   * and a selection that outlived one of them would be a range the user cannot see the start of.
   */
  const moveActive = (row: number, col: number, extend = false) => {
    if (total === 0 || columns.length === 0) return;
    wantFocus.current = true;
    focusWaits.current = 0;
    const next = {
      row: Math.max(0, Math.min(total - 1, row)),
      col: Math.max(0, Math.min(columns.length - 1, col)),
    };
    if (extend) setAnchor((a) => a ?? active ?? next);
    else setAnchor(null);
    setActive(next);
  };

  /** The selected box, in view coordinates. Always at least the active cell. */
  const selection: Rect | null = active
    ? rectOf({ anchor: anchor ?? active, focus: active })
    : null;

  /**
   * What is actually drawn as selected.
   *
   * While a fill handle is being dragged this is the selection PLUS the rows the drag has reached,
   * so the user can see how far the fill will go before letting go. A fill you only find out the
   * extent of after it has been written is a fill nobody trusts.
   */
  const paint: Rect | null =
    fillFrom.current && fillTo !== null
      ? {
          ...fillFrom.current,
          top: Math.min(fillFrom.current.top, fillTo),
          bottom: Math.max(fillFrom.current.bottom, fillTo),
        }
      : selection;

  /**
   * Bring a row into the window.
   *
   * scrollIntoView is the wrong tool here: rows are positioned relative to the LIVE scroll offset
   * (baseOffset IS scrollTop), so scrolling the container by a delta moves the row by the same
   * delta and the browser chases it forever. The scroll position is computed from the row index
   * instead, through the same compression the window itself uses.
   */
  const revealRow = (row: number) => {
    const el = scrollRef.current;
    if (!el) return;
    // The header and the status strip are sticky ON TOP of the body, so the first couple of rows
    // under them are covered rather than visible.
    const COVERED = 2;
    const lastVisible = win.firstRow + Math.max(COVERED + 1, Math.floor(el.clientHeight / ROW_H) - 1);
    if (row >= win.firstRow + COVERED && row <= lastVisible) return;
    el.scrollTop = Math.max(0, ((row - COVERED) * ROW_H) / win.scale);
  };

  // Focus follows the active cell — but only once the virtualizer has actually rendered it, which is
  // why this re-runs on the window too. A jump normally takes two passes: the first scrolls the row
  // into range, the second takes the focus.
  useEffect(() => {
    if (!active || !wantFocus.current) return;
    revealRow(active.row);
    const el = cellAt(active.row, active.col);
    if (!el) {
      if (focusWaits.current++ > 4) wantFocus.current = false;
      return;
    }
    wantFocus.current = false;
    focusWaits.current = 0;
    // preventScroll, because the browser's own scroll-to-focus fights the row transforms exactly the
    // way scrollIntoView does. The horizontal nudge below is safe — it only moves scrollLeft.
    el.focus({ preventScroll: true });
    const sc = scrollRef.current;
    if (!sc) return;
    const box = sc.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // The row-number gutter is sticky over the left edge, so "at the left of the scrollport" and
    // "visible" are not the same thing.
    const leftEdge = box.left + GUTTER_W;
    if (r.left < leftEdge) sc.scrollLeft -= leftEdge - r.left;
    else if (r.right > box.right) sc.scrollLeft += r.right - box.right;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, win.indices, win.firstRow, win.scale]);

  /**
   * Begin editing a cell.
   *
   * `seed` is what the box starts with: the current value when this was opened deliberately (F2,
   * Enter, a double-click), or the character just typed when editing began by typing over the cell.
   */
  const beginEdit = useCallback((row: number, col: number, seed?: string) => {
    const r = cellStore.getRowByPosition(row);
    const c = columns[col];
    if (!r || !c) return;
    /**
     * A column that fills itself in is not typed into by accident.
     *
     * The refusal SAYS SO rather than doing nothing. A key that silently has no effect reads as a
     * broken grid, and the reason is the useful half — "this is pulled out of Company JSON" tells
     * you where to go, which is more than a disabled cursor does.
     *
     * The server refuses this too, and independently: this is the courtesy, that is the rule.
     */
    if (c.editable === false) {
      onNotice?.(c.lockedReason ?? `"${c.name}" is filled in by a run, not by hand.`);
      return;
    }
    const current = cellStore.getCell(r.id, c.id)?.value ?? "";
    setEditing({ row, col, seed: seed ?? String(current ?? "") });
  }, [columns, onNotice]);


  /**
   * Write a typed value.
   *
   * Optimistic, then reconciled with what the server actually stored — a hand edit also PINS the
   * cell and clears any error on it, and those come back in the response. Sent even when the text is
   * unchanged only if it really differs; retyping the same value would otherwise mark every
   * downstream cell stale for nothing.
   */
  const commitEdit = useCallback(async (row: number, col: number, value: string, move: "down" | "right" | "none") => {
    const r = cellStore.getRowByPosition(row);
    const c = columns[col];
    setEditing(null);
    if (move === "down") moveActive(row + 1, col);
    else if (move === "right") moveActive(row, col + 1);
    if (!r || !c) return;

    const before = cellStore.getCell(r.id, c.id)?.value ?? "";
    if (String(before ?? "") === value) return;

    /**
     * Undo the optimistic write. One definition, because it is now needed on three paths.
     *
     * `{i,r,s,v}` is the store's actual delta shape, and it is not optional. The store indexes
     * deltas on `d.i`, so passing `{id,status,value,rev}` and casting it to `never` to get past the
     * typechecker drops every delta on the floor and the optimistic paint never runs at all. What
     * makes the grid look responsive in that case is the
     * live stream arriving a moment later, and the rollback did nothing whatsoever.
     */
    const rollback = () =>
      cellStore.applyDeltas([{ i: `${r.id}:${c.id}`, r: nextRev(r.id, c.id), s: before ? "done" : "empty", v: before || null }]);

    cellStore.applyDeltas([{ i: `${r.id}:${c.id}`, r: nextRev(r.id, c.id), s: value ? "done" : "empty", v: value || null }]);
    try {
      const res = await fetch(`/api/cells/${r.id}:${c.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }),
      });
      /**
       * A REFUSAL is a rollback, not a silent success.
       *
       * With `.then(x => x.json())` and the old value restored only in the `catch`, any 4xx that
       * returns a valid JSON body leaves the typed value sitting on screen looking accepted. The cell
       * says one thing, the database says another, and nothing reconciles them until the next reload. Harmless while no request could be refused on purpose; the moment the
       * server can say "this column is not editable", it is the difference between a rule and a lie.
       */
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        rollback();
        onNotice?.(String(body?.error ?? "That change was not saved."));
        return;
      }
      if (body?.cell) {
        cellStore.applyDeltas([{
          i: `${r.id}:${c.id}`, r: Number(body.cell.rev), s: body.cell.status, v: body.cell.value ?? null,
        }]);
      }
    } catch {
      // Put the old value back rather than leaving a change on screen that never landed.
      rollback();
      onNotice?.("That change was not saved — the engine did not answer.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, onNotice]);

  /**
   * Empty a cell — Delete and Backspace.
   *
   * Its own function so that the key pair cannot call `commitEdit` directly, going round
   * `beginEdit` and therefore round every check `beginEdit` makes. On a derived column that single
   * key is the most destructive thing in the grid: the blank would be PINNED, and a pinned cell is
   * never refilled from its source again, with nothing on screen saying so.
   */
  const clearCell = useCallback((row: number, col: number) => {
    const c = columns[col];
    if (!c) return;
    if (c.editable === false) {
      onNotice?.(c.lockedReason ?? `"${c.name}" is filled in by a run, not by hand.`);
      return;
    }
    void commitEdit(row, col, "", "none");
  }, [columns, onNotice, commitEdit]);

  // ── clipboard ─────────────────────────────────────────────────
  //
  // Bound to the browser's own copy/cut/paste EVENTS, not to Ctrl+C in the key handler and
  // `navigator.clipboard`. Two reasons, and both are the difference between working and nearly
  // working: the async Clipboard API needs a permission prompt to READ, which turns every paste into
  // a dialog; and it is unavailable outside a secure context, which a plain http://localhost engine
  // sometimes is. The events carry `clipboardData` with no permission at all, they fire for the
  // platform's own shortcut whatever it is (⌘ on a Mac, Ctrl elsewhere), and they cover the browser
  // menu's Copy and Paste as well.

  /**
   * The revision an optimistic write should claim: exactly one past what the cell holds.
   *
   * NOT `Date.now()`. The store drops any delta whose revision is not newer than the one on screen,
   * and server revisions are small counters — so stamping an optimistic write with a millisecond
   * clock puts the cell permanently ahead of the engine, and every later update to it, from every
   * source, is silently discarded for the life of the page. One past the current value is enough to
   * win now and lose to the next real write, which is the whole contract.
   */
  const nextRev = (rowId: string, columnId: string): number =>
    (cellStore.getCell(rowId, columnId)?.rev ?? 0) + 1;

  /** A value as text, for the clipboard. Only a `done` cell has one — an error must never be copied
   *  out as the word "error", the same rule the CSV export follows. */
  const readCellText = useCallback((row: number, col: number): string => {
    const r = cellStore.getRowByPosition(row);
    const c = columns[col];
    if (!r || !c) return "";
    const cell = cellStore.getCell(r.id, c.id);
    return cell && cell.status === "done" ? String(cell.value ?? "") : "";
  }, [columns]);

  /**
   * Rows that have not been fetched cannot be copied, because their values are not here.
   *
   * The grid holds a window, not the sheet. A user who selects rows 1–5,000 with Ctrl+Shift+End and
   * copies has only ever loaded a couple of thousand of them, and the honest answer is to say so
   * rather than to write blanks into their clipboard and let them paste a hole into a CRM.
   */
  const unloadedIn = (rect: Rect): number => {
    let n = 0;
    for (let r = rect.top; r <= rect.bottom; r++) if (!cellStore.getRowByPosition(r)) n++;
    return n;
  };

  const onGridCopy = (e: React.ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    // A cell mid-edit owns its own clipboard: copying inside a text box must copy the selected TEXT,
    // not the block of cells behind it.
    if (editing || !selection) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;

    const missing = unloadedIn(selection);
    if (missing > 0) {
      e.preventDefault();
      onNotice?.(
        `${missing.toLocaleString()} of those rows are not loaded yet, so they would have copied as blanks. ` +
          "Scroll through them first, or export the filtered view as a CSV.",
      );
      return;
    }

    const grid: string[][] = [];
    for (let r = selection.top; r <= selection.bottom; r++) {
      const line: string[] = [];
      for (let c = selection.left; c <= selection.right; c++) line.push(readCellText(r, c));
      grid.push(line);
    }
    e.preventDefault();
    const text = toClipboardText(grid);
    e.clipboardData.setData("text/plain", text);
    // Also as a one-cell HTML table, which is what Excel and Sheets prefer when both are offered.
    // Without it, a value containing a line break pastes into Sheets as several rows however
    // correctly it was quoted, because Sheets only honours the quoting in its own HTML flavour.
    e.clipboardData.setData(
      "text/html",
      `<table>${grid.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</table>`,
    );

    if (cut) void writeBlock(paintTargets([[""]], selection), "Cut");
  };

  /**
   * Write a block of cells in ONE request.
   *
   * Never a loop of single-cell PUTs. A 200×5 paste is a thousand requests, a thousand undo entries
   * — enough to evict the entire session's history — and a half-written table the moment one of them
   * fails. The server takes the whole block, writes it in one transaction, and records one undo step.
   *
   * Rows past the end of the sheet are sent as `newRows` rather than dropped: a spreadsheet grows to
   * fit what you paste into it, and a paste that silently discarded its last forty rows is the kind
   * of loss nobody checks for.
   */
  const writeBlock = async (
    targets: Array<{ row: number; col: number; value: string }>,
    label: string,
  ): Promise<void> => {
    if (targets.length === 0) return;

    // Columns off the right edge are DROPPED, and it is said out loud. Growing the table sideways is
    // not what a paste means — a column here is a configured thing with a mode, a prompt and a cost,
    // not a slot — so the block is clipped and the notice names how much was clipped.
    const overWide = targets.filter((t) => t.col >= columns.length).length;
    const inBounds = targets.filter((t) => t.col < columns.length);

    const locked = [...new Set(inBounds.filter((t) => columns[t.col]?.editable === false).map((t) => columns[t.col]!.name))];
    if (locked.length > 0) {
      onNotice?.(
        `Nothing was written, because ${locked.map((n) => `"${n}"`).join(", ")} ` +
          `${locked.length === 1 ? "is" : "are"} filled in by a run, not by hand.`,
      );
      return;
    }

    const edits: Array<{ rowId: number; columnId: number; value: string }> = [];
    const appended = new Map<number, Record<string, string>>();
    for (const t of inBounds) {
      const col = columns[t.col]!;
      const row = cellStore.getRowByPosition(t.row);
      if (row) { edits.push({ rowId: Number(row.id), columnId: Number(col.id), value: t.value }); continue; }
      if (t.row < total) {
        // Inside the sheet but not in memory. Refused rather than guessed at: writing to a row this
        // client has never seen means addressing it by POSITION, and position under a filter and a
        // sort is a client-side belief the server does not share. Guessing wrong writes real values
        // into the wrong records, which is the single worst outcome available here.
        onNotice?.("Some of those rows have not loaded yet. Scroll them into view and paste again.");
        return;
      }
      const bucket = appended.get(t.row) ?? {};
      bucket[String(col.id)] = t.value;
      appended.set(t.row, bucket);
    }

    // Sorted by row so the new rows land in the order they were pasted, not in Map insertion order —
    // which is column-major for a multi-column paste and would scramble the block.
    const newRows = [...appended.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

    try {
      const res = await fetch(`/api/sheets/${sheetId}/cells/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits, newRows, label }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        onNotice?.(String(body?.error ?? "That paste was not saved."));
        return;
      }
      // Optimistic paint for the rows already on screen, so the block appears at once rather than on
      // the next SSE tick. The appended rows are not painted here — they have no position in the
      // window yet, and the row count coming back drives the refetch that brings them in.
      cellStore.applyDeltas(
        // `{i,r,s,v}` — the wire shape, NOT `{id,rev,status,value}`. The long-named version type-
        // checks only because the call sites cast it to `never`, and the store then looks the delta
        // up by `d.i`, which is undefined, and drops every one of them. An optimistic paint that
        // silently does nothing is worse than none: the code reads as if the grid updates at once
        // and the behaviour quietly depends on the live stream arriving.
        edits.map((e) => ({
          i: `${e.rowId}:${e.columnId}`,
          r: nextRev(String(e.rowId), String(e.columnId)),
          s: (e.value ? "done" : "empty") as CellStatus,
          v: e.value || null,
        })),
      );
      if (typeof body?.rowCount === "number") cellStore.setTotal(body.rowCount);
      // The rows the paste created are not in the window yet — they have no cells here to paint —
      // so the app refetches, which also corrects every OTHER count on screen.
      if (Number(body?.rowsAdded ?? 0) > 0) onRowsAdded?.();
      if (overWide > 0) {
        onNotice?.(
          `Pasted. ${overWide.toLocaleString()} ${overWide === 1 ? "value" : "values"} fell past the last column and ` +
            "were not written — a paste fills columns that exist, it does not add them.",
        );
      }
    } catch {
      onNotice?.("That paste was not saved — the engine did not answer.");
    }
  };

  const onGridPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selection) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    if (!me.can.write) { onNotice?.("Your account is read-only."); return; }

    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();

    const block = fromClipboardText(text);
    if (block.length === 0) return;
    void writeBlock(paintTargets(block, selection), "Paste");
  };

  /**
   * A fill drag ends wherever the button comes up, including outside the window.
   *
   * On `window`, not on the grid: releasing the mouse over the header, over the toolbar, or past the
   * edge of the browser is normal at the end of a drag, and a listener bound to the grid would miss
   * every one of them and leave the fill preview painted with no way to dismiss it.
   */
  useEffect(() => {
    if (fillTo === null) return;
    const up = () => commitFill(fillTo);
    // Escape abandons a fill in progress — the standard way out of a drag you started by accident.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      fillFrom.current = null;
      setFillTo(null);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillTo]);

  /** Commit a fill-handle drag. */
  const commitFill = (to: number) => {
    const source = fillFrom.current;
    fillFrom.current = null;
    setFillTo(null);
    if (!source || to === null) return;
    if (unloadedIn({ ...source, top: Math.min(source.top, to), bottom: Math.max(source.bottom, to) }) > 0) {
      onNotice?.("Some of those rows have not loaded yet. Scroll them into view and drag again.");
      return;
    }
    const targets = fillValues(source, to, readCellText);
    if (targets.length === 0) return;
    void writeBlock(targets, "Fill");
    // The selection grows to cover what was filled, the way it does in a spreadsheet — otherwise the
    // range you just created is invisible the moment you let go.
    setAnchor({ row: Math.min(source.top, to), col: source.left });
    setActive({ row: Math.max(source.bottom, to), col: source.right });
  };

  /** The way IN: the scrollport only holds a tab stop when no cell does, and it hands focus straight
   *  on rather than keeping it. */
  const onGridFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (total === 0 || columns.length === 0) return;
    moveActive(active ? active.row : win.firstRow, active ? active.col : 0);
  };

  /** The grid's key map. Bound to the scrollport so it catches keys wherever inside focus sits. */
  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const from = e.target as HTMLElement;
    // A control owns its own keys. The rename box lives in a header cell, and so do the sort, run
    // and edit buttons, the progress chip and each cell's details button — all inside this
    // scrollport. Without this, Space on the details button would be swallowed and an arrow key on
    // a header button would yank focus down into the body.
    if (from.closest("input, textarea, button, a[href], [contenteditable='true']")) return;
    // Only a cell, or the scrollport itself, drives the roving focus.
    if (from !== e.currentTarget && !from.closest("[data-cc-cell]")) return;

    const cur = active ?? { row: win.firstRow, col: 0 };
    // One screen, minus the two rows the sticky header covers, so a page turn overlaps rather than
    // skipping the rows that were under the header.
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 600) / ROW_H) - 2);

    // Shift on any movement key EXTENDS the selection instead of moving it, which is the whole of
    // range selection from the keyboard. `ext` is threaded through every case rather than handled in
    // four of them, because a movement key that quietly collapses a range the user built is worse
    // than one that does not extend it at all.
    const ext = e.shiftKey;

    switch (e.key) {
      case "ArrowDown":  e.preventDefault(); moveActive(cur.row + 1, cur.col, ext); return;
      case "ArrowUp":    e.preventDefault(); moveActive(cur.row - 1, cur.col, ext); return;
      case "ArrowRight": e.preventDefault(); moveActive(cur.row, cur.col + 1, ext); return;
      case "ArrowLeft":  e.preventDefault(); moveActive(cur.row, cur.col - 1, ext); return;
      // Ctrl widens Home/End from the row to the whole sheet, the way a spreadsheet does.
      case "Home":       e.preventDefault(); moveActive(e.ctrlKey ? 0 : cur.row, 0, ext); return;
      case "End":        e.preventDefault(); moveActive(e.ctrlKey ? total - 1 : cur.row, columns.length - 1, ext); return;
      case "PageDown":   e.preventDefault(); moveActive(cur.row + page, cur.col, ext); return;
      case "PageUp":     e.preventDefault(); moveActive(cur.row - page, cur.col, ext); return;
      /**
       * Tab moves one cell to the right and wraps onto the next row, as in every spreadsheet.
       *
       * This TAKES A KEY the browser owns, so it is deliberate: the grid's roving tabindex means
       * Tab would otherwise leave the grid entirely from any cell, and a user filling a row by hand
       * would be thrown out of the surface on every field. The way out is Escape, which returns the
       * tab stop to the scrollport.
       */
      case "Tab": {
        e.preventDefault();
        const last = columns.length - 1;
        if (e.shiftKey) {
          if (cur.col > 0) moveActive(cur.row, cur.col - 1);
          else if (cur.row > 0) moveActive(cur.row - 1, last);
        } else if (cur.col < last) moveActive(cur.row, cur.col + 1);
        else moveActive(cur.row + 1, 0);
        return;
      }
      default: break;
    }

    // Select the whole sheet — but only the columns, because "every row" of a million-row table is
    // not something the client holds and copying it would produce a file of blanks. The notice on
    // copy says so if they try.
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setAnchor({ row: 0, col: 0 });
      setActive({ row: total - 1, col: columns.length - 1 });
      return;
    }

    // Escape collapses a range back to one cell. Without it, a selection built with Shift+arrows can
    // only be cleared by clicking, which is a mouse dependency in the middle of a keyboard flow.
    if (e.key === "Escape" && anchor) {
      e.preventDefault();
      setAnchor(null);
      return;
    }

    // Everything below acts ON the focused cell, so it needs one that exists and has loaded.
    const row = cellStore.getRowByPosition(cur.row);
    const col = columns[cur.col];
    const node = cellAt(cur.row, cur.col);
    if (!row || !col || !node) return;

    // Enter and F2 EDIT; Space opens the details. Enter opening the details too would make it a
    // duplicate of Space, and leave the most-expected key in a grid doing the one thing a grid does
    // not need it to do.
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      beginEdit(cur.row, cur.col);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      onOpenCell(`${row.id}:${col.id}`, node.getBoundingClientRect());
      return;
    }
    // Delete and Backspace clear the cell — or the whole range, once there is one. Emptying 400
    // cells one request at a time is the same thousand-transaction problem a paste has, so a range
    // goes through the block writer and gets a single undo step.
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (selection && !isSingle(selection)) void writeBlock(paintTargets([[""]], selection), "Clear cells");
      else clearCell(cur.row, cur.col);
      return;
    }
    /**
     * Typing over a cell starts editing with that character.
     *
     * Guarded to a single printable key with no modifier, so Ctrl+C, Alt+Tab and every shortcut the
     * browser owns still reach it — the check is on the key's LENGTH, which is 1 for a character
     * and a word ("ArrowLeft", "Shift") for everything else.
     */
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      beginEdit(cur.row, cur.col, e.key);
      return;
    }
    // Shift+F10 and the Menu key are the keyboard's right-click. There is no pointer position to
    // open under, so the menu is aimed at the focused cell's own rect.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      ctx.openAt(
        r.left + 8,
        r.bottom,
        `${col.name} cell`,
        cellMenu(row.id, col, cellStore.getCell(row.id, col.id)?.value ?? null),
      );
    }
  };

  /** asc → desc → unsorted, the cycle a spreadsheet header is expected to have. */
  const toggleSort = (colId: string) => {
    const id = Number(colId);
    if (view.sort?.columnId !== id) { onViewChange({ ...view, sort: { columnId: id, dir: "asc" } }); return; }
    onViewChange({ ...view, sort: view.sort.dir === "asc" ? { columnId: id, dir: "desc" } : null });
  };

  /**
   * Dragging a column to a new place.
   *
   * Deliberately does NOT start on pointerdown. The header is already a click target (sort) and a
   * double-click target (rename), so a drag that begins on contact would eat both. It arms on
   * pointerdown and only becomes a drag past a small threshold, which is the difference between
   * "the header does three things" and "the header does one thing and fights you about it".
   *
   * The live feedback is a single insertion line rather than a moving ghost column: the question
   * being asked is "where will it land", and a line answers exactly that without the grid having to
   * re-render a thousand cells per frame.
   */
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; name: string; x: number; y: number } | null>(null);

  // Tears down whatever gesture is live. Held in a ref so it survives a re-render, and so unmounting
  // the grid mid-drag can call it: `pointerup` was the ONLY thing that removed the window listeners
  // and the body class, so a gesture the OS cancelled — an alt-tab, a touch turning into a system
  // swipe, a route change — left three window listeners attached and text selection disabled
  // app-wide until the page was reloaded.
  const endGesture = useRef<(() => void) | null>(null);
  useEffect(() => () => { endGesture.current?.(); }, []);

  const startDrag = (col: Column, from: number, startX: number) => {
    if (!onMoveColumn || col.frozen) return;
    // A second gesture cannot start on top of a live one.
    endGesture.current?.();
    let armed = false;

    // Measured once, at the start: the header cells do not move during the drag, and re-reading
    // rects on every pointermove is what makes this kind of interaction stutter.
    const heads = [...(scrollRef.current?.querySelectorAll(".cc-th") ?? [])]
      .slice(0, columns.length)
      .map((el) => el.getBoundingClientRect());

    const indexAt = (x: number): number => {
      for (let i = 0; i < heads.length; i++) {
        const r = heads[i]!;
        if (x < r.left + r.width / 2) return i;
      }
      return heads.length;
    };

    const onMove = (e: PointerEvent) => {
      if (!armed && Math.abs(e.clientX - startX) < 5) return;
      if (!armed) {
        armed = true;
        // Text selection is the thing that makes a hand-rolled drag feel broken: without this the
        // browser starts selecting header labels the moment the pointer moves, and the whole grid
        // lights up blue behind the drag.
        document.body.classList.add("cc-dragging-col");
      }
      // A pinned column stays pinned, and pinning only means anything for a LEADING run — so a
      // dragged column cannot be dropped in front of one without silently unpinning it.
      const floor = columns.filter((c) => c.frozen).length;
      const raw = indexAt(e.clientX);

      // Auto-scroll near the edges, so a column can reach a drop point that is off screen. Without
      // it, reordering across a thirty-column sheet is impossible: you run out of window before you
      // run out of columns.
      const box = scrollRef.current?.getBoundingClientRect();
      if (box) {
        const EDGE = 60;
        if (e.clientX < box.left + EDGE) scrollRef.current!.scrollLeft -= Math.ceil((box.left + EDGE - e.clientX) / 4);
        else if (e.clientX > box.right - EDGE) scrollRef.current!.scrollLeft += Math.ceil((e.clientX - (box.right - EDGE)) / 4);
      }

      setDrag({ id: col.id, from, to: Math.max(floor, raw > from ? raw - 1 : raw), name: col.name, x: e.clientX, y: e.clientY });
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("cc-dragging-col");
      endGesture.current = null;
    };

    const onUp = () => {
      detach();
      setDrag((d) => {
        if (d && armed && d.to !== d.from) onMoveColumn(col, d.to);
        return null;
      });
    };

    /** The OS took the pointer away. Abandon where it started rather than committing a move the
     *  user never released on. Also what unmounting mid-drag runs. */
    const onCancel = () => {
      detach();
      setDrag(null);
    };

    // Escape abandons the drag where it started. A drag with no way out is a drag people are afraid
    // to start on data they care about.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onCancel();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    endGesture.current = onCancel;
  };

  /** What colour a column is right now — an unsaved local choice wins over the stored one. */
  const colColor = useCallback(
    (c: Column) => knownColor(c.id in colors ? colors[c.id] : c.color),
    [colors],
  );

  /** Where a column's header is on screen, so the picker opens over the column it is about. */
  const colHeaderRect = useCallback((colId: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-col-id="${colId}"]`);
    return el ? { rect: el.getBoundingClientRect() } : null;
  }, []);

  /** Commit a colour. Optimistic for the same reason width is: the grid must not wait to repaint. */
  const setColor = (c: Column, color: string | null) => {
    setColors((prev) => ({ ...prev, [c.id]: color }));
    setColoring(null);
    void fetch(`/api/columns/${c.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ color }),
    }).catch(() => { /* the colour stays for this session rather than flickering back */ });
  };

  /**
   * Commit a width. Shared by the drag grip and the two menu items that give it a keyboard path.
   *
   * Held locally AND sent to the server. Locally so the grid does not wait on a round trip mid-drag;
   * sent, because presentation that vanishes on reload is not presentation, it is a bug that looks
   * like one. Fire-and-forget: a failed save leaves the width on screen for this session rather than
   * snapping the column back under the pointer that just set it.
   */
  const setWidth = (colId: string, w: number) => {
    const next = Math.max(72, Math.min(1200, Math.round(w)));
    scrollRef.current?.style.removeProperty(`--cw-${colId}`);
    setWidths((prev) => ({ ...prev, [colId]: next }));
    void fetch(`/api/columns/${colId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ width: next }),
    }).catch(() => { /* see above */ });
  };

  const startResize = (colId: string, startX: number, startW: number) => {
    endGesture.current?.();
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      endGesture.current = null;
    };
    const onMove = (e: PointerEvent) => {
      const w = Math.max(72, startW + (e.clientX - startX));
      // Width is written straight to a CSS variable during the drag, so a resize never re-renders
      // React. State is committed once, on release. See colWidthCss — every width consumer reads
      // this variable with the committed width as its fallback.
      scrollRef.current?.style.setProperty(`--cw-${colId}`, `${w}px`);
    };
    const onUp = (e: PointerEvent) => {
      detach();
      setWidth(colId, startW + (e.clientX - startX));
    };
    // Cancelled gestures keep the width they started with — the inline variable is dropped so the
    // rendered width takes over again.
    const onCancel = () => {
      detach();
      scrollRef.current?.style.removeProperty(`--cw-${colId}`);
    };
    // Escape abandons the resize at the width it started, the same way the reorder drag does. A drag
    // with no way out is one people hesitate to start on a column they have carefully sized. Dropping
    // the inline variable lets the committed width take back over.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    endGesture.current = onCancel;
  };

  return (
    <div className={`cc-grid${selectMode ? " cc-grid--selectmode" : ""}${selRows.size > 0 ? " cc-grid--rowselect" : ""}${selCols.size > 0 ? " cc-grid--colselect" : ""}`}>
      {/* aria-colcount counts EVERY column the grid renders — the row-number gutter, the data
          columns, and the add-column header — because each of them announces a colindex below.
          It said `columns.length + 1` while the header row held 13 columnheaders for 11 columns,
          which is a grid that describes itself wrongly to anything reading it.

          The scrollport takes the tab stop only while no cell holds one; see `activeRendered`. */}
      <div
        className="cc-grid__scroll"
        ref={attachScroll}
        role="grid"
        aria-rowcount={total}
        aria-colcount={columns.length + 2}
        tabIndex={activeRendered ? -1 : 0}
        onFocus={onGridFocus}
        onKeyDown={onGridKeyDown}
        // A click is a move too: the roving target follows the pointer, so tabbing back into the
        // grid returns to the cell last worked on rather than to wherever the keyboard left off.
        //
        // It also STARTS a selection, and does it here rather than on the cell so that the rows the
        // virtualizer has not filled in yet behave the same — those render as skeletons, not as
        // `Cell`s, and a drag passing over one would otherwise break in the middle.
        onMouseDown={(e) => {
          const target = e.target as HTMLElement;
          // A control inside a cell keeps its own click: the details button, the edit box.
          if (target.closest("button, input, textarea, a[href], [contenteditable='true']")) return;
          /**
           * The fill handle is NOT a place to start a selection.
           *
           * `stopPropagation` on the handle's own pointerdown does not help here: mousedown is a
           * SEPARATE event that follows it, and this listener sees that one. So grabbing the handle
           * collapsed the range to the single cell underneath it, and the fill then had nothing to
           * copy from — the gesture appeared to do nothing at all.
           */
          if (target.closest(".cc-cell__fill")) return;
          const key = target.closest<HTMLElement>("[data-cc-cell]")?.dataset.ccCell;
          if (!key) return;
          // Suppresses the browser's own text selection, which otherwise paints a blue drag across
          // the cell text and fights the range. Focus is not lost by it — `moveActive` takes focus
          // deliberately on the next pass.
          e.preventDefault();
          const [r, c] = key.split(":");
          moveActive(Number(r), Number(c), e.shiftKey);
        }}
        onCopy={(e) => onGridCopy(e, false)}
        onCut={(e) => onGridCopy(e, true)}
        onPaste={onGridPaste}
      >
        <div className="cc-grid__inner" style={{ width: totalWidth + 56 + 40 }}>
          {/* Header row — sticky, sentence case, every column sortable with aria-sort. */}
          <div className="cc-grid__header" role="row">
            <div className="cc-grid__gutter cc-grid__gutter--head" role="columnheader" aria-colindex={1} aria-label="Row number">
              {onDeleteRows && selectMode && rowTotal > 0 && (
                <button
                  type="button"
                  className={`cc-corner__check${allRowsSelected ? " cc-corner__check--all" : selRows.size > 0 ? " cc-corner__check--some" : ""}`}
                  role="checkbox"
                  aria-checked={allRowsSelected ? "true" : selRows.size > 0 ? "mixed" : "false"}
                  aria-label={allRowsSelected ? "Clear row selection" : "Select all rows"}
                  disabled={viewNarrowed || selectingAll}
                  title={
                    viewNarrowed ? "Select all covers the whole table — clear the filter and search first."
                    : allRowsSelected ? "Clear the selection"
                    : selectingAll ? "Selecting…"
                    : `Select all ${rowTotal.toLocaleString()} ${rowTotal === 1 ? "row" : "rows"}`
                  }
                  onClick={(e) => { e.stopPropagation(); void toggleAllRows(); }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {allRowsSelected
                    ? <IconCheck />
                    : selRows.size > 0
                      ? <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7" /></svg>
                      : null}
                </button>
              )}
            </div>
            {columns.map((c, ci) => {
              // Named `sorted`, not `active`: `active` is the roving-focus cell for the whole grid,
              // and shadowing it inside the header map is how the two got confused.
              const sorted = sortCol === c.id;
              return (
                <div
                  key={c.id}
                  className={`cc-th${pinLeft.has(c.id) ? " cc-th--pinned" : ""}${drag?.id === c.id ? " cc-th--dragging" : ""}${selCols.has(Number(c.id)) ? " cc-th--sel" : ""}`}
                  style={{ width: colWidthCss(c), background: colorBand(colColor(c)), ...pinStyle(c), zIndex: pinLeft.has(c.id) ? 4 : undefined }}
                  data-col-id={c.id}
                  role="columnheader"
                  aria-colindex={ci + 2}
                  aria-sort={sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  // The description, where it is useful: on the thing it describes. Written once,
                  // read by everyone who opens the sheet afterwards.
                  title={c.description || undefined}
                  onContextMenu={(e) => ctx.open(e, `${c.name} column`, columnMenu(c))}
                  onPointerDown={(e) => {
                    // Left button only, and never from the resize grip or a header button — those
                    // own their own gestures.
                    if (e.button !== 0) return;
                    if ((e.target as HTMLElement).closest(".cc-th__resize, .cc-th__menu, .cc-th__run, .cc-th__rename, .cc-th__check")) return;
                    startDrag(c, columns.indexOf(c), e.clientX);
                  }}
                >
                  {/* Where it would land. Full grid height, not just the header — the question is
                      "which side of this column", and a 34px tick at the top makes that guess. */}
                  {drag && drag.id !== c.id && drag.to === columns.indexOf(c) && (
                    <span className={`cc-th__drop${drag.from < columns.indexOf(c) ? " cc-th__drop--after" : ""}`} aria-hidden />
                  )}
                  {/* Select this column for a bulk delete. Hover-revealed, and it stays once anything is
                      selected. stopPropagation so a click selects rather than starting a reorder drag. */}
                  {renaming !== c.id && selectMode && (onDeleteColumns || selCols.size > 0) && (
                    <button
                      type="button"
                      className="cc-th__check"
                      role="checkbox"
                      aria-checked={selCols.has(Number(c.id))}
                      aria-label={`Select the ${c.name} column`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); pickCol(ci, Number(c.id), e); }}
                    >
                      <IconCheck size={12} />
                    </button>
                  )}
                  {/* What kind of column this is, before its name.
                      Identical headers say nothing about which columns spend money per row, which
                      are copies of another table, or which are fields pulled out of one
                      enrichment's answer. Hidden while renaming, so the box gets
                      the full width. */}
                  {renaming !== c.id && (() => {
                    const b = columnBadge(c, sourceNameOf(c, columns));
                    return <ColumnKindIcon kind={b.kind} title={b.title} />;
                  })()}
                  <ColumnName
                    name={c.name}
                    editing={renaming === c.id}
                    onEditingChange={(on) => setRenaming(on ? c.id : null)}
                    onSort={() => toggleSort(c.id)}
                    onRename={(next) => onRenameColumn(c, next)}
                  />
                  {renaming !== c.id && (
                    <span className="cc-th__caret" aria-hidden="true">
                      {sorted && sortDir === "asc" ? <IconCaretUp /> : sorted && sortDir === "desc" ? <IconCaretDown /> : null}
                    </span>
                  )}
                  {c.kind !== "static" && (
                    <button
                      className="hk-icon-btn cc-th__run"
                      aria-label={`Run ${c.name}`}
                      title={`Run "${c.name}" — you will see the row count before anything spends`}
                      onClick={() => onRunColumn?.(c)}
                    >
                      <IconPlay />
                    </button>
                  )}
                  {/* Opens the column editor drawer, so it says so. There is no aria-expanded to go
                      with it: this component is not told whether that drawer is open, and a state
                      attribute that is always "false" is worse than none. */}
                  <button
                    className="hk-icon-btn cc-th__menu"
                    aria-label={`Edit ${c.name}`}
                    aria-haspopup="dialog"
                    title="Edit column"
                    onClick={() => onEditColumn?.(c)}
                  >
                    <IconMore />
                  </button>
                  <span
                    className="cc-th__resize"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startResize(c.id, e.clientX, colWidth(c));
                    }}
                  />
                </div>
              );
            })}
            {/* Where hidden columns came back from. At the END of the header — exactly where the
                missing columns are — with the count as the label and the names on hover, so "the
                sheet is shorter than it was" has an answer on screen. */}
            {(hiddenColumns?.length ?? 0) > 0 && (
              <button
                type="button"
                className="cc-th cc-th--hiddenchip"
                style={{ width: 44 }}
                role="columnheader"
                aria-colindex={columns.length + 2}
                aria-label={`${hiddenColumns!.length} hidden ${hiddenColumns!.length === 1 ? "column" : "columns"}`}
                title={`Hidden: ${hiddenColumns!.map((c) => c.name).join(", ")}`}
                aria-haspopup="menu"
                onClick={(e) => ctx.open(e, "Hidden columns", hiddenMenu())}
              >
                +{hiddenColumns!.length}
              </button>
            )}
            <div className="cc-th cc-th--add" style={{ width: 40 }} role="columnheader" aria-colindex={columns.length + 3}>
              <button className="hk-icon-btn" onClick={onAddColumn} aria-label="Add column" title="Add column">
                <IconPlus />
              </button>
            </div>
          </div>

          {/* Per-column status row. Fixed height and always present — a column moving between
              "Up to date" and a running bar must not resize the header.

              Each chip is wrapped in a real gridcell. It was a `role="row"` holding bare buttons,
              which is a malformed row: a row's children have to be cells, and the interactive
              control then lives INSIDE its cell. */}
          <div className="cc-grid__statusrow" role="row">
            <div className="cc-grid__gutter cc-grid__gutter--head" role="gridcell" aria-colindex={1} />
            {columns.map((c, ci) => (
              <div
                key={c.id}
                role="gridcell"
                aria-colindex={ci + 2}
                className={pinLeft.has(c.id) ? "cc-grid__pinbg" : undefined}
                style={{ width: colWidthCss(c), flex: "0 0 auto", background: colorBand(colColor(c)), ...pinStyle(c), zIndex: pinLeft.has(c.id) ? 4 : undefined }}
              >
                <ColumnProgress
                  stats={columnStats?.[c.id]}
                  live={liveRun && liveRun.columnIds.includes(Number(c.id)) ? liveRun : null}
                  scrollContainer={scrollEl}
                />
              </div>
            ))}
            <div role="gridcell" aria-colindex={columns.length + 2} style={{ width: 40, flex: "0 0 auto" }} />
          </div>

          {/* Body. The spacer height is capped below the browser's element-height ceiling; rows are
              positioned relative to the live scroll offset rather than to absolute content space. */}
          <div className="cc-grid__body" style={{ height: win.spacerHeight }}>
            {win.indices.map((index) => {
              const header = grouped ? headerAt.current.get(index) : undefined;
              if (header) {
                const hy = win.baseOffset + (index - win.firstRow) * ROW_H;
                return (
                  <div
                    key={index}
                    className="cc-tr cc-tr--grp"
                    role="row"
                    aria-rowindex={index + 1}
                    style={{ transform: `translateY(${hy}px)`, height: ROW_H }}
                  >
                    <span className="cc-grp__label">{header.label ?? "blank"}</span>
                    <span className="cc-grp__n mono">
                      {header.n.toLocaleString()} {header.n === 1 ? "row" : "rows"}
                    </span>
                  </div>
                );
              }
              const row = cellStore.getRowByPosition(index);
              // The place this row occupies in the VIEW — the number the record page reads. Under
              // grouping the display slot counts headers, so the row's own position comes from the
              // page that delivered it.
              const viewPos = grouped ? (rowPos.current.get(index) ?? index) : index;
              const y = win.baseOffset + (index - win.firstRow) * ROW_H;
              return (
                <div
                  key={index}
                  // The row rises while one of its cells is being edited. A cell z-index cannot do
                  // this on its own: .cc-tr has will-change:transform, which makes every row its own
                  // STACKING CONTEXT, so the editor competed only inside its row and the next row
                  // painted over its bottom edge — the ring appeared open at the bottom.
                  className={`cc-tr${editing?.row === index ? " cc-tr--editing" : ""}${row && selRows.has(Number(row.id)) ? " cc-tr--sel" : ""}`}
                  role="row"
                  aria-rowindex={index + 1}
                  style={{ transform: `translateY(${y}px)`, height: ROW_H }}
                >
                  <div
                    className="cc-grid__gutter"
                    role="rowheader"
                    aria-colindex={1}
                    onContextMenu={(e) => { if (row) ctx.open(e, `Row ${index + 1}`, rowMenu(row.id, viewPos)); }}
                    /* The row NUMBER opens the record. It is the one part of a row that is not a
                       cell and had no behaviour at all, and "click the row to open it" is what a
                       gutter looks like it should do. Under grouping the record opens by the ROW's
                       own place in the view — the display slot counts headers, and the record page
                       does not. */
                    onClick={() => { if (row) onOpenRecord?.(viewPos); }}
                    title="Open this row as a record"
                  >
                    {/* The checkbox sits over the number: the number shows at rest, the box on hover or
                        once anything is selected, and clicking it selects instead of opening the row. */}
                    {row && selectMode && (onDeleteRows || selRows.size > 0) && (
                      <button
                        type="button"
                        className="cc-tr__check"
                        role="checkbox"
                        aria-checked={selRows.has(Number(row.id))}
                        aria-label={`Select row ${index + 1}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); pickRow(index, Number(row!.id), e); }}
                      >
                        <IconCheck size={12} />
                      </button>
                    )}
                    {row && <RowBadge rowId={row.id} />}
                    <span className="cc-tr__num mono">{index + 1}</span>
                  </div>
                  {row
                    ? columns.map((c, ci) => (
                        // Presentational: this wrapper only carries the pin geometry, and a plain div
                        // between a row and its cells breaks the row/cell relationship for anything
                        // reading the grid.
                        <div
                          key={c.id}
                          role="presentation"
                          className={`${pinLeft.has(c.id) ? "cc-grid__pinbg" : ""}${drag?.id === c.id ? " cc-cell--dragging" : ""}`.trim() || undefined}
                          style={
                            pinLeft.has(c.id) || drag?.id === c.id
                              ? { width: colWidthCss(c), flex: "0 0 auto", background: colorBand(colColor(c)), ...pinStyle(c) }
                              : { display: "contents" }
                          }
                          onContextMenu={(e) => {
                            pointer.current = { x: e.clientX, y: e.clientY };
                            ctx.open(e, `${c.name} cell`, cellMenu(row.id, c, cellStore.getCell(row.id, c.id)?.value ?? null));
                          }}
                        >
                          <Cell
                            rowId={row.id}
                            columnId={c.id}
                            width={colWidthCss(c)}
                            colIndex={ci + 2}
                            cellKey={`${index}:${ci}`}
                            /* So a currency/percent cell shows "$29.00" / "29%". Both come straight
                               off the stable column object, so they do not defeat the cell's memo. */
                            valueType={c.valueType}
                            format={c.format}
                            active={active?.row === index && active.col === ci}
                            /* A single cell is not "a selection" — the focus ring already says
                               where you are, and tinting it as well would mean the grid always
                               looks like something is selected. The tint starts at two cells. */
                            selected={!!paint && !isSingle(paint) && rectHas(paint, index, ci)}
                            edges={
                              paint && !isSingle(paint) && rectHas(paint, index, ci)
                                ? {
                                    top: index === paint.top,
                                    bottom: index === paint.bottom,
                                    left: ci === paint.left,
                                    right: ci === paint.right,
                                  }
                                : undefined
                            }
                            /* No handle while a fill drag is in flight — it is under the pointer,
                               and re-grabbing it mid-drag would nest one fill inside another. */
                            fillCorner={
                              !!selection && me.can.write && fillTo === null &&
                              index === selection.bottom && ci === selection.right
                            }
                            onSelectOver={() => {
                              if (fillFrom.current) setFillTo(index);
                              else moveActive(index, ci, true);
                            }}
                            onFillStart={() => { fillFrom.current = selection; setFillTo(index); }}
                            onOpen={openCell}
                            editing={editing?.row === index && editing.col === ci}
                            seed={editing?.row === index && editing.col === ci ? editing.seed : undefined}
                            /**
                             * Double-click EDITS an editable cell and OPENS THE DETAILS on a locked
                             * one.
                             *
                             * A deliberate two-click gesture on a cell you cannot type into should
                             * answer "why not" rather than do nothing — and the answer, the error if
                             * there is one, and the way to override it all live in that panel. The
                             * branch is here rather than in `Cell`, which stays unaware of any of it.
                             */
                            onEdit={() => {
                              if (c.editable === false) {
                                const node = cellAt(index, ci);
                                if (node) openCell(`${row.id}:${c.id}`, node.getBoundingClientRect());
                                return;
                              }
                              beginEdit(index, ci);
                            }}
                            onCommit={(v, move) => void commitEdit(index, ci, v, move)}
                            onCancelEdit={() => { setEditing(null); moveActive(index, ci); }}
                          />
                        </div>
                      ))
                    : columns.map((c, ci) => (
                        // Skeleton at exactly ROW_H, so a page arriving cannot change the row's size.
                        // Width is derived from the indices, not random, so it holds steady across
                        // frames instead of flickering.
                        //
                        // It carries the same roving-focus attributes as a real cell: arrowing into a
                        // page that has not loaded yet must move the focus, not drop it.
                        <div
                          key={c.id}
                          className={`cc-cell cc-cell--skeleton${pinLeft.has(c.id) ? " cc-grid__pinbg" : ""}`}
                          style={{ width: colWidthCss(c), ...pinStyle(c) }}
                          role="gridcell"
                          aria-colindex={ci + 2}
                          aria-busy="true"
                          data-cc-cell={`${index}:${ci}`}
                          tabIndex={active?.row === index && active.col === ci ? 0 : -1}
                        >
                          <span className="cc-skel" style={{ width: `${40 + ((index * 7 + c.id.length * 13) % 45)}%` }} />
                        </div>
                      ))}
                  <div className="cc-cell cc-cell--pad" style={{ width: 40 }} role="gridcell" aria-colindex={columns.length + 2} />
                </div>
              );
            })}
          </div>

          {/* What is being dragged, following the pointer. The column itself dims in place; this is
              the piece that stays with the hand, which is what makes the gesture read as carrying
              something rather than as the header having gone strange. */}
          {drag && (
            <div className="cc-dragchip" style={{ left: drag.x, top: drag.y }} aria-hidden>
              <span className="truncate">{drag.name}</span>
              <span className="cc-dragchip__to mono">{drag.to === drag.from ? "here" : `${drag.to + 1}`}</span>
            </div>
          )}

          {/* Add a row where a spreadsheet actually grows: under the last one.
              
              Sticky to the left edge so it stays reachable on a thirty-column sheet, and it shrinks
              to its own content rather than stretching a button across the full grid width. */}
          {onAddRow && (
            <div className="cc-grid__addrow">
              {/* Disabled rather than hidden for a read-only account. A control that vanishes reads
                  as a missing feature; one that explains itself reads as the permission it is. */}
              <button
                className="cc-btn cc-btn--ghost cc-btn--xs"
                disabled={!me.can.write}
                onClick={onAddRow}
                title={me.can.write ? "Add an empty row at the end" : "Your account is read-only. Ask an admin to make you a member."}
              >
                <IconPlus /> <span>Row</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <ContextMenu menu={ctx.menu} onClose={ctx.close} scrollContainer={scrollEl} />

      {/* The colour picker.

          Anchored to the column's own header rather than to the pointer, so it appears over the
          thing it is about — and the swatches paint live, because the only question worth answering
          here is "does this read well next to the columns beside it", which no label can answer. */}
      {/* Anchored to the column's header, like the colour picker, so it appears over the thing it
          is about rather than wherever the pointer happened to be. */}
      {explaining && (
        <WhyEmpty
          columnId={Number(explaining.id)}
          anchor={colHeaderRect(explaining.id)}
          onClose={() => setExplaining(null)}
          scrollContainer={scrollEl}
          /* "Show me one" opens that cell's DETAILS rather than scrolling to it. Scrolling would
             mean finding an arbitrary row's position inside a filtered, sorted million-row view,
             which is a server question — and the drawer is the better answer anyway: it shows what
             actually happened to that row, which is what the panel just claimed. */
          onGoToRow={(rowId) => {
            const col = explaining;
            setExplaining(null);
            onOpenCell(`${rowId}:${col.id}`, colHeaderRect(col.id)?.rect as DOMRect ?? lastPointerRect());
          }}
        />
      )}

      {coloring && (
        <Popover
          open
          anchor={colHeaderRect(coloring.id)}
          onClose={() => setColoring(null)}
          scrollContainer={scrollEl}
          width={196}
          role="dialog"
          label={`Colour for ${coloring.name}`}
          placement="bottom-start"
        >
          <div className="cc-colpick">
            <div className="cc-colpick__grid">
              {COLUMN_COLORS.map((c) => {
                const on = colColor(coloring) === c.id;
                return (
                  <button
                    key={c.id}
                    className={`cc-colpick__swatch${on ? " cc-colpick__swatch--on" : ""}`}
                    style={{ background: colorDot(c.id) }}
                    title={c.label}
                    aria-label={c.label}
                    aria-pressed={on}
                    onClick={() => setColor(coloring, c.id)}
                  />
                );
              })}
            </div>
            <button className="cc-colpick__none" onClick={() => setColor(coloring, null)}>
              No colour
            </button>
          </div>
        </Popover>
      )}

      {/* Selection bar. Present the whole time select mode is on — its "select all" buttons are how a
          whole-table selection is made — and it names exactly what is selected: rows, columns, or both.
          The delete is one undoable step per axis, so it acts on click, with Undo as the safety net. */}
      {(selectMode || selRows.size > 0 || selCols.size > 0) && (() => {
        const r = selRows.size, c = selCols.size;
        const parts: string[] = [];
        if (r > 0) parts.push(`${r.toLocaleString()} row${r === 1 ? "" : "s"}`);
        if (c > 0) parts.push(`${c.toLocaleString()} column${c === 1 ? "" : "s"}`);
        const label = parts.length ? `${parts.join(" and ")} selected` : "Nothing selected";
        const delNoun = r > 0 && c > 0 ? "rows & columns" : r > 0 ? `row${r === 1 ? "" : "s"}` : `column${c === 1 ? "" : "s"}`;
        const rowsBlocked = viewNarrowed || !onSelectAllRows;
        return (
          <div className="cc-bulkbar" role="region" aria-label="Selection actions">
            <span className="cc-bulkbar__count mono">{label}</span>
            <span className="cc-bulkbar__sep" aria-hidden />
            {/* The three whole-table selectors. Each shows as pressed when its set is fully chosen. */}
            <span className="cc-bulkbar__group">
              <span className="cc-bulkbar__lead">Select all</span>
              <button
                type="button"
                className={`cc-btn cc-btn--ghost cc-btn--sm${allRowsSelected && c === 0 ? " is-on" : ""}`}
                onClick={() => void selectAllRows()}
                disabled={deleting || selectingAll || rowsBlocked}
                title={rowsBlocked ? "Select all rows covers the whole table — clear the filter and search first." : `Select all ${rowTotal.toLocaleString()} rows`}
              >
                Rows
              </button>
              <button
                type="button"
                className={`cc-btn cc-btn--ghost cc-btn--sm${allColsSelected && r === 0 ? " is-on" : ""}`}
                onClick={selectAllCols}
                disabled={deleting || selectingAll || allColIds.length === 0}
                title={`Select all ${allColIds.length} columns`}
              >
                Columns
              </button>
              <button
                type="button"
                className={`cc-btn cc-btn--ghost cc-btn--sm${allRowsSelected && allColsSelected ? " is-on" : ""}`}
                onClick={() => void selectAllBoth()}
                disabled={deleting || selectingAll || rowsBlocked || allColIds.length === 0}
                title={rowsBlocked ? "Selecting all rows covers the whole table — clear the filter and search first." : "Select every row and every column"}
              >
                Rows &amp; columns
              </button>
            </span>
            <span className="cc-bulkbar__sep" aria-hidden />
            <button
              type="button"
              className="cc-btn cc-btn--danger cc-btn--sm"
              onClick={() => void confirmDelete()}
              disabled={deleting || (r === 0 && c === 0)}
            >
              <IconTrash size={13} /> <span>{deleting ? "Deleting…" : `Delete ${delNoun}`}</span>
            </button>
            <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={clearSelection} disabled={deleting || (r === 0 && c === 0)}>
              Clear
            </button>
          </div>
        );
      })()}
    </div>
  );
}

