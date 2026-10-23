import { test } from "node:test";
import assert from "node:assert/strict";
import { railHead, railList, threadCard } from "../../public/js/lib/cards.js";

let nextId = 1;
function message(fields = {}) {
  const id = nextId++;
  const body = fields.body ?? `Message ${id}`;
  return { id, author: "adam", authorKind: "human", body, bodyHtml: `<p>${body}</p>`, versionSeq: 1, createdAt: new Date().toISOString(), pending: false, ...fields };
}

function thread(fields = {}) {
  return {
    id: nextId++,
    status: "open",
    pending: false,
    waitingOn: "agent",
    state: "current",
    quote: "the quote",
    madeOn: { seq: 1 },
    nowReads: null,
    messages: [message()],
    ...fields,
  };
}

const groupTitles = (html) => [...html.matchAll(/<h3 class="rail-group">([^<]+) <span>(\d+)/g)].map(([, title, n]) => `${title.trim()} ${n}`);

test("the list view groups threads by what they wait on, in order", () => {
  const threads = [
    thread({ status: "resolved", waitingOn: null }),
    thread({ state: "outdated" }),
    thread({ waitingOn: "agent" }),
    thread({ waitingOn: "human" }),
    thread({ pending: true, waitingOn: null }),
  ];
  assert.deepEqual(groupTitles(railList(threads, { active: null, docPath: "plan.md" })), [
    "Pending, not sent 1",
    "Waiting on you 1",
    "Waiting on the agent 1",
    "On older versions 1",
    "Resolved 1",
  ]);
});

test("an empty list invites a first comment", () => {
  assert.match(railList([], { active: null, docPath: "plan.md" }), /No comments on this doc yet/);
});

test("a collapsed card shows the first and last messages and counts the rest", () => {
  const t = thread({ messages: [message({ body: "first" }), message(), message(), message({ body: "last" })] });
  const html = threadCard(t, { docPath: "plan.md" });
  assert.match(html, /first[\s\S]*2 more[\s\S]*last/);
  assert.doesNotMatch(html, /textarea/);
});

test("the open card shows every message and its controls", () => {
  const t = thread({ messages: [message(), message(), message()] });
  const html = threadCard(t, { expanded: true, docPath: "plan.md" });
  assert.doesNotMatch(html, /more<\/li>/);
  assert.match(html, /textarea class="reply"/);
  assert.match(html, /data-action="resolved"/);
});

test("names and quotes are escaped", () => {
  const t = thread({ quote: "<img src=x>", messages: [message({ author: "<b>eve</b>" })] });
  const html = threadCard(t, { docPath: "plan.md" });
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;b&gt;eve&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img src=x>|<b>eve<\/b>/);
});

test("an outdated card links to the version it was made on", () => {
  const t = thread({ state: "outdated", madeOn: { seq: 3 }, nowReads: { source: "New text" } });
  assert.match(threadCard(t, { docPath: "notes/plan.md" }), /href="\/view\/notes\/plan.md\?v=3"/);
});

test("an open thread the agent answered says it is the human's turn", () => {
  assert.match(threadCard(thread({ waitingOn: "human" }), { docPath: "plan.md" }), /class="chip chip-turn"[^>]*>Your turn</);
  assert.match(threadCard(thread({ waitingOn: "human" }), { docPath: "plan.md" }), /data-turn="human"/);
  assert.doesNotMatch(threadCard(thread({ waitingOn: "agent" }), { docPath: "plan.md" }), /Your turn/);
  assert.doesNotMatch(threadCard(thread({ status: "suggested", waitingOn: "human" }), { docPath: "plan.md" }), /Your turn/);
});

test("an agent's message names its session", () => {
  const t = thread({ messages: [message(), message({ authorKind: "agent", author: "agent", session: "chat-<1>" })] });
  assert.match(threadCard(t, { docPath: "plan.md" }), /<span class="badge" title="Session chat-&lt;1&gt;">agent<\/span>/);
});

test("the header counts unresolved threads and those on older versions", () => {
  const threads = [thread(), thread({ state: "outdated" }), thread({ status: "resolved" })];
  const html = railHead(threads, { listing: false, docked: true });
  assert.match(html, /2 unresolved/);
  assert.match(html, /1 on older versions/);
});
