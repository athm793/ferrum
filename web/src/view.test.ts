// The one definition of "apply this view" — and the one thing hiding must never do: change which
// rows a run covers or which rows an export carries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_VIEW, savedViewToGrid, viewQuery, viewScope, type SavedView } from "./view.ts";

test("a saved view carries its hidden columns into the grid", () => {
  const s: SavedView = {
    id: 1, name: "Leads", filter: { conj: "and", children: [] }, sorts: [], search: null,
    columns: { hidden: [4, 2, 7] },
  };
  assert.deepEqual(savedViewToGrid(s).hidden, [4, 2, 7]);
});

test("a view with no hidden columns reads as none, not undefined", () => {
  const s: SavedView = { id: 2, name: "All", filter: { conj: "and", children: [] }, sorts: [], search: null };
  const v = savedViewToGrid(s);
  assert.deepEqual(v.hidden, []);
  assert.deepEqual(EMPTY_VIEW.hidden, []);
});

test("hiding a column is presentation only", () => {
  const v = { ...EMPTY_VIEW, hidden: [3] };
  // The rows endpoint must not hear about it, and a run scoped to what is on screen covers the
  // same rows whether the column is shown or not. This is the property that stops "hide the messy
  // column" from quietly narrowing the next run.
  assert.equal(viewQuery(v), "");
  assert.deepEqual(viewScope(v), {});
});
