import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, escapeHtml, truncate } from "../../public/js/lib/format.js";
import { encodePath, relFromPathname, versionFromSearch } from "../../public/js/lib/paths.js";
import { placeTick } from "../../public/js/lib/ticks.js";
import { buildTree } from "../../public/js/lib/tree.js";

test("escapeHtml and truncate", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

test("ago rounds to the nearest unit and falls back to a date after a day", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(ago(now - 44_000, now), "just now");
  assert.equal(ago(now - 50_000, now), "1m ago");
  assert.equal(ago(now - 90 * 60_000, now), "2h ago");
  assert.doesNotMatch(ago(now - 30 * 3_600_000, now), /ago/);
});

test("doc paths round-trip through viewer URLs", () => {
  assert.equal(encodePath("a b/c#d.md"), "a%20b/c%23d.md");
  assert.equal(relFromPathname("/view/a%20b/c%23d.md"), "a b/c#d.md");
  assert.equal(relFromPathname("/view/%E0%A4%A"), "");
  assert.equal(versionFromSearch("?v=3"), 3);
  assert.equal(versionFromSearch(""), null);
  assert.equal(versionFromSearch("?v=x"), null);
});

test("a tick lands in its section, as far down as the comment is", () => {
  const tops = [100, 300, 500];
  assert.deepEqual(placeTick(tops, 50, 900), { index: 0, share: 0 });
  assert.deepEqual(placeTick(tops, 200, 900), { index: 0, share: 0.5 });
  assert.deepEqual(placeTick(tops, 600, 900), { index: 2, share: 0.25 });
});

test("files nest into their folders", () => {
  const tree = buildTree(["a.md", "x/b.md", "x/y/c.md"]);
  assert.deepEqual(tree.files, ["a.md"]);
  assert.deepEqual(tree.dirs.get("x").files, ["x/b.md"]);
  assert.deepEqual(tree.dirs.get("x").dirs.get("y").files, ["x/y/c.md"]);
});
