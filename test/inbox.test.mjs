import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../lib/server.mjs";
import { openStore } from "../lib/store.mjs";

const HUMAN = { name: "adam", kind: "human", session: null };
const AGENT = { name: "agent", kind: "agent", session: null };
const BIN = fileURLToPath(new URL("../bin/mdview.mjs", import.meta.url));

let dir;
let home;
let store;
let server;
let url;
const ids = {};

async function getJson(pathname) {
  return (await fetch(new URL(pathname, url))).json();
}

before(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mdview-inbox-")));
  home = path.join(dir, "home");
  const root = path.join(dir, "root");
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  const files = {
    "a.md": "# A\n\nFirst paragraph.\n\nSecond paragraph.\n",
    "notes/b.md": "# B\n\nOnly paragraph.\n",
    "notes/c.md": "# C\n\nNobody waits here.\n",
  };
  for (const [rel, content] of Object.entries(files)) await fs.writeFile(path.join(root, rel), content);
  const outside = path.join(dir, "outside.md");
  await fs.writeFile(outside, "# Outside\n\nNot under the root.\n");
  store = await openStore(home);
  const on = (rel, quote) => {
    const file = rel === "outside" ? outside : path.join(root, rel);
    const content = rel === "outside" ? "# Outside\n\nNot under the root.\n" : files[rel];
    return store.createThread({ file, content, quote, body: `About ${quote}`, author: HUMAN });
  };
  // Waits on the human: the agent answered.
  ids.answered = on("a.md", "First paragraph.");
  store.reply(ids.answered, "Answered.", AGENT);
  // Waits on the human: the agent suggested resolving it.
  ids.suggested = on("notes/b.md", "Only paragraph.");
  store.setStatus(ids.suggested, "suggested", AGENT, "Done, I think.");
  // Waits on the agent: nobody answered yet.
  ids.agentsTurn = on("a.md", "Second paragraph.");
  // Resolved: waits on nobody.
  ids.resolved = on("notes/c.md", "Nobody waits here.");
  store.reply(ids.resolved, "Fixed.", AGENT);
  store.setStatus(ids.resolved, "resolved", HUMAN);
  // Waits on the human, but outside this viewer's root.
  ids.outside = on("outside", "Not under the root.");
  store.reply(ids.outside, "Answered.", AGENT);
  ({ server, url } = await startServer({ root, initial: "a.md", port: 47120, store }));
});

after(async () => {
  server.closeAllConnections();
  server.close();
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("the tree counts, per doc under the root, the threads waiting on the human", async () => {
  const tree = await getJson("/api/tree");
  assert.deepEqual(tree.waiting, { "a.md": 1, "notes/b.md": 1 });
});

test("the inbox lists the threads waiting on the human under the root, by doc, with their last word", async () => {
  const { docs } = await getJson("/api/inbox");
  assert.deepEqual(
    docs.map((d) => [d.path, d.threads.map((t) => [t.id, t.status, t.quote, t.last.author, t.last.body])]),
    [
      ["a.md", [[ids.answered, "open", "First paragraph.", "agent", "Answered."]]],
      ["notes/b.md", [[ids.suggested, "suggested", "Only paragraph.", "agent", "Done, I think."]]],
    ],
  );
});

test("the inbox lists exactly what `comments list --waiting-on human` lists", async () => {
  const res = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", BIN, "comments", "list", path.join(dir, "root"), "--waiting-on", "human", "--json"],
    { cwd: dir, env: { ...process.env, MDVIEW_HOME: home }, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const fromCli = JSON.parse(res.stdout).flatMap((d) => d.threads.map((t) => t.id)).sort();
  const { docs } = await getJson("/api/inbox");
  assert.deepEqual(docs.flatMap((d) => d.threads.map((t) => t.id)).sort(), fromCli);
});

test("the inbox page is the viewer's page, under its script policy", async () => {
  const res = await fetch(new URL("/inbox", url));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /script-src http:\/\/127\.0\.0\.1:\d+\/static\/js\//);
  assert.match(await res.text(), /id="inbox-link"/);
});

test("a viewer without a comment store reports nothing waiting", async (t) => {
  const bare = await startServer({ root: path.join(dir, "root"), initial: "a.md", port: 47125 });
  t.after(() => {
    bare.server.closeAllConnections();
    bare.server.close();
  });
  assert.deepEqual((await (await fetch(new URL("/api/tree", bare.url))).json()).waiting, {});
  assert.deepEqual(await (await fetch(new URL("/api/inbox", bare.url))).json(), { docs: [] });
});
