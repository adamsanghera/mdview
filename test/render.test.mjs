import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, resolveHref, splitFrontMatter } from "../lib/render.mjs";

test("resolveHref maps links from a document to viewer URLs", () => {
  [
    { desc: "sibling doc", href: "b.md", dir: "notes", expected: { kind: "doc", href: "/view/notes/b.md" } },
    { desc: "parent doc with an anchor", href: "../a.md#why", dir: "notes", expected: { kind: "doc", href: "/view/a.md#why" } },
    { desc: "folder", href: "1x-scm-db/", dir: "", expected: { kind: "doc", href: "/view/1x-scm-db" } },
    { desc: "image", href: "img/arch.jpg", dir: "notes", expected: { kind: "raw", href: "/raw/notes/img/arch.jpg" } },
    { desc: "encoded spaces", href: "my%20doc.md", dir: "", expected: { kind: "doc", href: "/view/my%20doc.md" } },
    { desc: "root-relative", href: "/top.md", dir: "deep/er", expected: { kind: "doc", href: "/view/top.md" } },
    { desc: "same-page anchor", href: "#section", dir: "notes", expected: { kind: "anchor", href: "#section" } },
    { desc: "web link", href: "https://example.com/x.md", dir: "", expected: { kind: "external", href: "https://example.com/x.md" } },
    { desc: "editor link", href: "cursor://file/x", dir: "", expected: { kind: "external", href: "cursor://file/x" } },
    { desc: "above the root", href: "../../x.md", dir: "notes", expected: { kind: "outside", href: "../../x.md" } },
  ].forEach((tc) => assert.deepEqual(resolveHref(tc.href, tc.dir), tc.expected, tc.desc));
});

test("renderMarkdown builds GitHub-style anchors and a table of contents", () => {
  const src = "# Title\n\n## 1. The engine is MySQL (Vitess)\n\n### Why\n\n## Why\n\n##### Too deep\n";

  const doc = renderMarkdown(src, "notes/doc.md");

  assert.equal(doc.title, "Title");
  assert.deepEqual(doc.toc, [
    { level: 1, id: "title", text: "Title" },
    { level: 2, id: "1-the-engine-is-mysql-vitess", text: "1. The engine is MySQL (Vitess)" },
    { level: 3, id: "why", text: "Why" },
    { level: 2, id: "why-1", text: "Why" },
  ]);
  assert.match(doc.html, /<h2 id="1-the-engine-is-mysql-vitess"[ >]/);
});

test("renderMarkdown resets anchors between documents", () => {
  renderMarkdown("## Why\n", "a.md");

  const doc = renderMarkdown("## Why\n", "b.md");

  assert.equal(doc.toc[0].id, "why");
});

test("renderMarkdown rewrites links and images relative to the document", () => {
  const src = "[next](../other.md#x) ![arch](arch.jpg) [web](https://example.com) [far](../../up.md)";

  const { html } = renderMarkdown(src, "notes/doc.md");

  assert.match(html, /href="\/view\/other\.md#x"/);
  assert.match(html, /src="\/raw\/notes\/arch\.jpg"/);
  assert.match(html, /href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /class="outside-root"/);
});

test("renderMarkdown wraps tables, highlights code and counts words", () => {
  const src = "| a | b |\n|---|--:|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\none two three four\n";

  const doc = renderMarkdown(src, "doc.md");

  assert.match(doc.html, /<div class="table-wrap"><table>/);
  assert.match(doc.html, /<pre data-block="\d+" class="code" data-lang="js"><code class="hljs">.*hljs-keyword/s);
  assert.equal(doc.words, 8);
  assert.equal(doc.minutes, 1);
});

test("splitFrontMatter separates a leading YAML block", () => {
  [
    { desc: "with front matter", src: "---\ntitle: x\n---\n# Body\n", expected: { body: "# Body\n", frontMatter: "title: x" } },
    { desc: "without front matter", src: "# Body\n", expected: { body: "# Body\n", frontMatter: null } },
    { desc: "a rule later in the doc", src: "# Body\n\n---\n\nmore\n", expected: { body: "# Body\n\n---\n\nmore\n", frontMatter: null } },
  ].forEach((tc) => assert.deepEqual(splitFrontMatter(tc.src), tc.expected, tc.desc));
});
