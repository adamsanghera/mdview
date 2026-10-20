import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../lib/blocks.mjs";
import { startServer } from "../lib/server.mjs";
import { openStore } from "../lib/store.mjs";

const AGENT = { name: "agent", kind: "agent", session: null };

let dir;
let home;
let store;
let server;
let port;

function get(pathname, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

/** POSTs JSON as mdview's own page would. A header set to null is left out. */
function post(pathname, body, overrides = {}) {
  const data = JSON.stringify(body);
  const headers = Object.fromEntries(
    Object.entries({
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      ...overrides,
    }).filter(([, value]) => value !== null),
  );
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Not every refusal is JSON.
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function docJson(rel) {
  return JSON.parse((await get(`/api/doc?path=${encodeURIComponent(rel)}`)).body);
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-server-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-server-home-"));
  store = await openStore(home);
  await fs.mkdir(path.join(dir, "notes"));
  await fs.writeFile(path.join(dir, "README.md"), "# Home\n\nSee [notes](notes/plan.md).\n");
  await fs.writeFile(path.join(dir, "notes", "plan.md"), "# Plan\n\n## Step one\n");
  await fs.writeFile(path.join(dir, "notes", "draft.md"), "# Draft\n\nFirst pass.\n");
  await fs.writeFile(path.join(dir, "notes", "diagram.png"), "png-bytes");
  ({ server, port } = await startServer({ root: dir, initial: "notes/plan.md", port: 47100, store }));
});

after(() => {
  server.closeAllConnections();
  server.close();
  store.close();
});

test("the root redirects to the initial document", async () => {
  const res = await get("/");

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/view/notes/plan.md");
});

test("the doc API renders a file and resolves folders to their index", async () => {
  const file = JSON.parse((await get("/api/doc?path=notes/plan.md")).body);
  const folder = JSON.parse((await get("/api/doc?path=")).body);

  assert.equal(file.title, "Plan");
  assert.deepEqual(file.toc.map((h) => h.id), ["plan", "step-one"]);
  assert.equal(folder.path, "README.md");
  assert.match(folder.html, /href="\/view\/notes\/plan\.md"/);
});

test("the doc API sends other files to the raw route", async () => {
  const res = JSON.parse((await get("/api/doc?path=notes/diagram.png")).body);

  assert.deepEqual(res, { raw: "notes/diagram.png" });
});

test("the tree lists Markdown files under the root", async () => {
  const res = JSON.parse((await get("/api/tree")).body);

  assert.deepEqual([...res.files].sort(), ["README.md", "notes/draft.md", "notes/plan.md"]);
});

test("files outside the root are refused", async () => {
  [
    await get("/raw/notes%2F..%2F..%2F..%2Fetc%2Fpasswd"),
    await get("/api/doc?path=../../etc/passwd"),
  ].forEach((res) => assert.equal(res.status, 403));
});

test("requests that name another host are refused", async () => {
  const res = await get("/api/tree", `evil.example:${port}`);

  assert.equal(res.status, 403);
});

test("writes need mdview's own Origin and a JSON body", async () => {
  const comment = { path: "notes/plan.md", sha: "x", blockIndex: 0, body: "hi" };
  for (const tc of [
    { desc: "no Origin", headers: { Origin: null }, status: 403 },
    { desc: "another site's Origin", headers: { Origin: "https://evil.example" }, status: 403 },
    { desc: "an opaque Origin", headers: { Origin: "null" }, status: 403 },
    { desc: "a form post", headers: { "Content-Type": "application/x-www-form-urlencoded" }, status: 415 },
  ]) {
    assert.equal((await post("/api/comments", comment, tc.headers)).status, tc.status, tc.desc);
  }
  assert.equal((await post("/api/comments", null)).status, 400, "a body that is not an object");
});

test("a doc's first comment tracks it, and comments come back rendered and escaped", async () => {
  const before = await docJson("notes/plan.md");
  const src = await fs.readFile(path.join(dir, "notes", "plan.md"), "utf8");
  assert.equal(before.version, null);
  assert.equal(before.sha, sha256(src));

  const created = await post("/api/comments", {
    path: "notes/plan.md",
    sha: before.sha,
    blockIndex: 1,
    quote: "Step",
    start: 0,
    body: "Is this **right**? <script>alert(1)</script>",
  });
  assert.equal(created.status, 201);

  const after = await docJson("notes/plan.md");
  assert.deepEqual(after.version, { seq: 1 });
  const { threads } = JSON.parse((await get(`/api/comments?path=notes/plan.md&sha=${after.sha}`)).body);
  assert.deepEqual(
    threads.map((t) => [t.id, t.blockIndex, t.state, t.quote]),
    [[created.body.id, 1, "current", "Step"]],
  );
  assert.match(threads[0].messages[0].bodyHtml, /<strong>right<\/strong>/);
  assert.match(threads[0].messages[0].bodyHtml, /&lt;script&gt;/);
});

test("stored versions render read-only, and the version list counts their threads", async () => {
  await fs.writeFile(path.join(dir, "notes", "plan.md"), "# Plan\n\n## Step one\n\nA new paragraph.\n");

  const latest = await docJson("notes/plan.md");
  const old = JSON.parse((await get("/api/doc?path=notes/plan.md&v=1")).body);
  const { versions } = JSON.parse((await get("/api/versions?path=notes/plan.md")).body);

  assert.deepEqual(latest.version, { seq: 2 });
  assert.equal(old.old, true);
  assert.deepEqual(old.version, { seq: 1, latestSeq: 2 });
  assert.doesNotMatch(old.html, /A new paragraph/);
  assert.deepEqual(
    versions.map((v) => [v.seq, v.threads]),
    [
      [2, 0],
      [1, 1],
    ],
  );
  assert.equal((await get("/api/doc?path=notes/plan.md&v=9")).status, 404);
});

test("the viewer batches comments, and agents see them only after Send", async () => {
  const file = path.join(dir, "notes", "batch.md");
  await fs.writeFile(file, "# Batch\n\nOne.\n\nTwo.\n\nThree.\n");
  const doc = await docJson("notes/batch.md");
  const draft = (blockIndex, body) => post("/api/comments", { path: "notes/batch.md", sha: doc.sha, blockIndex, body, pending: true });
  await draft(1, "first");
  await draft(2, "second");

  const viewer = JSON.parse((await get(`/api/comments?path=notes/batch.md&sha=${doc.sha}`)).body);
  assert.deepEqual([viewer.threads.map((t) => t.pending), viewer.pendingCount], [[true, true], 2]);
  assert.deepEqual(store.threadsAt(file).threads, []);

  assert.deepEqual((await post("/api/comments/batch/send", {})).body, { sent: 2 });
  assert.deepEqual(store.threadsAt(file).threads.map((t) => t.waitingOn), ["agent", "agent"]);

  await draft(3, "third, then thrown away");
  assert.deepEqual((await post("/api/comments/batch/discard", {})).body, { discarded: 1 });
  assert.equal(store.threadsAt(file, { includePending: true }).threads.length, 2);
});

test("a first comment on content that changed underneath gets 409", async () => {
  const opened = await docJson("notes/draft.md");
  await fs.writeFile(path.join(dir, "notes", "draft.md"), "# Draft\n\nRewritten by an agent.\n");

  const res = await post("/api/comments", { path: "notes/draft.md", sha: opened.sha, blockIndex: 1, body: "hi" });

  assert.equal(res.status, 409);
});

test("the browser resolves, reopens and replies, but cannot suggest", async () => {
  const file = path.join(dir, "README.md");
  const id = store.createThread({ file, content: await fs.readFile(file, "utf8"), blockIndex: 0, body: "x", author: AGENT });
  const status = (body) => post(`/api/comments/${id}/status`, body).then((res) => res.status);

  assert.equal(await status({ status: "suggested" }), 400);
  assert.equal(await status({ status: "resolved" }), 200);
  assert.equal((await post(`/api/comments/${id}/messages`, { body: "thanks" })).status, 200);
  assert.equal(store.thread(id).thread.status, "resolved");
  assert.equal(await status({ status: "open" }), 200);
  assert.equal((await post("/api/comments/999/status", { status: "open" })).status, 400);
});

test("the browser deletes threads and replies permanently, behind the same Origin check", async () => {
  const file = path.join(dir, "README.md");
  const id = store.createThread({ file, content: await fs.readFile(file, "utf8"), blockIndex: 0, body: "doomed", author: AGENT });
  store.reply(id, "a reply", AGENT);
  const [first, reply] = store.thread(id).thread.messages;

  assert.equal((await post(`/api/comments/${id}/messages/${first.id}/delete`, {})).status, 400);
  assert.equal((await post(`/api/comments/${id}/messages/${reply.id}/delete`, {})).status, 200);
  assert.equal(store.thread(id).thread.messages.length, 1);
  assert.equal((await post(`/api/comments/${id}/delete`, {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(`/api/comments/${id}/delete`, {})).status, 200);
  assert.throws(() => store.thread(id), /No thread/);
});

test("a write from another process streams a comments event", async () => {
  const file = path.join(dir, "README.md");
  const id = store.createThread({ file, content: await fs.readFile(file, "utf8"), blockIndex: 1, body: "x", author: AGENT });

  const stream = await new Promise((resolve, reject) => {
    let timer;
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events?path=README.md", headers: { Host: `127.0.0.1:${port}` } }, async (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
        if (data.includes("event: comments")) {
          clearTimeout(timer);
          req.destroy();
          resolve(data);
        }
      });
      const cli = await openStore(home);
      cli.reply(id, "from the CLI", AGENT);
      cli.close();
    });
    req.on("error", () => {});
    timer = setTimeout(() => {
      req.destroy();
      reject(new Error("no comments event within 3s"));
    }, 3000);
  });

  assert.match(stream, /event: comments/);
});
