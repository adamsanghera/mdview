import { test } from "node:test";
import assert from "node:assert/strict";
import { stackCards } from "../../public/js/lib/card-stack.js";

const card = (target, height = 50) => ({ target, height });

test("cards sit level with their highlights when they have room", () => {
  assert.deepEqual(stackCards([card(100), card(300)], { gap: 10 }), [100, 300]);
});

test("cards below the open one stack downward without overlapping", () => {
  assert.deepEqual(stackCards([card(100), card(120), card(130)], { pivot: 0, gap: 10 }), [100, 160, 220]);
});

test("cards above the open one stack upward, and the open one stays at its highlight", () => {
  assert.deepEqual(stackCards([card(100), card(120), card(400)], { pivot: 1, gap: 10 }), [60, 120, 400]);
});

test("when stacking upward passes the header, every card shifts down together", () => {
  assert.deepEqual(stackCards([card(30), card(40)], { pivot: 1, minTop: 20, gap: 10 }), [20, 80]);
  assert.deepEqual(stackCards([card(5)], { minTop: 40, gap: 10 }), [40]);
});
