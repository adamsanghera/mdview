import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { AGENT, HUMAN, startViewer } from "../helpers/viewer.mjs";
import { click, highlighted, openComposer, select, typeAndEnter } from "../helpers/viewer-page.mjs";

const PLAN = `# Plan

## Goal

Intro paragraph.

## Steps

First, the agent writes the store. Then the viewer reads it.

## Done

The end.
`;
// What an agent's edit does mid-comment: a new block above the selection shifts every block index after it.
const EDITED = PLAN.replace("Intro paragraph.\n", "Intro paragraph.\n\nA new paragraph the agent added.\n");

const chrome = sharedChrome();

/** A viewer on plan.md, tracked through a thread on its intro, and a tab showing that thread. */
async function setup(t, port, files = {}) {
  const viewer = await startViewer({ files: { "plan.md": PLAN, ...files }, initial: "plan.md", port });
  t.after(() => viewer.close());
  const file = viewer.file("plan.md");
  viewer.store.createThread({ file, content: fs.readFileSync(file, "utf8"), quote: "Intro paragraph", body: "First.", author: HUMAN });
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 1, { what: "the first thread's highlight" });
  await page.waitFor(() => document.querySelector("#live").classList.contains("on"), { what: "live reload to connect" });
  return { viewer, page, file };
}

const showsEdit = () => document.querySelector("#doc").textContent.includes("A new paragraph the agent added.");

test("a comment written while an agent edits the doc anchors to the text it was selected in", { skip: chromeMissing }, async (t) => {
  const { viewer, page, file } = await setup(t, 47460);
  await select(page, "the agent writes the store");
  await openComposer(page);

  fs.writeFileSync(file, EDITED);
  await page.waitFor(
    (edited) => document.querySelector("#doc").textContent.includes(edited) || document.querySelector("#live").classList.contains("held"),
    { what: "the viewer to notice the edit" },
    "A new paragraph the agent added.",
  );
  await typeAndEnter(page, "#composer-text", "Which store?");
  await page.waitFor(showsEdit, { what: "the edit to show" });
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 2, { what: "both highlights" });

  assert.deepEqual((await highlighted(page)).sort(), ["Intro paragraph", "the agent writes the store"]);
  const added = viewer.store.threadsAt(file).threads.find((t) => t.messages[0].body === "Which store?");
  assert.match(added.source, /the agent writes the store/);
});

test("live reload waits while a comment is being written, and catches up when it closes", { skip: chromeMissing }, async (t) => {
  const { page, file } = await setup(t, 47470);
  await select(page, "the agent writes the store");
  await openComposer(page);

  fs.writeFileSync(file, EDITED);
  await page.waitFor(() => document.querySelector("#live").classList.contains("held"), { what: "live reload to hold" });
  assert.equal(await page.eval(showsEdit), false);

  await page.eval(() => document.querySelector("#composer-text").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitFor(showsEdit, { what: "the held reload" });
  assert.equal(await page.eval(() => document.querySelector("#live").classList.contains("held")), false);
});

test("a reply being typed keeps its caret when agents write elsewhere", { skip: chromeMissing }, async (t) => {
  const { viewer, page, file } = await setup(t, 47480, { "other.md": "# Other\n\nSomewhere else.\n" });
  const other = viewer.file("other.md");
  const elsewhere = viewer.store.createThread({ file: other, content: fs.readFileSync(other, "utf8"), quote: "Somewhere", body: "x", author: HUMAN });
  const sibling = viewer.store.createThread({ file, content: fs.readFileSync(file, "utf8"), quote: "The end", body: "y", author: HUMAN });
  await page.waitFor(() => document.querySelectorAll("#rail .thread").length === 2, { what: "both cards" });

  await click(page, '#rail .thread[data-thread="1"]');
  await page.waitFor(() => document.querySelector("#rail .thread.expanded textarea.reply"), { what: "the reply box" });
  await page.eval(() => {
    const input = document.querySelector("#rail .thread.expanded textarea.reply");
    input.focus();
    input.value = "hello world";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(5, 5);
    window.commentLoads = 0;
    const fetchBefore = window.fetch;
    window.fetch = (url, ...rest) => {
      if (String(url).startsWith("/api/comments?")) window.commentLoads++;
      return fetchBefore(url, ...rest);
    };
  });
  const caret = () =>
    page.eval(() => {
      const input = document.activeElement;
      return input?.matches("textarea.reply") ? [input.value, input.selectionStart, input.selectionEnd] : null;
    });

  viewer.store.reply(elsewhere, "noise on another doc", AGENT);
  await page.waitFor(() => window.commentLoads > 0, { what: "the comments to reload" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await caret(), ["hello world", 5, 5]);

  viewer.store.reply(sibling, "an answer on this doc", AGENT);
  await page.waitFor(() => document.querySelector("#rail").textContent.includes("an answer on this doc"), { what: "the sibling's answer" });
  assert.deepEqual(await caret(), ["hello world", 5, 5]);
});
