import { test } from "node:test";
import assert from "node:assert/strict";
import { keyHint, submitMode } from "../../public/js/lib/keys.js";

const keys = (mods = {}) => ({ altKey: false, metaKey: false, ctrlKey: false, ...mods });

test("with no batch open, Enter sends and ⌥Enter starts a batch", () => {
  assert.equal(submitMode(keys(), false), "now");
  assert.equal(submitMode(keys({ altKey: true }), false), "batch");
  assert.equal(submitMode(keys({ metaKey: true }), false), "now");
  assert.equal(submitMode(keys({ ctrlKey: true }), false), "now");
});

test("with a batch open, Enter adds to it, ⌘Enter sends it, and ⌥Enter sends just this", () => {
  assert.equal(submitMode(keys(), true), "batch");
  assert.equal(submitMode(keys({ metaKey: true }), true), "send");
  assert.equal(submitMode(keys({ altKey: true }), true), "now");
});

test("the hint names the keys for the current mode", () => {
  assert.match(keyHint(false), /^Enter sends/);
  assert.match(keyHint(true), /^Enter adds to your batch/);
});
