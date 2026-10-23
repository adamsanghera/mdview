import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { startViewer } from "../helpers/viewer.mjs";
import { click } from "../helpers/viewer-page.mjs";

const UNTRUSTED = `# Untrusted

<img id="bait" src="/nowhere.png" onerror="window.pwned = 'onerror'">

<a id="js-link" href="javascript:window.pwned = 'link'">A link</a>

The rest of the doc.
`;

const chrome = sharedChrome();

test("a doc's raw HTML cannot run scripts in the viewer", { skip: chromeMissing }, async (t) => {
  const viewer = await startViewer({ files: { "untrusted.md": UNTRUSTED }, initial: "untrusted.md", port: 47450 });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());

  await page.waitFor(() => document.querySelector("#bait")?.complete, { what: "the image to fail" });
  assert.equal(await page.eval(() => document.querySelector("#bait").getAttribute("onerror")), "window.pwned = 'onerror'");
  await click(page, "#js-link");
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(await page.eval(() => window.pwned ?? null), null);
  assert.equal(await page.eval(() => document.querySelector("#doc h1")?.textContent.includes("Untrusted")), true);
});
