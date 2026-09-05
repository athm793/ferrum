// What renders as chips and what stays raw.
//
// A value that merely STARTS with "[" is data — a truncated paste, a note that opens with an
// example — and one unparseable cell must not turn into a silently empty-looking chip row. The
// parse fails, the value stays raw, nothing is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListValue, LIST_CHIPS_SHOWN } from "./listValue.ts";

test("a JSON list parses into display items", () => {
  assert.deepEqual(parseListValue('["a","b","c"]'), ["a", "b", "c"]);
  assert.deepEqual(parseListValue("[1,2]"), ["1", "2"]);
  assert.deepEqual(parseListValue("[]"), []);
  assert.deepEqual(parseListValue('[null,"x"]'), ["", "x"]);
  // The whole list, not the bounded chip view — the bound is a rendering decision.
  assert.equal(parseListValue('["a","b","c","d","e"]')?.length, 5);
});

test("anything that is not a list stays raw", () => {
  assert.equal(parseListValue("just one value"), null);
  assert.equal(parseListValue('{"a":1}'), null, "an object is the JSON tree's job, not chips");
  assert.equal(parseListValue("[not json"), null, "a truncated paste is data");
  assert.equal(parseListValue(""), null);
  assert.equal(parseListValue(null), null);
  assert.equal(parseListValue('"[1,2]"'), null, "a quoted string is a string");
});

test("the chip bound is small and named", () => {
  assert.ok(LIST_CHIPS_SHOWN >= 2 && LIST_CHIPS_SHOWN <= 5);
});
