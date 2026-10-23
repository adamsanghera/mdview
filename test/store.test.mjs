import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../lib/blocks.mjs";
import { parseBlocks } from "../lib/render.mjs";
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

test("an outdated thread says what its block became, when a new block resembles it", async () => {
  const v1 = "# Retries\n\n- A 4xx response is never retried.\n- Jitter spreads retries out.\n";
  const file = await writeDoc("now-reads.md", v1);
  const id = comment(file, v1, { blockIndex: 1, quote: "never retried" });

  await fs.writeFile(file, "# Retries\n\n- A 4xx response is never retried, except 429, which backs off.\n- Jitter spreads retries out.\n");
  store.observe(file);
  assert.deepEqual(store.thread(id).thread.nowReads, {
    blockIndex: 1,
    lines: [3, 3],
    source: "- A 4xx response is never retried, except 429, which backs off.",
  });

  await fs.writeFile(file, "# Retries\n\n- Jitter spreads retries out.\n\nSomething else entirely.\n");
  store.observe(file);
  assert.equal(store.thread(id).thread.nowReads, null);
});

test("a human reopening without a message leaves one, so the thread waits on the agent", async () => {
  const file = await writeDoc("reopen.md", "Text.\n");
  const id = comment(file, "Text.\n");
  store.setStatus(id, "suggested", AGENT, "done");
  store.setStatus(id, "open", ADAM);

  const { thread } = store.thread(id);

  assert.equal(thread.messages.at(-1).body, "Reopened.");
  assert.equal(thread.waitingOn, "agent");
});

test("a doc's versions list newest first, and any one of them can be read back", async () => {
  const file = await writeDoc("history.md", "One.\n");
  comment(file, "One.\n");
  await fs.writeFile(file, "Two.\n");
  store.observe(file);

  assert.deepEqual(
    store.versions(file).map((v) => [v.seq, v.threads]),
    [
      [2, 0],
      [1, 1],
    ],
  );
  assert.deepEqual([store.versionAt(file, 1).content, store.versionAt(file, 1).latestSeq], ["One.\n", 2]);
  assert.equal(store.versionAt(file, 9), null);
});

test("waitingOnAgent finds sent threads where a human spoke last, inside the scope", async () => {
  await fs.mkdir(path.join(dir, "scope", "deep"), { recursive: true });
  const inside = await writeDoc("scope/deep/a.md", "A.\n");
  const sibling = await writeDoc("scope-sibling.md", "S.\n");
  const asked = comment(inside, "A.\n");
  const answered = comment(inside, "A.\n");
  store.reply(answered, "an answer", AGENT);
  const resolved = comment(inside, "A.\n");
  store.setStatus(resolved, "resolved", ADAM);
  comment(inside, "A.\n", { pending: true });
  const outside = comment(sibling, "S.\n");

  assert.deepEqual(store.waitingOnAgent({ folders: [path.join(dir, "scope")] }), [asked]);
  assert.deepEqual(store.waitingOnAgent({ files: [sibling] }), [outside]);
  store.discardPending(ADAM);
});

test("only a human deletes threads, and a doc's last thread takes its stored versions along", async () => {
  const content = "One.\n\nTwo.\n";
  const file = await writeDoc("delete.md", content);
  const first = comment(file, content, { blockIndex: 0 });
  const second = comment(file, content, { blockIndex: 1 });
  store.reply(first, "an answer", AGENT);

  assert.throws(() => store.deleteThread(first, AGENT), StoreError);
  store.deleteThread(first, ADAM);
  assert.throws(() => store.thread(first), /No thread/);
  assert.equal(store.observe(file).version.seq, 1);

  store.deleteThread(second, ADAM);
  assert.equal(store.findDoc(file), undefined);
  assert.equal(store.observe(file), null);

  comment(file, content);
  assert.equal(store.observe(file).version.seq, 1);
});

test("a human deletes a reply, but the first message goes only with its thread", async () => {
  const file = await writeDoc("delete-message.md", "Text.\n");
  const id = comment(file, "Text.\n");
  store.reply(id, "a wrong answer", AGENT);
  const [first, reply] = store.thread(id).thread.messages;

  assert.throws(() => store.deleteMessage(id, reply.id, AGENT), StoreError);
  assert.throws(() => store.deleteMessage(id, first.id, ADAM), /Delete the thread instead/);
  assert.throws(() => store.deleteMessage(id, reply.id + 1000, ADAM), /has no message/);
  store.deleteMessage(id, reply.id, ADAM);

  const { thread } = store.thread(id);
  assert.deepEqual(thread.messages.map((m) => m.body), ["a comment"]);
  assert.equal(thread.waitingOn, "agent");
});

