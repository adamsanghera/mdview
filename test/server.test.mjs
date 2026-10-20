import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";

let dir;
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

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-server-"));
  await fs.mkdir(path.join(dir, "notes"));
  await fs.writeFile(path.join(dir, "README.md"), "# Home\n\nSee [notes](notes/plan.md).\n");
  await fs.writeFile(path.join(dir, "notes", "plan.md"), "# Plan\n\n## Step one\n");
  await fs.writeFile(path.join(dir, "notes", "diagram.png"), "png-bytes");
  ({ server, port } = await startServer({ root: dir, initial: "notes/plan.md", port: 47100 }));
});

after(() => server.close());

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

  assert.deepEqual([...res.files].sort(), ["README.md", "notes/plan.md"]);
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
