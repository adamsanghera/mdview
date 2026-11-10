/**
 * mdview's comment store, kept on peanut (~/mono/peanut): one SQLite file in
 * MDVIEW_HOME (default ~/.mdview) holding threads on Markdown docs and the
 * doc versions they were made on.
 *
 * peanut keeps the threads, messages, statuses, the human's pending batch
 * and the versions threads were made on (lib/peanut-app.mjs says what an
 * mdview doc is). This module keeps the API the server and CLI were written
 * against, keyed by file path.
 *
 * Nothing can rebuild this data, so it lives outside the docs' folders, and
 * mdview never writes a doc. Deleting is permanent and human-only. A human's
 * pending messages stay hidden from every agent-facing read until the batch
 * is sent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnchorError, openStore as openPeanut, Registry, StoreError } from "peanut";
import { BLOCK, DOC, mdviewApp, readOrNull } from "./peanut-app.mjs";

export { StoreError };

export const STATUS_LABELS = { open: "open", suggested: "suggested resolved", resolved: "resolved" };

/**
 * Whether a thread waits on `kind` ("human" or "agent"): it is unresolved and
 * the next word is theirs. What `comments list --waiting-on` and the viewer's
 * inbox both go by.
 */
export function isWaitingOn(thread, kind) {
  return thread.status !== "resolved" && thread.waitingOn === kind;
}

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

/** Opens the store in `home`, creating it on first use. */
export async function openStore(home = storeHome()) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const peanut = await openPeanut({ registry: new Registry().register(mdviewApp), dir: home });
  return new Store(peanut);
}

export class Store {
  #p;

  constructor(peanut) {
    this.#p = peanut;
  }

  close() {
    this.#p.close();
  }

  /** Changes whenever this process or another one writes to the store. */
  changeToken() {
    return this.#p.changeToken();
  }

  /** Calls `listener` after each write this process commits. Returns a function that stops it. */
  onWrite(listener) {
    return this.#p.onWrite(listener);
  }

  /** The tracked doc at `file`, {path}, or undefined when it has no threads. */
  findDoc(file) {
    const key = docKey(file);
    return this.#p.document(DOC, key) ? { path: key } : undefined;
  }

  /** The keys (realpaths) of tracked docs inside `dir`, at any depth, sorted. */
  docsUnder(dir) {
    return this.#p.documents([{ type: DOC, keyPrefix: docKey(dir) + path.sep }]).map((d) => d.key);
  }

