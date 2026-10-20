import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./blocks.mjs";
import { isMarkdown, listMarkdown, pickIndex, resolveInRoot, toPosix } from "./files.mjs";
import { renderCommentBody, renderMarkdown } from "./render.mjs";
import { humanName, StoreError } from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "..", "public");
const HLJS_STYLES = path.join(HERE, "..", "node_modules", "highlight.js", "styles");
const HLJS_THEMES = new Set(["github.css", "github-dark.css"]);
const WATCH_INTERVAL_MS = 400;
const HEARTBEAT_MS = 20_000;
const PORT_ATTEMPTS = 20;
const MAX_BODY_BYTES = 64 * 1024;
const THREAD_ROUTE = /^\/api\/comments\/(\d+)\/(messages|status)$/;
const HUMAN_STATUSES = new Set(["resolved", "open"]);
const NO_THREADS = { version: null, threads: [] };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), TYPES[".json"]);
}

async function sendFile(res, abs) {
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return send(res, 404, "not found");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    createReadStream(abs).pipe(res);
  } catch {
    send(res, 404, "not found");
  }
}

async function mtimeOf(abs) {
  try {
    return (await fs.stat(abs)).mtimeMs;
  } catch {
    return null;
  }
}

function decodePathname(pathname, prefix) {
  return pathname
    .slice(prefix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

/**
 * Resolves a requested document path to the Markdown file to show.
 * Folders resolve to their index file. Non-Markdown files come back as
 * `raw` so the client can open them directly.
 */
async function resolveDoc(root, rel) {
  const abs = resolveInRoot(root, rel);
  if (!abs) return { error: "That path is outside the viewer's root.", status: 403 };
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) return { error: `No such file: ${rel || "."}`, status: 404 };
  if (stat.isDirectory()) {
    const index = await pickIndex(abs);
    if (!index) return { error: `No Markdown files in ${rel || "the root"}.`, status: 404 };
    return { abs: path.join(abs, index), rel: toPosix(path.relative(root, path.join(abs, index))) };
  }
  if (!isMarkdown(abs)) return { raw: toPosix(path.relative(root, abs)) };
  return { abs, rel: toPosix(path.relative(root, abs)) };
}

function changeTokenOf(store) {
  try {
    return store?.changeToken() ?? null;
  } catch {
    return null;
  }
}

/**
 * Streams "change" when the file's mtime moves and "comments" when anyone,
 * this server or a CLI process, writes to the comment store.
 */
function streamChanges(req, res, abs, store) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("retry: 1500\n\n");
  let last;
  let lastToken = changeTokenOf(store);
  let checking = false;
  mtimeOf(abs).then((m) => (last = m));
  const watch = setInterval(async () => {
    if (checking) return;
    checking = true;
    const now = await mtimeOf(abs);
    checking = false;
    if (last !== undefined && now !== last && now !== null) res.write(`event: change\ndata: ${now}\n\n`);
    last = now;
    const token = changeTokenOf(store);
    if (token !== lastToken) {
      lastToken = token;
      res.write("event: comments\ndata: \n\n");
    }
  }, WATCH_INTERVAL_MS);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(watch);
    clearInterval(heartbeat);
  });
}

/**
 * Refuses writes that did not come from mdview's own page. Browsers send
 * Origin on every POST, and a cross-site JSON POST needs a CORS preflight
 * that mdview never approves, so together the two checks stop any other site
 * from posting comments through the browser.
 */
function checkWriteRequest(req, allowedHosts) {
  let origin;
  try {
    origin = new URL(req.headers.origin ?? "");
  } catch {
    throw new HttpError(403, "Writes must come from mdview's own page.");
  }
  if (origin.protocol !== "http:" || !allowedHosts.has(origin.host)) {
    throw new HttpError(403, "Writes must come from mdview's own page.");
  }
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Writes must be JSON.");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, "That request is too large."));
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reject(new HttpError(400, "The request body is not JSON."));
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return reject(new HttpError(400, "The request body must be a JSON object."));
      }
      resolve(body);
    });
    req.on("error", reject);
  });
}

/** The content with hash `sha`: a stored version, or the file itself if it still matches. */
async function contentFor(store, abs, sha) {
  const stored = store.contentForSha(abs, sha);
  if (stored !== null) return stored;
  const current = await fs.readFile(abs, "utf8").catch(() => null);
  return current !== null && sha256(current) === sha ? current : null;
}

function withBodyHtml(result) {
  return {
    ...result,
    threads: result.threads.map((t) => ({
      ...t,
      messages: t.messages.map((m) => ({ ...m, bodyHtml: renderCommentBody(m.body) })),
    })),
  };
}

