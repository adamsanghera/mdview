import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { liveServers, register } from "../lib/registry.mjs";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mdview-registry-"));
}

test("a viewer is listed while it runs and gone once it withdraws", async () => {
  const home = await tempHome();
  const unregister = register(home, { port: 4545, root: "/docs" });

  assert.deepEqual(
    liveServers(home).map((s) => [s.pid, s.port, s.root]),
    [[process.pid, 4545, "/docs"]],
  );
  unregister();
  assert.deepEqual(liveServers(home), []);
});

test("an announcement left by a viewer that died is dropped", async () => {
  const home = await tempHome();
  await fs.mkdir(path.join(home, "servers"));
  const stale = path.join(home, "servers", "999999999.json");
  await fs.writeFile(stale, JSON.stringify({ pid: 999999999, port: 4546, root: "/gone", startedAt: new Date().toISOString() }));

  assert.deepEqual(liveServers(home), []);
  await assert.rejects(fs.access(stale));
});
