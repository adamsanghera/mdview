/**
 * Draws ```mermaid fences as diagrams. The server renders a fence as code,
 * like any other; this swaps it for a figure that holds the diagram, with the
 * source kept below it in a closed toggle. The figure takes over the fence's
 * data-block, so comments still anchor to the source text, and the drawn SVG
 * is a decoration that comments skip.
 *
 * Mermaid is large, so it loads only once a doc has a diagram. It is served
 * from /static/js/vendor/, so the page's Content-Security-Policy still runs
 * only mdview's own scripts. Its strict security level escapes HTML in
 * labels and turns off click handlers.
 */
import { root } from "./dom.js";

const MODULE = "/static/js/vendor/mermaid/mermaid.esm.min.mjs";

let loading = null;
let queue = Promise.resolve();
let drawn = 0;

function load() {
  loading ??= import(MODULE).then((module) => module.default);
  return loading;
}

function theme() {
  return root.dataset.theme === "dark" ? "dark" : "default";
}

/** Wraps each mermaid fence in `article` in a figure, synchronously, and returns the figures. */
function prepare(article) {
  const figures = [];
  for (const pre of article.querySelectorAll('pre.code[data-lang="mermaid"]')) {
    if (pre.closest("figure.mermaid")) continue;
    const figure = document.createElement("figure");
    figure.className = "mermaid";
    if (pre.dataset.block !== undefined) {
      figure.dataset.block = pre.dataset.block;
      delete pre.dataset.block;
    }
    const diagram = document.createElement("div");
    diagram.className = "mermaid-svg";
    diagram.setAttribute("role", "img");
    diagram.setAttribute("aria-label", "Diagram");
    const source = document.createElement("details");
    source.className = "mermaid-source";
    const summary = document.createElement("summary");
    summary.textContent = "Source";
    pre.replaceWith(figure);
    source.append(summary, pre);
    figure.append(diagram, source);
    figures.push(figure);
  }
  return figures;
}

async function draw(figure) {
  const diagram = figure.querySelector(":scope > .mermaid-svg");
  const code = figure.querySelector(".mermaid-source code")?.textContent ?? "";
  try {
    const mermaid = await load();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme() });
    const { svg } = await mermaid.render(`mermaid-${++drawn}`, code);
    if (!figure.isConnected) return;
    diagram.innerHTML = svg;
    figure.classList.remove("mermaid-failed");
  } catch (err) {
    if (!figure.isConnected) return;
    diagram.textContent = `Couldn't draw this diagram: ${err?.message ?? err}`;
    figure.classList.add("mermaid-failed");
  }
}

/** Mermaid draws one diagram at a time, so draws wait in line. */
function enqueue(figures) {
  for (const figure of figures) queue = queue.then(() => draw(figure));
  return queue;
}

/** Turns the mermaid fences in `article` into diagrams. The returned promise settles once they are drawn. */
export function renderDiagrams(article) {
  return enqueue(prepare(article));
}

/** Redraws every diagram when the theme flips between light and dark. */
export function watchDiagramTheme(article) {
  new MutationObserver(() => enqueue([...article.querySelectorAll("figure.mermaid")])).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}
