// The two rev guards, which are the same idea pointed in opposite directions and were NOT the same
// comparison.
//
// The delta path drops `d.r <= cur.rev`, because a delta carries a real server rev and an equal one
// is a replay. `ingestWindow` was written with that same `<=`, which looks symmetrical and is not:
// `readWindow` does not SELECT `rev`, so every page arrives with the 0 fallback on every cell. For
// any cell the stream had never touched — held rev 0, page rev 0 — `0 <= 0` held, and the page was
// discarded in favour of what was already in memory. A refetch after an import, a dedupe, an undo or
// a hand edit kept showing the value from before it, with nothing on screen to say the grid was
// behind, and no later write to correct it.
//
// Both directions are asserted here, because fixing one by breaking the other is the obvious wrong
// answer: making the window win unconditionally reintroduces the revert-a-live-run bug it was added
// to stop.

import { test } from "node:test";
import assert from "node:assert/strict";

// `applyDeltas` buffers onto an animation frame, so Node needs one. It has to behave like the real
// thing in two ways that matter here: the callback runs LATER (the store re-arms only after the
// frame it queued has run), and the id is never 0 (the store tests `frame != null`, and a stub
// returning 0 leaves it permanently believing a frame is still pending).
let rafId = 0;
(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
  (cb) => { queueMicrotask(() => cb(0)); return ++rafId; };

const { cellStore } = await import("./cellStore.ts");

/** Let the queued frame run. */
const frame = () => new Promise<void>((r) => setTimeout(r, 0));

/** One row, one column, as `readWindow` shapes it. `r` is omitted exactly as the server omits it. */
const page = (value: string, rev?: number) => [
  { id: "1", position: 0, cells: { "7": { id: "1:7", s: "done", v: value, ...(rev == null ? {} : { r: rev }) } } },
];

test("a refetched page replaces a cell the delta stream never touched", () => {
  cellStore.reset();
  cellStore.ingestWindow(page("old"));
  assert.equal(cellStore.getCell("1", "7")?.value, "old");

  // The same page read again after something changed the value server-side. Both revs are the 0
  // fallback, which is precisely the case `<=` swallowed.
  cellStore.ingestWindow(page("new"));
  assert.equal(cellStore.getCell("1", "7")?.value, "new");
});

test("a refetched page does NOT revert a cell the stream has already advanced", async () => {
  cellStore.reset();
  cellStore.ingestWindow(page("old"));
  cellStore.applyDeltas([{ i: "1:7", r: 4, s: "done", v: "from the run" }]);
  await frame();
  assert.equal(cellStore.getCell("1", "7")?.value, "from the run");
  assert.equal(cellStore.getCell("1", "7")?.rev, 4);

  // A page fetched during the drain still carries the pre-run value under the 0 fallback. Applying
  // it would revert the cell AND reset its rev to 0, which makes the revert permanent — after a
  // finished run there is no next write to correct it.
  cellStore.ingestWindow(page("old"));
  assert.equal(cellStore.getCell("1", "7")?.value, "from the run");
  assert.equal(cellStore.getCell("1", "7")?.rev, 4);
});

test("a page carrying a real, newer rev still wins", async () => {
  cellStore.reset();
  cellStore.ingestWindow(page("old"));
  cellStore.applyDeltas([{ i: "1:7", r: 4, s: "done", v: "from the run" }]);
  await frame();

  cellStore.ingestWindow(page("newer still", 9));
  assert.equal(cellStore.getCell("1", "7")?.value, "newer still");
  assert.equal(cellStore.getCell("1", "7")?.rev, 9);
});

test("the delta path drops a replayed or out-of-order frame", async () => {
  cellStore.reset();
  cellStore.ingestWindow(page("old"));

  cellStore.applyDeltas([{ i: "1:7", r: 3, s: "done", v: "third" }]);
  await frame();
  // Replayed: the same frame again.
  cellStore.applyDeltas([{ i: "1:7", r: 3, s: "done", v: "replay" }]);
  await frame();
  assert.equal(cellStore.getCell("1", "7")?.value, "third");
  // Out of order: an older frame arriving after a newer one.
  cellStore.applyDeltas([{ i: "1:7", r: 2, s: "done", v: "second" }]);
  await frame();
  assert.equal(cellStore.getCell("1", "7")?.value, "third");
  assert.equal(cellStore.getCell("1", "7")?.rev, 3);
});

test("a delta for a row outside the loaded window is ignored, not invented", async () => {
  cellStore.reset();
  cellStore.ingestWindow(page("old"));
  cellStore.applyDeltas([{ i: "999:7", r: 1, s: "done", v: "elsewhere" }]);
  await frame();
  assert.equal(cellStore.getCell("999", "7"), undefined);
  assert.equal(cellStore.getCell("1", "7")?.value, "old");
});

test("the gutter badge aggregates a row's own cells", () => {
  cellStore.reset();
  cellStore.ingestWindow([
    {
      id: "r1", position: 0,
      cells: {
        "1": { id: "r1:1", s: "done", v: "x" },
        "2": { id: "r1:2", s: "error", e: "timeout" },
        "3": { id: "r1:3", s: "running" },
        "4": { id: "r1:4", s: "queued" },
        "5": { id: "r1:5", s: "done", v: "y", stale: 1 },
      },
    },
    { id: "r2", position: 1, cells: { "1": { id: "r2:1", s: "done", v: "z" } } },
    // A quiet success and an explicit non-failure both carry no dot: not_found is a SUCCESS, and a
    // cancelled cell was a decision, not a problem.
    {
      id: "r3", position: 2,
      cells: {
        "1": { id: "r3:1", s: "not_found" },
        "2": { id: "r3:2", s: "cancelled" },
      },
    },
  ]);

  assert.deepEqual(cellStore.rowBadge("r1"), { errors: 1, live: 2, stale: 1 });
  assert.equal(cellStore.rowBadge("r2"), null, "a quiet row carries no dot");
  assert.equal(cellStore.rowBadge("r3"), null, "not_found is a success; cancelled is a decision");
  assert.equal(cellStore.rowBadge("nope"), null, "an unloaded row has nothing to say");
  assert.equal(cellStore.rowBadgeKey("r1"), "e1r2s1");
  assert.equal(cellStore.rowBadgeKey("r2"), "");

  cellStore.reset();
  assert.equal(cellStore.rowBadge("r1"), null, "a reset clears the badges with the rows");
});

test("the badge follows a cell that fails and then recovers", async () => {
  cellStore.reset();
  cellStore.ingestWindow(page("old"));
  assert.equal(cellStore.rowBadge("1"), null);

  cellStore.applyDeltas([{ i: "1:7", r: 5, s: "error", e: "timeout" }]);
  await frame();
  assert.deepEqual(cellStore.rowBadge("1"), { errors: 1, live: 0, stale: 0 });

  // The retry lands: the dot goes away without any refetch, because the live cells ARE the truth.
  cellStore.applyDeltas([{ i: "1:7", r: 6, s: "done", v: "recovered" }]);
  await frame();
  assert.equal(cellStore.rowBadge("1"), null);
});
