import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { api, connectStream, type Column, type Sheet, type UsageScope } from "./api.ts";
import { cellStore } from "./store/cellStore.ts";
import { SheetGrid } from "./grid/SheetGrid.tsx";
import { CellPanel, type OpenCell } from "./grid/CellPanel.tsx";
import { OverrideCell, type OverrideTarget } from "./grid/OverrideCell.tsx";
import { ColumnEditor } from "./prompt/ColumnEditor.tsx";
import { SheetTabs } from "./SheetTabs.tsx";
import { SheetMenu } from "./SheetMenu.tsx";
import { useSession } from "./people/SessionGate.tsx";
import { UndoBar } from "./UndoBar.tsx";
import { CommandPalette, type Command } from "./ui/CommandPalette.tsx";
import { Limits } from "./run/Limits.tsx";
import { RecordView } from "./grid/RecordView.tsx";
import { Select } from "./ui/Select.tsx";
import { Modal } from "./ui/Modal.tsx";
import { Toast } from "./ui/Toast.tsx";
import { SupportButton } from "./ui/SupportButton.tsx";
import { ContextMenu, useContextMenu, type MenuItem } from "./ui/ContextMenu.tsx";
import { EMPTY_VIEW, isNarrowed, savedViewToGrid, viewQuery, viewScope, type GridView } from "./view.ts";
import { RunStrip } from "./run/RunStrip.tsx";
import { FilterBar } from "./filter/FilterBar.tsx";
import { ViewBar } from "./filter/ViewBar.tsx";
import { ConfirmRun, type RunScopeRequest } from "./run/ConfirmRun.tsx";
import { RunScopeDialog } from "./run/RunScopeDialog.tsx";
import { ExpandJson } from "./grid/ExpandJson.tsx";
import { Sources } from "./sources/Sources.tsx";
import { Dedupe } from "./sources/Dedupe.tsx";
import { Schedules } from "./run/Schedules.tsx";
import { RestorePoints } from "./run/RestorePoints.tsx";
import { SaveTemplate, TemplateGallery } from "./prompt/Templates.tsx";
import { Home, type At as BrowserAt, type BrowserView } from "./home/Home.tsx";
import { Settings, isSettingsSection, type SettingsSection } from "./settings/Settings.tsx";
import { TableWizard } from "./setup/TableWizard.tsx";
import { Assistant } from "./setup/Assistant.tsx";
import { runStore } from "./run/runStore.ts";
import type { ColumnStats } from "./grid/ColumnProgress.tsx";
import { IconInbox, IconMoon, IconPlay, IconPlus, IconSearch, IconSettings, IconSparkle, IconSun } from "./ui/Icon.tsx";
import { Mark } from "./ui/Mark.tsx";
import { PathCrumb } from "./PathCrumb.tsx";
import "./App.css";

type Theme = "light" | "dark";

/**
 * What the status filter offers.
 *
 * `not_found` is deliberately grouped under "Ran successfully" rather than given its own entry: it
 * means the engine looked and the answer genuinely does not exist, which is a success. Listing it
 * beside "Failed" would teach exactly the wrong thing about it.
 */
const STATUS_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "error", label: "Failed" },
  { value: "empty", label: "Never run" },
  { value: "done,not_found", label: "Ran successfully" },
  { value: "skipped", label: "Skipped by a condition" },
];

/**
 * The address bar describes where the app is.
 *
 * The open table has been a query param since the tab bar arrived. The FILE BROWSER was not, so a
 * reload while standing in a folder dropped the user back into the grid, and there was no link to
 * a folder to send anyone. Same mechanism for both, so there is one description of the location
 * rather than two: `browse` names the sub-tab, `folder`/`workbook` name the place, and no `browse`
 * at all means the grid.
 *
 * Module scope on purpose — these touch no state, so they are stable identities and nothing
 * re-subscribes because of them.
 */
function urlToSheet(sheetId: string): void {
  const url = new URL(location.href);
  url.searchParams.set("sheet", sheetId);
  // `settings` goes too. Leaving it behind meant closing Settings put the grid on screen under an
  // address that still said ?settings=models — so a reload, or a link copied from the bar, went
  // somewhere other than where the user was standing.
  for (const k of ["browse", "folder", "workbook", "settings", "uscope", "uid"]) url.searchParams.delete(k);
  history.replaceState(null, "", url);
}

/**
 * Settings is a place, so it has an address.
 *
 * A modal with no URL cannot be linked to, drops you back in the grid on reload, and gives you no
 * way to point someone at the section you meant. The open table is kept in
 * the URL beside it, so coming back out lands where you were rather than on whatever sheet happens
 * to sort first.
 */
function urlToSettings(section: SettingsSection, usage?: { scope: UsageScope; id: string | null }): void {
  const url = new URL(location.href);
  url.searchParams.set("settings", section);
  // The usage report is ABOUT something, and that something is part of where you are standing — a
  // table's cost page has to survive a reload and be linkable, the same way the section does.
  // Written only for the usage section, so leaving it does not carry a stale scope around.
  if (section === "usage" && usage) {
    url.searchParams.set("uscope", usage.scope);
    if (usage.id) url.searchParams.set("uid", usage.id);
    else url.searchParams.delete("uid");
  } else {
    for (const k of ["uscope", "uid"]) url.searchParams.delete(k);
  }
  for (const k of ["browse", "folder", "workbook"]) url.searchParams.delete(k);
  history.replaceState(null, "", url);
}

/** The open table stays in the URL alongside it, so leaving the browser comes back to it. */
function urlToBrowser(at: BrowserAt): void {
  const url = new URL(location.href);
  url.searchParams.set("browse", at.view);
  if (at.workbookId) url.searchParams.set("workbook", at.workbookId);
  else url.searchParams.delete("workbook");
  if (at.folderId) url.searchParams.set("folder", at.folderId);
  else url.searchParams.delete("folder");
  // The settings keys go, for the same reason `urlToSheet` drops them: this address is now the file
  // browser, and an address that still says `settings=models` reopens Settings over it on the next
  // reload. `urlToSheet` had this and its twin did not, so the leak only appeared when Settings was
  // closed with NO table open — the one path that lands here instead of there.
  for (const k of ["settings", "uscope", "uid"]) url.searchParams.delete(k);
  history.replaceState(null, "", url);
}

/**
 * What a read-only account is told when it reaches for a control that spends.
 *
 * Names the rung and the ask, because "Forbidden" sends someone looking for a bug when the actual
 * next step is a sentence to an admin.
 */
const CANNOT_SPEND = "Running a column spends money, and your account is read-only. Ask an admin to make you a member.";

/** The same, for the controls that change data rather than spend. */
const CANNOT_WRITE = "Your account is read-only. Ask an admin to make you a member.";

