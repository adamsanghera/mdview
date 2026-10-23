import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote } from "../../public/js/lib/quote.js";

test("a quote matches across reflowed whitespace, and the span covers the original text", () => {
  const text = "Every  part\nof the helper";
  const span = findQuote(text, "part of the", 0);
  assert.deepEqual(span, [7, 18]);
  assert.equal(text.slice(...span), "part\nof the");
});

test("among repeats, the occurrence nearest the hint wins", () => {
  assert.deepEqual(findQuote("a b a b a", "a", 4), [4, 5]);
  assert.deepEqual(findQuote("a b a b a", "a", 7), [8, 9]);
});

test("a missing or blank quote finds nothing", () => {
  assert.equal(findQuote("Every part", "helper", 0), null);
  assert.equal(findQuote("Every part", "  ", 0), null);
});
