import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { normalizeText } from "./blocks.mjs";
import { docKey, humanName, openStore, STATUS_LABELS, StoreError, storeHome } from "./store.mjs";

const USAGE = `Usage: mdview comments <verb> [options]

Reads and answers comments left on Markdown docs in mdview. Agents reply and
suggest resolving. Only a human resolves or reopens a thread.

Verbs:
  list <doc> [--all]                Unresolved threads on a doc (--all adds resolved ones)
  show <id>                         One thread in full, with its block's source
  reply <id> -m <text>              Add a message
  suggest-resolve <id> -m <text>    Say a thread is done, and what changed
  resolve <id> --human [-m <text>]  Resolve a thread
  reopen <id> --human [-m <text>]   Reopen a thread
  add <doc> (--line <n> | --quote <text>) -m <text>
                                    Start a thread on the block at a line, or the one block containing a quote
  wait <doc> [--timeout 30m] [--interval 30s]
                                    Block until the human writes on the doc, printing one line per check

Options:
  -m, --message <text>  The message, in Markdown
      --json            Print JSON instead of text
      --human           Act as the human (MDVIEW_USER, or the OS username) instead of an agent
  -h, --help            Show this help

Exit codes: 0 done, 1 refused (unknown thread, disallowed status change),
2 malformed command, 3 wait timed out.

Environment:
  MDVIEW_AUTHOR         The agent's name on its messages (default: agent)
  MDVIEW_HOME           The store's folder (default: ~/.mdview)
`;

const PREVIEW_CHARS = 100;
const DURATION = /^(\d+)(s|m|h)?$/;
const DURATION_MS = { s: 1000, m: 60_000, h: 3_600_000 };

class UsageError extends Error {}

function parseDuration(text, flag) {
  const match = DURATION.exec(text);
  if (!match || Number(match[1]) === 0) throw new UsageError(`${flag} must look like 30s, 10m or 1h, not ${text}`);
  return Number(match[1]) * DURATION_MS[match[2] ?? "s"];
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60}m` : `${seconds}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authorFrom(values, env) {
  if (values.human) return { name: humanName(env), kind: "human", session: null };
  return {
    name: env.MDVIEW_AUTHOR || "agent",
    kind: "agent",
    session: env.MDVIEW_SESSION || env.CURSOR_CONVERSATION_ID || env.TERM_SESSION_ID || null,
  };
}

function requireMessage(values, verb) {
  if (!values.message?.trim()) throw new UsageError(`${verb} needs a message: -m <text>`);
  return values.message;
}

function requireHuman(values, verb) {
  if (!values.human) {
    throw new StoreError(`Only a human may ${verb} a thread (pass --human if that is you). Agents use suggest-resolve.`);
  }
}

/* Text output */

function displayPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function when(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return clock;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function lineRange([start, end]) {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function where(thread) {
  const at = thread.lines ? lineRange(thread.lines) + (thread.heading ? ` under "${truncate(thread.heading, 60)}"` : "") : "";
  if (thread.state === "current") return at;
  if (thread.state === "carried") return `${at} · from v${thread.madeOn.seq}, block unchanged`;
  return `outdated: made on v${thread.madeOn.seq}, block changed since${at ? ` (was ${at})` : ""}`;
}

function headline(thread) {
  return [`#${thread.id} ${STATUS_LABELS[thread.status]}`, thread.waitingOn && `waiting on ${thread.waitingOn}`, where(thread)]
    .filter(Boolean)
    .join(" · ");
}

function quoteLine(thread) {
  if (thread.quote) return `> ${truncate(normalizeText(thread.quote), PREVIEW_CHARS)}`;
  return `> (whole block) ${truncate(normalizeText(thread.source ?? ""), PREVIEW_CHARS)}`;
}

function listedMessage(m) {
  const [first, ...rest] = m.body.split("\n");
  return [`  ${m.author} (${when(m.createdAt)}, v${m.versionSeq}): ${first}`, ...rest.map((line) => `      ${line}`)].join("\n");
}

function listText(result, threads) {
  const counts = Object.entries(STATUS_LABELS)
    .map(([status, label]) => [result.threads.filter((t) => t.status === status).length, label])
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");
  const head = `${displayPath(result.doc)} · v${result.version.latestSeq} · ${counts}`;
  const body = threads.length
    ? threads.map((t) => [headline(t), `  ${quoteLine(t)}`, ...t.messages.map(listedMessage)].join("\n"))
    : ["Every thread is resolved. Pass --all to see them."];
  return `${[head, ...body].join("\n\n")}\n`;
}

function showText({ doc, version, thread: t }) {
  const blockSeq = t.state === "outdated" ? t.madeOn.seq : version.seq;
  const block = [t.source === null ? "Block: not found." : `Block in v${blockSeq}, ${lineRange(t.lines)}:\n${indent(t.source, "    ")}`];
  if (t.state === "outdated") {
    block.push(
      t.nowReads
        ? `Now reads, in v${version.seq}, ${lineRange(t.nowReads.lines)}:\n${indent(t.nowReads.source, "    ")}`
        : `No block in v${version.seq} resembles it, so it was removed or rewritten.`,
    );
  }
  const messages = t.messages.map((m) => `${m.author} · ${when(m.createdAt)} · v${m.versionSeq}\n${indent(m.body, "    ")}`);
  return `${[
    [`#${t.id} ${STATUS_LABELS[t.status]}`, t.waitingOn && `waiting on ${t.waitingOn}`, displayPath(doc)].filter(Boolean).join(" · "),
    `${where(t)} · latest is v${version.latestSeq}`,
    "",
    block.join("\n\n"),
    "",
    quoteLine(t),
    "",
    messages.join("\n\n"),
  ].join("\n")}\n`;
}

/* Verbs */

function list(store, docArg, values) {
  const file = path.resolve(docArg);
  const tracked = store.observe(file);
  if (!tracked && !fs.existsSync(file)) throw new UsageError(`No such file: ${docArg}`);
  const result = store.threadsAt(file);
  if (!result) {
    return { text: `No comments on ${displayPath(file)}.\n`, json: { doc: docKey(file), version: null, threads: [] } };
  }
  const threads = values.all ? result.threads : result.threads.filter((t) => t.status !== "resolved");
  const note = tracked.missing ? `The file is missing, so this shows its last version.\n` : "";
  return { text: note + listText(result, threads), json: { ...result, threads } };
}

function show(store, id) {
  store.observe(store.docOf(id));
  const result = store.thread(id);
  return { text: showText(result), json: result };
}

function acted(store, id, sentence) {
  const result = store.thread(id);
  return { text: `${sentence}\n${headline(result.thread)}\n`, json: result };
}

function reply(store, id, values, author) {
  store.reply(id, requireMessage(values, "reply"), author);
  return acted(store, id, `Replied to #${id}.`);
}

function suggestResolve(store, id, values, author) {
  store.setStatus(id, "suggested", author, requireMessage(values, "suggest-resolve"));
  return acted(store, id, `Suggested resolving #${id}. It now waits on the human.`);
}

function resolve(store, id, values, author) {
  requireHuman(values, "resolve");
  store.setStatus(id, "resolved", author, values.message);
  return acted(store, id, `Resolved #${id}.`);
}

function reopen(store, id, values, author) {
  requireHuman(values, "reopen");
  store.setStatus(id, "open", author, values.message);
  return acted(store, id, `Reopened #${id}.`);
}

function add(store, docArg, values, author) {
  const body = requireMessage(values, "add");
  if (values.line === undefined && values.quote === undefined) throw new UsageError("add needs --line <n> or --quote <text>");
  const line = values.line === undefined ? undefined : Number(values.line);
  if (line !== undefined && !(Number.isInteger(line) && line >= 1)) throw new UsageError(`--line must be a line number, not ${values.line}`);
  const file = path.resolve(docArg);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`No such file: ${docArg}`);
  }
  store.observe(file, content);
  const id = store.createThread({ file, content, line, quote: values.quote ?? "", body, author });
  const result = store.thread(id);
  return { text: `Started thread #${id} on ${lineRange(result.thread.lines)} of ${displayPath(file)}.\n`, json: result };
}

