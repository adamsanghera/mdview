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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locate, normalizeText, sha256 } from "./blocks.mjs";
import { parseBlocks } from "./render.mjs";

const SCHEMA_VERSION = 1;
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
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (thread_id);
`;

// The statuses each kind of author may move a thread to, and from which.
// Agents can only say a thread is done. Humans resolve and reopen.
const TRANSITIONS = {
  agent: { suggested: ["open"] },
  human: { resolved: ["open", "suggested"], open: ["suggested", "resolved"] },
};

export const STATUS_LABELS = { open: "open", suggested: "suggested resolved", resolved: "resolved" };

/** A request the store refuses, worded for the person or agent who made it. */
export class StoreError extends Error {}

/** The folder holding the store: MDVIEW_HOME, or ~/.mdview. */
export function storeHome(env = process.env) {
  return env.MDVIEW_HOME || path.join(os.homedir(), ".mdview");
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
  if (db.prepare("PRAGMA user_version").get().user_version === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return new Store(db);
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

function waitingOn(status, messages) {
  if (status === "resolved") return null;
  if (status === "suggested") return "human";
  return messages.at(-1)?.authorKind === "human" ? "agent" : "human";
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

  findDoc(file) {
    return this.#db.prepare("SELECT * FROM docs WHERE path = ?").get(docKey(file));
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
   * The doc becomes tracked if it was not already.
   */
  createThread({ file, content, blockIndex, line, quote = "", start, body, author }) {
    if (!body?.trim()) throw new StoreError("A comment needs a message.");
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
      this.#insertMessage(thread.id, version.id, body, author);
      return thread.id;
    });
    this.#writes++;
    return id;
  }

  /** Adds a message. A human reply to a suggested thread reopens it. */
  reply(threadId, body, author) {
    if (!body?.trim()) throw new StoreError("A reply needs a message.");
    this.#transaction(() => {
      const thread = this.#threadRow(threadId);
      const { version } = this.#observeDoc(this.#docById(thread.doc_id));
      this.#insertMessage(thread.id, version.id, body, author);
      if (author.kind === "human" && thread.status === "suggested") this.#updateStatus(thread.id, "open", author);
    });
    this.#writes++;
  }

  /**
   * Moves a thread to `status` if `author` may: agents suggest resolving,
   * which needs a message saying what changed, and humans resolve or reopen.
   * An optional `body` is added as a message first.
   */
  setStatus(threadId, status, author, body) {
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
      const thread = this.#threadRow(threadId);
      if (thread.status === status) throw new StoreError(`Thread #${thread.id} is already ${STATUS_LABELS[status]}.`);
      if (!allowedFrom.includes(thread.status)) {
        throw new StoreError(`Thread #${thread.id} is ${STATUS_LABELS[thread.status]}, so it cannot become ${STATUS_LABELS[status]}.`);
      }
      const { version } = this.#observeDoc(this.#docById(thread.doc_id));
      if (body?.trim()) this.#insertMessage(thread.id, version.id, body, author);
      this.#updateStatus(thread.id, status, author);
    });
    this.#writes++;
  }

  /**
   * Every thread on a doc, located against one of its versions: the one with
   * content hash `sha`, or the latest. Threads made after that version are
   * left out. Returns null when the doc has no threads or no such version.
   */
  threadsAt(file, { sha } = {}) {
    const doc = this.findDoc(file);
    if (!doc) return null;
    const version = sha ? this.#versionBySha(doc.id, sha) : this.#latestVersion(doc.id);
    if (!version) return null;
    const rows = this.#db
      .prepare("SELECT * FROM threads WHERE doc_id = ? AND version_id IN (SELECT id FROM versions WHERE doc_id = ? AND seq <= ?) ORDER BY id")
      .all(doc.id, doc.id, version.seq);
    return { doc: doc.path, version: this.#versionInfo(doc.id, version), threads: this.#views(version, rows) };
  }

  /** One thread, located against its doc's latest version. */
  thread(threadId) {
    const row = this.#threadRow(threadId);
    const doc = this.#docById(row.doc_id);
    const version = this.#latestVersion(doc.id);
    const [view] = this.#views(version, [row]);
    return { doc: doc.path, version: this.#versionInfo(doc.id, version), thread: view };
  }

  /** The doc a thread belongs to, so callers can observe it before acting. */
  docOf(threadId) {
    return this.#docById(this.#threadRow(threadId).doc_id).path;
  }

  #transaction(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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

  #insertMessage(threadId, versionId, body, author) {
    this.#db
      .prepare(
        `INSERT INTO messages (thread_id, author, author_kind, body, version_id, session, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, author.name, author.kind, body.trim(), versionId, author.session ?? null, now());
  }

  #updateStatus(threadId, status, author) {
    this.#db.prepare("UPDATE threads SET status = ?, status_by = ?, status_at = ? WHERE id = ?").run(status, author.name, now(), threadId);
  }

  #messagesFor(threadIds) {
    const byThread = new Map(threadIds.map((id) => [id, []]));
    if (!threadIds.length) return byThread;
    const rows = this.#db
      .prepare(
        `SELECT m.*, v.seq AS version_seq FROM messages m JOIN versions v ON v.id = m.version_id
         WHERE m.thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY m.id`,
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
      });
    }
    return byThread;
  }

  #views(version, rows) {
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

    return rows.map((row) => {
      const anchor = { blockSha: row.block_sha, ordinal: row.block_ordinal };
      const origin = parsed(row.version_id);
      // Only a renderer change that alters block hashes can lose a block in its own version.
      const originBlock = locate(anchor, origin.blocks).block;
      const hit = locate(anchor, here.blocks);
      const state = hit.state === "outdated" ? "outdated" : row.version_id === version.id ? "current" : "carried";
      const shown = hit.block ? { ...here, block: hit.block } : originBlock ? { ...origin, block: originBlock } : null;
      const threadMessages = messages.get(row.id);
      return {
        id: row.id,
        status: row.status,
        waitingOn: waitingOn(row.status, threadMessages),
        state,
        blockIndex: hit.block?.index ?? null,
        lines: shown && [shown.block.startLine, shown.block.endLine],
        heading: shown && headingAbove(shown.blocks, shown.block.index),
        source: shown && sourceLines(shown.version.content, shown.block),
        madeOn: { seq: origin.version.seq, lines: originBlock ? [originBlock.startLine, originBlock.endLine] : null },
        quote: row.quote,
        start: row.start,
        statusBy: row.status_by,
        statusAt: row.status_at,
        createdAt: row.created_at,
        messages: threadMessages,
      };
    });
  }
}
