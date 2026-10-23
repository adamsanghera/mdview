import { test } from "node:test";
import assert from "node:assert/strict";
import { placeTable } from "../../public/js/lib/table-placement.js";

// The docked layout at 1800 px: a 672 px text column with 114 px free on each side.
const DOCKED = { textWidth: 672, reach: 114 };

test("a table that fits the text column is left alone", () => {
  assert.equal(placeTable({ natural: 600, narrowest: 300, ...DOCKED }), null);
  assert.equal(placeTable({ natural: 672, narrowest: 300, ...DOCKED }), null);
});

test("a slightly wide table sits flush with the text and runs right", () => {
  assert.deepEqual(placeTable({ natural: 750, narrowest: 400, ...DOCKED }), { box: 900, inset: 114, width: 750 });
});

test("a prose table wraps to fill from the text's left edge to the box's right edge", () => {
  assert.deepEqual(placeTable({ natural: 2000, narrowest: 400, ...DOCKED }), { box: 900, inset: 114, width: 786 });
});

test("a table that only fits by using the left side moves left just enough, instead of scrolling", () => {
  assert.deepEqual(placeTable({ natural: 866, narrowest: 866, ...DOCKED }), { box: 900, inset: 34, width: 866 });
  assert.deepEqual(placeTable({ natural: 900, narrowest: 900, ...DOCKED }), { box: 900, inset: 0, width: 900 });
});

test("a table too wide for the box starts flush and scrolls", () => {
  assert.deepEqual(placeTable({ natural: 3678, narrowest: 3678, ...DOCKED }), { box: 900, inset: 114, width: 3678 });
  assert.deepEqual(placeTable({ natural: 3678, narrowest: 901, ...DOCKED }), { box: 900, inset: 114, width: 901 });
});

test("with no room beside the text, a table wraps to the column or scrolls inside it", () => {
  assert.deepEqual(placeTable({ natural: 900, narrowest: 500, textWidth: 672, reach: 0 }), { box: 672, inset: 0, width: 672 });
  assert.deepEqual(placeTable({ natural: 900, narrowest: 800, textWidth: 672, reach: 0 }), { box: 672, inset: 0, width: 800 });
});
