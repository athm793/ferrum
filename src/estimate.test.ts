// What a run will cost, before it starts.
//
// The number this produces is the one a person approves a run on, so the failure that matters is
// the one that reports LESS than the truth. A declared third-party rate going missing here was
// exactly that: an HTTP column that had been told "2 credits a call, 1,000 credits for $49"
// estimated at $0, and the dialog whose whole job is to say what a run will spend said nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRun } from "./estimate.ts";
import { createSheet } from "./store.ts";
import { addColumn, setColumnHttpConfig, insertRows } from "./store.ts";
import { normalizeHttpConfig, DEFAULT_HTTP } from "./http/httpColumn.ts";
import { getColumn } from "./store.ts";
import { savePrice } from "./providers/prices.ts";
import { db } from "./db.ts";

function httpColumn(cost: unknown) {
  const s = createSheet(`ZZ est ${Math.random().toString(36).slice(2, 7)}`);
  const c = addColumn(s.id, { name: "ZZ call", kind: "http", valueType: "text" });
  setColumnHttpConfig(
    Number(c.id),
    normalizeHttpConfig({ ...DEFAULT_HTTP, url: "https://api.example.com/x", cost }) as never,
  );
  return getColumn(Number(c.id))!;
}

test("a declared rate reaches the estimate", async () => {
  const col = httpColumn({ unit: "credits", perCall: 2, packUnits: 1000, packUsd: 49 });
  const est = await estimateRun([col], 1000);
  // 2 credits a call at $0.049 per credit-pair → $0.098 a row, $98 over a thousand rows.
  assert.ok(Math.abs(est.total - 98) < 0.001, `got ${est.total}`);
  assert.equal(est.free, false);
  assert.equal(est.external, true, "the money still leaves through someone else's account");
});

test("an undeclared API column is still not called free", async () => {
  const col = httpColumn(undefined);
  const est = await estimateRun([col], 1000);
  assert.equal(est.total, 0, "nothing is invented");
  assert.equal(est.free, false, "but 'we cannot price this' is not 'this is free'");
  assert.equal(est.external, true);
});

test("a fan-out column's estimate carries the item distribution", async () => {
  // Priced through a typed rate so the arithmetic is real, then asserted on the RATIO between the
  // worst and average cases rather than on dollars — the ratio is the feature; the token arithmetic
  // underneath is shared with every other estimate and covered there.
  savePrice({ provider: "openrouter", model: "openrouter/fo-model", input: 1, output: 3, scale: 1_000_000 });
  const s = createSheet("ZZ fo est");
  const source = addColumn(s.id, { name: "Titles", valueType: "json" });
  const col = addColumn(s.id, { name: "Per title", kind: "ai" });
  db.prepare("UPDATE columns SET model = 'openrouter/fo-model' WHERE id = ?").run(Number(col.id));
  const srcId = Number(source.id);
  insertRows(
    s.id,
    [
      { values: { [srcId]: "x" } },
      { values: { [srcId]: "y" } },
    ],
    0,
    [srcId],
  );
  // Row 1 holds two items, row 2 holds four: avg 3, max 4 over the sampled rows.
  db.prepare("UPDATE cells SET value_json = ?, value_text = NULL WHERE row_id = (SELECT MIN(id) FROM rows WHERE sheet_id = ?) AND column_id = ?")
    .run(JSON.stringify(["a", "b"]), s.id, srcId);
  db.prepare("UPDATE cells SET value_json = ?, value_text = NULL WHERE row_id = (SELECT MAX(id) FROM rows WHERE sheet_id = ?) AND column_id = ?")
    .run(JSON.stringify(["c", "d", "e", "f"]), s.id, srcId);
  db.prepare("UPDATE columns SET fan_out = 'per_item', fan_out_source = ?, fan_out_cap = 50 WHERE id = ?")
    .run(srcId, Number(col.id));

  const est = await estimateRun([getColumn(Number(col.id))!], 10);
  const cc = est.columns[0]!;
  assert.ok(cc.fanOutItems != null && Math.abs(cc.fanOutItems - 3) < 1e-9, `avg items, got ${cc.fanOutItems}`);
  assert.equal(cc.fanOutMaxItems, 4);
  assert.equal(cc.fanOutCap, 50);
  // The worst case leads; the average rides beside it, the same pair a waterfall shows.
  assert.ok(Math.abs(cc.perRow / cc.bestPerRow! - 4 / 3) < 1e-9, `worst/avg ratio, got ${cc.perRow / cc.bestPerRow!}`);
  assert.ok(Math.abs(cc.total - cc.perRow * 10) < 1e-9);
});