test("docsUnder finds tracked docs at any depth inside a folder, and nothing beside it", async () => {
  await fs.mkdir(path.join(dir, "tree", "sub"), { recursive: true });
  const top = await writeDoc("tree/top.md", "Top.\n");
  const nested = await writeDoc("tree/sub/nested.md", "Nested.\n");
  const sibling = await writeDoc("tree-sibling.md", "Shares the folder's name as a prefix.\n");
  await writeDoc("tree/untracked.md", "No comments.\n");
  for (const file of [top, nested, sibling]) comment(file, await fs.readFile(file, "utf8"));

  const real = await fs.realpath(dir);

  assert.deepEqual(
    store.docsUnder(path.join(dir, "tree")).map((file) => path.relative(real, file)),
    ["tree/sub/nested.md", "tree/top.md"],
  );
});

test("pending comments stay out of agent views until the batch is sent", async () => {
  const content = "Alpha.\n\nBeta.\n";
  const file = await writeDoc("batch.md", content);
  const visible = comment(file, content, { blockIndex: 0 });
  store.reply(visible, "an agent answer", AGENT);
  const draft = comment(file, content, { blockIndex: 1, body: "drafted", pending: true });
  store.reply(visible, "a drafted follow-up", ADAM, { pending: true });

  assert.deepEqual(
    store.threadsAt(file).threads.map((t) => [t.id, t.waitingOn, t.messages.length]),
    [[visible, "human", 2]],
  );
  assert.throws(() => store.thread(draft), /No thread/);
  assert.deepEqual(
    store.threadsAt(file, { includePending: true }).threads.map((t) => [t.id, t.pending, t.waitingOn, t.messages.length]),
    [
      [visible, false, "human", 3],
      [draft, true, null, 1],
    ],
  );
  assert.equal(store.pendingCount(), 2);

  assert.equal(store.sendPending(ADAM), 2);
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(
    store.threadsAt(file).threads.map((t) => [t.id, t.waitingOn, t.messages.at(-1).body]),
    [
      [visible, "agent", "a drafted follow-up"],
      [draft, "agent", "drafted"],
    ],
  );
});

test("a batch sent after an agent's answer still reads as the latest word", async () => {
  const file = await writeDoc("order.md", "Text.\n");
  const id = comment(file, "Text.\n");
  store.reply(id, "drafted before the agent answered", ADAM, { pending: true });
  store.reply(id, "the agent's answer", AGENT);
  store.sendPending(ADAM);

  const { thread } = store.thread(id);

  assert.deepEqual(thread.messages.map((m) => m.authorKind), ["human", "agent", "human"]);
  assert.equal(thread.waitingOn, "agent");
});

test("discarding a batch drops drafts, and a doc with only drafts goes back to untracked", async () => {
  const onlyDraft = await writeDoc("draft-only.md", "Draft.\n");
  comment(onlyDraft, "Draft.\n", { pending: true });
  const mixed = await writeDoc("mixed.md", "Kept.\n");
  const kept = comment(mixed, "Kept.\n");
  store.reply(kept, "a pending reply", ADAM, { pending: true });

  assert.equal(store.discardPending(ADAM), 2);
  assert.equal(store.findDoc(onlyDraft), undefined);
  assert.deepEqual(store.thread(kept).thread.messages.map((m) => m.body), ["a comment"]);
  assert.equal(store.pendingCount(), 0);
});

test("agents can neither see nor touch a human's draft thread", async () => {
  const file = await writeDoc("hidden.md", "Text.\n");
  const draft = comment(file, "Text.\n", { pending: true });

  assert.throws(() => store.reply(draft, "found it", AGENT), /No thread/);
  assert.throws(() => store.setStatus(draft, "suggested", AGENT, "done"), /No thread/);
  assert.throws(() => store.createThread({ file, content: "Text.\n", blockIndex: 0, body: "x", author: AGENT, pending: true }), /Only a human/);
  store.discardPending(ADAM);
});

test("a reopen inside a batch keeps the thread on the human until the batch is sent", async () => {
  const file = await writeDoc("reopen-batch.md", "Text.\n");
  const id = comment(file, "Text.\n");
  store.setStatus(id, "suggested", AGENT, "done");
  store.setStatus(id, "open", ADAM, undefined, { pending: true });

  assert.deepEqual([store.thread(id).thread.status, store.thread(id).thread.waitingOn], ["open", "human"]);
  store.sendPending(ADAM);
  assert.equal(store.thread(id).thread.waitingOn, "agent");
});

test("a reply to a draft thread joins the draft, so it can never be sent ahead of the comment", async () => {
  const file = await writeDoc("draft-reply.md", "Text.\n");
  const id = comment(file, "Text.\n", { body: "the comment", pending: true });
  store.reply(id, "a reply sent right away", ADAM, { pending: false });

  assert.equal(store.pendingCount(), 2);
  assert.throws(() => store.thread(id), /No thread/);
  store.sendPending(ADAM);
  assert.deepEqual(store.thread(id).thread.messages.map((m) => m.body), ["the comment", "a reply sent right away"]);
});

