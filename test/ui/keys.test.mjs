import { test } from "node:test";
import assert from "node:assert/strict";
import { isSubmitKey, submitButton } from "../../public/js/lib/keys.js";

const key = (mods = {}) => ({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods });

test("Enter is a new line; Shift+Enter and ⌘ or Ctrl+Enter submit", () => {
  assert.equal(isSubmitKey(key()), false);
  assert.equal(isSubmitKey(key({ shiftKey: true })), true);
  assert.equal(isSubmitKey(key({ metaKey: true })), true);
  assert.equal(isSubmitKey(key({ ctrlKey: true })), true);
});

test("no submit key fires while an IME is composing, with ⌥, or on another key", () => {
  assert.equal(isSubmitKey(key({ metaKey: true, isComposing: true })), false);
  assert.equal(isSubmitKey(key({ metaKey: true, altKey: true })), false);
  assert.equal(isSubmitKey(key({ key: "a", metaKey: true })), false);
});

test("the submit button says what it does, and its menu checks the current mode", () => {
  const checked = (html) => [...html.matchAll(/aria-checked="true" data-batch-choice="(\w+)"/g)].map(([, choice]) => choice);
  const now = submitButton(false, { now: "Comment", id: "composer-submit" });
  assert.match(now, /id="composer-submit">Comment</);
  assert.deepEqual(checked(now), ["off"]);
  const batch = submitButton(true, { now: "Reply", primary: false });
  assert.match(batch, /data-label-now="Reply">Add to batch</);
  assert.doesNotMatch(batch, /btn-primary/);
  assert.deepEqual(checked(batch), ["on"]);
});
