import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { AGENT, HUMAN, startViewer } from "../helpers/viewer.mjs";
import { chooseBatching, click, comment, highlighted, openComposer, select } from "../helpers/viewer-page.mjs";

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

const chrome = sharedChrome();

/** A viewer on plan.md and a tab on it. Both close after the test. */
async function setup(t, { files = { "plan.md": PLAN }, width, height, before: prepare } = {}) {
  const viewer = await startViewer({ files, initial: "plan.md" });
  t.after(() => viewer.close());
  await prepare?.(viewer);
  const page = await (await chrome()).open(viewer.url, { width, height });
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

test("Enter is a new line, and batching stays on for the next comment and reply until switched off", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t);
  await select(page, "Every part of the helper");
  await openComposer(page);
  await page.eval(() => {
    const input = document.querySelector("#composer-text");
    input.value = "Which helper?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  assert.equal(await page.eval(() => document.querySelector("#composer").hidden), false, "plain Enter does not submit");

  await chooseBatching(page, "#composer", true);
  await click(page, "#composer-submit");
  await page.waitFor(() => document.querySelector("#batch-count").textContent === "1 pending", { what: "the comment to join the batch" });

  await select(page, "the agent writes the store");
  await openComposer(page);
  assert.equal(await page.eval(() => document.querySelector("#composer-submit").textContent), "Add to batch");
  await page.eval(() => document.querySelector("#composer-cancel").click());
  await click(page, "#rail .thread .message-body");
  assert.equal(await page.eval(() => document.querySelector("#rail .thread.expanded [data-submit]").textContent), "Add to batch");
  assert.equal(viewer.store.threadsAt(viewer.file("plan.md"))?.threads.length ?? 0, 0);

  await chooseBatching(page, "#rail .thread.expanded", false);
  await click(page, '#rail [data-mode="list"]');
  assert.equal(await page.eval(() => document.querySelector("#rail .thread.expanded [data-submit]").textContent), "Reply", "a pending draft does not turn batching back on");
});

test("a closed card resolves in one click, which clears its highlight", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { before: (v) => threadOn(v, "Then the viewer reads it.") });
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 1, { what: "the highlight" });

  await click(page, '#rail .thread [data-action="resolved"]');

  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 0, { what: "the highlight to clear" });
});

test("resolving the last thread keeps the margin, so the doc does not move sideways", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { before: (v) => threadOn(v, "Then the viewer reads it.") });
  await page.waitFor(() => document.documentElement.classList.contains("rail-docked"), { what: "the rail to dock" });
  const docLeft = () => page.eval(() => document.querySelector("#doc").getBoundingClientRect().left);
  const before = await docLeft();

  await click(page, '#rail .thread [data-action="resolved"]');

  await page.waitFor(() => !document.querySelector("#rail .thread"), { what: "the card to go" });
  assert.equal(await page.eval(() => document.documentElement.classList.contains("rail-docked")), true);
  assert.equal(await docLeft(), before);
});

test("clicking a card stacked far below its text keeps it under the pointer, and scrolls its text level with it", { skip: chromeMissing }, async (t) => {
  const body = "A comment long enough to fill the three lines a closed card shows, so that cards on the same text stack well below it.";
  // Far enough down that the seven cards stacked above the open one fit between it and the top.
  const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i}.`).join("\n\n");
  const { page } = await setup(t, {
    files: { "plan.md": `# Plan\n\n${filler}\n\nThe target sentence.\n` },
    before: (v) => {
      for (let i = 0; i < 8; i++) threadOn(v, "The target sentence.", body);
    },
  });
  await page.waitFor(() => document.querySelectorAll("#rail .thread").length === 8, { what: "eight cards" });
  const last = () =>
    page.eval(() => {
      const card = document.querySelector("#rail .thread:last-of-type");
      const text = document.createRange();
      text.selectNodeContents([...document.querySelectorAll("#doc p")].find((p) => p.textContent.includes("The target sentence.")));
      return { card: card.getBoundingClientRect().top, text: text.getClientRects()[0].top, expanded: card.classList.contains("expanded") };
    });
  await page.eval(() => window.scrollTo(0, document.querySelector("#rail .thread:last-of-type").getBoundingClientRect().top + scrollY - 700));
  const before = await last();
  assert.ok(before.card - before.text > 600, `the last card starts well below its text: ${JSON.stringify(before)}`);

  await click(page, "#rail .thread:last-of-type .message-body");

  const after = await last();
  assert.equal(after.expanded, true);
  assert.ok(Math.abs(after.card - before.card) <= 1, `the card stays where it was clicked: ${JSON.stringify({ before, after })}`);
  assert.ok(Math.abs(after.card - after.text) <= 1, `its text comes level with it: ${JSON.stringify(after)}`);
});

