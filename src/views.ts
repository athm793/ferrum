// Saved views, workbooks, and per-row run status.
//
// A view owns the whole presentation state AND the predicate a scoped run targets. Keeping both in
// one record is deliberate: if the filter that draws the grid and the filter that selects rows for a
// run could drift apart, "run the visible rows" would eventually spend money on rows the user cannot
// see. One record, one predicate.

import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import type { FilterGroup } from "./filter.ts";
import { isSheetKind } from "./types.ts";
import type { CellStatus, SheetKind } from "./types.ts";

// ─────────────────────────────────────────────────────────────── workbooks

export interface Workbook {
  id: string;
  name: string;
  description: string | null;
  isTemplate: boolean;
  publicToken: string | null;
  /** The workbook's spending ceiling in USD, enforced by `budgetExceeded` over every table in it. Null = no cap. */
  budgetUsd: number | null;
  tableCount: number;
  createdAt: string;
  updatedAt: string;
}

function toWorkbook(r: any): Workbook {
  return {
    id: r.id, name: r.name, description: r.description ?? null,
    isTemplate: !!r.is_template, publicToken: r.public_token ?? null,
    budgetUsd: r.budget_usd == null ? null : Number(r.budget_usd),
    tableCount: Number(r.table_count ?? 0),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const wbSelect = `
  SELECT w.*, (SELECT COUNT(*) FROM sheets WHERE workbook_id = w.id AND deleted_at IS NULL) AS table_count
    FROM workbooks w`;

/**
 * `createdBy` is who made it.
 *
 * Null on a single-user install, where the question has one answer. It is what gives the maker of a
 * workbook their own way back into it after they mark it restricted — otherwise the first thing
 * restricting does is lock out the person who pressed the button.
 */
export function createWorkbook(name: string, createdBy: number | null = null): Workbook {
  const id = randomUUID();
  db.prepare("INSERT INTO workbooks (id, name, created_by) VALUES (?, ?, ?)").run(id, name, createdBy);
  return getWorkbook(id)!;
}

export function getWorkbook(id: string): Workbook | null {
  const r = db.prepare(`${wbSelect} WHERE w.id = ? AND w.archived = 0`).get(id) as any;
  return r ? toWorkbook(r) : null;
}

export function listWorkbooks(): Workbook[] {
  return (db.prepare(`${wbSelect} WHERE w.archived = 0 AND w.is_template = 0 ORDER BY w.updated_at DESC`).all() as any[])
    .map(toWorkbook);
}

export function listTemplates(): Workbook[] {
  return (db.prepare(`${wbSelect} WHERE w.archived = 0 AND w.is_template = 1 ORDER BY w.updated_at DESC`).all() as any[])
    .map(toWorkbook);
}

export function listTables(workbookId: string): Array<{ id: string; name: string; position: number; kind: SheetKind; rowCount: number }> {
  return (
    db
      .prepare(
        `SELECT s.id, s.name, s.position, s.kind,
                (SELECT COUNT(*) FROM rows WHERE sheet_id = s.id) AS row_count
           FROM sheets s
          WHERE s.workbook_id = ? AND s.deleted_at IS NULL
          ORDER BY s.position`,
      )
      .all(workbookId) as any[]
  ).map((r) => ({
    id: r.id, name: r.name, position: r.position,
    kind: isSheetKind(r.kind) ? r.kind : "generic",
    rowCount: Number(r.row_count),
  }));
}

/** Soft delete — a destructive action on a large table has to be recoverable. */
export function trashTable(sheetId: string): void {
  db.prepare("UPDATE sheets SET deleted_at = datetime('now') WHERE id = ?").run(sheetId);
}

export function restoreTable(sheetId: string): void {
  db.prepare("UPDATE sheets SET deleted_at = NULL WHERE id = ?").run(sheetId);
}

// ─────────────────────────────────────────────────────────────── views

export interface View {
  id: number;
  sheetId: string;
  name: string;
  position: number;
  filter: FilterGroup;
  sorts: Array<{ columnId: number; dir: "asc" | "desc" }>;
  columns: { order?: number[]; hidden?: number[]; widths?: Record<string, number>; frozen?: number };
  groupBy: number | null;
  rowHeight: "compact" | "default" | "tall";
  search: string | null;
  isShared: boolean;
}

const EMPTY_FILTER: FilterGroup = { conj: "and", children: [] };

function toView(r: any): View {
  const parse = <T>(s: string, fallback: T): T => {
    try { return JSON.parse(s) as T; } catch { return fallback; }
  };
  return {
    id: Number(r.id), sheetId: r.sheet_id, name: r.name, position: r.position,
    filter: parse<FilterGroup>(r.filter_json, EMPTY_FILTER),
    sorts: parse(r.sorts_json, []),
    columns: parse(r.columns_json, {}),
    groupBy: r.group_by ?? null,
    rowHeight: r.row_height,
    search: r.search ?? null,
    isShared: !!r.is_shared,
  };
}

export function listViews(sheetId: string): View[] {
  return (db.prepare("SELECT * FROM views WHERE sheet_id = ? ORDER BY position, id").all(sheetId) as any[]).map(toView);
}

export function getView(id: number): View | null {
  const r = db.prepare("SELECT * FROM views WHERE id = ?").get(Number(id)) as any;
  return r ? toView(r) : null;
}

export function createView(sheetId: string, name: string, patch: Partial<View> = {}): View {
  const pos = Number(
    (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM views WHERE sheet_id = ?").get(sheetId) as any).p,
  ) + 1;
  const res = db
    .prepare(
      `INSERT INTO views (sheet_id, name, position, filter_json, sorts_json, columns_json, group_by, row_height, search)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sheetId, name, pos,
      JSON.stringify(patch.filter ?? EMPTY_FILTER),
      JSON.stringify(patch.sorts ?? []),
      JSON.stringify(patch.columns ?? {}),
      patch.groupBy ?? null,
      patch.rowHeight ?? "default",
      patch.search ?? null,
    );
  return getView(Number(res.lastInsertRowid))!;
}

export function updateView(id: number, patch: Partial<View>): View | null {
  const cur = getView(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE views SET name = ?, filter_json = ?, sorts_json = ?, columns_json = ?,
                      group_by = ?, row_height = ?, search = ?, is_shared = ?,
                      updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    patch.name ?? cur.name,
    JSON.stringify(patch.filter ?? cur.filter),
    JSON.stringify(patch.sorts ?? cur.sorts),
    JSON.stringify(patch.columns ?? cur.columns),
    patch.groupBy !== undefined ? patch.groupBy : cur.groupBy,
    patch.rowHeight ?? cur.rowHeight,
    patch.search !== undefined ? patch.search : cur.search,
    (patch.isShared ?? cur.isShared) ? 1 : 0,
    Number(id),
  );
  return getView(id);
}

export function deleteView(id: number): void {
  db.prepare("DELETE FROM views WHERE id = ?").run(Number(id));
}

/**
 * The view a table opens on.
 *
 * Deliberately NOT cleared when the view it names is deleted. A view delete is undoable and restores
 * the row with its original id (see `undo.ts`), so the pointer heals itself; the read path in
 * `store.ts` resolves a currently-dangling one to null. Clearing it here would turn an undoable
 * action into a silent, permanent loss of the setting.
 */
export function setDefaultView(sheetId: string, viewId: number | null): void {
  if (viewId != null) {
    const ok = db.prepare("SELECT 1 FROM views WHERE id = ? AND sheet_id = ?").get(Number(viewId), sheetId);
    if (!ok) throw new Error("That view is not on this table.");
  }
  db.prepare("UPDATE sheets SET default_view_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(viewId == null ? null : Number(viewId), sheetId);
}

// ─────────────────────────────────────────────────────────────── per-row status
//
// The gutter shows a row's aggregate state: a blue count while cells are running, red when any
// failed. Computed for the visible window only — never for the whole table.

export interface RowStatus {
  rowId: number;
  running: number;
  queued: number;
  errors: number;
  stale: number;
  /** The single state the gutter badge shows, by severity. */
  worst: CellStatus | null;
}

const SEVERITY: CellStatus[] = ["error", "running", "queued", "blocked", "skipped", "not_found", "done", "empty"];

export function rowStatuses(rowIds: number[]): Map<number, RowStatus> {
  const out = new Map<number, RowStatus>();
  if (rowIds.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT row_id, status, SUM(stale) AS stale_n, COUNT(*) AS n
         FROM cells WHERE row_id IN (${rowIds.map(() => "?").join(",")})
        GROUP BY row_id, status`,
    )
    .all(...rowIds) as any[];

  for (const id of rowIds) out.set(id, { rowId: id, running: 0, queued: 0, errors: 0, stale: 0, worst: null });

  for (const r of rows) {
    const s = out.get(Number(r.row_id))!;
    const n = Number(r.n);
    if (r.status === "running") s.running += n;
    else if (r.status === "queued") s.queued += n;
    else if (r.status === "error") s.errors += n;
    s.stale += Number(r.stale_n ?? 0);

    const cur = s.worst;
    if (cur == null || SEVERITY.indexOf(r.status) < SEVERITY.indexOf(cur)) s.worst = r.status;
  }
  return out;
}
