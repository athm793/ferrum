// The grid's data store. Deliberately NOT React state.
//
// The problem this solves: with 200 cells finishing concurrently, holding cell data in component
// state means every arriving value re-renders the grid. Here each <Cell> subscribes to its own key
// via useSyncExternalStore, so one cell's value change re-renders exactly one leaf.
//
// Two further guarantees:
//   - Incoming deltas are buffered and applied on an animation frame, so a burst costs one notify
//     pass per frame rather than one per delta.
//   - The store holds ONLY the loaded window. At a million rows x 30 columns, keeping every cell
//     would be tens of millions of objects and gigabytes of heap, so rows evict LRU-style once the
//     retained set exceeds a cap.

import type { CellDelta, CellStatus } from "../types.ts";

export interface CellRecord {
  id: string;
  status: CellStatus;
  value: string | null;
  stale?: boolean;
  pinned?: boolean;
  /** The error CLASS — a bucket name like "timeout" or "cancelled". */
  error?: string;
  /** What actually happened, in words. The class alone explains nothing to the person reading it. */
  message?: string;
  /** Server revision. A delta with rev <= the held rev is dropped, which makes duplicate,
   *  out-of-order, and replayed frames all harmless. */
  rev: number;
  /** Epoch ms when this cell entered `running` — drives the elapsed readout. */
  startedAt?: number;
}

export interface RowRecord {
  id: string;
  position: number;
  cells: Record<string, CellRecord>;
}

type Listener = () => void;

/** Rows retained in memory. ~2000 rows x 30 cols = 60k records, comfortably small, and far more
 *  than any viewport plus overscan needs. */
const MAX_RETAINED_ROWS = 2000;

class CellStore {
  private rows = new Map<string, RowRecord>();
  private byPosition = new Map<number, string>();
  /** Insertion-ordered recency for eviction. A Map preserves insertion order, so re-inserting a key
   *  moves it to the end — that is the whole LRU mechanism. */
  private recency = new Set<string>();

  private cellListeners = new Map<string, Set<Listener>>();
  private rowListeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<Listener>();

  private pending = new Map<string, CellDelta>();
  private frame: number | null = null;

  /** cellId -> its row, so a delta (which only carries a cell id) can find its bucket. */
  private cellIndex = new Map<string, { rowId: string; columnId: string }>();

  private _total = 0;
  get total(): number { return this._total; }

  /**
   * Monotonic structure version.
   *
   * useSyncExternalStore re-renders only when the SNAPSHOT changes, so subscribing to `total` alone
   * silently fails: a page of rows arriving does not change the row count, React bails out, and the
   * grid sits on skeletons forever even though the data is in the store. This counter is the
   * snapshot instead, and it bumps on any structural change.
   */
  private _version = 0;
  get version(): number { return this._version; }

  setTotal(n: number): void {
    if (n === this._total) return;
    this._total = n;
    this._version++;
    this.notifyGlobal();
  }

  // ── reads ────────────────────────────────────────────────────

  getRowByPosition(position: number): RowRecord | undefined {
    const id = this.byPosition.get(position);
    return id ? this.rows.get(id) : undefined;
  }

  getCell(rowId: string, columnId: string): CellRecord | undefined {
    return this.rows.get(rowId)?.cells[columnId];
  }

  hasRow(position: number): boolean {
    return this.byPosition.has(position);
  }

  // ── window ingestion ─────────────────────────────────────────

  /**
   * A page of rows, straight from the server.
   *
   * The rev guard runs HERE too, not only in `drain()`. A window read races the delta stream — a
   * run's frames keep draining for seconds after it reports done, and `ensurePage` fires on every
   * scroll into an unloaded page — so a page fetched in that gap carries the value from BEFORE
   * those frames. Applied blind it reverted the cell AND reset its rev to 0, which made the revert
   * permanent: nothing could correct it until the next write to that cell, and after a finished run
   * there is no next write.
   *
   * The window's rev is read off the payload (`r`) and falls back to 0, because `readWindow` does
   * not SELECT `rev` yet. Falling back to 0 is the safe direction: a cell the stream has already
   * advanced is kept, and a cell nobody has touched is taken from the page as before.
   *
   * The comparison is STRICTLY greater, and that is the whole fix rather than a style choice. The
   * delta path drops `d.r <= cur.rev` because a delta carries a REAL rev and an equal one is a
   * replay. A page carries the 0 fallback for every cell, so `rev <= held.rev` was true for every
   * cell the stream had never touched (0 <= 0) — a refetch after an import, a dedupe, an undo or a
   * hand edit kept showing the value from before it, with nothing on screen to say so.
   */
  ingestWindow(rows: Array<{ id: string; position: number; cells: Record<string, any> }>): void {
    for (const r of rows) {
      const prev = this.rows.get(r.id);
      const cells: Record<string, CellRecord> = {};
      for (const [colId, c] of Object.entries(r.cells)) {
        this.cellIndex.set(c.id, { rowId: r.id, columnId: colId });
        const rev = Number(c.r ?? 0);
        const held = prev?.cells[colId];
        // Only what the stream has genuinely advanced PAST the page survives the page.
        if (held && held.rev > rev) { cells[colId] = held; continue; }
        cells[colId] = {
          id: c.id,
          status: c.s,
          value: c.v ?? null,
          stale: !!c.stale,
          pinned: !!c.pinned,
          error: c.e,
          message: c.m,
          rev,
        };
      }
      this.rows.set(r.id, { id: r.id, position: r.position, cells });
      this.byPosition.set(r.position, r.id);
      this.touch(r.id);
      this.notifyRow(r.id);
    }
    this.evict();
    this._version++;
    this.notifyGlobal();
  }

