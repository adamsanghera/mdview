/**
 * The comment store: one SQLite file per user holding threads on Markdown
 * docs and the doc versions they were made on.
 *
 * Unlike a search index, nothing can rebuild this data, so it lives outside
 * the docs' folders (in MDVIEW_HOME, default ~/.mdview) and never writes the
 * docs themselves. A doc becomes tracked with its first thread. From then on,
 * every observe() records its content as a new version when it changed, so
 * each thread can say which version it was made on. Where a thread lands in
 * a later version is computed on read by locate(), never stored.
 *
 * The viewer and any number of CLI processes share the file. WAL mode and a
 * busy timeout serialize their writes, and BEGIN IMMEDIATE keeps two writers
 * from claiming the same version number.
 *
 * Deleting is permanent and human-only. The CLI that agents use has no delete
 * verb, so in practice only the viewer deletes.
 *
 * A human's messages can be pending, like comments in a GitHub review that is
 * not yet submitted: stored and shown in the viewer, but hidden from every
 * agent-facing read until the human sends the batch. Sending flips them all
 * in one transaction, so an agent sees the whole batch at once. A thread is
 * pending while its first message is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locate, normalizeText, sha256 } from "./blocks.mjs";
import { parseBlocks } from "./render.mjs";

const SCHEMA_VERSION = 2;
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,  -- realpath of the Markdown file
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY,
  doc_id      INTEGER NOT NULL REFERENCES docs(id),
  seq         INTEGER NOT NULL,     -- the "v7" people see
  sha256      TEXT NOT NULL,
  content     TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (doc_id, seq)
);
CREATE INDEX IF NOT EXISTS versions_by_sha ON versions (doc_id, sha256);
CREATE TABLE IF NOT EXISTS threads (
  id            INTEGER PRIMARY KEY,
  doc_id        INTEGER NOT NULL REFERENCES docs(id),
  version_id    INTEGER NOT NULL REFERENCES versions(id),
  block_sha     TEXT NOT NULL,
  block_ordinal INTEGER NOT NULL,
  quote         TEXT NOT NULL,
  start         INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'suggested', 'resolved')),
  status_by     TEXT,
  status_at     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_by_doc ON threads (doc_id);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  author      TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  body        TEXT NOT NULL,
  version_id  INTEGER NOT NULL REFERENCES versions(id),
  session     TEXT,
  created_at  TEXT NOT NULL,           -- when it was sent, for a message that was pending
  pending     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (thread_id);
`;

// The statuses each kind of author may move a thread to, and from which.
// Agents can only say a thread is done. Humans resolve and reopen.
const TRANSITIONS = {
  agent: { suggested: ["open"] },
  human: { resolved: ["open", "suggested"], open: ["suggested", "resolved"] },
};

// How alike (Dice coefficient over word sets) a new block must be to an
// outdated thread's old block to count as that block, edited.
const SUCCESSOR_SIMILARITY = 0.5;

export const STATUS_LABELS = { open: "open", suggested: "suggested resolved", resolved: "resolved" };

/** A request the store refuses, worded for the person or agent who made it. */
export class StoreError extends Error {}

/** The folder holding the store: MDVIEW_HOME, or ~/.mdview. */
export function storeHome(env = process.env) {
  return env.MDVIEW_HOME || path.join(os.homedir(), ".mdview");
}

/** The name the human's messages carry: MDVIEW_USER, or the OS username. */
export function humanName(env = process.env) {
  return env.MDVIEW_USER || os.userInfo().username;
}

/** Docs are keyed by realpath, so symlinks and different --root values agree. */
export function docKey(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Opens the store in `home`, creating it on first use. node:sqlite loads
 * lazily, so a Node without it fails here instead of at import time.
 */
export async function openStore(home = storeHome()) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, "mdview.sqlite3"));
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return new Store(db);
}

/**
 * Brings a store made by an older mdview up to SCHEMA_VERSION. Checks run
 * inside the write lock, so two processes opening an old store at once
 * migrate it once.
 */