/**
 * Polls until a human message newer than the ones present at the start lands
 * on the doc, then prints the threads it landed on. Each check that finds
 * nothing prints one line ending in {next:<wait>}, the format agent-dash
 * watch shells use.
 */
async function wait(store, docArg, values, author, { progress }) {
  const file = path.resolve(docArg);
  if (!fs.existsSync(file) && !store.findDoc(file)) throw new UsageError(`No such file: ${docArg}`);
  const timeout = parseDuration(values.timeout ?? "30m", "--timeout");
  const interval = parseDuration(values.interval ?? "30s", "--interval");
  const since = store.lastHumanMessage(file);
  const deadline = Date.now() + timeout;
  for (;;) {
    if (store.lastHumanMessage(file) > since) {
      store.observe(file);
      const result = store.threadsAt(file);
      const fresh = result.threads.filter((t) => t.messages.some((m) => m.authorKind === "human" && m.id > since));
      const blocks = fresh.map((t) => [headline(t), `  ${quoteLine(t)}`, ...t.messages.filter((m) => m.id > since).map(listedMessage)].join("\n"));
      return { text: `New comments on ${displayPath(file)}:\n\n${blocks.join("\n\n")}\n`, json: { ...result, threads: fresh } };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return { text: `No new comments on ${displayPath(file)} after ${formatDuration(timeout)}.\n`, json: { timedOut: true }, code: 3 };
    }
    const pause = Math.min(interval, left);
    progress(`no new comments on ${displayPath(file)} {next:${formatDuration(pause)}}\n`);
    await sleep(pause);
  }
}

const VERBS = {
  list: { arg: "<doc>", run: list },
  show: { arg: "<id>", run: show },
  reply: { arg: "<id>", run: reply },
  "suggest-resolve": { arg: "<id>", run: suggestResolve },
  resolve: { arg: "<id>", run: resolve },
  reopen: { arg: "<id>", run: reopen },
  add: { arg: "<doc>", run: add },
  wait: { arg: "<doc>", run: wait },
};

/**
 * Runs `mdview comments <args>` and returns the exit code: 0 on success, 1
 * when the store refuses (an unknown thread, a disallowed status change),
 * 2 for a malformed command, and 3 when `wait` times out.
 */
export async function runComments(args, { out = process.stdout, err = process.stderr, env = process.env } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        message: { type: "string", short: "m" },
        json: { type: "boolean" },
        human: { type: "boolean" },
        all: { type: "boolean" },
        line: { type: "string" },
        quote: { type: "string" },
        timeout: { type: "string" },
        interval: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err.write(`mdview comments: ${error.message}\n\n${USAGE}`);
    return 2;
  }

  const [verb, target] = positionals;
  if (values.help) {
    out.write(USAGE);
    return 0;
  }
  if (!VERBS[verb]) {
    err.write(`${verb ? `mdview comments: unknown verb "${verb}"\n\n` : ""}${USAGE}`);
    return 2;
  }
  if (!target) {
    err.write(`mdview comments ${verb}: missing ${VERBS[verb].arg}\n`);
    return 2;
  }

  let store;
  try {
    store = await openStore(storeHome(env));
    // Progress lines would break JSON on stdout, so they move to stderr with --json.
    const progress = (line) => (values.json ? err : out).write(line);
    const result = await VERBS[verb].run(store, target, values, authorFrom(values, env), { progress });
    out.write(values.json ? `${JSON.stringify(result.json, null, 2)}\n` : result.text);
    return result.code ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(`mdview comments ${verb}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof StoreError) {
      err.write(`mdview comments ${verb}: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    store?.close();
  }
}