  private touch(rowId: string): void {
    this.recency.delete(rowId);
    this.recency.add(rowId);
  }

  /** Drop least-recently-touched rows once over the cap. This is what keeps a 1M-row sheet from
   *  becoming a 1M-row heap. */
  private evict(): void {
    if (this.rows.size <= MAX_RETAINED_ROWS) return;
    const excess = this.rows.size - MAX_RETAINED_ROWS;
    let n = 0;
    for (const rowId of this.recency) {
      if (n >= excess) break;
      const row = this.rows.get(rowId);
      if (row) {
        for (const c of Object.values(row.cells)) this.cellIndex.delete(c.id);
        this.byPosition.delete(row.position);
        this.rows.delete(rowId);
      }
      this.recency.delete(rowId);
      n++;
    }
  }

  // ── live deltas ──────────────────────────────────────────────

  applyDeltas(deltas: CellDelta[]): void {
    for (const d of deltas) this.pending.set(d.i, d);
    if (this.frame != null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.drain();
    });
  }

  private drain(): void {
    const touchedRows = new Set<string>();
    for (const d of this.pending.values()) {
      const idx = this.cellIndex.get(d.i);
      if (!idx) continue; // belongs to a row outside the loaded window — nothing to update
      const row = this.rows.get(idx.rowId);
      if (!row) continue;
      const cur = row.cells[idx.columnId];
      if (!cur) continue;
      // Older or duplicate frame — ignore it rather than letting the UI go backwards.
      if (d.r <= cur.rev) continue;

      const next: CellRecord = {
        ...cur,
        rev: d.r,
        status: d.s,
        error: d.e,
        message: d.m,
      };
      if ("v" in d) next.value = d.v ?? null;
      if (d.s === "running" && cur.status !== "running") next.startedAt = Date.now();
      if (d.s !== "running") next.startedAt = undefined;

      row.cells[idx.columnId] = next;
      this.notifyCell(idx.rowId, idx.columnId);
      touchedRows.add(idx.rowId);
    }
    this.pending.clear();
    for (const r of touchedRows) this.notifyRow(r);
  }

  // ── subscriptions ────────────────────────────────────────────

  private key(rowId: string, columnId: string): string { return rowId + ":" + columnId; }

  subscribeCell(rowId: string, columnId: string, l: Listener): () => void {
    const k = this.key(rowId, columnId);
    let set = this.cellListeners.get(k);
    if (!set) { set = new Set(); this.cellListeners.set(k, set); }
    set.add(l);
    return () => {
      set!.delete(l);
      if (set!.size === 0) this.cellListeners.delete(k);
    };
  }

  subscribeRow(rowId: string, l: Listener): () => void {
    let set = this.rowListeners.get(rowId);
    if (!set) { set = new Set(); this.rowListeners.set(rowId, set); }
    set.add(l);
    return () => {
      set!.delete(l);
      if (set!.size === 0) this.rowListeners.delete(rowId);
    };
  }

  subscribeGlobal(l: Listener): () => void {
    this.globalListeners.add(l);
    return () => { this.globalListeners.delete(l); };
  }

  private notifyCell(rowId: string, columnId: string): void {
    const set = this.cellListeners.get(this.key(rowId, columnId));
    if (set) for (const l of set) l();
  }
  private notifyRow(rowId: string): void {
    const set = this.rowListeners.get(rowId);
    if (set) for (const l of set) l();
  }
  private notifyGlobal(): void {
    for (const l of this.globalListeners) l();
  }

  reset(): void {
    this.rows.clear();
    this.byPosition.clear();
    this.recency.clear();
    this.cellIndex.clear();
    this.pending.clear();
    this._total = 0;
    this._version++;
    this.notifyGlobal();
  }

  // ── the gutter badge ─────────────────────────────────────────

  /**
   * What a row's own cells say, for the gutter dot.
   *
   * Computed from the LOADED cells, not from a server aggregate: the delta stream already keeps
   * them live, so the badge moves the moment a cell fails or starts, with no second fetch to go
   * stale between pages. Null when the row holds nothing worth a dot.
   */
  rowBadge(rowId: string): { errors: number; live: number; stale: number } | null {
    const row = this.rows.get(rowId);
    if (!row) return null;
    let errors = 0, live = 0, stale = 0;
    for (const c of Object.values(row.cells)) {
      if (c.status === "error") errors++;
      else if (c.status === "running" || c.status === "queued") live++;
      if (c.stale) stale++;
    }
    if (errors === 0 && live === 0 && stale === 0) return null;
    return { errors, live, stale };
  }

  /** The same answer as a string, so useSyncExternalStore can compare snapshots cheaply. */
  rowBadgeKey(rowId: string): string {
    const b = this.rowBadge(rowId);
    return b ? `e${b.errors}r${b.live}s${b.stale}` : "";
  }
}

export const cellStore = new CellStore();

/**
 * One 1Hz tick for every elapsed timer in the grid.
 *
 * 500 running cells each owning a setInterval is 500 timers and 500 independent re-renders a second.
 * One shared clock is 1 timer, and cells read the current second from it.
 */
class Clock {
  private listeners = new Set<Listener>();
  private timer: number | null = null;
  private _now = Date.now();
  get now(): number { return this._now; }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    if (this.timer == null) {
      this.timer = window.setInterval(() => {
        this._now = Date.now();
        for (const fn of this.listeners) fn();
      }, 1000);
    }
    return () => {
      this.listeners.delete(l);
      // No running cells left — stop ticking rather than burning a timer forever.
      if (this.listeners.size === 0 && this.timer != null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}

export const clock = new Clock();