test("the header's switch shows the list as a panel, and goes back to the margin", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { before: (v) => threadOn(v, "Then the viewer reads it.") });
  await page.waitFor(() => document.querySelector('#rail [data-mode="list"]'), { what: "the switch" });

  await click(page, '#rail [data-mode="list"]');
  assert.equal(await page.eval(() => document.querySelector("#rail").classList.contains("listing")), true);
  assert.equal(await page.eval(() => document.querySelector('#rail [data-mode="list"]').getAttribute("aria-pressed")), "true");

  await click(page, '#rail [data-mode="margin"]');
  assert.equal(await page.eval(() => document.querySelector("#rail").classList.contains("listing")), false);
});

test("a thread deletes in two clicks from its card's menu, with no dialog", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t, { before: (v) => threadOn(v, "Then the viewer reads it.") });
  await page.waitFor(() => document.querySelector("#rail .thread"), { what: "the card" });

  await click(page, '#rail .thread [data-action="thread-menu"]');
  assert.equal(await page.eval(() => document.querySelector("#rail .thread-menu").hidden), false);
  await click(page, '#rail .thread [data-action="delete-thread"]');

  await page.waitFor(() => !document.querySelector("#rail .thread"), { what: "the card to go" });
  assert.equal(viewer.store.threadsAt(viewer.file("plan.md"))?.threads.length ?? 0, 0);
});

test("live reload shows the file's new text", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t);
  await page.waitFor(() => document.querySelector("#live").classList.contains("on"), { what: "live reload to connect" });
  await viewer.write("plan.md", PLAN.replace("The end.", "The real end."));
  await page.waitFor(() => document.querySelector("#doc").textContent.includes("The real end."), { what: "the reload" });
});

const TOGGLES = `# Plan

- > First toggle
  Hidden under the first.
- > Second toggle
  Hidden under the second.
`;

test("a toggle the reader opened stays open across a live reload", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t, { files: { "plan.md": TOGGLES } });
  await page.waitFor(() => document.querySelector("#live").classList.contains("on"), { what: "live reload to connect" });
  await click(page, "#doc li.toggle:nth-child(2) summary");

  await viewer.write("plan.md", TOGGLES.replace("# Plan\n", "# Plan\n\nAdded above.\n"));
  await page.waitFor(() => document.querySelector("#doc").textContent.includes("Added above."), { what: "the reload" });

  const open = await page.eval(() => [...document.querySelectorAll("#doc details")].map((d) => d.open));
  assert.deepEqual(open, [false, true]);
});

test("selecting a toggle's title to comment on it leaves the toggle as it was", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { files: { "plan.md": TOGGLES } });
  await select(page, "First toggle");

  await click(page, "#doc li.toggle:nth-child(1) summary");

  assert.equal(await page.eval(() => document.querySelector("#doc li.toggle:nth-child(1) details").open), false);
});

test("a comment inside a closed toggle waits on its title, and opening the thread opens the toggle", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { files: { "plan.md": TOGGLES }, before: (v) => threadOn(v, "Hidden under the second.") });
  await page.waitFor(() => document.querySelector("#rail .thread"), { what: "the card" });
  const tops = () =>
    page.eval(() => ({
      card: Math.round(document.querySelector("#rail .thread").getBoundingClientRect().top),
      title: Math.round(document.querySelector("#doc li.toggle:nth-child(2) summary").getBoundingClientRect().top),
    }));
  const closed = await tops();
  assert.equal(closed.card, closed.title);

  await click(page, "#rail .thread");

  await page.waitFor(() => document.querySelector("#doc li.toggle:nth-child(2) details").open, { what: "the toggle to open" });
  assert.equal(await page.eval(() => document.querySelector("#doc li.toggle:nth-child(1) details").open), false);
  assert.deepEqual(await highlighted(page, "active"), ["Hidden under the second."]);
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

test("the outline gives up its column to the comment rail only when both do not fit", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { width: 1512, height: 900, before: (v) => threadOn(v, "The end.") });
  const layout = () =>
    page.eval(() => ({
      docked: document.documentElement.classList.contains("rail-docked"),
      outline: document.querySelector("#toc-pane").offsetWidth > 0,
      ticks: [...document.querySelectorAll("#toc .toc-mark")].filter((tick) => tick.offsetParent).length,
    }));
  await page.waitFor(() => document.documentElement.classList.contains("rail-docked"), { what: "the rail to dock" });
  assert.deepEqual(await layout(), { docked: true, outline: false, ticks: 0 }, "with the file list open, the outline yields");

  await page.eval(() => document.querySelector("#toggle-sidebar").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitFor(() => document.querySelector("#toc-pane").offsetWidth > 0, { what: "the outline to come back" });
  await page.waitFor(() => document.querySelector("#toc .toc-mark"), { what: "the tick" });
  assert.deepEqual(await layout(), { docked: true, outline: true, ticks: 1 }, "with the file list closed, both fit");
});
