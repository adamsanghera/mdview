import { test } from "node:test";
import assert from "node:assert/strict";
import { railLayout } from "../../public/js/lib/layout.js";

// The real sizes: a 752 px doc, a 300 px rail, a 24 px gap, so the rail needs 1076 px; the outline is 248 px.
const SIZES = { doc: 752, rail: 300, gap: 24, toc: 248 };

test("the rail docks beside the outline when both fit", () => {
  assert.deepEqual(railLayout({ wanted: true, content: 1112, ...SIZES }), { docked: true, tocYields: false });
});

test("the outline yields only when the rail fits without it but not with it", () => {
  assert.deepEqual(railLayout({ wanted: true, content: 984, ...SIZES }), { docked: true, tocYields: true });
});

test("when the rail does not fit even without the outline, it is a drawer and the outline stays", () => {
  assert.deepEqual(railLayout({ wanted: true, content: 700, ...SIZES }), { docked: false, tocYields: false });
  assert.deepEqual(railLayout({ wanted: true, content: 1000, ...SIZES, toc: 0 }), { docked: false, tocYields: false });
});

test("with nothing to show, the rail neither docks nor takes the outline's place", () => {
  assert.deepEqual(railLayout({ wanted: false, content: 2000, ...SIZES }), { docked: false, tocYields: false });
});