export function App() {
  /**
   * Who is signed in, and what they may do.
   *
   * On a single-user install this is "nobody, everything allowed" and nothing below behaves any
   * differently. It is read here rather than passed in so that adding a permission check to a screen
   * does not mean threading a prop through every component between it and the root.
   *
   * Used only to decide what to DRAW. Every one of these questions is asked again by the server on
   * the request itself — a client that decided for itself would be a client that could be told to
   * decide differently.
   */
  const { me, reload: reloadSession } = useSession();

  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  /** Set when the FIRST read of the workspace failed, so "no sheets" is never claimed on no answer. */
  const [bootError, setBootError] = useState<string | null>(null);
  /** Bumped to dial a fresh EventSource — the honest alternative to reloading the page. */
  const [streamNonce, setStreamNonce] = useState(0);
  const [editing, setEditing] = useState<Column | null>(null);
  const [pendingRun, setPendingRun] = useState<{ scope: RunScopeRequest; title: string } | null>(null);
  const [columnStats, setColumnStats] = useState<Record<string, ColumnStats>>({});
  const [liveRun, setLiveRun] = useState<{ columnIds: number[]; done: number; errors: number; skipped: number; total: number } | null>(null);
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);

  // The cell panel and the column editor are the SAME right-hand inspector — both are fixed `right: 0`
  // full-height drawers, so with both open they overlap: the wider editor's left edge juts out from
  // behind the cell panel. They are mutually exclusive, so opening either closes the other. (Closing
  // and toggling still go through the raw setters — only the OPEN transitions need to clear a sibling.)
  //
  // Closing the editor could DISCARD work: it holds an unsaved rule until Save (everything else there
  // autosaves), while a cell panel has nothing to lose. So any transition that would unmount a dirty
  // editor — opening a cell over it, OR switching to a DIFFERENT column's editor — first raises the
  // editor's own "Discard changes?" prompt instead of pulling the drawer out from under the user. The
  // editor reports its dirty state and lends its guarded close through these refs; `editingIdRef` is
  // the column currently open, so switching back to the SAME column is not treated as losing it.
  const editorDirtyRef = useRef(false);
  const editorRequestCloseRef = useRef<null | (() => void)>(null);
  const editingIdRef = useRef<string | number | null>(null);
  useEffect(() => { editingIdRef.current = editing?.id ?? null; }, [editing]);

  /** True when unmounting the open editor now would drop an unsaved rule — so ask first, don't switch. */
  const guardDirtyEditor = useCallback((targetColumnId?: string | number): boolean => {
    if (!editorDirtyRef.current || !editorRequestCloseRef.current) return false;
    // Re-opening the SAME column is not a switch and must not nag; a cell (no id) always guards.
    if (targetColumnId != null && editingIdRef.current != null
        && String(targetColumnId) === String(editingIdRef.current)) return false;
    editorRequestCloseRef.current();
    return true;
  }, []);

  const openColumnEditor = useCallback((col: Column | null) => {
    if (col && guardDirtyEditor(col.id)) return;
    setOpenCell(null);
    setEditing(col);
  }, [guardDirtyEditor]);
  const openCellPanel = useCallback((cell: OpenCell | null) => {
    // Opening a cell would close a dirty editor. Ask first, through the editor's own guard, and leave
    // the cell for the next click once the drawer is actually shut — never drop the rule silently.
    if (cell && guardDirtyEditor()) return;
    setEditing(null);
    setOpenCell(cell);
  }, [guardDirtyEditor]);

  /**
   * The cell about to be written over by hand, on a column that produces its own value.
   *
   * Held at the app rather than in the grid: it is a modal, and the grid should not start rendering
   * dialogs over itself. Cleared on every close, never remembered — an override is a decision about
   * ONE cell, and a dialog that reopens on the last one is a decision made about the wrong cell.
   */
  const [overriding, setOverriding] = useState<OverrideTarget | null>(null);
  /**
   * What is ACTUALLY on screen, not what has been stored.
   *
   * `index.html` only stamps `data-theme` when localStorage holds one, and tokens.css applies dark
   * through `:root:not([data-theme="light"])` inside a `prefers-color-scheme` query — a path no
   * attribute reflects. Reading the attribute alone therefore said "light" on a first visit in a
   * dark-mode browser: the toggle showed a moon on an already-dark app, announced "Switch to dark
   * theme", and its first press only stamped the attribute the media query had already produced —
   * a visual no-op that took two clicks to get past.
   */
  const [theme, setTheme] = useState<Theme>(() => {
    const stamped = document.documentElement.getAttribute("data-theme");
    if (stamped === "dark" || stamped === "light") return stamped;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  // ── how the grid is being looked at ───────────────────────────
  const [view, setView] = useState<GridView>(EMPTY_VIEW);
  // The input's text is separate from the view's search term. Typing re-renders on every keystroke;
  // the VIEW only moves after a pause, because each change is a fresh server-side scan of every cell
  // in the sheet. Bound directly, "acme" would have run five of them.
  const [searchText, setSearchText] = useState("");
  useEffect(() => {
    if (searchText === view.search) return;
    const t = setTimeout(() => setView((v) => ({ ...v, search: searchText })), 250);
    return () => clearTimeout(t);
  }, [searchText, view.search]);

  /**
   * Replace the WHOLE view — a saved view, or "no view".
   *
   * The box and the view have to move together, and this is the only way they can. The debounce
   * above makes the input the owner of `view.search`, so setting the view alone loses: 250ms later
   * the box's untouched text is written back over the view's term. A saved view saved WITH a search
   * silently cleared itself a quarter of a second after being applied, and "All rows — no view"
   * could not clear a typed one. The Clear button already sets both; so does this.
   *
   * NOT used by the filter bar or the grid, which change one part of the view while the box may be
   * mid-word — those must leave `searchText` alone.
   */
  const applyView = useCallback((next: GridView) => {
    setSearchText(next.search);
    setView(next);
  }, []);

  // Narrowing changed, so every position means a different row now. See `recordAt`.
  useEffect(() => { setRecordAt(null); }, [view]);

  // The row count AFTER narrowing. It comes from the store rather than a second request, so it is
  // by construction the count of what the grid is showing.
  useSyncExternalStore(
    useCallback((l: () => void) => cellStore.subscribeGlobal(l), []),
    () => cellStore.version,
  );
  const visibleRows = cellStore.total;

  const sortOptions = useMemo(
    () => [
      { value: "none", label: "Table order" },
      ...columns.flatMap((c) => [
        { value: `${c.id}:asc`, label: `${c.name} ↑` },
        { value: `${c.id}:desc`, label: `${c.name} ↓` },
      ]),
    ],
    [columns],
  );

  // The Run button says what it will actually do. A button labelled "Run" that silently covers a
  // different set than the grid shows is the failure this whole view plumbing exists to prevent.
  const runTitle = isNarrowed(view)
    ? `Run every runnable column on the ${visibleRows.toLocaleString()} matching rows`
    : "Run every runnable column";

  // ── live stream ───────────────────────────────────────────────
  //
  // `streamNonce` is what the banner's "Try again" bumps: it tears this socket down and dials a new
  // one, rather than `location.reload()`, which throws away every unsaved thing on screen — an
  // open column rule, a half-typed description — to fix a socket.
  useEffect(() => {
    return connectStream({
      onCells: (deltas) => cellStore.applyDeltas(deltas),
      onRun: (run) => {
        runStore.upsert(run as never);
        const r = run as any;
        const active = r.status === "running" || r.status === "pending";
        // While a run is live the header reads ITS counters — re-querying per-column status costs
        // ~400ms per column on a million rows, so the database is only consulted once it finishes.
        setLiveRun(active ? { columnIds: r.columnIds ?? [], done: r.done, errors: r.errors, skipped: r.skipped, total: r.total } : null);
      },
      onColumnStats: (stats) => {
        setColumnStats((prev) => {
          const next = { ...prev };
          for (const s of stats as ColumnStats[]) next[String(s.columnId)] = s;
          return next;
        });
      },
      onOpen: () => setConnected(true),
      // A localhost app losing its server is the most likely real failure here, so it gets a visible
      // state rather than a UI that silently keeps claiming everything is fine.
      onError: () => setConnected(false),
    });
  }, [streamNonce]);

  const loadColumnStats = useCallback(async (sheetId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/column-stats`).then((r) => r.json());
      const map: Record<string, ColumnStats> = {};
      for (const s of res.stats ?? []) map[String(s.columnId)] = s;
      setColumnStats(map);
      // Whether any column is still unmeasured. The request deliberately computes nothing — a cold
      // column costs ~400ms — so the first answer for a fresh sheet is always "not yet".
      return (res.stats ?? []).every((s: ColumnStats) => s.computedAt);
    } catch {
      // The header degrades to no bars rather than blocking the grid. Reported as "not settled" so
      // the poll below tries again.
      return false;
    }
  }, []);

  /**
   * Keep asking until every column has been measured.
   *
   * The numbers arrive over SSE as the background warmer produces them, and that was the ONLY way
   * they arrived — one push, no retry. Miss it and the header sat on "…" forever: a dropped stream,
   * an engine restart, or simply the warmer finishing before this tab subscribed, and the column
   * headers were stuck on a spinner with nothing on screen or off it that would ever ask again.
   * (Seen live: ten minutes on a three-row table whose stats had been sitting ready the whole time.)
   *
   * So the push is now an optimisation rather than the mechanism. This polls slowly, stops the
   * moment every column reports a real `computedAt`, and gives up after a minute rather than
   * hammering a server that is evidently not going to answer.
   *
   * It depends on the sheet's ID, not on the sheet OBJECT. `refreshSheet` replaces that object after
   * every mutation, so an object dependency tore this effect down and rebuilt it on each one — with
   * `tries` back at 0 and a fresh 1,200ms delay. The give-up-after-a-minute guarantee in the
   * paragraph above simply did not hold for anyone who was editing while it polled.
   */
  const [statsSettled, setStatsSettled] = useState(true);
  const statsSheetId = sheet?.id ?? null;
  useEffect(() => {
    if (statsSettled || !statsSheetId) return;
    let tries = 0;
    let live = true;
    const tick = async () => {
      if (!live) return;
      const done = await loadColumnStats(statsSheetId);
      if (!live) return;
      if (done || ++tries > 30) { setStatsSettled(true); return; }
      timer = setTimeout(() => void tick(), 2000);
    };
    let timer = setTimeout(() => void tick(), 1200);
    return () => { live = false; clearTimeout(timer); };
  }, [statsSettled, statsSheetId, loadColumnStats]);

  // An SSE push can settle it early — that is the fast path, and it is welcome when it works.
  useEffect(() => {
    if (statsSettled || columns.length === 0) return;
    if (columns.every((c) => columnStats[c.id]?.computedAt)) setStatsSettled(true);
  }, [columnStats, columns, statsSettled]);

  /**
   * SWITCH to a sheet. Drops everything belonging to the one being left.
   *
   * Kept strictly separate from `refreshSheet` below. They were briefly the same function, and the
   * result was that saving a column closed the editor you were saving from — because a save went
   * through the switch path, which clears the editor by design.
   */
  const openSheet = useCallback(async (id: string) => {
    const { sheet, columns, defaultView } = await api.getSheet(id);
    cellStore.reset();
    cellStore.setTotal(sheet.rowCount);
    setSheet(sheet);
    setColumns(columns);
    // The column editor is the one that bites: it would stay open showing a column from the previous
    // sheet and happily save against it.
    setEditing(null);
    setPendingRun(null);
    setColumnStats({});
    // How the PREVIOUS table was being looked at. A filter and a sort are written in terms of that
    // table's column ids, and those ids do not exist here — so the grid asked the new sheet for rows
    // matching a foreign column and narrowed to nothing, while the Sort trigger fell back to its
    // first option and read "Sheet order" over a sort that was very much still applied.
    // `applyView` rather than `setView`, so the search box empties with the view instead of typing
    // the old term back in a quarter of a second later.
    //
    // The table's own default view, when it has one, is applied INSTEAD of the empty one — through
    // the same `applyView`, and through the same `savedViewToGrid` the view bar uses, so opening a
    // table and picking that view from the bar cannot mean two different things. The clear above is
    // still what protects against the previous table's column ids; this replaces it in one step
    // rather than clearing and then narrowing, which would be two renders and a visible flash.
    applyView(defaultView ? savedViewToGrid(defaultView) : EMPTY_VIEW);
    // Everything else anchored to a column or a cell of the table being left.
    setOpenCell(null);
    setFilterRequest(null);
    setDescribing(null);
    setExpandJsonFor(null);
    setRunRangeFor(null);
    setRunRangeAll(false);
    setDedupeOpen(false);
    setDedupeStartWith(null);
    setSourcesOpen(false);
    setConfirmDeleteColumn(null);
    setConfirmDeleteRow(null);
    // The assistant's whole conversation is about the table it was opened on, and it reads the
    // sheet id from a prop — left open across a switch it kept answering about the previous one.
    setAssistantOpen(false);
    // Not settled until proven: a fresh sheet answers "nothing measured yet" and the poll above
    // takes it from there.
    setStatsSettled(false);
    void loadColumnStats(sheet.id).then(setStatsSettled);
    // The open table goes in the URL, so a reload comes back to it and a link points at it. Matters
    // more now that switching is one click on a tab rather than a deliberate trip to the switcher.
    // `urlToSheet` also clears the browser's half of the location — opening a table is leaving the
    // file browser, and a stale `browse=` would send the next reload back into it.
    urlToSheet(sheet.id);
    // The path follows the open table, so the header always says where this table lives rather than
    // only what it is called.
    void fetch(`/api/sheets/${sheet.id}/path`).then((r) => r.json()).then((res) => setPath(res.path ?? [])).catch(() => setPath([]));
  }, [loadColumnStats, applyView]);

  /**
   * REFRESH the sheet already open, after a mutation.
   *
   * Deliberately does not reset the cell store: that would drop every loaded row and put the grid
   * back to skeletons on a single column save, which is exactly the full-surface flash the reactive
   * rule forbids. Rows that changed arrive over the stream on their own.
   *
   * Resolves to the columns it read, or null when it could not read them. Every caller fires this
   * with `void` after a mutation, so a rejection had nothing on screen to attach itself to — and the
   * answer is what tells `onColumnsChanged` below whether the sheet's SHAPE actually changed.
   */
  const refreshSheet = useCallback(async (id: string): Promise<Column[] | null> => {
    try {
      const { sheet, columns } = await api.getSheet(id);
      cellStore.setTotal(sheet.rowCount);
      setSheet(sheet);
      setColumns(columns);
      void loadColumnStats(id).then((done) => { if (!done) setStatsSettled(false); });
      return columns;
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not re-read this table.");
      return null;
    }
  }, [loadColumnStats]);

  /**
   * Open a table from a control that cannot wait for it.
   *
   * Every one of those fires this with `void`, and `api.getSheet` throws on a refusal — so clicking a
   * table while the engine was restarting did nothing visible at all: the previous table stayed on
   * screen, the address bar had already been rewritten, and the only trace was an unhandled
   * rejection in a console nobody is reading.
   *
   * `boot` deliberately keeps calling `openSheet` directly. There, the same failure belongs on the
   * full-page "Can't read your tables" screen rather than in a toast over an empty app.
   */
  const goToSheet = useCallback(async (id: string) => {
    try {
      await openSheet(id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not open that table.");
    }
  }, [openSheet]);

  // ── boot ──────────────────────────────────────────────────────
  //
  // A named function rather than an inline effect body, because "Try again" after a failed boot has
  // to run exactly this again. Reloading the page would do it too, and that is what the retry used
  // to do — but a reload is a blunt instrument that also throws away anything unsaved, so nothing
  // here reaches for one.
  const boot = useCallback(async () => {
    // Read once, before anything opens: opening a table rewrites the URL, and the browser's half of
    // it has to survive that.
    const params = new URLSearchParams(location.search);
    setLoading(true);
    setBootError(null);
    try {
      const { sheets } = await api.listSheets();
      setSheets(sheets);
      // The URL wins when it names a table that still exists — a reload should come back where it
      // was, not where the sheet list happens to start. Otherwise: most-recently-updated.
      const wanted = params.get("sheet");
      const target = (wanted && sheets.find((s) => s.id === wanted)) || sheets[0];
      if (target) await openSheet(target.id);
      // …and the same for the file browser, which is a place you can be standing in when you
      // reload. Applied last, because opening a table takes the browser back out of the URL.
      // Settings is a page you can be standing on when you reload, so the URL restores it — the
      // whole reason it stopped being a modal. Applied before the browser check because the two are
      // mutually exclusive and `settings` is the more specific of the pair.
      const at = params.get("settings");
      if (isSettingsSection(at)) {
        setSettingsAt(at);
        // A scope named in the address must be one the report can be about. An unrecognised word
        // falls back to the workspace rather than being passed through — a scope of "table" with no
        // id, or with a nonsense one, is a request the server rejects, so the page would open on an
        // error rather than on the wide answer that is always correct.
        const us = params.get("uscope");
        const uid = params.get("uid");
        const scope: { scope: UsageScope; id: string | null } =
          (us === "table" || us === "workbook") && uid ? { scope: us, id: uid } : { scope: "workspace", id: null };
        setUsageAt(scope);
        // Re-stamped, because opening a table above ran `urlToSheet`, which strips `settings` — so
        // without this a reload onto Settings would show Settings under an address that had just
        // erased it, and the NEXT reload would land on the grid.
        urlToSettings(at, scope);
      }

      const browse = params.get("browse");
      if (browse) {
        setHomeAt({
          view: browse === "recent" || browse === "starred" || browse === "templates" ? browse : "files",
          folderId: params.get("folder") ?? undefined,
          workbookId: params.get("workbook") ?? undefined,
        });
        setHomeOpen(true);
      }
    } catch {
      // Boot is the one place where "nothing came back" and "there is nothing" look identical and
      // mean opposite things. Unhandled, a listSheets that rejected because the engine was not
      // running still cleared `loading` and dropped the user on "No sheets yet" — a confident claim
      // about a workspace that was never read, beside a button offering to make a sheet that cannot
      // be made.
      setBootError("Could not reach the local engine.");
    } finally {
      setLoading(false);
    }
  }, [openSheet]);

  useEffect(() => {
    void boot();
    // Mount only. Re-running this on an identity change would re-open the URL's table over whatever
    // the user had since switched to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A blank table, in the workbook you are standing in.
   *
   * The workbook is passed on purpose. The engine gives a table with no workbook a BRAND NEW one,
   * so this made a table that vanished from the file it was created in — it appeared as its own
   * file in the browser and never showed up in the tab bar it came from.
   */
  const newSheet = useCallback(async () => {
    try {
      const { sheet: made } = await api.createSheet("Untitled table", sheet?.workbookId ?? null);
      setSheets((s) => [made, ...s]);
      await goToSheet(made.id);
    } catch {
      setToast("Could not make a table.");
    }
  }, [sheet, goToSheet]);

  const addColumn = useCallback(async () => {
    if (!sheet) return;
    try {
      const { column } = await api.addColumn(sheet.id, `Column ${columns.length + 1}`, "script");
      // The loaded window has no cell records for a column that did not exist when it was fetched,
      // and `ensurePage` will not re-read a page it already holds — so every delta for the new
      // column was dropped as "outside the loaded window" and its values never appeared until the
      // view changed. The same reason `insertColumn` resets.
      cellStore.reset();
      bump();
      await refreshSheet(sheet.id);
      // A brand-new column has never been measured, and `statsSettled` is already true — which
      // short-circuits BOTH refresh paths, so its header sat on an empty status area until some
      // unrelated mutation happened to ask for stats again.
      setStatsSettled(false);
      // Open the editor immediately — a script column with no rule does nothing, so landing the user
      // on an inert column would just be a dead end.
      openColumnEditor(column);
    } catch {
      setToast("Could not add a column.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, columns.length, refreshSheet]);

  /**
   * Put a new column at a given place in the order rather than at the far right.
   *
   * Two calls, because a column is created at the end and then moved — which is also the only way
   * that keeps every other column's position renumbered consistently, since `moveColumn` owns that
   * arithmetic and having a second place that does it is how the two drift apart.
   */
  const insertColumn = useCallback(async (atIndex: number) => {
    if (!sheet) return;
    try {
      const { column } = await api.addColumn(sheet.id, `Column ${columns.length + 1}`, "script");
      await api.moveColumn(column.id, Math.max(0, atIndex));
      cellStore.reset();
      bump();
      await refreshSheet(sheet.id);
      openColumnEditor(column);
    } catch {
      setToast("Could not add a column there.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, columns.length, refreshSheet]);

  /**
   * Add a column whose job is sending these rows into another table.
   *
   * Not a modal — pick a destination, press Send, done — because that is the wrong shape. Sending
   * rows somewhere is a thing a COLUMN does: it lives in the dependency graph, it re-runs,
   * and it can be gated by a run condition, so "send only the qualified leads" is a setting rather
   * than a filter you have to remember to apply by hand each time.
   *
   * Opened from a column holding a list, it starts on "one row per item in that list" — which is
   * what right-clicking a list column and asking to send it means.
   */
  const addSendColumn = useCallback(async (from?: Column, listPath?: string) => {
    if (!sheet) return;
    try {
      const { column } = await api.addColumn(sheet.id, from ? `Send ${from.name}` : "Send to table", "send");
      const holdsList = from && (from.valueType === "json" || from.valueType === "array" || !!listPath);
      if (holdsList) {
        const r = await fetch(`/api/columns/${column.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            send: { method: "per_item", listColumnId: Number(from!.id), listPath: listPath || undefined },
          }),
        });
        const body = await r.json().catch(() => null);
        // The column is made either way, so a refused seed is not fatal — but the editor would then
        // open on "one row per table" while the user asked for one row per item in a list, and
        // nothing would say the setting had not taken.
        if (!r.ok || body?.error) {
          setToast(String(body?.error ?? "The column was added, but its list setting could not be saved."));
        }
      }
      cellStore.reset();
      bump();
      await refreshSheet(sheet.id);
      // Re-read it, so the editor opens on what was actually saved rather than on the bare column
      // that existed before the destination was seeded onto it.
      const fresh = await fetch(`/api/columns/${column.id}`).then((r) => r.json()).catch(() => null);
      openColumnEditor(fresh?.column ?? column);
    } catch {
      setToast("Could not add that column.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, refreshSheet]);

  const duplicateColumn = useCallback(async (column: Column) => {
    try {
      const { column: made } = await api.duplicateColumn(column.id);
      cellStore.reset();
      bump();
      await refreshSheet(column.sheetId);
      // Said out loud, because the copy is EMPTY: a duplicate that looks identical in the header and
      // holds nothing reads as a failed copy unless the difference is stated.
      setToast(`Copied "${column.name}" — the copy has no values yet. Run it when you are ready.`);
      openColumnEditor(made);
    } catch {
      setToast("Could not duplicate that column.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSheet]);

  /**
   * Rename a column in place. Resolves to an error string rather than throwing, because the header
   * editor stays open on failure with the typed text intact — a thrown error would close it and
   * silently restore the old name, which reads as the rename having worked and then reverted.
   */
  const renameColumn = useCallback(async (column: Column, name: string): Promise<string | null> => {
    try {
      await api.renameColumn(column.id, name);
      // Optimistic locally rather than a full sheet refetch: a refetch would also replace `columns`,
      // and every open menu anchored to a column object would lose its identity mid-interaction.
      setColumns((cs) => cs.map((c) => (c.id === column.id ? { ...c, name } : c)));
      bump();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Could not rename this column.";
    }
  }, []);

  /** One cell is below every threshold the confirm dialog exists for, so it starts immediately. */
  const runCell = useCallback(
    (cellId: string) => {
      if (!sheet) return;
      const [rowId, columnId] = cellId.split(":").map(Number);
      if (!rowId || !columnId) return;
      void api.startRun(sheet.id, { rowIds: [rowId], columnIds: [columnId], force: true });
    },
    [sheet],
  );

  // Bumped after every mutation. The undo buttons read the SERVER state, and this is what tells
  // them to look again — cheaper and more reliable than polling.
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((r) => r + 1), []);
  const [confirmDeleteColumn, setConfirmDeleteColumn] = useState<Column | null>(null);
  const [confirmDeleteRow, setConfirmDeleteRow] = useState<string | null>(null);
  /** The column whose rows are being picked — the step BEFORE the run is priced. */
  const [runRangeFor, setRunRangeFor] = useState<Column | null>(null);
  /** The range picker aimed at the whole table rather than one column. */
  const [runRangeAll, setRunRangeAll] = useState(false);
  const [expandJsonFor, setExpandJsonFor] = useState<Column | null>(null);
  /**
   * The send-to-another-table screen.
   *
   * An object rather than a column, because it opens from three places that know different amounts:
   * the toolbar (nothing — send the rows), a column header (this list), and a field inside a cell
   * (this list, at this path). `null` is closed; `{}` is open with no column.
   */

  const [sourcesOpen, setSourcesOpen] = useState(false);
  /**
   * The record page: a row POSITION in the current view, or null for the grid.
   *
   * A position and not a row id — see `RecordView`. It is cleared whenever the narrowing changes,
   * because position 40 of one filter is a different record from position 40 of another and
   * silently swapping the row under the reader is worse than closing the page.
   */
  const [recordAt, setRecordAt] = useState<number | null>(null);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  /** The column being kept as a template, and whether the gallery is open. */
  const [savingTemplate, setSavingTemplate] = useState<Column | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  /** Set when deduplication was opened from one column's menu, so it starts on that column. */
  const [dedupeStartWith, setDedupeStartWith] = useState<number | null>(null);
  /** "Filter on this column", asked for from a column's menu. The nonce makes asking twice work. */
  const [filterRequest, setFilterRequest] = useState<{ columnId: number; nonce: number } | null>(null);
  /** The column whose description is being written, and the text being written. */
  const [describing, setDescribing] = useState<Column | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [homeOpen, setHomeOpen] = useState(false);
  /** null means not on the settings page; a section name means we are, and which one. */
  const [settingsAt, setSettingsAt] = useState<SettingsSection | null>(null);
  /** What the usage report is about. Defaults to the whole workspace, which is the safe wide answer. */
  const [usageAt, setUsageAt] = useState<{ scope: UsageScope; id: string | null }>({ scope: "workspace", id: null });
  /**
   * Where the browser should open — a sub-tab, a folder, a workbook, or the root.
   *
   * Always a FRESH object, never `null`, when it is set from a crumb. `Home` re-reads this on a
   * prop change and compares by identity on purpose, so that clicking the same crumb twice
   * navigates twice; reusing `null` for "the root" meant the second click on "All files" changed
   * nothing and the crumb read as broken.
   */
  const [homeAt, setHomeAt] = useState<{ view?: BrowserView; folderId?: string; workbookId?: string } | null>(null);
  /** Where the browser is, reported by it, so the header path and the browser cannot disagree. */
  const [browserPath, setBrowserPath] = useState<Array<{ kind: string; id: string; name: string }>>([]);
  /** The crumb being renamed, by id — a table, a workbook or a folder. */
  const [renamingCrumb, setRenamingCrumb] = useState<string | null>(null);
  /** Root-first: folders, the workbook, then this table. Rendered as the app bar's breadcrumb. */
  const [path, setPath] = useState<Array<{ kind: string; id: string; name: string }>>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /**
   * Re-extract the columns derived from a JSON source.
   *
   * A run already does this automatically; this covers the other way a source changes — a hand edit,
   * a re-import — where the derived columns would otherwise keep showing values taken from data that
   * is no longer there.
   */
  const refreshDerived = useCallback(async (column: Column) => {
    try {
      const r = await fetch(`/api/columns/${column.id}/refresh-derived`, { method: "POST" });
      const res = await r.json().catch(() => null);
      // A refused request answers with no `rows`, which counts as zero — so a failure was reported as
      // "nothing is derived from this column", a confident statement about data that was never read.
      if (!r.ok || res?.error) {
        setToast(String(res?.error ?? "Could not refresh the derived columns."));
        return;
      }
      const n = Number(res.rows ?? 0);
      // Says what happened either way. "Nothing derived from this column" is a useful answer; a
      // silent no-op reads as the button being broken.
      setToast(n > 0 ? `Refreshed ${n.toLocaleString()} ${n === 1 ? "row" : "rows"}` : "Nothing is derived from this column.");
      cellStore.reset();
      await refreshSheet(column.sheetId);
    } catch {
      setToast("Could not refresh the derived columns.");
    }
  }, [refreshSheet]);

  /**
   * Rename whatever the path is pointing at — a table, a workbook, or a folder.
   *
   * It only ever renamed TABLES, which made the gesture read as broken rather than as unsupported:
   * the crumb for a folder looks identical, double-clicking it did nothing, and the only way to
   * rename a folder was to go back to the browser and find it in the list.
   */
  const renameCrumbTo = useCallback(async (crumb: { kind: string; id: string; name: string }, name: string) => {
    const next = name.trim();
    if (!next || next === crumb.name) return;
    const url =
      crumb.kind === "table" ? `/api/sheets/${crumb.id}`
      : crumb.kind === "workbook" ? `/api/workbooks/${crumb.id}`
      : `/api/folders/${crumb.id}`;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      }).then((r) => r.json());
      if (res.error) { setToast(res.error); return; }
    } catch {
      setToast("Could not rename that.");
      return;
    }
    // Every place that name is currently on screen. A rename that updates the crumb and leaves the
    // tab bar and the file list on the old name reads as a rename that half-worked.
    if (crumb.kind === "table") {
      if (sheet?.id === crumb.id) setSheet({ ...sheet, name: next });
      setSheets((s) => s.map((x) => (x.id === crumb.id ? { ...x, name: next } : x)));
    }
    setPath((p) => p.map((c) => (c.id === crumb.id ? { ...c, name: next } : c)));
    setBrowserPath((p) => p.map((c) => (c.id === crumb.id ? { ...c, name: next } : c)));
    bump();
  }, [sheet]);

  const pinColumn = useCallback(async (column: Column, pinned: boolean) => {
    try {
      const r = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frozen: pinned }),
      });
      const body = await r.json().catch(() => null);
      // The refresh below redraws the column from the server either way, so an unread refusal put
      // the header straight back where it was and read as the control not working.
      if (!r.ok || body?.error) {
        setToast(String(body?.error ?? `Could not ${pinned ? "pin" : "unpin"} that column.`));
        return;
      }
      await refreshSheet(column.sheetId);
    } catch {
      setToast(`Could not ${pinned ? "pin" : "unpin"} that column.`);
    }
  }, [refreshSheet]);

  const moveColumn = useCallback(async (column: Column, toIndex: number) => {
    try {
      const r = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toIndex }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || body?.error) {
        setToast(String(body?.error ?? "Could not move that column."));
        return;
      }
      await refreshSheet(column.sheetId);
    } catch {
      setToast("Could not move that column.");
    }
  }, [refreshSheet]);

  const addRow = useCallback(async () => {
    if (!sheet) return;
    try {
      const res = await fetch(`/api/sheets/${sheet.id}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 1 }),
      }).then((r) => r.json());
      if (res.error) { setToast(res.error); return; }
      cellStore.reset();
      // The tab bar is a different React tree and reads its row counts from its own request, which
      // only re-runs on `revision`. Without this the tab for the table you are looking at kept
      // showing the count from before the row you just added.
      bump();
      await refreshSheet(sheet.id);
      // A new row is empty, so a filter or a status view will usually hide it. Said out loud,
      // because a button that appears to do nothing reads as broken.
      if (view.search.trim() || view.status.length > 0 || view.filter) {
        setToast("Row added at the end — the current filter may be hiding it.");
      }
    } catch {
      setToast("Could not add a row.");
    }
  }, [sheet, refreshSheet, view]);

  // Both of these run AFTER their dialog has closed, so a rejection has nothing left on screen to
  // attach itself to: the modal was gone, nothing had changed, and the failure surfaced only as an
  // unhandled rejection in a console the user is not reading.
  const doDeleteColumn = async () => {
    if (!sheet || !confirmDeleteColumn) return;
    const target = confirmDeleteColumn;
    setConfirmDeleteColumn(null);
    try {
      await api.deleteColumn(target.id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not delete that column.");
      return;
    }
    // The editor is closed first: left open on a deleted column it would happily save a script
    // against an id that no longer exists.
    setEditing((e) => (e?.id === target.id ? null : e));
    if (view.sort?.columnId === Number(target.id)) setView((v) => ({ ...v, sort: null }));
    // No `cellStore.reset()` here, unlike a row delete. Removing a column changes no row's position
    // and mints no cell id, so every loaded row is still correct — blanking the whole grid to
    // skeletons for it was the full-surface flash for nothing.
    bump();
    await refreshSheet(sheet.id);
  };

  const doDeleteRow = async () => {
    if (!sheet || !confirmDeleteRow) return;
    const target = confirmDeleteRow;
    setConfirmDeleteRow(null);
    try {
      await api.deleteRow(target);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not delete that row.");
      return;
    }
    // Every row after this one shifts up by one in the view index, so the loaded window is no longer
    // trustworthy — dropping it is cheaper and safer than trying to patch the positions.
    cellStore.reset();
    setOpenCell((c) => (c && c.cellId.startsWith(`${target}:`) ? null : c));
    bump();
    await refreshSheet(sheet.id);
  };

  /**
   * Right-click anywhere in the app chrome.
   *
   * One menu for the whole shell rather than one per control, and the items are built from where the
   * click landed. The gesture has to be answered EVERYWHERE it is tried — a context menu that works
   * on the grid and nowhere else teaches the gesture and then hands back the browser's own menu,
   * which offers Reload and Save As on a toolbar.
   *
   * Text inputs are the deliberate exception, handled below: their native menu carries Cut, Copy,
   * Paste and spellcheck, and nothing here is worth losing those for.
   */
  const shell = useContextMenu();

  const shellMenu = useCallback(
    (e: React.MouseEvent, label: string, items: MenuItem[]) => {
      // Never over a field. Replacing the native menu on an input takes away paste — on a search box
      // that is the single most likely thing the user wanted from a right-click.
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable='true']")) return;
      shell.open(e, label, items);
    },
    [shell],
  );

  // ── ⌘K ────────────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);

  /**
   * Start a download from code.
   *
   * A temporary anchor with `download`, not `location.href`. Navigating to the URL makes the export
   * an ordinary page load, so a failure — a refused filter, a table that has gone — replaces the app
   * with a bare JSON error page and loses whatever was on screen. The anchor keeps the app where it
   * is and lets the browser handle the response as an attachment.
   */
  const download = (url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  /**
   * ⌘K / Ctrl+K, from anywhere.
   *
   * Deliberately NOT skipped while a text field has focus, unlike Ctrl+Z. Ctrl+Z has a meaning
   * inside an input that the browser owns and the app must not steal; Ctrl+K does not, and a
   * palette you cannot open because the cursor happens to be in the search box is a palette people
   * stop reaching for.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Everything the palette can reach.
   *
   * Assembled HERE rather than collected from the menus, because the menus are `MenuItem`s built for
   * a pointer and half of them are separators. Kept in one list so a command cannot exist in the
   * palette and nowhere else, or drift from the menu item it mirrors.
   *
   * A command that cannot run right now is included WITH ITS REASON rather than dropped — see
   * `disabledReason`. The tables are in the same list as the actions, so ⌘K is also how you move
   * between them without going back out to the file browser.
   */
  const commands = useMemo((): Command[] => {
    const list: Command[] = [];
    const noSheet = sheet ? undefined : "Open a table first.";

    list.push(
      { id: "new-table", group: "Create", label: "Blank table", keywords: "sheet add new", run: () => void newSheet() },
      { id: "wizard", group: "Create", label: "Build a table…", keywords: "wizard describe interview", run: () => setWizardOpen(true) },
      // "Add column", not the menu's "Column". Under a "Create" heading in a menu the noun alone is
      // unambiguous; in a flat searchable list it is not, and nobody types "column" looking to make
      // one — they type "add col".
      { id: "add-column", group: "Create", label: "Add column", keywords: "field new insert", disabledReason: noSheet, run: () => void addColumn() },
      { id: "add-row", group: "Create", label: "Add row", keywords: "record new insert", disabledReason: noSheet, run: () => void addRow() },
      { id: "send-to-table", group: "Create", label: "Send to another table…", keywords: "write fan out", disabledReason: noSheet, run: () => void addSendColumn() },
    );

    list.push(
      {
        id: "run-all", group: "Run", label: "Run every runnable column",
        keywords: "start execute", hint: "costs money", disabledReason: noSheet,
        run: () => setPendingRun({ scope: viewScope(view), title: runTitle }),
      },
      {
        id: "show-failed", group: "View", label: "Show only failed rows", keywords: "error filter",
        disabledReason: noSheet ?? (view.status[0] === "error" ? "Already showing failed rows." : undefined),
        run: () => setView({ ...view, status: ["error"] }),
      },
      {
        id: "clear-filters", group: "View", label: "Clear filters", keywords: "reset view search",
        disabledReason: noSheet ?? (isNarrowed(view) ? undefined : "Nothing is filtered."),
        run: () => applyView(EMPTY_VIEW),
      },
    );

    if (sheet) {
      const narrowed = isNarrowed(view);
      list.push(
        {
          id: "export-view", group: "Data",
          // The COUNT only appears when the command can actually run. "Export 5 filtered rows"
          // sitting greyed out beside "nothing is filtered" states a number and then denies it in
          // the same row — the label has to stop making the claim when the claim is not true.
          label: narrowed ? `Export ${visibleRows.toLocaleString()} filtered rows as CSV` : "Export the filtered rows as CSV",
          keywords: "download csv save filtered",
          // Offered only when it differs from the whole table — two identical exports side by side
          // is a choice with no content, and the label would be making a distinction it cannot keep.
          disabledReason: narrowed ? undefined : "Nothing is filtered — use the whole-table export.",
          run: () => download(`/api/sheets/${sheet.id}/export.csv?${viewQuery(view).slice(1)}`),
        },
        {
          id: "export-all", group: "Data", label: "Export the whole table as CSV",
          keywords: "download csv save everything",
          run: () => download(`/api/sheets/${sheet.id}/export.csv`),
        },
        {
          id: "record", group: "Table", label: "Open the first row as a record",
          keywords: "row detail record page single",
          disabledReason: visibleRows > 0 ? undefined : "This table has no rows.",
          run: () => setRecordAt(0),
        },
        { id: "dedupe", group: "Data", label: "Deduplication…", keywords: "duplicate merge match", run: () => { setDedupeStartWith(null); setDedupeOpen(true); } },
        { id: "sources", group: "Data", label: "Sources — bring rows in…", keywords: "import csv webhook upload", run: () => setSourcesOpen(true) },
        { id: "schedules", group: "Table", label: "Scheduled runs…", keywords: "cron timer repeat", run: () => setSchedulesOpen(true) },
        { id: "limits", group: "Table", label: "Speed limits…", keywords: "rate throttle pace per minute 429", run: () => setLimitsOpen(true) },
        { id: "restore", group: "Table", label: "Restore points…", keywords: "snapshot revert undo run", run: () => setRestoreOpen(true) },
        {
          id: "usage", group: "Table", label: "Cost for this table", keywords: "spend money usage billing",
          run: () => { const at = { scope: "table" as const, id: sheet.id }; setUsageAt(at); setSettingsAt("usage"); urlToSettings("usage", at); },
        },
      );
    }

    list.push(
      { id: "settings-keys", group: "Settings", label: "API keys", keywords: "secret token credential", run: () => { setSettingsAt("keys"); urlToSettings("keys"); } },
      { id: "settings-models", group: "Settings", label: "Models", keywords: "openrouter ollama provider", run: () => { setSettingsAt("models"); urlToSettings("models"); } },
      { id: "settings-account", group: "Settings", label: "Account", keywords: "people sign out profile", run: () => { setSettingsAt("account"); urlToSettings("account"); } },
      { id: "settings-usage", group: "Settings", label: "Usage and cost", keywords: "spend money billing", run: () => { const at = { scope: "workspace" as const, id: null }; setUsageAt(at); setSettingsAt("usage"); urlToSettings("usage", at); } },
      { id: "home", group: "Go to", label: "All files", keywords: "browse home workbooks folders", run: () => { setHomeAt({ view: "files" }); setHomeOpen(true); } },
    );

    // The tables of the workbook you are in. Not every table in the workspace: that list is
    // unbounded, and a palette that pages or truncates is one that quietly cannot find things.
    for (const s of sheets) {
      if (s.id === sheet?.id) continue;
      list.push({
        id: `sheet-${s.id}`, group: "Go to", label: s.name, keywords: "table sheet open",
        hint: `${(s.rowCount ?? 0).toLocaleString()} rows`,
        run: () => void goToSheet(s.id),
      });
    }

    return list;
  }, [sheet, sheets, view, runTitle, visibleRows, newSheet, addColumn, addRow, addSendColumn, applyView, goToSheet]);

  const sheetItems = useCallback((): MenuItem[] => {
    if (!sheet) return [];
    return [
      { label: "Build a table…", title: "Describe what you want and answer a few questions", onSelect: () => setWizardOpen(true) },
      { label: "Blank table", onSelect: () => void newSheet() },
      { label: "Column", onSelect: () => void addColumn() },
      { label: "Row", onSelect: () => void addRow() },
      { label: "Deduplication…", title: "Match on one or more columns and remove repeated rows", onSelect: () => { setDedupeStartWith(null); setDedupeOpen(true); } },
      { label: "Send to another table…", title: "Adds a column that writes these rows into another table", onSelect: () => void addSendColumn() },
      { separator: true },
      { label: "Run every runnable column", onSelect: () => setPendingRun({ scope: viewScope(view), title: runTitle }) },
      {
        label: "Show only failed rows",
        // Disabled with a reason rather than hidden: on a clean sheet the absence of the item reads
        // as the feature missing, not as there being nothing to show.
        disabled: view.status[0] === "error",
        title: view.status[0] === "error" ? "Already filtered to failed rows." : undefined,
        onSelect: () => setView({ ...view, status: ["error"] }),
      },
      {
        label: "Clear filters",
        disabled: !isNarrowed(view),
        title: isNarrowed(view) ? undefined : "Nothing is filtered.",
        // Both halves, through the one path that owns them — the search box owns `view.search`, so
        // clearing the view alone gets the typed term written straight back 250ms later.
        onSelect: () => applyView(EMPTY_VIEW),
      },
    ];
    // The handlers are dependencies, not incidentals. `addColumn` reads `columns.length` to name the
    // new column; memoised without it, the menu kept a closure from before the last column was added
    // and produced a second "Column 4".
  }, [sheet, view, runTitle, newSheet, addColumn, addRow, addSendColumn, applyView]);

  /**
   * The scoped run choices, as one menu.
   *
   * The same four the column header offers, aimed at every runnable column instead of one. Each
   * still goes through the confirmation that shows the row count and the estimate — nothing here
   * starts a run directly.
   */
  const runMenu = (e: React.MouseEvent) => {
    if (!sheet) return;
    const scope = viewScope(view);
    shell.open(e, "Run", [
      {
        label: isNarrowed(view) ? `Every runnable column, ${visibleRows.toLocaleString()} matching rows` : "Every runnable column",
        onSelect: () => setPendingRun({ scope, title: runTitle }),
      },
      { separator: true },
      {
        label: "Retry only the rows that failed",
        // The one that saves real money: on a half-finished paid column, running everything again
        // pays a second time for every row that already worked.
        onSelect: () => setPendingRun({ scope: { ...scope, statuses: ["error"], force: false }, title: "Retry failed rows" }),
      },
      {
        label: "Run only rows that never ran",
        // `cancelled` counts as never-run: a cell stopped mid-flight produced no value, and leaving
        // it out would make a stopped run impossible to finish off.
        onSelect: () => setPendingRun({ scope: { ...scope, statuses: ["empty", "cancelled"], force: false }, title: "Run rows that never ran" }),
      },
      {
        label: "Rows that a condition skipped",
        onSelect: () => setPendingRun({ scope: { ...scope, statuses: ["skipped"], force: false }, title: "Run skipped rows" }),
      },
      { separator: true },
      {
        label: "Pick a count or a range…",
        onSelect: () => setRunRangeAll(true),
      },
    ]);
  };

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("cc-theme", next); } catch { /* private mode */ }
  };

  /**
   * Every right-docked panel, so the shell can end where the widest one begins.
   *
   * The assistant was missing from this list, and it is `position: fixed; right: 0` like the other
   * two — so opening it laid a 420px panel over the right-hand end of everything: the last columns
   * of the grid could not be scrolled to at all, and the toolbar's Run, Sources and Column buttons
   * were underneath it. Which is the worst place for it to land, since those are the controls you
   * reach for while talking to the assistant ABOUT the table.
   *
   * `max()` rather than a first-match chain because more than one can be open at once — the column
   * drawer and the assistant stack, and reserving only the first one's width leaves the wider one
   * overlapping again.
   */
  const dockedWidths = [
    openCell && "420px",
    editing && "var(--drawer-w)",
    assistantOpen && "420px",
  ].filter(Boolean) as string[];
  const dockWidth =
    dockedWidths.length === 0 ? "0px"
    : dockedWidths.length === 1 ? dockedWidths[0]!
    : `max(${dockedWidths.join(", ")})`;

  return (
    /**
     * The width a right-docked panel is taking, so the sheet can end where the panel begins.
     *
     * Both panels are `position: fixed`, which made them float OVER the grid — and the grid's
     * horizontal scrollbar runs the full width at the bottom, so a panel covered its right 420px.
     * The scrollbar was cut in half by an edge, its rounded end disappearing under the panel, with
     * the table-tab strip below meeting neither cleanly. Patchwork, and the covered half could not
     * be dragged.
     *
     * Reserving the space here means the scrollbar ends AT the panel's edge and the two bottom
     * edges land on the tab strip together. Zero when nothing is docked, so the grid is full width
     * exactly as before.
     */
    <div
      className="cc-app"
      style={{ "--dock-w": dockWidth } as CSSProperties}
    >
      <header
        className="cc-appbar"
        onContextMenu={(e) =>
          shellMenu(e, "App actions", [
            { label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", onSelect: toggleTheme },
            ...(sheet ? [{ separator: true }, ...sheetItems()] : []),
          ])
        }
      >
        <div className="cc-appbar__brand" title="Ferrum">
          <Mark size={22} />
        </div>

        {/* The full path, clickable at every level — the way up and down the workspace, in the one
            place that is always on screen. Clicking a folder or workbook crumb opens the browser
            there; the last crumb is this table, and double-clicking it renames. */}
        <nav className="cc-path" aria-label="Where you are">
          <button
            className={`cc-path__crumb${homeOpen && browserPath.length === 0 ? " cc-path__crumb--here" : ""}`}
            // A FRESH object every press, never `null`. The browser compares this prop by identity so
            // that pressing the same crumb twice navigates twice; reusing one value meant that from
            // two folders down, "All files" changed nothing at all.
            onClick={() => { setHomeAt({ view: "files" }); setHomeOpen(true); }}
          >
            All files
          </button>
          {/* With the browser open the path is the BROWSER's location. It used to keep showing the
              last table you had open, so clicking "All files" landed you at the root with a
              breadcrumb still claiming you were three levels down inside a table. */}
          {(homeOpen ? browserPath : path).map((c, i) => {
            const crumbs = homeOpen ? browserPath : path;
            const last = i === crumbs.length - 1;
            return (
              <PathCrumb
                key={c.id}
                crumb={c}
                // The crumb you are standing on is only "here" when the browser is closed; with it
                // open the path belongs to the browser and its last crumb is still somewhere to go.
                last={last && !homeOpen}
                onOpen={() => {
                  if (c.kind === "table") { setHomeOpen(false); void goToSheet(c.id); return; }
                  setHomeAt(c.kind === "workbook" ? { workbookId: c.id } : { folderId: c.id });
                  setHomeOpen(true);
                }}
                renaming={renamingCrumb === c.id}
                onStartRename={() => setRenamingCrumb(c.id)}
                onCommitRename={(next) => { setRenamingCrumb(null); void renameCrumbTo(c, next); }}
                onCancelRename={() => setRenamingCrumb(null)}
              />
            );
          })}
          {/* What the table HOLDS, both halves of it.
              Rows alone answered half the question: a table is a grid, and "how wide is it" had no
              answer anywhere on screen — you counted the headers, and past the edge of the viewport
              you could not even do that. */}
          {sheet && !homeOpen && (
            <span className="cc-path__size mono">
              <span title={`${sheet.rowCount.toLocaleString()} rows in this table`}>
                {sheet.rowCount.toLocaleString()} rows
              </span>
              <span className="cc-path__size-sep" aria-hidden>·</span>
              <span title={`${columns.length.toLocaleString()} columns in this table`}>
                {columns.length.toLocaleString()} {columns.length === 1 ? "column" : "columns"}
              </span>
            </span>
          )}
        </nav>

        <div className="cc-appbar__spacer" />
        {/* Who you are, on a shared instance only.
            Absent entirely on a single-user install — a chip saying "you are you" beside a table
            nobody else can reach is decoration. When it IS there it is the way to your own account
            and to signing out, and it carries the one fact a read-only person needs to see without
            hunting for it: the rung they are on. */}
        {me.claimed && me.person && (
          <button
            className="cc-whoami"
            onClick={() => { setSettingsAt("account"); urlToSettings("account"); }}
            title={`Signed in as ${me.person.email} — ${me.person.role}. Your account, your password, and signing out.`}
            aria-label={`Your account. Signed in as ${me.person.email}, ${me.person.role}.`}
          >
            <span className="cc-whoami__dot" aria-hidden>{(me.person.name || me.person.email).slice(0, 1).toUpperCase()}</span>
            <span className="cc-whoami__name truncate">{me.person.name || me.person.email}</span>
            {!me.can.spend && <span className="cc-whoami__ro">read-only</span>}
          </button>
        )}
        {/* App-level, so it lives in the header rather than in the per-table overflow menu — which
            model answers and whose bill it lands on is not a property of the table you happen to
            have open. */}
        <button
          className="hk-icon-btn"
          onClick={() => { setSettingsAt("models"); urlToSettings("models"); }}
          aria-label="Settings"
          title="Models, keys, and what each column costs to run"
        >
          <IconSettings />
        </button>
        <button className="hk-icon-btn" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Toggle theme">
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </header>


      {wizardOpen && (
        <TableWizard
          onBuilt={(id) => { void goToSheet(id); bump(); void api.listSheets().then(({ sheets }) => setSheets(sheets)); }}
          onClose={() => setWizardOpen(false)}
        />
      )}

      {!connected && (
        <div className="cc-banner" role="status">
          <span>Lost connection to the local engine. Reconnecting…</span>
          {/* Dials a new socket and re-reads what was missed while it was down. Not
              `location.reload()`, which fixes the socket by throwing away every unsaved thing on
              screen — an open column rule, a half-typed description, the assistant's transcript. */}
          <button
            className="cc-btn cc-btn--ghost"
            onClick={() => {
              setConnected(true);
              setStreamNonce((n) => n + 1);
              // Frames that arrived while the socket was down are gone, so the loaded window is the
              // one thing that cannot be trusted after a reconnect.
              if (sheet) { cellStore.reset(); void refreshSheet(sheet.id); }
            }}
          >
            Try again
          </button>
        </div>
      )}

      {settingsAt ? (
        <Settings
          me={me}
          onSessionChanged={reloadSession}
          section={settingsAt}
          onSection={(s) => { setSettingsAt(s); urlToSettings(s, usageAt); }}
          usageScope={usageAt.scope}
          usageScopeId={usageAt.id}
          onUsageScope={(scope, id) => {
            const next = { scope, id };
            setUsageAt(next);
            urlToSettings("usage", next);
          }}
          // Back to exactly where you were. Falling back to the browser rather than to nothing,
          // because a workspace with no table open still has somewhere to be.
          onClose={() => {
            setSettingsAt(null);
            if (sheet) urlToSheet(sheet.id);
            else urlToBrowser({ view: "files", folderId: null, workbookId: null });
          }}
        />
      ) : homeOpen ? (
        <Home
          startAt={homeAt}
          onOpenTable={(id) => { setHomeOpen(false); void goToSheet(id); bump(); }}
          onPathChange={setBrowserPath}
          // Where the browser is goes in the address bar, the same way the open table does — so a
          // reload comes back to the folder you were standing in instead of dropping you in the
          // grid, and a folder is something you can send someone a link to.
          onNavigate={urlToBrowser}
          onBuildTable={() => { setHomeOpen(false); setWizardOpen(true); }}
          // Leaving the browser puts the open table back in the URL, so the location never claims
          // you are somewhere you have just left.
          onClose={sheet ? () => { setHomeOpen(false); urlToSheet(sheet.id); } : undefined}
        />
      ) : loading ? (
        <SheetSkeleton />
      ) : !sheet ? (
        <EmptyState
          onNew={newSheet}
          error={bootError}
          onRetry={() => void boot()}
          onBuild={() => setWizardOpen(true)}
          onBrowse={() => { setHomeAt({ view: "files" }); setHomeOpen(true); }}
        />
      ) : (
        <>
          {/* ONE toolbar row.
              
              It was two, and between them they said the row count twice, the table's name twice
              over from the app bar, and left most of both lines empty. Narrowing controls on the
              left, acting controls on the right, one line — which gives the grid back 44px of the
              window on every screen. */}
          <div
            className="cc-toolbar cc-toolbar--1"
            onContextMenu={(e) => shellMenu(e, "Table actions", sheetItems())}
          >
            <div className="cc-toolbar__left">
              <UndoBar
                sheetId={sheet.id}
                revision={revision}
                // `bump` as well, because an undo can restore or remove ROWS and the tab bar reads
                // its counts from its own request in another tree — it only re-asks on `revision`,
                // so undoing a row delete left the tab showing the count from after it.
                onApplied={() => { cellStore.reset(); bump(); void refreshSheet(sheet.id); }}
              />
              <Select
                label="Status"
                value={view.status[0] ?? "any"}
                options={STATUS_OPTIONS}
                onChange={(v) => setView({ ...view, status: v === "any" ? [] : [v] })}
              />
              <Select
                label="Sort"
                value={view.sort ? `${view.sort.columnId}:${view.sort.dir}` : "none"}
                options={sortOptions}
                onChange={(v) => {
                  if (v === "none") { setView({ ...view, sort: null }); return; }
                  const [id, dir] = v.split(":");
                  setView({ ...view, sort: { columnId: Number(id), dir: dir === "desc" ? "desc" : "asc" } });
                }}
              />
              {/* `applyView`, not `setView`: the bar replaces the WHOLE view, and the search box
                  owns `view.search` through a debounce. Handed `setView`, a saved view's search term
                  was overwritten by the box's untouched text 250ms after being applied — so the view
                  cleared its own search and immediately read as edited — and "All rows — no view"
                  could not clear a typed one. */}
              <ViewBar
                sheetId={sheet.id}
                view={view}
                onChange={applyView}
                onMutated={bump}
                defaultViewId={sheet.defaultViewId}
                openedWith={sheet.defaultViewId ? Number(sheet.defaultViewId) : null}
                onSetDefaultView={(viewId) => {
                  void api.setDefaultView(sheet.id, viewId).then((r) => setSheet(r.sheet));
                }}
              />
              <FilterBar columns={columns} view={view} onChange={setView} request={filterRequest} />
              {isNarrowed(view) && (
                <>
                  <button className="cc-btn cc-btn--ghost cc-btn--xs" onClick={() => applyView(EMPTY_VIEW)}>
                    Clear
                  </button>
                  {/* The narrowed count, and ONLY when narrowed. The sheet's own total lives in the
                      path up top, so repeating it here said the same number twice. */}
                  <span className="cc-count mono">{visibleRows.toLocaleString()} of {sheet.rowCount.toLocaleString()}</span>
                </>
              )}
            </div>
            <div className="cc-toolbar__right">
              <label className="cc-search">
                <span className="cc-search__icon" aria-hidden="true"><IconSearch /></span>
                <input
                  type="search"
                  placeholder="Search rows"
                  aria-label="Search rows"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                />
              </label>
              {/* The label is spelled out in `aria-label` as well as in the span, and every button
                  on this row does the same. At 768px and below the stylesheet collapses `.cc-btn
                  span` to icon-only — which for the primary action removed its ONLY name source and
                  left a screen reader announcing the app's main control as "button". */}
              {/* A split, matching Run below it.

                  The main half adds a blank column, as it always did. The caret reaches the columns
                  you have already built and kept — which is the difference between rebuilding the
                  same enrichment column from memory on every table and adding it in one click. */}
              <span className="cc-split">
                <button
                  className="cc-btn cc-btn--primary cc-split__main"
                  disabled={!me.can.write}
                  onClick={() => void addColumn()}
                  aria-label="Add a column"
                  title={me.can.write ? "Add a column" : CANNOT_WRITE}
                >
                  <IconPlus /> <span>Column</span>
                </button>
                <button
                  className="cc-btn cc-btn--primary cc-split__more"
                  disabled={!me.can.write}
                  aria-label="Add from one of your templates"
                  title={me.can.write ? "Add a column you have already built and kept" : CANNOT_WRITE}
                  onClick={() => setGalleryOpen(true)}
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 6.5 4 4 4-4" /></svg>
                </button>
              </span>
              {/* A split button.
                  
                  It only ever ran everything, while the same choices — retry the failures, fill in
                  what never ran, a range of rows — were sitting one right-click away on a column
                  header. On a paid column "run everything" is the expensive answer and the other
                  three are the ones you want, so hiding them behind a gesture nobody discovers made
                  the cheap paths unreachable from the obvious control.
                  
                  The main half keeps doing what it did; the caret opens the rest. */}
              {/* Disabled rather than hidden for a read-only account, with the reason on the
                  tooltip. A control that vanishes reads as a broken app or a missing feature; one
                  that is present and explains itself reads as a permission — which is what it is,
                  and which tells them what to ask an admin for. */}
              <span className="cc-split">
                <button
                  className="cc-btn cc-split__main"
                  disabled={!me.can.spend}
                  onClick={() => setPendingRun({ scope: viewScope(view), title: runTitle })}
                  aria-label={runTitle}
                  title={me.can.spend ? runTitle : CANNOT_SPEND}
                >
                  <IconPlay /> <span>Run</span>
                </button>
                <button
                  className="cc-btn cc-split__more"
                  disabled={!me.can.spend}
                  aria-label="Other ways to run"
                  title={me.can.spend ? "Retry failures, fill gaps, or pick a range" : CANNOT_SPEND}
                  onClick={(e) => runMenu(e)}
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 6.5 4 4 4-4" /></svg>
                </button>
              </span>
              {/* The marker is what the assistant's dismiss-on-outside-pointerdown listener looks
                  for. Without it this button matched none of its exemptions, so pressing it while
                  the panel was open closed the panel on `pointerdown` — taking the conversation with
                  it — and the `click` that followed reopened an empty one. The toggle could not
                  close the panel, and pressing it destroyed the transcript. */}
              <button
                className="cc-btn"
                data-cc-assistant-toggle=""
                onClick={() => setAssistantOpen((v) => !v)}
                aria-expanded={assistantOpen}
                aria-label="Assistant"
                title="Ask about this table, or describe a change"
              >
                <IconSparkle /> <span>Assistant</span>
              </button>
              <button
                className="cc-btn"
                onClick={() => setSourcesOpen(true)}
                aria-label="Sources"
                title="Bring rows in — a CSV file, or an address other tools send to"
              >
                <IconInbox /> <span>Sources</span>
              </button>
              <SheetMenu
                sheet={sheet}
                view={view}
                visibleRows={visibleRows}
                onRenamed={(name) => { setSheet({ ...sheet, name }); setSheets((s) => s.map((x) => (x.id === sheet.id ? { ...x, name } : x))); }}
                onBudgetSet={(budgetUsd) => {
                  setSheet({ ...sheet, budgetUsd });
                  setSheets((s) => s.map((x) => (x.id === sheet.id ? { ...x, budgetUsd } : x)));
                }}
                onSheetChanged={(next) => {
                  setSheet(next);
                  setSheets((s) => s.map((x) => (x.id === next.id ? next : x)));
                }}
                onDedupe={() => setDedupeOpen(true)}
                // The way up a level. Without it the three scopes were three unrelated places, and
                // reaching the workspace defaults meant already knowing the gear opened them.
                onWorkspaceSettings={() => { setSettingsAt("models"); urlToSettings("models"); }}
                onSchedules={() => setSchedulesOpen(true)}
                onLimits={() => setLimitsOpen(true)}
                onRestorePoints={() => setRestoreOpen(true)}
                onUsage={() => {
                  const next = { scope: "table" as const, id: sheet.id };
                  setUsageAt(next);
                  setSettingsAt("usage");
                  urlToSettings("usage", next);
                }}
                onTrashed={async () => {
                  const { sheets } = await api.listSheets();
                  setSheets(sheets);
                  if (sheets[0]) await goToSheet(sheets[0].id); else setSheet(null);
                }}
              />
            </div>
          </div>

          {/* The errors segment had an onShowErrors prop that nothing passed, so clicking the
              failure count did nothing. There is no error drawer yet, but filtering the grid to the
              failed rows is the thing you actually want from that click. */}
          <div onContextMenu={(e) => shellMenu(e, "Run actions", sheetItems())}>
            <RunStrip sheetId={sheet.id} onShowErrors={() => setView({ ...view, status: ["error"] })} />
          </div>

          {/* The record page REPLACES the grid rather than floating over it, and keeps the app bar
              and toolbar above it — it is a page, which is the whole point of it. The grid is
              unmounted while it is up, so nothing is virtualizing a million rows behind a screen
              showing one of them. */}
          {recordAt !== null ? (
          <RecordView
            sheetId={sheet.id}
            columns={columns}
            position={recordAt}
            total={visibleRows}
            view={view}
            canWrite={me.can.write}
            primaryColumnId={sheet.primaryColumnId}
            onGo={setRecordAt}
            onClose={() => setRecordAt(null)}
            onNotice={setToast}
            /* No rect: the cell panel anchors itself full-height on the right, and the record page
               has no cell rectangle to point at. */
            onOpenCell={(cellId) => openCellPanel({ cellId, rect: new DOMRect() })}
          />
          ) : columns.length === 0 ? (
            /*
              A table with no columns yet.

              The grid rendered anyway: a single empty header cell with a lone `+` in the corner and
              the rest of the window blank. Nothing said what a column is, and the three real ways to
              get one — add it, import a file, describe it — were spread across a toolbar button, a
              second toolbar button and the command palette.

              Rows are not offered here on purpose. A row with no columns has nowhere to put a value,
              so "+ Row" first is a step that achieves nothing.
            */
            <div className="cc-empty cc-empty--cols">
              <div className="cc-empty__body">
                <h2 className="cc-empty__title cc-empty__title--sm">
                  “{sheet.name}” has no columns yet
                </h2>
                <p className="cc-empty__copy">
                  Every column decides for itself where its values come from: typed in, pulled from
                  another column by a rule, fetched from an API, or answered by a model once per row.
                </p>
                <div className="cc-empty__actions">
                  <button className="cc-btn cc-btn--primary" disabled={!me.can.write} onClick={() => void addColumn()}>
                    <IconPlus /> <span>Column</span>
                  </button>
                  <button className="cc-btn" onClick={() => setSourcesOpen(true)} title="A CSV brings its own columns with it">
                    Import a CSV
                  </button>
                  <button className="cc-btn" onClick={() => setAssistantOpen(true)} title="Describe the table you want and it proposes the columns">
                    Ask the assistant
                  </button>
                </div>
              </div>
            </div>
          ) : (
          <SheetGrid
            sheetId={sheet.id}
            columns={columns}
            onAddColumn={addColumn}
            onOpenCell={(cellId, rect) => openCellPanel({ cellId, rect })}
            onEditColumn={(c) => openColumnEditor(c)}
            onRunColumn={(c) =>
              setPendingRun({ scope: { columnIds: [Number(c.id)] }, title: `Run "${c.name}"` })
            }
            columnStats={columnStats}
            liveRun={liveRun}
            view={view}
            onViewChange={setView}
            onRenameColumn={renameColumn}
            onDeleteColumn={(c) => setConfirmDeleteColumn(c)}
            onRunCell={runCell}
            onRunRow={(rowId) =>
              setPendingRun({ scope: { rowIds: [Number(rowId)], force: true }, title: "Run this row" })
            }
            onDeleteRow={(rowId) => setConfirmDeleteRow(rowId)}
            onRunScope={(_c, scope, title) => setPendingRun({ scope: scope as RunScopeRequest, title })}
            onRunRange={(c) => setRunRangeFor(c)}
            onExpandJson={(c) => setExpandJsonFor(c)}
            onSendToTable={(c) => { void addSendColumn(c); }}
            onInsertColumn={(at) => { void insertColumn(at); }}
            onDuplicateColumn={(c) => { void duplicateColumn(c); }}
            onSaveTemplate={(c) => setSavingTemplate(c)}
            onDescribeColumn={(c) => { setDescriptionDraft(c.description ?? ""); setDescribing(c); }}
            onFilterColumn={(c) => setFilterRequest({ columnId: Number(c.id), nonce: Date.now() })}
            onDedupeColumn={(c) => { setDedupeStartWith(Number(c.id)); setDedupeOpen(true); }}
            onRefreshDerived={(c) => { void refreshDerived(c); }}
            onNotice={setToast}
            /* Exactly what "+ Row" does, for the same reason: the breadcrumb count and the table
               tabs are separate trees reading their own counts, and a paste that grew the table
               left both of them showing the number from before it. */
            onRowsAdded={() => { bump(); void refreshSheet(sheet.id); }}
            onOverrideCell={(rowId, column, current) => setOverriding({ rowId, column, current })}
            onPinColumn={(c, pinned) => { void pinColumn(c, pinned); }}
            primaryColumnId={sheet.primaryColumnId}
            onSetPrimaryColumn={(columnId) => {
              void api.setPrimaryColumn(sheet.id, columnId).then((r) => {
                setSheet(r.sheet);
                setToast(columnId ? "Rows are named by that column now." : "Rows are back to being numbered.");
              }).catch((e) => setToast(String(e?.message ?? e)));
            }}
            onMoveColumn={(c, to) => { void moveColumn(c, to); }}
            onAddRow={() => { void addRow(); }}
            onOpenRecord={(position) => setRecordAt(position)}
            onDeleteRows={async (rowIds) => {
              try {
                const { deleted } = await api.deleteRows(sheet.id, rowIds);
                // Same reasoning as the single delete: positions after a removed row shift, so the
                // loaded window is no longer trustworthy — drop it and re-read.
                cellStore.reset();
                setOpenCell((c) => (c && rowIds.some((id) => c.cellId.startsWith(`${id}:`)) ? null : c));
                bump();
                await refreshSheet(sheet.id);
                setToast(`${deleted} row${deleted === 1 ? "" : "s"} deleted — undo to bring ${deleted === 1 ? "it" : "them"} back.`);
              } catch (e) {
                setToast(e instanceof Error ? e.message : "Could not delete those rows.");
              }
            }}
            onDeleteColumns={async (columnIds) => {
              try {
                const { deleted } = await api.deleteColumns(sheet.id, columnIds);
                setEditing((cur) => (cur && columnIds.includes(Number(cur.id)) ? null : cur));
                bump();
                await refreshSheet(sheet.id);
                setToast(`${deleted} column${deleted === 1 ? "" : "s"} deleted — undo to bring ${deleted === 1 ? "it" : "them"} back.`);
              } catch (e) {
                setToast(e instanceof Error ? e.message : "Could not delete those columns.");
              }
            }}
            onSelectAllRows={async () => (await api.allRowIds(sheet.id)).ids}
          />
          )}

          {assistantOpen && (
            <Assistant
              sheetId={sheet.id}
              columns={columns}
              onClose={() => setAssistantOpen(false)}
              onChanged={() => { cellStore.reset(); bump(); void refreshSheet(sheet.id); }}
            />
          )}

          {savingTemplate && (
            <SaveTemplate
              column={savingTemplate}
              onClose={() => setSavingTemplate(null)}
              onSaved={(name) => {
                setSavingTemplate(null);
                setToast(`Kept "${name}". Add it to any table from + Column → Your columns.`);
              }}
            />
          )}

          {galleryOpen && (
            <TemplateGallery
              sheetId={sheet.id}
              onClose={() => setGalleryOpen(false)}
              onApplied={(msg) => {
                setGalleryOpen(false);
                setToast(msg);
                // The new column has to appear without a reload, like any other column added here.
                void refreshSheet(sheet.id);
              }}
            />
          )}

          {schedulesOpen && (
            <Schedules
              sheetId={sheet.id}
              sheetName={sheet.name}
              columns={columns}
              onClose={() => setSchedulesOpen(false)}
            />
          )}

          {limitsOpen && (
            <Limits
              sheetId={sheet.id}
              sheetName={sheet.name}
              onClose={() => setLimitsOpen(false)}
              onOpenTable={(id) => { setLimitsOpen(false); void goToSheet(id); bump(); }}
            />
          )}

          {restoreOpen && (
            <RestorePoints
              sheetId={sheet.id}
              sheetName={sheet.name}
              onClose={() => setRestoreOpen(false)}
              // A restore rewrites cells in bulk without going through the per-cell bus — it can touch
              // a million of them, and pushing a million ids through to redraw the fifty on screen
              // would be worse than dropping the cache and refetching the window.
              onRestored={() => { cellStore.reset(); bump(); void refreshSheet(sheet.id); }}
            />
          )}

          {dedupeOpen && (
            <Dedupe
              sheetId={sheet.id}
              sheetName={sheet.name}
              columns={columns}
              startWith={dedupeStartWith}
              onClose={() => { setDedupeOpen(false); setDedupeStartWith(null); }}
              // Removing duplicates removes ROWS, so the tab bar's count for this table — a
              // different React tree, refetched only on `revision` — was left reading the total
              // from before the removal until something unrelated happened to bump it.
              onChanged={() => { cellStore.reset(); bump(); void refreshSheet(sheet.id); }}
            />
          )}

          {/* The tables of this workbook, along the bottom. Below the grid and above nothing, which
              is where every spreadsheet anyone has used puts them. */}
          <SheetTabs
            sheetId={sheet.id}
            revision={revision}
            onOpen={(id) => { void goToSheet(id); }}
            onChanged={() => { bump(); void api.listSheets().then(({ sheets }) => setSheets(sheets)); }}
          />

          {/* Two steps on purpose: pick the rows, THEN see the price. Merging them would mean
              approving a cost that moves while you are still choosing what to run. */}
          {(runRangeFor || runRangeAll) && (
            <RunScopeDialog
              columnName={runRangeFor ? runRangeFor.name : "every runnable column"}
              columnIds={runRangeFor
                ? [Number(runRangeFor.id)]
                : columns.filter((c) => c.kind !== "static").map((c) => Number(c.id))}
              rowCount={sheet.rowCount}
              onCancel={() => { setRunRangeFor(null); setRunRangeAll(false); }}
              onPick={(scope, title) => { setRunRangeFor(null); setRunRangeAll(false); setPendingRun({ scope, title }); }}
            />
          )}

          {expandJsonFor && (
            <ExpandJson
              columnId={expandJsonFor.id}
              columnName={expandJsonFor.name}
              onClose={() => setExpandJsonFor(null)}
              // New columns mean a new sheet shape, and their cells arrive populated — so the loaded
              // window is refetched rather than patched.
              onExpanded={() => { cellStore.reset(); bump(); void refreshSheet(sheet.id); }}
            />
          )}

          {pendingRun && (
            <ConfirmRun
              sheetId={sheet.id}
              scope={pendingRun.scope}
              title={pendingRun.title}
              onCancel={() => setPendingRun(null)}
              onStarted={() => setPendingRun(null)}
            />
          )}

          {sourcesOpen && (
            <Sources
              sheetId={sheet.id}
              columns={columns}
              onClose={() => setSourcesOpen(false)}
              // A delivery can land while this is open, so the grid re-reads rather than showing a
              // row count that stopped being true a moment ago.
              onChanged={() => { cellStore.reset(); bump(); void refreshSheet(sheet.id); }}
            />
          )}

          <CellPanel
            open={openCell}
            columns={columns}
            onClose={() => setOpenCell(null)}
            // Adding a column from a field changes this sheet's shape, so the grid has to learn
            // about it — otherwise the new column exists and is invisible until a reload.
            //
            // The reset is what makes those cells appear: `ensurePage` will not re-read a page it
            // already holds, so deltas for a column that did not exist when the window was fetched
            // are dropped. But the panel fires this for a single-cell RESTORE as well, and blanking
            // every loaded row to skeletons for one cell is exactly the full-surface flash the
            // reactive rule forbids — and needless, since the restore marks that cell dirty and its
            // new value arrives over the stream. So the store is only dropped when a column the grid
            // has never seen actually turned up.
            onColumnsChanged={() => {
              if (!sheet) return;
              const known = new Set(columns.map((c) => String(c.id)));
              bump();
              void refreshSheet(sheet.id).then((next) => {
                if (next?.some((c) => !known.has(String(c.id)))) cellStore.reset();
              });
            }}
            onOverride={(current) => {
              const [rowId, columnId] = (openCell?.cellId ?? "").split(":");
              const col = columns.find((c) => String(c.id) === String(columnId));
              if (rowId && col) setOverriding({ rowId, column: col, current });
            }}
            onOpenSettings={(s) => { setSettingsAt(s); urlToSettings(s); }}
            onEditColumn={() => {
              const columnId = (openCell?.cellId ?? "").split(":")[1];
              const col = columns.find((c) => String(c.id) === String(columnId));
              if (col) openColumnEditor(col);
            }}
            onExpandList={(columnId, path) => {
              const col = columns.find((c) => String(c.id) === String(columnId));
              if (!col) return;
              void addSendColumn(col, path);
            }}
            onRunCell={(cellId) => {
              const [rowId, columnId] = cellId.split(":").map(Number);
              if (!rowId || !columnId) return;
              void api.startRun(sheet!.id, { rowIds: [rowId], columnIds: [columnId], force: true });
            }}
          />

          {/* One sentence saying what a column is for. Small feature, and the difference between a
              thirty-column sheet somebody else can use and one only its author understands. */}
          <Modal
            open={!!describing}
            onClose={() => setDescribing(null)}
            title={`What is "${describing?.name}" for?`}
            footNote="Shown when you hover the column header."
            footer={
              <>
                <button className="cc-btn" onClick={() => setDescribing(null)}>Cancel</button>
                <button
                  className="cc-btn cc-btn--primary"
                  onClick={() => {
                    const target = describing;
                    setDescribing(null);
                    if (!target) return;
                    void (async () => {
                      try {
                        await api.describeColumn(target.id, descriptionDraft);
                        await refreshSheet(target.sheetId);
                      } catch { setToast("Could not save that description."); }
                    })();
                  }}
                >
                  Save
                </button>
              </>
            }
          >
            <textarea
              className="cc-textarea"
              rows={4}
              autoFocus
              value={descriptionDraft}
              placeholder="Where this comes from, what counts as a good value, anything the next person would ask."
              aria-label="Column description"
              onChange={(e) => setDescriptionDraft(e.target.value)}
            />
          </Modal>

          {/* Deleting a column destroys every value in it, and there is no undo yet — so the dialog
              says how many rows are affected rather than asking "are you sure?" about nothing. */}
          <Modal
            open={!!confirmDeleteColumn}
            onClose={() => setConfirmDeleteColumn(null)}
            title="Delete this column?"
            footNote="This cannot be undone."
            footer={
              <>
                <button className="cc-btn" onClick={() => setConfirmDeleteColumn(null)}>Keep it</button>
                <button className="cc-btn cc-btn--danger" onClick={() => void doDeleteColumn()}>Delete column</button>
              </>
            }
          >
            <p className="cc-modal__summary">
              <strong>{confirmDeleteColumn?.name}</strong> and its {sheet.rowCount.toLocaleString()} values
              are removed. Any rule that references this column will need editing.
            </p>
          </Modal>

          <Modal
            open={!!confirmDeleteRow}
            onClose={() => setConfirmDeleteRow(null)}
            title="Delete this row?"
            footNote="This cannot be undone."
            footer={
              <>
                <button className="cc-btn" onClick={() => setConfirmDeleteRow(null)}>Keep it</button>
                <button className="cc-btn cc-btn--danger" onClick={() => void doDeleteRow()}>Delete row</button>
              </>
            }
          >
            <p className="cc-modal__summary">
              The row and its {columns.length} values are removed from <strong>{sheet.name}</strong>.
            </p>
          </Modal>

          {editing && (
            <ColumnEditor
              // Keyed on the column, so switching columns REMOUNTS the drawer. Most of the editor's
              // state is seeded once in its useState initializers — mode, model, value type, search,
              // request, destination, instruction, auto-run — and only `code`, `intent` and
              // `runtime` are re-seeded on a column change. Without a key, opening a second column
              // from a header menu kept the first one's unsaved rule on screen while every write,
              // including the instruction autosave, went to the NEW column's id.
              key={editing.id}
              sheetId={sheet.id}
              // Looked up by id on every render rather than passed as the snapshot taken when the
              // drawer opened. The drawer now writes settings the drawer itself has to read back —
              // an AI setup can change the mode, the type, the instruction and the request in one
              // go — and a frozen prop would leave every one of those screens showing the values
              // from before the change it just made.
              column={columns.find((c) => c.id === editing.id) ?? editing}
              columns={columns}
              sheets={sheets}
              rowCount={sheet.rowCount}
              onClose={() => { editorDirtyRef.current = false; editorRequestCloseRef.current = null; setEditing(null); }}
              onSaved={() => { bump(); void refreshSheet(sheet.id); }}
              onDirtyChange={(d) => { editorDirtyRef.current = d; }}
              bindRequestClose={(fn) => { editorRequestCloseRef.current = fn; }}
            />
          )}
        </>
      )}

      {/* Outside the sheet branch on purpose: the app bar offers a menu even with no sheet open, and
          a menu rendered only alongside a sheet would set state that nothing draws. */}
      <ContextMenu menu={shell.menu} onClose={shell.close} />

      {/* Writing over a value a column produced for itself. Rendered at the app level so it sits
          above both the grid and the cell panel, either of which can ask for it. */}
      {overriding && (
        <OverrideCell
          target={overriding}
          columns={columns}
          onClose={() => setOverriding(null)}
          onNotice={setToast}
          onDone={(cell) => {
            // The server's version of the cell, not the typed string — the write also pins it and
            // clears any error, and the grid has to show that rather than a value that merely looks
            // right until the next reload.
            const c = cell as { status?: string; value?: unknown; rev?: number; stale?: boolean; pinned?: boolean } | null;
            if (!c) return;
            cellStore.applyDeltas([{
              id: `${overriding.rowId}:${overriding.column.id}`,
              status: c.status, value: c.value ?? null, rev: c.rev, stale: c.stale, pinned: c.pinned,
            }] as never);
          }}
        />
      )}

      {/* Last, and outside every conditional above it: the palette can be opened over a drawer, a
          dialog or the file browser, and it must render above whichever of those is up. */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />

      <Toast message={toast} onDone={() => setToast(null)} />

      {/* Last in the tree and lowest of the floating layers, so it is never what covers a dialog. */}
      <SupportButton />
    </div>
  );
}

/**
 * Mirrors the real surface's shape — toolbar, header row, rows — so hydrating causes no jump.
 *
 * ONE toolbar row, because that is what the real surface has. This drew a second 36px row left over
 * from when the toolbar was two lines, so the whole grid jumped up by exactly that much the moment
 * a table finished loading — the layout shift the skeleton exists to prevent, caused by the
 * skeleton.
 */
function SheetSkeleton() {
  return (
    <div className="cc-skelpage">
      <div className="cc-toolbar cc-toolbar--1" />
      <div className="cc-skelpage__grid">
        {Array.from({ length: 15 }, (_, i) => (
          <div key={i} className="cc-skelpage__row">
            <span className="cc-skel" style={{ width: `${30 + ((i * 11) % 40)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* Left-aligned, one concrete sentence, two real actions — not a centred hero with three identical
   icon cards.

   `error` is the case where the workspace was never read at all. "No sheets yet" is a claim about
   what is in there, and making it on a request that failed is worse than saying nothing: it reads
   as an empty workspace next to a button that cannot possibly work. */
function EmptyState({
  onNew, error, onRetry, onBuild, onBrowse,
}: {
  onNew: () => void;
  error?: string | null;
  onRetry: () => void;
  onBuild: () => void;
  onBrowse: () => void;
}) {
  return (
    <div className="cc-empty">
      {/*
        A bounded panel, not a paragraph adrift in the viewport.

        It was `flex: 1` with a 460px block inside it, so on a full-height window a title and two
        lines floated in the middle of an otherwise empty screen with nothing to give it an edge —
        the fill-it-or-shrink-it case, answered both ways at once: shrink the box to its content,
        and fill it with the routes that actually exist.

        The copy already said "bring in a CSV" and offered no way to do it, which is the other half
        of why this read as empty: one button under a sentence describing three things.
      */}
      <div className="cc-empty__body">
        <h1 className="cc-empty__title">{error ? "Can’t read your tables" : "No tables yet"}</h1>
        <p className="cc-empty__copy">
          {error
            ? `${error} Ferrum runs on this machine — start it, then press Try again.`
            : "A table is a grid of rows where each column can be typed in, or fill itself in by asking a model, running a rule or calling an API."}
        </p>
        <div className="cc-empty__actions">
          {error ? (
            <button className="cc-btn cc-btn--primary" onClick={onRetry}>
              Try again
            </button>
          ) : (
            <>
              <button className="cc-btn cc-btn--primary" onClick={onNew}>
                <IconPlus /> <span>Table</span>
              </button>
              {/* Both of these already existed and were reachable only from the command palette or a
                  right-click, neither of which anyone finds on their first screen. */}
              <button className="cc-btn" onClick={onBuild} title="Describe what you want and answer a few questions">
                Build one with AI
              </button>
              <button className="cc-btn" onClick={onBrowse} title="Folders, workbooks and templates">
                Browse your files
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
