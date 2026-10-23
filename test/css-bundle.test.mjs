import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCss } from "../lib/css-bundle.mjs";

async function styles(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-css-"));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  return dir;
}

test("imports are inlined in order, recursively, each under a comment naming it", async () => {
  const dir = await styles({
    "index.css": '/* entry */\n@import "a.css";\n@import url("sub/b.css");\n.after {}\n',
    "a.css": ".a {}\n",
    "sub/b.css": "@import '../c.css';\n.b {}\n",
    "c.css": ".c {}\n",
  });
  assert.equal(await bundleCss(path.join(dir, "index.css")), "/* entry */\n/* a.css */\n.a {}\n\n/* sub/b.css */\n/* c.css */\n.c {}\n\n.b {}\n\n.after {}\n");
});

test("a missing file or an import cycle fails loudly", async () => {
  const missing = await styles({ "index.css": '@import "gone.css";\n' });
  await assert.rejects(bundleCss(path.join(missing, "index.css")), /ENOENT/);
  const cycle = await styles({ "index.css": '@import "a.css";\n', "a.css": '@import "index.css";\n' });
  await assert.rejects(bundleCss(path.join(cycle, "index.css")), /CSS import cycle: index.css -> a.css -> index.css/);
});

test("the viewer's stylesheet bundles with no import left over", async () => {
  const entry = fileURLToPath(new URL("../public/styles/index.css", import.meta.url));
  const css = await bundleCss(entry);
  assert.doesNotMatch(css, /@import/);
  for (const name of (await fs.readdir(path.dirname(entry))).filter((f) => f !== "index.css")) {
    assert.match(css, new RegExp(`/\\* ${name.replace(".", "\\.")} \\*/`), `${name} is in the bundle`);
  }
});
