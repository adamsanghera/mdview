/** Starts a viewer on a temp folder and a temp comment store, for browser tests. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../lib/server.mjs";
import { openStore } from "../../lib/store.mjs";

export const HUMAN = { name: "adam", kind: "human", session: null };
export const AGENT = { name: "agent", kind: "agent", session: "test-session" };

/**
 * Writes `files` ({relativePath: content}) under a temp root and serves it,
 * opening `initial`. Returns the URL, the store, helpers to read and write
 * files, and close().
 */
export async function startViewer({ files, initial, port = 47400 }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-ui-"));
  const root = path.join(dir, "root");
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const store = await openStore(path.join(dir, "home"));
  const { server, url } = await startServer({ root: await fs.realpath(root), initial, port, store });
  return {
    url,
    store,
    file: (rel) => path.join(root, rel),
    write: (rel, content) => fs.writeFile(path.join(root, rel), content),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
