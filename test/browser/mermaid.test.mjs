import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { HUMAN, startViewer } from "../helpers/viewer.mjs";
import { click } from "../helpers/viewer-page.mjs";

// Shaped like a spec: front matter, prose, and the diagram kinds specs reach for.
const SPEC = `---
status: draft
---
# Spec-driven bot loop

## Loop

\`\`\`mermaid
flowchart TD
  spec[Spec in the vault] --> bot{Bot picks it up}
  bot -->|plan| pr[Opens a PR]
  pr --> review[Human reviews]
  review -->|comments| bot
\`\`\`

## Handoff

\`\`\`mermaid
sequenceDiagram
  participant H as Human
  participant B as Bot
  H->>B: Approves the spec
  B-->>H: Draft PR
\`\`\`

## States

\`\`\`mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Review
  Review --> Done
\`\`\`

The end.
`;

const BROKEN = `# Broken

\`\`\`mermaid
flowchart TD
  a --> (((
\`\`\`
`;

const chrome = sharedChrome();

/** A viewer on `files` and a tab that records every Content-Security-Policy violation from its first script on. */
async function setup(t, files, initial) {
  const viewer = await startViewer({ files, initial, port: 47460 });
  t.after(() => viewer.close());
  const page = await (await chrome()).open("about:blank");
  t.after(() => page.close());
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.violations = []; addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective + " " + e.blockedURI));`,
  });
  await page.goto(viewer.url);
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  return { viewer, page };
}

test("mermaid blocks render as diagrams under the strict policy, with their source folded below", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { "spec.md": SPEC }, "spec.md");

  await page.waitFor(() => document.querySelectorAll("#doc figure.mermaid-diagram svg").length === 3, {
    what: "three diagrams",
    timeout: 15000,
  });
  const result = await page.eval(() => ({
    kinds: [...document.querySelectorAll("#doc figure.mermaid-diagram svg")].map((svg) => svg.getAttribute("aria-roledescription")),
    labels: document.querySelector("#doc figure.mermaid-diagram svg").textContent,
    sources: [...document.querySelectorAll("#doc details.mermaid-source")].map((d) => ({
      open: d.open,
      block: d.querySelector("pre.code[data-lang=mermaid]")?.dataset.block ?? null,
    })),
    violations: window.violations,
    scripts: [...document.scripts].map((s) => new URL(s.src).pathname),
  }));

  assert.deepEqual(result.kinds, ["flowchart-v2", "sequence", "stateDiagram"]);
  assert.match(result.labels, /Bot picks it up/);
  assert.equal(result.sources.length, 3);
  for (const source of result.sources) {
    assert.equal(source.open, false);
    assert.notEqual(source.block, null);
  }
  assert.deepEqual(result.violations, []);
  assert.ok(result.scripts.every((p) => p.startsWith("/static/js/")), result.scripts.join());
});

test("a diagram that does not parse says so and shows its source", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { "broken.md": BROKEN }, "broken.md");

  await page.waitFor(() => document.querySelector("#doc figure.mermaid-diagram.failed"), { what: "the failure", timeout: 15000 });
  const result = await page.eval(() => ({
    text: document.querySelector("#doc figure.mermaid-diagram").textContent,
    open: document.querySelector("#doc details.mermaid-source").open,
    strays: document.querySelectorAll("body > :not(header, .layout, .progress, .toast, .comment-btn, .composer, .versions-menu, svg[hidden], script)").length,
  }));
  assert.match(result.text, /did not render/);
  assert.equal(result.open, true);
  assert.equal(result.strays, 0);
});

test("switching the theme redraws diagrams, and live reload keeps them without a flash", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t, { "spec.md": SPEC }, "spec.md");
  const diagrams = () => [...document.querySelectorAll("#doc figure.mermaid-diagram svg")].map((svg) => svg.outerHTML.replace(/mermaid-\d+/g, ""));
  await page.waitFor(() => document.querySelectorAll("#doc figure.mermaid-diagram svg").length === 3, { what: "diagrams", timeout: 15000 });
  const light = await page.eval(diagrams);

  while ((await page.eval(() => document.documentElement.dataset.theme)) !== "dark") await click(page, "#theme");
  await page.waitFor(
    (before) => {
      const now = [...document.querySelectorAll("#doc figure.mermaid-diagram svg")].map((svg) => svg.outerHTML.replace(/mermaid-\d+/g, ""));
      return now.length === 3 && now.every((html, i) => html !== before[i]);
    },
    { what: "the dark redraw" },
    light,
  );

  await viewer.write("spec.md", SPEC.replace("The end.", "The end, edited."));
  await page.waitFor(() => document.querySelector("#doc").textContent.includes("The end, edited."), { what: "the reload" });
  // Synchronously after the reload replaced the article, so the diagrams came back from the cache.
  assert.equal(await page.eval(() => document.querySelectorAll("#doc figure.mermaid-diagram svg").length), 3);
});

test("a comment on a diagram's source still highlights its quote there", { skip: chromeMissing }, async (t) => {
  const { page, viewer } = await setup(t, { "spec.md": SPEC }, "spec.md");
  const file = viewer.file("spec.md");
  viewer.store.createThread({ file, content: fs.readFileSync(file, "utf8"), quote: "Bot picks it up", body: "Which bot?", author: HUMAN });
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 1, { what: "the highlight", timeout: 10000 });
  const text = await page.eval(() => [...CSS.highlights.get("mdview-comment-open")][0].toString());
  assert.equal(text, "Bot picks it up");
});
