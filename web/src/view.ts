// How the grid is currently being looked at, and the ONE place it is turned into a request.
//
// The grid reads through `viewQuery` and a run scopes through `viewScope`. Both derive from the same
// object, so "Run" always covers the rows on screen. If these were built separately, a filtered grid
// could hand the engine a wider set than the user was looking at — which on a paid column is the
// most expensive bug this app could have.

export interface Condition {
  columnId: number;
  op: string;
  value?: string | number | boolean | Array<string | number>;
}

export interface FilterGroup {
  conj: "and" | "or";
  children: Condition[];
}

export interface GridView {
  /** Free text, matched against every column. */
  search: string;
  /** Cell statuses to keep. Empty means every status. */
  status: string[];
  sort: { columnId: number; dir: "asc" | "desc" } | null;
  /** The filter bar's conditions. Null when nothing is built. */
  filter: FilterGroup | null;
  /**
   * Column ids the grid does NOT render, as numbers to match the engine's
   * `views.columns_json.hidden` and `sort.columnId` beside it.
   *
   * Presentation only, and deliberately kept out of `viewQuery` and `viewScope`: hiding a column
   * changes what is on screen, never which rows a run covers or what an export carries.
   */
  hidden: number[];
}

export const EMPTY_VIEW: GridView = { search: "", status: [], sort: null, filter: null, hidden: [] };

/** A saved view as the engine stores it. Sorts are an ARRAY in storage; the grid reads one today. */
export interface SavedView {
  id: number;
  name: string;
  filter: FilterGroup;
  sorts: Array<{ columnId: number; dir: "asc" | "desc" }>;
  search: string | null;
  /** The engine's `views.columns_json`, of which only `hidden` is read today. */
  columns?: { hidden?: number[] };
}

/**
 * Turning a SAVED view into the grid's current view. The one definition of "apply this view".
 *
 * It lived inside the view bar while the bar was the only thing that applied one. A table that opens
 * on a default view applies one too, and two copies of this would eventually disagree about what a
 * saved view means — which is the same failure `viewQuery` and `viewScope` sit here to prevent.
 *
 * A filter with no children becomes null rather than an empty group, so a view saved mid-edit cannot
 * blank the grid. `status` is deliberately not carried: it is a transient "show me the errors"
 * narrowing, not part of what a view names.
 */
export function savedViewToGrid(s: SavedView): GridView {
  return {
    search: s.search ?? "",
    status: [],
    sort: s.sorts?.[0] ?? null,
    filter: s.filter?.children?.length ? s.filter : null,
    hidden: (s.columns?.hidden ?? []).map(Number),
  };
}

/** A filter with no usable conditions must serialise as NOTHING, not as an empty group.
 *  An empty group compiles to a predicate that matches everything, which is harmless — but a
 *  half-built condition (a column picked, no value typed) would compile to one that matches nothing,
 *  and the grid would go blank while the user was still choosing. */
export function usableFilter(f: FilterGroup | null): FilterGroup | null {
  if (!f) return null;
  const children = f.children.filter(isComplete);
  return children.length > 0 ? { conj: f.conj, children } : null;
}

/** Operators that need no value are complete as soon as a column is picked. */
const NO_VALUE = new Set(["is_empty", "is_not_empty", "is_stale", "is_not_stale", "is_pinned"]);

export function isComplete(c: Condition): boolean {
  if (!c.columnId || !c.op) return false;
  if (NO_VALUE.has(c.op)) return true;
  if (Array.isArray(c.value)) return c.value.length > 0 && c.value.every((v) => String(v).trim() !== "");
  return c.value != null && String(c.value).trim() !== "";
}

/** True when the view narrows or reorders anything — drives the "clear" affordance. */
export function isNarrowed(v: GridView): boolean {
  return v.search.trim() !== "" || v.status.length > 0 || usableFilter(v.filter) !== null;
}

/** Query-string fragment for the rows endpoint. Always starts with "&" or is empty. */
export function viewQuery(v: GridView): string {
  const p = new URLSearchParams();
  if (v.search.trim()) p.set("q", v.search.trim());
  if (v.status.length) p.set("status", v.status.join(","));
  const f = usableFilter(v.filter);
  if (f) p.set("filter", JSON.stringify(f));
  if (v.sort) { p.set("sort", String(v.sort.columnId)); p.set("dir", v.sort.dir); }
  const s = p.toString();
  return s ? `&${s}` : "";
}

/** The same narrowing, in the shape a run scope takes. Sort is omitted — order does not change WHICH
 *  rows run, and including it would make two identical runs look different. */
export function viewScope(v: GridView): { search?: string; statuses?: string[]; filter?: FilterGroup } {
  const out: { search?: string; statuses?: string[]; filter?: FilterGroup } = {};
  if (v.search.trim()) out.search = v.search.trim();
  if (v.status.length) out.statuses = v.status;
  // The SAME usableFilter the grid serialises. If these two ever diverged, a run would cover a
  // different set of rows than the one on screen — the failure this whole module exists to prevent.
  const f = usableFilter(v.filter);
  if (f) out.filter = f;
  return out;
}