async function handleWrite(req, res, pathname, { root, store, allowedHosts }) {
  if (!store) throw new HttpError(503, "Comments are off because the comment store did not open.");
  checkWriteRequest(req, allowedHosts);
  const body = await readJsonBody(req);
  const author = { name: humanName(), kind: "human", session: null };

  if (pathname === "/api/comments") {
    if (!Number.isInteger(body.blockIndex)) throw new HttpError(400, "blockIndex must be an integer.");
    const doc = await resolveDoc(root, String(body.path ?? ""));
    if (!doc.abs) throw new HttpError(doc.status ?? 400, doc.error ?? "Comments go on Markdown files.");
    const content = await contentFor(store, doc.abs, String(body.sha ?? ""));
    if (content === null) throw new HttpError(409, "This doc changed since you opened it.");
    const id = store.createThread({
      file: doc.abs,
      content,
      blockIndex: body.blockIndex,
      quote: String(body.quote ?? ""),
      start: Number.isInteger(body.start) ? body.start : 0,
      body: String(body.body ?? ""),
      author,
    });
    return sendJson(res, 201, { id });
  }

  const match = THREAD_ROUTE.exec(pathname);
  if (!match) throw new HttpError(404, "not found");
  const [, id, action] = match;
  if (action === "messages") {
    store.reply(id, String(body.body ?? ""), author);
  } else {
    if (!HUMAN_STATUSES.has(body.status)) throw new HttpError(400, 'status must be "resolved" or "open".');
    store.setStatus(id, body.status, author);
  }
  return sendJson(res, 200, { id: Number(id) });
}

function createHandler({ root, initial, allowedHosts, store }) {
  return async function handle(req, res) {
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, "forbidden host");
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    if (req.method === "POST") {
      try {
        return await handleWrite(req, res, pathname, { root, store, allowedHosts });
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof StoreError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");

    if (pathname === "/") {
      const target = "/view/" + initial.split("/").map(encodeURIComponent).join("/");
      res.writeHead(302, { Location: target });
      return res.end();
    }
    if (pathname === "/view" || pathname.startsWith("/view/")) {
      return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    }
    if (pathname.startsWith("/static/hljs/")) {
      const name = pathname.slice("/static/hljs/".length);
      if (!HLJS_THEMES.has(name)) return send(res, 404, "not found");
      return sendFile(res, path.join(HLJS_STYLES, name));
    }
    if (pathname.startsWith("/static/")) {
      const abs = resolveInRoot(PUBLIC_DIR, decodePathname(pathname, "/static/"));
      return abs ? sendFile(res, abs) : send(res, 404, "not found");
    }
    if (pathname.startsWith("/raw/")) {
      const abs = resolveInRoot(root, decodePathname(pathname, "/raw/"));
      return abs ? sendFile(res, abs) : send(res, 403, "outside root");
    }
    if (pathname === "/api/info") {
      return sendJson(res, 200, { root, rootName: path.basename(root), initial, comments: Boolean(store), user: store ? humanName() : null });
    }
    if (pathname === "/api/tree") {
      return sendJson(res, 200, { files: await listMarkdown(root) });
    }
    if (pathname === "/api/doc") {
      const doc = await resolveDoc(root, url.searchParams.get("path") ?? "");
      if (doc.error) return sendJson(res, doc.status, { error: doc.error });
      if (doc.raw !== undefined) return sendJson(res, 200, { raw: doc.raw });
      const [src, mtimeMs] = await Promise.all([fs.readFile(doc.abs, "utf8"), mtimeOf(doc.abs)]);
      let version = null;
      try {
        version = store?.observe(doc.abs, src)?.version ?? null;
      } catch (err) {
        console.error(`mdview: could not record a version of ${doc.rel}: ${err.message}`);
      }
      return sendJson(res, 200, {
        path: doc.rel,
        abs: doc.abs,
        mtimeMs,
        sha: sha256(src),
        version: version && { seq: version.seq },
        ...renderMarkdown(src, doc.rel),
      });
    }
    if (pathname === "/api/comments") {
      if (!store) return sendJson(res, 200, NO_THREADS);
      const doc = await resolveDoc(root, url.searchParams.get("path") ?? "");
      if (doc.error) return sendJson(res, doc.status, { error: doc.error });
      if (!doc.abs) return sendJson(res, 200, NO_THREADS);
      const result = store.threadsAt(doc.abs, { sha: url.searchParams.get("sha") || undefined });
      return sendJson(res, 200, result ? withBodyHtml(result) : NO_THREADS);
    }
    if (pathname === "/api/events") {
      const doc = await resolveDoc(root, url.searchParams.get("path") ?? "");
      if (!doc.abs) return send(res, 404, "not found");
      return streamChanges(req, res, doc.abs, store);
    }
    return send(res, 404, "not found");
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Serves `root` on 127.0.0.1, starting at `port` and moving up past ports in
 * use. `initial` is the root-relative document that "/" opens. Without a
 * comment `store`, the viewer is read-only.
 */
export async function startServer({ root, initial = "", port = 4545, store = null }) {
  const allowedHosts = new Set();
  const server = http.createServer();
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const candidate = port + attempt;
    try {
      await listen(server, candidate);
      for (const host of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.add(`${host}:${candidate}`);
      const handler = createHandler({ root, initial, allowedHosts, store });
      server.on("request", (req, res) => {
        handler(req, res).catch((err) => {
          if (!res.headersSent) send(res, 500, String(err?.message ?? err));
          else res.end();
        });
      });
      return { server, port: candidate, url: `http://127.0.0.1:${candidate}/` };
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No free port in ${port}-${port + PORT_ATTEMPTS - 1}`);
}