test("whose turn it is follows the last sent word, and a suggestion waits on the human", async () => {
  const file = await writeDoc("turns.md", "Text.\n");
  const id = comment(file, "Text.\n");
  const turn = () => store.thread(id).thread.waitingOn;

  assert.equal(turn(), "agent");
  store.reply(id, "a question back", AGENT);
  assert.equal(turn(), "human");
  store.setStatus(id, "suggested", AGENT, "done");
  assert.equal(turn(), "human");
  store.setStatus(id, "resolved", ADAM);
  assert.equal(turn(), null);
  assert.deepEqual(store.waitingOnAgent({ files: [file] }), []);
  store.setStatus(id, "open", ADAM);
  assert.equal(turn(), "agent");
  assert.deepEqual(store.waitingOnAgent({ files: [file] }), [id]);
});

/** Writes a store with the tables of an older mdview, one thread on `content`, and the given messages. */
async function oldStore(name, { pendingColumn, version, messages, content = "Old text.\n" }) {
  const oldHome = path.join(dir, name);
  await fs.mkdir(oldHome);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(oldHome, "mdview.sqlite3"));
  db.exec(`
    CREATE TABLE docs (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE versions (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, sha256 TEXT NOT NULL,
      content TEXT NOT NULL, observed_at TEXT NOT NULL, UNIQUE (doc_id, seq));
    CREATE TABLE threads (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, version_id INTEGER NOT NULL, block_sha TEXT NOT NULL,
      block_ordinal INTEGER NOT NULL, quote TEXT NOT NULL, start INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      status_by TEXT, status_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, author TEXT NOT NULL, author_kind TEXT NOT NULL,
      body TEXT NOT NULL, version_id INTEGER NOT NULL, session TEXT, created_at TEXT NOT NULL
      ${pendingColumn ? ", pending INTEGER NOT NULL DEFAULT 0" : ""});
    PRAGMA user_version = ${version};
  `);
  const at = "2026-10-20T12:00:00.000Z";
  db.prepare("INSERT INTO docs VALUES (1, '/nowhere/old.md', ?)").run(at);
  db.prepare("INSERT INTO versions VALUES (1, 1, 1, ?, ?, ?)").run(sha256(content), content, at);
  db.prepare("INSERT INTO threads VALUES (1, 1, 1, ?, 0, '', 0, 'open', NULL, NULL, ?)").run(parseBlocks(content)[0].sha, at);
  messages.forEach(([body, kind, pending], i) => {
    const columns = pendingColumn ? "(id, thread_id, author, author_kind, body, version_id, created_at, pending)" : "(id, thread_id, author, author_kind, body, version_id, created_at)";
    const values = [i + 1, 1, kind === "human" ? "adam" : "agent", kind, body, 1, `2026-10-20T12:00:0${i}.000Z`];
    if (pendingColumn) values.push(pending ? 1 : 0);
    db.prepare(`INSERT INTO messages ${columns} VALUES (${values.map(() => "?").join(", ")})`).run(...values);
  });
  db.close();
  return oldHome;
}

test("a store from before batches upgrades with every message sent at the time it was written", async () => {
  const oldHome = await oldStore("v1-home", { pendingColumn: false, version: 1, messages: [["an old comment", "human"]] });

  const migrated = await openStore(oldHome);
  const { thread } = migrated.thread(1);
  const pendingCount = migrated.pendingCount();
  migrated.close();

  assert.deepEqual([thread.messages.map((m) => [m.body, m.sentAt]), thread.waitingOn, pendingCount], [[["an old comment", "2026-10-20T12:00:00.000Z"]], "agent", 0]);
});

test("a version 2 store keeps its batch pending, drops the pending column, and is backed up first", async () => {
  const oldHome = await oldStore("v2-home", {
    pendingColumn: true,
    version: 2,
    messages: [["the comment", "human", false], ["an answer", "agent", false], ["a drafted reply", "human", true]],
  });

  const migrated = await openStore(oldHome);
  const thread = migrated.thread(1, { includePending: true }).thread;
  const pendingCount = migrated.pendingCount();
  migrated.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(oldHome, "mdview.sqlite3"), { readOnly: true });
  const columns = db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((c) => c.name);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  db.close();
  const backups = await fs.readdir(path.join(oldHome, "backups"));

  assert.deepEqual(thread.messages.map((m) => [m.body, m.pending]), [["the comment", false], ["an answer", false], ["a drafted reply", true]]);
  assert.equal(thread.waitingOn, "human");
  assert.equal(pendingCount, 1);
  assert.ok(columns.includes("sent_at") && !columns.includes("pending"), columns.join(", "));
  assert.equal(version, 3);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^mdview-before-v3-.*\.sqlite3$/);
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