  /**
   * Records a tracked doc's content as a new version when it changed, reading
   * the file unless `content` is given. Returns {doc, version, missing}, or
   * null for a doc without threads. A deleted file yields the last version
   * with `missing` set.
   */
  observe(file, content) {
    const key = docKey(file);
    const current = content ?? readOrNull(key);
    const found = this.#p.observe(DOC, key, current === null ? undefined : { content: current });
    if (!found) return null;
    return { doc: { path: key }, version: this.#versionInfo(found.revision, DOC, key), missing: current === null };
  }

  /** The stored content with this hash, for a tracked doc, or null. */
  contentForSha(file, sha) {
    return this.#p.contentForSha(DOC, docKey(file), sha);
  }

  /**
   * Starts a thread on the block the commenter picked in `content`, the exact
   * text they were looking at, and returns the thread id. The block is named
   * by `blockIndex` (the browser), or by `line` and/or `quote` (the CLI).
   * The doc becomes tracked if it was not already. A `pending` thread stays
   * hidden from agents until the human sends the batch.
   */
  createThread({ file, content, blockIndex, line, quote = "", start, body, author, pending = false }) {
    try {
      return this.#p.createThread({
        type: DOC,
        key: docKey(file),
        content,
        anchorType: BLOCK,
        spec: { blockIndex, line, quote, start },
        body,
        author,
        pending,
      });
    } catch (err) {
      if (err instanceof AnchorError) throw new StoreError(err.message);
      throw err;
    }
  }

  /**
   * Adds a message, recorded against the doc as it reads now. A human reply
   * to a suggested thread reopens it, and a reply to a draft joins the draft.
   */
  reply(threadId, body, author, options = {}) {
    this.#observeThreadDoc(threadId);
    this.#p.reply(threadId, body, author, options);
  }

  /** Agents suggest resolving, humans resolve and reopen (see peanut's Store.setStatus). */
  setStatus(threadId, status, author, body, options = {}) {
    this.#observeThreadDoc(threadId);
    this.#p.setStatus(threadId, status, author, body, options);
  }

  /** How many messages wait in the human's unsent batch, across all docs. */
  pendingCount() {
    return this.#p.pendingCount();
  }

  sendPending(author) {
    return this.#p.sendPending(author);
  }

  discardPending(author) {
    return this.#p.discardPending(author);
  }

  deleteThread(threadId, author) {
    this.#p.deleteThread(threadId, author);
  }

  deleteMessage(threadId, messageId, author) {
    this.#p.deleteMessage(threadId, messageId, author);
  }

  /** One stored version of a tracked doc, with its content, or null. */
  versionAt(file, seq) {
    const key = docKey(file);
    const revision = this.#p.revisionAt(DOC, key, seq);
    return revision ? { ...this.#versionInfo(revision, DOC, key), content: revision.content } : null;
  }

  /** A tracked doc's versions, newest first, with how many threads each one started. */
  versions(file) {
    return this.#p.revisions(DOC, docKey(file)).map((r) => ({ seq: r.seq, observedAt: r.observedAt, threads: r.threads }));
  }

  /**
   * Ids of threads in scope that wait on an agent. `files` name docs, and
   * `folders` cover every doc inside them, resolved on each call so docs
   * tracked since count. Cheap enough to run on every doorbell ring.
   */
  waitingOnAgent({ files = [], folders = [] }) {
    const filter = [
      ...files.map((file) => ({ type: DOC, key: docKey(file) })),
      ...folders.map((dir) => ({ type: DOC, keyPrefix: docKey(dir) + path.sep })),
    ];
    return this.#p.waitingOnAgent({ filter });
  }

  /**
   * How many threads wait on the human in each tracked doc inside `dir`, at
   * any depth, as a Map from doc key to count. Docs with none are left out.
   * One query on peanut's thread_facts, the view every reader takes whose
   * turn it is from, so it is cheap enough for every file-list refresh.
   */
  waitingOnHumanCounts(dir) {
    const prefix = docKey(dir) + path.sep;
    const rows = this.#p.db
      .prepare(
        `SELECT d.key AS key, count(*) AS n FROM threads t
         JOIN thread_facts f ON f.thread_id = t.id JOIN documents d ON d.id = t.document_id
         WHERE f.waiting_on = 'human' AND d.type = ? AND substr(d.key, 1, length(?)) = ?
         GROUP BY d.key ORDER BY d.key`,
      )
      .all(DOC, prefix, prefix);
    return new Map(rows.map((row) => [row.key, Number(row.n)]));
  }

  /**
   * The threads waiting on the human in tracked docs inside `dir`, as
   * [{doc, version, threads}] sorted by doc: what `comments list <dir>
   * --waiting-on human` lists. Each doc is observed first, so threads are
   * placed against the file as it reads now.
   */
  waitingOnHuman(dir) {
    const found = [];
    for (const key of this.waitingOnHumanCounts(dir).keys()) {
      this.observe(key);
      const result = this.threadsAt(key);
      const threads = result?.threads.filter((t) => isWaitingOn(t, "human")) ?? [];
      if (threads.length) found.push({ ...result, threads });
    }
    return found;
  }

  /**
   * Every thread on a doc, located against one of its versions: the one with
   * content hash `sha`, or the latest. Threads made after that version are
   * left out, and so are pending messages unless `includePending` (the
   * viewer) asks for them. Returns null when the doc has no threads or no
   * such version.
   */
  threadsAt(file, { sha, includePending = false } = {}) {
    const key = docKey(file);
    const found = this.#p.threadsAt(DOC, key, { sha, includePending, excerpts: true });
    if (!found) return null;
    return { doc: key, version: this.#versionInfo(found.revision, DOC, key), threads: found.threads.map(view) };
  }

  /** One thread, located against its doc's latest version. A pending thread does not exist for agents. */
  thread(threadId, { includePending = false } = {}) {
    const found = this.#p.thread(threadId, { includePending, excerpts: true });
    return { doc: found.document.key, version: this.#versionInfo(found.revision, DOC, found.document.key), thread: view(found.thread) };
  }

  /** The doc a thread belongs to, so callers can observe it before acting. */
  docOf(threadId) {
    return this.#p.documentOf(threadId).key;
  }

  /** Records the doc a thread is on as it reads now, so a message names the version its author saw. */
  #observeThreadDoc(threadId) {
    const { key } = this.#p.documentOf(threadId);
    const content = readOrNull(key);
    if (content !== null) this.#p.observe(DOC, key, { content });
  }

  #versionInfo(revision, type, key) {
    const latest = this.#p.db
      .prepare("SELECT max(r.seq) AS seq FROM revisions r JOIN documents d ON d.id = r.document_id WHERE d.type = ? AND d.key = ?")
      .get(type, key).seq;
    return { seq: revision.seq, sha256: revision.sha256, observedAt: revision.observedAt, latestSeq: latest };
  }
}

/** A peanut thread view (made with excerpts) in the shape mdview's server, CLI and page read. */
function view(t) {
  const shown = t.placement ?? t.madeOn.placement;
  const next = t.nowReads;
  return {
    id: t.id,
    status: t.status,
    pending: t.pending,
    waitingOn: t.waitingOn,
    state: t.state,
    blockIndex: t.placement?.blockIndex ?? null,
    lines: shown ? shown.lines : null,
    heading: shown ? shown.heading : null,
    source: t.excerpt?.text ?? null,
    madeOn: { seq: t.madeOn.seq, lines: t.madeOn.placement?.lines ?? null },
    nowReads: next ? { blockIndex: next.placement.blockIndex, lines: next.placement.lines, source: next.excerpt } : null,
    quote: t.quote,
    start: t.anchor.start ?? null,
    statusBy: t.statusBy,
    statusAt: t.statusAt,
    createdAt: t.createdAt,
    messages: t.messages.map((m) => ({
      id: m.id,
      author: m.author,
      authorKind: m.authorKind,
      session: m.session,
      body: m.body,
      versionSeq: m.revisionSeq,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      pending: m.pending,
    })),
  };
}
