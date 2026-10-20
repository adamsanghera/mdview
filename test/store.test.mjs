import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../lib/blocks.mjs";
import { openStore, StoreError } from "../lib/store.mjs";

const ADAM = { name: "adam", kind: "human" };
const AGENT = { name: "agent", kind: "agent", session: "session-1" };

let dir;
let home;
let store;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-store-"));
  home = path.join(dir, "home");
  store = await openStore(home);
});

after(() => store.close());

async function writeDoc(name, content) {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

function comment(file, content, extra = {}) {
  return store.createThread({ file, content, blockIndex: 0, body: "a comment", author: ADAM, ...extra });
}

test("observing a doc without threads records nothing", async () => {
  const file = await writeDoc("untracked.md", "# Hi\n");

  assert.equal(store.observe(file), null);
  assert.equal(store.findDoc(file), undefined);
});

test("a doc's first thread stores what the commenter saw, and edits add versions", async () => {
  const file = await writeDoc("first.md", "# Plan\n\nFirst.\n");
  comment(file, "# Plan\n\nFirst.\n");

  assert.equal(store.observe(file).version.seq, 1);
  await fs.writeFile(file, "# Plan\n\nFirst.\n\nSecond.\n");
  assert.equal(store.observe(file).version.seq, 2);
  assert.equal(store.observe(file).version.seq, 2);
});

test("two connections observing the same edit record one version", async () => {
  const file = await writeDoc("shared.md", "One.\n");
  comment(file, "One.\n");
  const other = await openStore(home);
  await fs.writeFile(file, "Two.\n");

  const mine = store.observe(file).version;
  const theirs = other.observe(file).version;
  other.close();

  assert.equal(mine.seq, 2);
  assert.equal(theirs.id, mine.id);
});

test("threads carry over while their block holds and go outdated when it changes", async () => {
  const v1 = "# Plan\n\nKeep this.\n\nChange me.\n";
  const file = await writeDoc("carry.md", v1);
  const id = comment(file, v1, { blockIndex: 2, quote: "Change" });
  const view = () => store.threadsAt(file).threads.find((t) => t.id === id);

  assert.equal(view().state, "current");

  await fs.writeFile(file, "# Plan\n\nKept, but edited.\n\nChange me.\n");
  store.observe(file);
  assert.equal(view().state, "carried");
  assert.equal(view().blockIndex, 2);

  await fs.writeFile(file, "# Plan\n\nKept, but edited.\n\nChanged.\n");
  store.observe(file);
  const outdated = view();
  assert.equal(outdated.state, "outdated");
  assert.equal(outdated.blockIndex, null);
  assert.deepEqual(outdated.madeOn, { seq: 1, lines: [5, 5] });
  assert.equal(outdated.source, "Change me.");
  assert.equal(outdated.heading, "Plan");
});

test("threads are located against the version a tab rendered", async () => {
  const v1 = "Alpha.\n\nBeta.\n";
  const v2 = "Intro.\n\nAlpha.\n\nBeta.\n";
  const file = await writeDoc("tab.md", v1);
  const first = comment(file, v1, { blockIndex: 1 });
  await fs.writeFile(file, v2);
  store.observe(file);
  const second = comment(file, v2, { blockIndex: 0 });

  const atV1 = store.threadsAt(file, { sha: sha256(v1) });
  const atV2 = store.threadsAt(file, { sha: sha256(v2) });

  assert.deepEqual(atV1.threads.map((t) => [t.id, t.state, t.blockIndex]), [[first, "current", 1]]);
  assert.deepEqual(atV2.threads.map((t) => [t.id, t.state, t.blockIndex]), [
    [first, "carried", 2],
    [second, "current", 0],
  ]);
  assert.deepEqual([atV1.version.seq, atV1.version.latestSeq], [1, 2]);
});

test("a comment typed against an older version stays pinned to it", async () => {
  const v1 = "Old text.\n";
  const file = await writeDoc("race.md", v1);
  comment(file, v1);
  await fs.writeFile(file, "New text.\n");
  store.observe(file);

  const id = comment(file, v1, { body: "typed before the edit landed" });
  const { thread, version } = store.thread(id);

  assert.equal(thread.madeOn.seq, 1);
  assert.equal(version.latestSeq, 2);
  assert.equal(thread.state, "outdated");
});

test("agents suggest resolving, and only humans resolve or reopen", async () => {
  const file = await writeDoc("status.md", "Text.\n");
  const threadIn = (status) => {
    const id = comment(file, "Text.\n");
    if (status !== "open") store.setStatus(id, "suggested", AGENT, "reworded it");
    if (status === "resolved") store.setStatus(id, "resolved", ADAM);
    return id;
  };
  [
    { desc: "an agent suggests resolving", from: "open", as: AGENT, to: "suggested", body: "reworded", allowed: true },
    { desc: "a suggestion must say what changed", from: "open", as: AGENT, to: "suggested", allowed: false },
    { desc: "an agent cannot resolve", from: "open", as: AGENT, to: "resolved", allowed: false },
    { desc: "an agent cannot reopen", from: "suggested", as: AGENT, to: "open", allowed: false },
    { desc: "a human resolves a suggestion", from: "suggested", as: ADAM, to: "resolved", allowed: true },
    { desc: "a human resolves an open thread", from: "open", as: ADAM, to: "resolved", allowed: true },
    { desc: "a human reopens a suggestion", from: "suggested", as: ADAM, to: "open", allowed: true },
    { desc: "a human reopens a resolved thread", from: "resolved", as: ADAM, to: "open", allowed: true },
    { desc: "a human cannot suggest", from: "open", as: ADAM, to: "suggested", body: "x", allowed: false },
    { desc: "a status cannot be set twice", from: "resolved", as: ADAM, to: "resolved", allowed: false },
  ].forEach((tc) => {
    const id = threadIn(tc.from);
    const act = () => store.setStatus(id, tc.to, tc.as, tc.body);
    if (tc.allowed) act();
    else assert.throws(act, StoreError, tc.desc);
    assert.equal(store.thread(id).thread.status, tc.allowed ? tc.to : tc.from, tc.desc);
  });
});

test("a human reply reopens a suggested thread, and an agent reply does not", async () => {
  const file = await writeDoc("replies.md", "Text.\n");
  const id = comment(file, "Text.\n");
  store.setStatus(id, "suggested", AGENT, "done");

  store.reply(id, "one more detail", AGENT);
  assert.equal(store.thread(id).thread.status, "suggested");
  store.reply(id, "not quite: also fix the title", ADAM);
  assert.equal(store.thread(id).thread.status, "open");
});

test("a thread waits on whoever did not write last, and suggestions wait on the human", async () => {
  const file = await writeDoc("turns.md", "Text.\n");
  const id = comment(file, "Text.\n");
  const turn = () => store.thread(id).thread.waitingOn;

  assert.equal(turn(), "agent");
  store.reply(id, "a question back", AGENT);
  assert.equal(turn(), "human");
  store.reply(id, "an answer", ADAM);
  assert.equal(turn(), "agent");
  store.setStatus(id, "suggested", AGENT, "done");
  assert.equal(turn(), "human");
  store.setStatus(id, "resolved", ADAM);
  assert.equal(turn(), null);
});

test("a line or a quote picks the block, and ambiguity is refused", async () => {
  const content = "# Title\n\nSame words.\n\nSame words here too.\n\n```\ncode line\n```\n";
  const file = await writeDoc("pick.md", content);
  const blockOf = (pick) => {
    const id = store.createThread({ file, content, body: "x", author: AGENT, ...pick });
    return store.thread(id).thread.blockIndex;
  };

  assert.equal(blockOf({ line: 3 }), 1);
  assert.equal(blockOf({ line: 8 }), 3);
  assert.equal(blockOf({ quote: "words here" }), 2);
  assert.equal(blockOf({ line: 5, quote: "Same words" }), 2);
  assert.throws(() => blockOf({ quote: "Same words" }), /appears in 2 blocks \(lines 3, 5\)/);
  assert.throws(() => blockOf({ quote: "absent" }), /not in the doc/);
  assert.throws(() => blockOf({ line: 2 }), /not inside/);
});

test("the change token moves on real writes from any process, and not on reads", async () => {
  const file = await writeDoc("token.md", "Text.\n");
  const before = store.changeToken();
  const id = comment(file, "Text.\n");
  const afterOwnWrite = store.changeToken();
  store.observe(file);
  store.threadsAt(file);
  const afterReads = store.changeToken();
  const other = await openStore(home);
  other.reply(id, "from another process", AGENT);
  other.close();

  assert.notEqual(afterOwnWrite, before);
  assert.equal(afterReads, afterOwnWrite);
  assert.notEqual(store.changeToken(), afterReads);
});

test("messages record the version that was latest when they were written", async () => {
  const file = await writeDoc("stamps.md", "Draft.\n");
  const id = comment(file, "Draft.\n");
  await fs.writeFile(file, "Draft, edited by the agent.\n");
  store.reply(id, "edited it", AGENT);

  const { messages } = store.thread(id).thread;

  assert.deepEqual(
    messages.map((m) => [m.author, m.authorKind, m.versionSeq]),
    [
      ["adam", "human", 1],
      ["agent", "agent", 2],
    ],
  );
});
