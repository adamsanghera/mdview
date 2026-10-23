import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, launchChrome } from "../helpers/browser.mjs";
import { AGENT, HUMAN, startViewer } from "../helpers/viewer.mjs";
import { click, comment, highlighted } from "../helpers/viewer-page.mjs";

const row = (cells) => `| ${cells.join(" | ")} |`;
const table = (head, body) => [row(head), row(head.map(() => "---")), ...body.map(row)].join("\n");
const wideCells = Array.from({ length: 16 }, (_, i) => `column_${i}_identifier`);

const PLAN = `# Plan

## Goal

Every part of the helper ports, and its option where it has one.

## Steps

First, the agent writes the store. Then the viewer reads it.

${table(["Part", "What it does in Graphite", "Ports", "Why"], [
  ["Content-hash filter", "Skips a row whose content matches the hash Redis kept from the row's last write.", "Yes, behind an optional store", "Re-deliveries of unchanged objects are common. Graphite already writes every row when Redis is absent."],
])}

## Wide

${table(wideCells, [wideCells.map((c) => `\`${c}_value\``)])}

## Done

The end.
`;

let chrome;
const open = [];

before(async () => {
  if (!chromeMissing) chrome = await launchChrome();
});

after(async () => {
  await chrome?.close();
});

/** A viewer on plan.md and a tab on it. Both close after the test. */
async function setup(t, { files = { "plan.md": PLAN }, width, height, before: prepare } = {}) {
  const viewer = await startViewer({ files, initial: "plan.md" });
  t.after(() => viewer.close());
  await prepare?.(viewer);
  const page = await chrome.open(viewer.url, { width, height });
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan"), { what: "the doc to render" });
  return { viewer, page };
}

function threadOn(viewer, quote, body = "A comment.") {
  const file = viewer.file("plan.md");
  return viewer.store.createThread({ file, content: fs.readFileSync(file, "utf8"), quote, body, author: HUMAN });
}

test("a comment on a selection highlights exactly its quote", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t);
  await comment(page, "the agent writes the store", "Which store?");

  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 1, { what: "the highlight" });
  assert.deepEqual(await highlighted(page), ["the agent writes the store"]);
  const card = await page.eval(() => ({
    quote: document.querySelector("#rail .thread .thread-quote")?.textContent,
    body: document.querySelector("#rail .thread .message-body")?.textContent.trim(),
  }));
  assert.deepEqual(card, { quote: "the agent writes the store", body: "Which store?" });
  const [thread] = viewer.store.threadsAt(viewer.file("plan.md")).threads;
  assert.equal(thread.quote, "the agent writes the store");
  assert.equal(thread.waitingOn, "agent");
});

test("an agent's reply appears in the open page", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t, { before: (v) => threadOn(v, "Then the viewer reads it.") });
  await page.waitFor(() => document.querySelectorAll("#rail .thread").length === 1, { what: "the card" });
  const [thread] = viewer.store.threadsAt(viewer.file("plan.md")).threads;

  viewer.store.reply(thread.id, "Done: it reads it now.", AGENT);
  await page.waitFor(() => document.querySelector("#rail")?.textContent.includes("Done: it reads it now."), { what: "the reply" });
  assert.equal(await page.eval(() => document.querySelector("#comments-btn").classList.contains("attention")), true);
});

test("a batched comment stays hidden from agents until the batch is sent", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t);
  await comment(page, "Every part of the helper", "Which helper?", { batch: true });

  await page.waitFor(() => !document.querySelector("#batch").hidden, { what: "the batch bar" });
  assert.equal(await page.eval(() => document.querySelector("#batch-count").textContent), "1 pending");
  assert.equal(viewer.store.threadsAt(viewer.file("plan.md")).threads.length, 0);
  assert.equal(await page.eval(() => document.querySelector("#rail .thread .chip-pending")?.textContent), "Pending");

  await click(page, "#batch-send");
  await page.waitFor(() => document.querySelector("#batch").hidden, { what: "the batch to send" });
  assert.equal(viewer.store.threadsAt(viewer.file("plan.md")).threads.length, 1);
  await page.waitFor(() => !document.querySelector("#rail .chip-pending"), { what: "the pending chip to go" });
});

test("resolving a thread clears its highlight", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { before: (v) => threadOn(v, "Then the viewer reads it.") });
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 1, { what: "the highlight" });

  await click(page, "#rail .thread");
  await page.waitFor(() => document.querySelector("#rail .thread.expanded"), { what: "the card to open" });
  await click(page, '#rail .thread [data-action="resolved"]');
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 0, { what: "the highlight to clear" });
});

test("live reload shows the file's new text", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t);
  await page.waitFor(() => document.querySelector("#live").classList.contains("on"), { what: "live reload to connect" });
  await viewer.write("plan.md", PLAN.replace("The end.", "The real end."));
  await page.waitFor(() => document.querySelector("#doc").textContent.includes("The real end."), { what: "the reload" });
});

test("a wide table starts flush with the text and scrolls across the space on both sides", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { before: (v) => threadOn(v, "Every part of the helper") });
  await page.waitFor(() => document.documentElement.classList.contains("rail-docked"), { what: "the rail to dock" });

  const layout = await page.eval(() => {
    const text = document.querySelector("#doc p").getBoundingClientRect();
    return [...document.querySelectorAll("#doc .table-wrap")].map((wrap) => {
      const box = wrap.getBoundingClientRect();
      wrap.scrollLeft = 0;
      const atLoad = wrap.querySelector("table").getBoundingClientRect();
      wrap.scrollLeft = wrap.scrollWidth;
      const atEnd = wrap.querySelector("table").getBoundingClientRect();
      wrap.scrollLeft = 0;
      return {
        flush: Math.round(atLoad.left) === Math.round(text.left),
        centered: Math.abs(text.left - box.left - (box.right - text.right)) <= 1,
        scrolls: wrap.scrollWidth > wrap.clientWidth,
        endsAtBox: Math.round(atEnd.right) === Math.round(box.right),
      };
    });
  });
  assert.deepEqual(layout, [
    { flush: true, centered: true, scrolls: false, endsAtBox: true },
    { flush: true, centered: true, scrolls: true, endsAtBox: true },
  ]);
});

test("clicking a comment's tick on the outline opens its thread", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { before: (v) => threadOn(v, "The end.") });
  await page.waitFor(() => document.querySelector("#toc .toc-mark"), { what: "the tick" });

  await click(page, "#toc .toc-mark");
  await page.waitFor(() => document.querySelector("#rail .thread.expanded"), { what: "the thread to open" });
  assert.deepEqual(await highlighted(page, "active"), ["The end."]);
});
