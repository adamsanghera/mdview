import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, launchChrome } from "../helpers/browser.mjs";
import { HUMAN, startViewer } from "../helpers/viewer.mjs";
import { highlighted, openComposer, select, typeAndEnter } from "../helpers/viewer-page.mjs";

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

let chrome;

before(async () => {
  if (!chromeMissing) chrome = await launchChrome();
});

after(async () => {
  await chrome?.close();
});

/** A viewer on plan.md, tracked through a thread on its intro, and a tab showing that thread. */
async function setup(t, port) {
  const viewer = await startViewer({ files: { "plan.md": PLAN }, initial: "plan.md", port });
  t.after(() => viewer.close());
  const file = viewer.file("plan.md");
  viewer.store.createThread({ file, content: fs.readFileSync(file, "utf8"), quote: "Intro paragraph", body: "First.", author: HUMAN });
  const page = await chrome.open(viewer.url);
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
