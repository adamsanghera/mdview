import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { AGENT, HUMAN, startViewer } from "../helpers/viewer.mjs";
import { click } from "../helpers/viewer-page.mjs";

const FILES = {
  "plan.md": "# Plan\n\nNothing to answer here.\n",
  "notes/other.md": "# Other\n\nThe agent answered this.\n\nAnd asked about this.\n",
};

const chrome = sharedChrome();

function threadOn(viewer, rel, quote) {
  const file = viewer.file(rel);
  return viewer.store.createThread({ file, content: fs.readFileSync(file, "utf8"), quote, body: `About: ${quote}`, author: HUMAN });
}

async function setup(t, { path = "/" } = {}) {
  const viewer = await startViewer({ files: FILES, initial: "plan.md", port: 47470 });
  t.after(() => viewer.close());
  const id = threadOn(viewer, "notes/other.md", "The agent answered this.");
  viewer.store.reply(id, "Here is my answer.", AGENT);
  const page = await (await chrome()).open(new URL(path, viewer.url).href);
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  return { viewer, page, id };
}

const badges = (page) =>
  page.eval(() => ({
    inbox: document.querySelector("#inbox-link").hidden ? null : document.querySelector("#inbox-count").textContent,
    folder: document.querySelector("#tree .dir-label .waiting-badge")?.textContent ?? null,
    file: document.querySelector('#tree .file[data-path="notes/other.md"] .waiting-badge')?.textContent ?? null,
  }));

test("the file list badges a doc waiting on you, and its closed folder, and resolving clears them", { skip: chromeMissing }, async (t) => {
  const { page, viewer, id } = await setup(t);
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan"), { what: "the doc" });
  assert.deepEqual(await badges(page), { inbox: "1", folder: "1", file: null });
  await click(page, "#tree .dir-label");
  assert.deepEqual(await badges(page), { inbox: "1", folder: null, file: "1" });

  viewer.store.setStatus(id, "resolved", HUMAN);
  await page.waitFor(() => !document.querySelector("#inbox-count").textContent, { what: "the badges to clear" });
  assert.deepEqual(await badges(page), { inbox: "", folder: null, file: null });
});

test("the inbox lists what waits on you, keeps current, and opens a thread in its doc", { skip: chromeMissing }, async (t) => {
  const { page, viewer, id } = await setup(t);
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan"), { what: "the doc" });
  await click(page, "#inbox-link");
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Waiting on you"), { what: "the inbox" });
  assert.equal(await page.eval(() => location.pathname), "/inbox");
  assert.deepEqual(
    await page.eval(() => [...document.querySelectorAll("#doc .inbox-thread")].map((li) => [li.closest(".inbox-doc").dataset.path, Number(li.dataset.thread), li.querySelector(".thread-quote").textContent])),
    [["notes/other.md", id, "The agent answered this."]],
  );

  // A second thread the agent answers shows up without a reload.
  const second = threadOn(viewer, "notes/other.md", "And asked about this.");
  viewer.store.reply(second, "Which one?", AGENT);
  await page.waitFor(() => document.querySelectorAll("#doc .inbox-thread").length === 2, { what: "the second thread" });

  await click(page, `#doc .inbox-thread[data-thread="${id}"] .inbox-open`);
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Other"), { what: "the thread's doc" });
  await page.waitFor((tid) => document.querySelector(`#rail .thread.expanded[data-thread="${tid}"]`), { what: "the thread to open" }, id);
  assert.equal(await page.eval(() => location.pathname + location.search), "/view/notes/other.md");
});

test("/inbox opened directly shows the inbox, and says when nothing waits", { skip: chromeMissing }, async (t) => {
  const { page, viewer, id } = await setup(t, { path: "/inbox" });
  await page.waitFor(() => document.querySelectorAll("#doc .inbox-thread").length === 1, { what: "the inbox" });
  viewer.store.setStatus(id, "resolved", HUMAN);
  await page.waitFor(() => document.querySelector("#doc .inbox-empty")?.textContent === "Nothing is waiting on you.", { what: "the empty inbox" });
});
