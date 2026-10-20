import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listMarkdown, pickIndex, resolveInRoot } from "../lib/files.mjs";

const root = path.resolve("/tmp/mdview-root");

test("resolveInRoot keeps paths inside the root", () => {
  [
    { desc: "nested file", rel: "a/b.md", expected: path.join(root, "a/b.md") },
    { desc: "the root itself", rel: "", expected: root },
    { desc: "dot segments that stay inside", rel: "a/../b.md", expected: path.join(root, "b.md") },
  ].forEach((tc) => assert.equal(resolveInRoot(root, tc.rel), tc.expected, tc.desc));
});

test("resolveInRoot refuses paths that leave the root", () => {
  [
    { desc: "parent climb", rel: "../secret.md" },
    { desc: "deep climb", rel: "a/../../secret.md" },
    { desc: "absolute path", rel: "/etc/passwd" },
    { desc: "sibling with a shared prefix", rel: "../mdview-root-other/x.md" },
    { desc: "null byte", rel: "a\0.md" },
  ].forEach((tc) => assert.equal(resolveInRoot(root, tc.rel), null, tc.desc));
});

test("listMarkdown sorts numerically and skips hidden and dependency folders", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-"));
  const files = ["10-later.md", "2-sooner.md", "notes/a.md", "image.png", ".hidden/x.md", "node_modules/pkg/README.md"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), "# x\n");
  }

  const listed = await listMarkdown(dir);

  assert.deepEqual(listed, ["2-sooner.md", "10-later.md", "notes/a.md"]);
});

test("pickIndex prefers a conventional index name, then the first Markdown file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-"));
  await fs.writeFile(path.join(dir, "b.md"), "");
  await fs.writeFile(path.join(dir, "a.md"), "");

  assert.equal(await pickIndex(dir), "a.md");

  await fs.writeFile(path.join(dir, "README.md"), "");

  assert.equal(await pickIndex(dir), "README.md");
});
