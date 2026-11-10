import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { HUMAN, startViewer } from "../helpers/viewer.mjs";
import { click, highlighted } from "../helpers/viewer-page.mjs";

const FLOW = `# Flow

Before the diagram.

\`\`\`mermaid
flowchart LR
  Writer --> Store
  Store --> Viewer
\`\`\`

\`\`\`mermaid
this is not a diagram
\`\`\`

\`\`\`js
const notADiagram = true;
\`\`\`
`;

const chrome = sharedChrome();

async function setup(t, { before } = {}) {
  const viewer = await startViewer({ files: { "flow.md": FLOW }, initial: "flow.md", port: 47460 });
  t.after(() => viewer.close());
  await before?.(viewer);
  const page = await (await chrome()).open("about:blank");
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  // Records anything the page's Content-Security-Policy blocks, from before the viewer's first script runs.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: 'window.blocked = []; addEventListener("securitypolicyviolation", (e) => blocked.push(`${e.violatedDirective} ${e.blockedURI}`));',
  });
  await page.goto(viewer.url);
  await page.waitFor(() => document.querySelectorAll("#doc figure.mermaid .mermaid-svg:not(:empty)").length === 2, { what: "the diagrams to draw" });
  return { viewer, page };
}

test("a mermaid fence draws as an SVG diagram under the page's script policy, with its source in a closed toggle", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t);
  const [good, bad] = await page.eval(() =>
    [...document.querySelectorAll("#doc figure.mermaid")].map((figure) => ({
      svg: Boolean(figure.querySelector(".mermaid-svg > svg")),
      labels: [...figure.querySelectorAll(".mermaid-svg .nodeLabel")].map((n) => n.textContent).sort(),
      failed: figure.classList.contains("mermaid-failed"),
      block: figure.dataset.block ?? null,
      sourceOpen: figure.querySelector("details.mermaid-source").open,
      source: figure.querySelector("details.mermaid-source pre.code code").textContent,
    })),
  );
  assert.deepEqual(await page.eval(() => window.blocked), []);
  assert.equal(good.svg, true);
  assert.deepEqual(good.labels, ["Store", "Viewer", "Writer"]);
  assert.equal(good.failed, false);
  assert.notEqual(good.block, null);
  assert.equal(good.sourceOpen, false);
  assert.match(good.source, /Writer --> Store/);

  assert.equal(bad.svg, false);
  assert.equal(bad.failed, true);
  assert.match(await page.eval(() => document.querySelectorAll("#doc figure.mermaid .mermaid-svg")[1].textContent), /Couldn't draw this diagram/);
  // Other code blocks are left as code.
  assert.equal(await page.eval(() => document.querySelector('#doc pre.code[data-lang="js"]')?.closest("figure") ?? null), null);
});

test("a comment on a diagram's source anchors to it, waits on the closed source toggle, and opens it", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, {
    before(viewer) {
      const file = viewer.file("flow.md");
      viewer.store.createThread({ file, content: fs.readFileSync(file, "utf8"), quote: "Store --> Viewer", body: "Should this be two-way?", author: HUMAN });
    },
  });
  await page.waitFor(() => document.querySelector("#rail .thread"), { what: "the card" });
  await click(page, "#rail .thread");
  await page.waitFor(() => document.querySelector("#doc details.mermaid-source").open, { what: "the source to open" });
  assert.deepEqual(await highlighted(page, "active"), ["Store --> Viewer"]);
});

test("only mermaid's own ES module build is served from /static/js/vendor/", async (t) => {
  const viewer = await startViewer({ files: { "flow.md": FLOW }, initial: "flow.md", port: 47465 });
  t.after(() => viewer.close());
  const get = async (p) => (await fetch(new URL(p, viewer.url))).status;
  assert.equal(await get("/static/js/vendor/mermaid/mermaid.esm.min.mjs"), 200);
  assert.equal(await get("/static/js/vendor/mermaid/mermaid.js"), 404);
  assert.equal(await get("/static/js/vendor/mermaid/../../../../package.json"), 404);
  assert.equal(await get("/static/js/vendor/mermaid/%2e%2e/package.json"), 404);
});