function migrate(db) {
  if (db.prepare("PRAGMA user_version").get().user_version >= SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((c) => c.name);
    // Version 1 stores predate pending messages.
    if (!columns.includes("pending")) db.exec("ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function now() {
  return new Date().toISOString();
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function sourceLines(content, block) {
  return content.split("\n").slice(block.startLine - 1, block.endLine).join("\n");
}

function headingAbove(blocks, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (blocks[i].kind === "heading") return blocks[i].text;
  }
  return null;
}

function wordSet(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * Guesses what an outdated thread's block became: the most similar block of
 * the same kind among those whose text is new since the thread's version.
 * Returns null when nothing is similar enough, as when the block was removed
 * or rewritten from scratch.
 */
function successor(block, oldBlocks, newBlocks) {
  const kept = new Set(oldBlocks.map((b) => b.sha));
  const words = wordSet(block.text);
  let best = null;
  let bestScore = 0;
  for (const candidate of newBlocks) {
    if (candidate.kind !== block.kind || kept.has(candidate.sha)) continue;
    const other = wordSet(candidate.text);
    let shared = 0;
    for (const word of words) if (other.has(word)) shared++;
    const score = (2 * shared) / (words.size + other.size || 1);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= SUCCESSOR_SIMILARITY ? best : null;
}

/** Whose turn a thread is, judged by its sent messages only. A pending thread is nobody's yet. */
function waitingOn(status, sent) {
  if (status === "resolved" || !sent.length) return null;
  if (status === "suggested") return "human";
  return sent.at(-1).authorKind === "human" ? "agent" : "human";
}

function pickBlock(blocks, { blockIndex, line, quote }) {
  if (blockIndex !== undefined) {
    const block = blocks[blockIndex];
    if (!block) throw new StoreError(`This version has no block ${blockIndex}.`);
    return block;
  }
  const needle = normalizeText(quote ?? "");
  if (line !== undefined) {
    const block = blocks.find((b) => b.startLine <= line && line <= b.endLine);
    if (!block) throw new StoreError(`Line ${line} is not inside a paragraph, heading, code block or table row.`);
    if (!block.text.includes(needle)) throw new StoreError(`The quote is not in the block at line ${line}.`);
    return block;
  }
  const hits = blocks.filter((b) => b.text.includes(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new StoreError("The quote is not in the doc.");
  const lines = hits.map((b) => b.startLine).join(", ");
  throw new StoreError(`The quote appears in ${hits.length} blocks (lines ${lines}). Pass --line to pick one.`);
}

export class Store {
  #db;
  #writes = 0;
  #listeners = new Set();

  constructor(db) {
    this.#db = db;
  }

  close() {
    this.#db.close();
  }

  /** Changes whenever this process or another one writes to the store. */
  changeToken() {
    return `${this.#db.prepare("PRAGMA data_version").get().data_version}:${this.#writes}`;
  }

  /** Calls `listener` after each write this process commits. Returns a function that stops it. */
  onWrite(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  findDoc(file) {
    return this.#db.prepare("SELECT * FROM docs WHERE path = ?").get(docKey(file));
  }

  /** The keys (realpaths) of tracked docs inside `dir`, at any depth, sorted. */
  docsUnder(dir) {
    const prefix = docKey(dir) + path.sep;
    return this.#db
      .prepare("SELECT path FROM docs ORDER BY path")
      .all()
      .map((row) => row.path)
      .filter((file) => file.startsWith(prefix));
  }

  /**
   * Records a tracked doc's content as a new version when it changed, reading
   * the file unless `content` is given. Returns {doc, version, missing}, or
   * null for a doc without threads. A deleted file yields the last version
   * with `missing` set.
   */
  observe(file, content) {
    const doc = this.findDoc(file);
    if (!doc) return null;
    return this.#transaction(() => this.#observeDoc(doc, content));
  }

  /** The stored content with this hash, for a tracked doc, or null. */
  contentForSha(file, sha) {
    const doc = this.findDoc(file);
    return (doc && this.#versionBySha(doc.id, sha)?.content) ?? null;
  }

  /**
   * Starts a thread on the block the commenter picked in `content`, the exact
   * text they were looking at, and returns the thread id. The block is named
   * by `blockIndex` (the browser), or by `line` and/or `quote` (the CLI).
   * The doc becomes tracked if it was not already. A `pending` thread stays
   * hidden from agents until the human sends the batch.
   */
  createThread({ file, content, blockIndex, line, quote = "", start, body, author, pending = false }) {
    if (!body?.trim()) throw new StoreError("A comment needs a message.");
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    const id = this.#transaction(() => {
      const doc = this.#findOrInsertDoc(file);
      const version = this.#versionBySha(doc.id, sha256(content)) ?? this.#recordVersion(doc.id, content);
      const block = pickBlock(parseBlocks(version.content), { blockIndex, line, quote });
      const offset = start ?? Math.max(0, block.text.indexOf(normalizeText(quote)));
      const thread = this.#db
        .prepare(
          `INSERT INTO threads (doc_id, version_id, block_sha, block_ordinal, quote, start, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(doc.id, version.id, block.sha, block.ordinal, quote, offset, now());
      this.#insertMessage(thread.id, version.id, body, author, pending);
      this.#writes++;
      return thread.id;
    });
    return id;
  }

  /**
   * Adds a message. A human reply to a suggested thread reopens it at once;
   * if the reply is `pending`, the thread still waits on the human until the
   * batch is sent.
   */
  reply(threadId, body, author, { pending = false } = {}) {
    if (!body?.trim()) throw new StoreError("A reply needs a message.");
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    this.#transaction(() => {
      const thread = this.#visibleThreadRow(threadId, author);
      const { version } = this.#observeDoc(this.#docById(thread.doc_id));
      this.#insertMessage(thread.id, version.id, body, author, pending);
      if (author.kind === "human" && thread.status === "suggested") this.#updateStatus(thread.id, "open", author);
      this.#writes++;
    });
  }

  /**
   * Moves a thread to `status` if `author` may: agents suggest resolving,
   * which needs a message saying what changed, and humans resolve or reopen.
   * An optional `body` is added as a message first. A reopen without one
   * records "Reopened." so the thread shows it waits on the agent again.
   * With `pending`, that message joins the human's batch.
   */
  setStatus(threadId, status, author, body, { pending = false } = {}) {
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    if (!Object.hasOwn(STATUS_LABELS, status)) throw new StoreError(`Unknown status "${status}".`);
    const allowedFrom = TRANSITIONS[author.kind]?.[status];
    if (!allowedFrom) {
      throw new StoreError(
        author.kind === "agent"
          ? "Only a human resolves or reopens a thread. Use suggest-resolve to say it is done."
          : "Suggesting is for agents. Resolve the thread instead.",
      );
    }
    if (status === "suggested" && !body?.trim()) throw new StoreError("Say what changed when suggesting a thread is resolved.");
    this.#transaction(() => {
      const thread = this.#visibleThreadRow(threadId, author);
      if (thread.status === status) throw new StoreError(`Thread #${thread.id} is already ${STATUS_LABELS[status]}.`);
      if (!allowedFrom.includes(thread.status)) {
        throw new StoreError(`Thread #${thread.id} is ${STATUS_LABELS[thread.status]}, so it cannot become ${STATUS_LABELS[status]}.`);
      }
      const { version } = this.#observeDoc(this.#docById(thread.doc_id));
      const message = body?.trim() || (status === "open" ? "Reopened." : "");
      if (message) this.#insertMessage(thread.id, version.id, message, author, pending);
      this.#updateStatus(thread.id, status, author);
      this.#writes++;
    });
  }

  /** How many messages wait in the human's unsent batch, across all docs. */
  pendingCount() {
    return this.#db.prepare("SELECT count(*) AS n FROM messages WHERE pending = 1").get().n;
  }

  /**
   * Sends every pending message in one transaction and returns how many went.
   * Each takes a send time later than every sent message, so a reply drafted
   * before an agent's answer still reads as the latest word, even when both
   * land in the same millisecond.
   */
  sendPending(author) {
    if (author.kind !== "human") throw new StoreError("Only a human sends a batch.");
    const sent = this.#transaction(() => {
      const latest = this.#db.prepare("SELECT max(created_at) AS at FROM messages WHERE pending = 0").get().at;
      const at = new Date(Math.max(Date.now(), latest ? Date.parse(latest) + 1 : 0)).toISOString();
      const changes = this.#db.prepare("UPDATE messages SET pending = 0, created_at = ? WHERE pending = 1").run(at).changes;
      if (changes) this.#writes++;
      return changes;
    });
    return Number(sent);
  }

  /** Deletes every pending message, and every thread that was only a draft. Returns how many messages went. */
  discardPending(author) {
    if (author.kind !== "human") throw new StoreError("Only a human discards a batch.");
    const discarded = this.#transaction(() => {
      const drafts = this.#db
        .prepare("SELECT t.id, t.doc_id FROM threads t WHERE (SELECT pending FROM messages WHERE thread_id = t.id ORDER BY id LIMIT 1) = 1")
        .all();
      const count = this.#db.prepare("DELETE FROM messages WHERE pending = 1").run().changes;
      for (const draft of drafts) this.#deleteThreadRows(draft.id, draft.doc_id);
      if (count) this.#writes++;
      return count;
    });
    return Number(discarded);
  }

  /**
   * Permanently deletes a thread and its messages. Only a human may. When it
   * was the doc's last thread, the doc's stored versions go too, because only
   * docs with threads keep copies.
   */
  deleteThread(threadId, author) {
    if (author.kind !== "human") throw new StoreError("Only a human deletes comments.");
    this.#transaction(() => {
      const thread = this.#threadRow(threadId);
      this.#deleteThreadRows(thread.id, thread.doc_id);
      this.#writes++;
    });
  }

  /**
   * Permanently deletes one reply. Only a human may. A thread's first message
   * is the comment itself, so it goes only with the whole thread.
   */
  deleteMessage(threadId, messageId, author) {
    if (author.kind !== "human") throw new StoreError("Only a human deletes comments.");
    this.#transaction(() => {
      const thread = this.#threadRow(threadId);
      const message = this.#db.prepare("SELECT id FROM messages WHERE id = ? AND thread_id = ?").get(Number(messageId), thread.id);
      if (!message) throw new StoreError(`Thread #${thread.id} has no message ${messageId}.`);
      const first = this.#db.prepare("SELECT min(id) AS id FROM messages WHERE thread_id = ?").get(thread.id).id;
      if (message.id === first) throw new StoreError("The first message is the comment itself. Delete the thread instead.");
      this.#db.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
      this.#writes++;
    });
  }

  /** One stored version of a tracked doc, with its content, or null. */
  versionAt(file, seq) {
    const doc = this.findDoc(file);
    const version = doc && this.#db.prepare("SELECT * FROM versions WHERE doc_id = ? AND seq = ?").get(doc.id, seq);
    return version ? { ...this.#versionInfo(doc.id, version), content: version.content } : null;
  }

  /** A tracked doc's versions, newest first, with how many threads each one started. */
  versions(file) {
    const doc = this.findDoc(file);
    if (!doc) return [];
    return this.#db
      .prepare(
        `SELECT v.seq, v.observed_at AS observedAt, (SELECT count(*) FROM threads t WHERE t.version_id = v.id) AS threads
         FROM versions v WHERE v.doc_id = ? ORDER BY v.seq DESC`,
      )
      .all(doc.id)
      .map((row) => ({ ...row }));
  }

  /** The id of the newest sent message a human wrote on a doc, or 0. */
  lastHumanMessage(file) {
    const doc = this.findDoc(file);
    if (!doc) return 0;
    return this.#db
      .prepare(
        `SELECT coalesce(max(m.id), 0) AS id FROM messages m JOIN threads t ON t.id = m.thread_id
         WHERE t.doc_id = ? AND m.author_kind = 'human' AND m.pending = 0`,
      )
      .get(doc.id).id;
  }

  /**
   * Every thread on a doc, located against one of its versions: the one with
   * content hash `sha`, or the latest. Threads made after that version are
   * left out, and so are pending messages unless `includePending` (the
   * viewer) asks for them. Returns null when the doc has no threads or no
   * such version.
   */
  threadsAt(file, { sha, includePending = false } = {}) {
    const doc = this.findDoc(file);
    if (!doc) return null;
    const version = sha ? this.#versionBySha(doc.id, sha) : this.#latestVersion(doc.id);
    if (!version) return null;
    const rows = this.#db
      .prepare("SELECT * FROM threads WHERE doc_id = ? AND version_id IN (SELECT id FROM versions WHERE doc_id = ? AND seq <= ?) ORDER BY id")
      .all(doc.id, doc.id, version.seq);
    return { doc: doc.path, version: this.#versionInfo(doc.id, version), threads: this.#views(version, rows, includePending) };
  }

  /** One thread, located against its doc's latest version. A pending thread does not exist for agents. */
  thread(threadId, { includePending = false } = {}) {
    const row = this.#threadRow(threadId);
    const doc = this.#docById(row.doc_id);
    const version = this.#latestVersion(doc.id);
    const [view] = this.#views(version, [row], includePending);
    if (!view) throw new StoreError(`No thread #${threadId}.`);
    return { doc: doc.path, version: this.#versionInfo(doc.id, version), thread: view };
  }

  /** The doc a thread belongs to, so callers can observe it before acting. */
  docOf(threadId) {
    return this.#docById(this.#threadRow(threadId).doc_id).path;
  }

  /** Runs `fn` under the write lock. Listeners hear about its writes only after they commit. */
  #transaction(fn) {
    const before = this.#writes;
    this.#db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      result = fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      this.#writes = before;
      throw err;
    }
    if (this.#writes !== before) for (const listener of this.#listeners) listener();
    return result;
  }

  #observeDoc(doc, content = readOrNull(doc.path)) {
    if (content === null) return { doc, version: this.#latestVersion(doc.id), missing: true };
    return { doc, version: this.#recordVersion(doc.id, content), missing: false };
  }

  #recordVersion(docId, content) {
    const sha = sha256(content);
    const latest = this.#latestVersion(docId);
    if (latest?.sha256 === sha) return latest;
    this.#writes++;
    return this.#db
      .prepare("INSERT INTO versions (doc_id, seq, sha256, content, observed_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
      .get(docId, (latest?.seq ?? 0) + 1, sha, content, now());
  }

  #findOrInsertDoc(file) {
    const key = docKey(file);
    return (
      this.#db.prepare("SELECT * FROM docs WHERE path = ?").get(key) ??
      this.#db.prepare("INSERT INTO docs (path, created_at) VALUES (?, ?) RETURNING *").get(key, now())
    );
  }

  #docById(id) {
    return this.#db.prepare("SELECT * FROM docs WHERE id = ?").get(id);
  }

  #threadRow(id) {
    const row = this.#db.prepare("SELECT * FROM threads WHERE id = ?").get(Number(id));
    if (!row) throw new StoreError(`No thread #${id}.`);
    return row;
  }

  /** A thread's row, refusing agents a thread that is still a human's draft, as if it did not exist. */
  #visibleThreadRow(id, author) {
    const row = this.#threadRow(id);
    const first = this.#db.prepare("SELECT pending FROM messages WHERE thread_id = ? ORDER BY id LIMIT 1").get(row.id);
    if (author.kind !== "human" && first?.pending) throw new StoreError(`No thread #${id}.`);
    return row;
  }

  #deleteThreadRows(threadId, docId) {
    this.#db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    this.#db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
    if (this.#db.prepare("SELECT count(*) AS n FROM threads WHERE doc_id = ?").get(docId).n === 0) {
      this.#db.prepare("DELETE FROM versions WHERE doc_id = ?").run(docId);
      this.#db.prepare("DELETE FROM docs WHERE id = ?").run(docId);
    }
  }

  #latestVersion(docId) {
    return this.#db.prepare("SELECT * FROM versions WHERE doc_id = ? ORDER BY seq DESC LIMIT 1").get(docId);
  }

  #versionBySha(docId, sha) {
    return this.#db.prepare("SELECT * FROM versions WHERE doc_id = ? AND sha256 = ? ORDER BY seq DESC LIMIT 1").get(docId, sha);
  }

  #versionById(id) {
    return this.#db.prepare("SELECT * FROM versions WHERE id = ?").get(id);
  }

  #versionInfo(docId, version) {
    return {
      seq: version.seq,
      sha256: version.sha256,
      observedAt: version.observed_at,
      latestSeq: this.#latestVersion(docId).seq,
    };
  }

  #insertMessage(threadId, versionId, body, author, pending = false) {
    this.#db
      .prepare(
        `INSERT INTO messages (thread_id, author, author_kind, body, version_id, session, created_at, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, author.name, author.kind, body.trim(), versionId, author.session ?? null, now(), pending ? 1 : 0);
  }

  #updateStatus(threadId, status, author) {
    this.#db.prepare("UPDATE threads SET status = ?, status_by = ?, status_at = ? WHERE id = ?").run(status, author.name, now(), threadId);
  }

  #messagesFor(threadIds) {
    const byThread = new Map(threadIds.map((id) => [id, []]));
    if (!threadIds.length) return byThread;
    // Sent messages carry their send time, so this order puts a sent batch after anything posted while it was drafted.
    const rows = this.#db
      .prepare(
        `SELECT m.*, v.seq AS version_seq FROM messages m JOIN versions v ON v.id = m.version_id
         WHERE m.thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY m.created_at, m.id`,
      )
      .all(...threadIds);
    for (const m of rows) {
      byThread.get(m.thread_id).push({
        id: m.id,
        author: m.author,
        authorKind: m.author_kind,
        body: m.body,
        versionSeq: m.version_seq,
        createdAt: m.created_at,
        pending: Boolean(m.pending),
      });
    }
    return byThread;
  }

  /** Views of thread rows against `version`. Without `includePending`, drafts and pending messages are left out. */
  #views(version, rows, includePending = false) {
    const blocksByVersion = new Map([[version.id, { version, blocks: parseBlocks(version.content) }]]);
    const parsed = (versionId) => {
      if (!blocksByVersion.has(versionId)) {
        const v = this.#versionById(versionId);
        blocksByVersion.set(versionId, { version: v, blocks: parseBlocks(v.content) });
      }
      return blocksByVersion.get(versionId);
    };
    const messages = this.#messagesFor(rows.map((r) => r.id));
    const here = parsed(version.id);
    // The comment that opened a thread has its lowest id, even after a batch send moves its time.
    const isDraft = (row) => {
      const list = messages.get(row.id);
      return list.length > 0 && list.reduce((first, m) => (m.id < first.id ? m : first)).pending;
    };
    const visible = includePending ? rows : rows.filter((row) => !isDraft(row));

    return visible.map((row) => {
      const anchor = { blockSha: row.block_sha, ordinal: row.block_ordinal };
      const origin = parsed(row.version_id);
      // Only a renderer change that alters block hashes can lose a block in its own version.
      const originBlock = locate(anchor, origin.blocks).block;
      const hit = locate(anchor, here.blocks);
      const state = hit.state === "outdated" ? "outdated" : row.version_id === version.id ? "current" : "carried";
      const shown = hit.block ? { ...here, block: hit.block } : originBlock ? { ...origin, block: originBlock } : null;
      const nowReads = !hit.block && originBlock ? successor(originBlock, origin.blocks, here.blocks) : null;
      const all = messages.get(row.id);
      const sent = all.filter((m) => !m.pending);
      const draft = isDraft(row);
      return {
        id: row.id,
        status: row.status,
        pending: draft,
        waitingOn: draft ? null : waitingOn(row.status, sent),
        state,
        blockIndex: hit.block?.index ?? null,
        lines: shown && [shown.block.startLine, shown.block.endLine],
        heading: shown && headingAbove(shown.blocks, shown.block.index),
        source: shown && sourceLines(shown.version.content, shown.block),
        madeOn: { seq: origin.version.seq, lines: originBlock ? [originBlock.startLine, originBlock.endLine] : null },
        nowReads: nowReads && {
          blockIndex: nowReads.index,
          lines: [nowReads.startLine, nowReads.endLine],
          source: sourceLines(here.version.content, nowReads),
        },
        quote: row.quote,
        start: row.start,
        statusBy: row.status_by,
        statusAt: row.status_at,
        createdAt: row.created_at,
        messages: includePending ? all : sent,
      };
    });
  }
}
