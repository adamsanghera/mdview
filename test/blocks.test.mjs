import { test } from "node:test";
import assert from "node:assert/strict";
import { locate } from "../lib/blocks.mjs";
import { parseBlocks, renderMarkdown } from "../lib/render.mjs";

function anchorAt(src, index) {
  const block = parseBlocks(src)[index];
  return { blockSha: block.sha, ordinal: block.ordinal };
}

function landing(anchor, src) {
  const hit = locate(anchor, parseBlocks(src));
  return hit.state === "outdated" ? "outdated" : hit.block.index;
}

test("locate carries an anchor forward while its block's text is unchanged", () => {
  const base = "# Plan\n\nKeep this paragraph.\n\nChange me.\n";
  const anchor = anchorAt(base, 1);
  [
    { desc: "unchanged", src: base, expected: 1 },
    { desc: "another block edited", src: "# Plan\n\nKeep this paragraph.\n\nChanged.\n", expected: 1 },
    { desc: "a block inserted above", src: "# Plan\n\nNew intro.\n\nKeep this paragraph.\n\nChange me.\n", expected: 2 },
    { desc: "the paragraph reflowed", src: "# Plan\n\nKeep this\nparagraph.\n\nChange me.\n", expected: 1 },
    { desc: "front matter added", src: "---\ntitle: Plan\n---\n# Plan\n\nKeep this paragraph.\n\nChange me.\n", expected: 1 },
    { desc: "the block edited", src: "# Plan\n\nKeep this paragraph, edited.\n\nChange me.\n", expected: "outdated" },
    { desc: "the block deleted", src: "# Plan\n\nChange me.\n", expected: "outdated" },
    { desc: "the text moved into a list item", src: "# Plan\n\n- Keep this paragraph.\n\nChange me.\n", expected: 1 },
  ].forEach((tc) => assert.equal(landing(anchor, tc.src), tc.expected, tc.desc));
});

test("locate follows list items through renumbering", () => {
  const anchor = anchorAt("1. alpha\n2. beta\n", 1);

  assert.equal(landing(anchor, "1. new\n2. alpha\n3. beta\n"), 2);
});

test("locate tells identical blocks apart by their order", () => {
  const anchor = anchorAt("TBD\n\nTBD\n", 1);
  [
    { desc: "unchanged", src: "TBD\n\nTBD\n", expected: 1 },
    { desc: "one fewer copy", src: "TBD\n", expected: 0 },
    // A copy inserted above shifts the order, so the anchor lands one block early.
    { desc: "a copy inserted above", src: "TBD\n\nTBD\n\nTBD\n", expected: 1 },
  ].forEach((tc) => assert.equal(landing(anchor, tc.src), tc.expected, tc.desc));
});

test("renderMarkdown tags each commentable block for the browser", () => {
  const src = [
    "# Title",
    "",
    "A paragraph.",
    "",
    "- tight item",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "<div>raw</div>",
    "",
    "---",
    "",
  ].join("\n");

  const { html } = renderMarkdown(src, "doc.md");
  const blocks = parseBlocks(src);

  assert.match(html, /<h1 id="title" data-block="0">/);
  assert.match(html, /<p data-block="1">A paragraph\.<\/p>/);
  assert.match(html, /<li data-block="2">tight item<\/li>/);
  assert.match(html, /<tr data-block="3">[\s\S]*<tr data-block="4">/);
  assert.match(html, /<pre data-block="5" class="code" data-lang="js">/);
  assert.doesNotMatch(html, /<(div|hr)[^>]*data-block/);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "paragraph", "paragraph", "row", "row", "code"],
  );
});

test("block line numbers are 1-based in the file, counting front matter", () => {
  const blocks = parseBlocks("---\ntitle: x\n---\n# Body\n\nOne\ntwo\n");

  assert.deepEqual(
    blocks.map((b) => [b.startLine, b.endLine]),
    [
      [4, 4],
      [6, 7],
    ],
  );
});
