/**
 * Draws ```mermaid blocks as diagrams. Each block's source stays in the page,
 * folded under its diagram, so comments on it keep their anchor. The library
 * is large, so it loads only once a doc has a diagram.
 */
import { $, root } from "./dom.js";
import { scheduleScrollUpdate } from "./scroll.js";

const LIBRARY = "/static/js/vendor/mermaid.min.js";
const THEMES = { light: "default", dark: "dark" };

// Keyed by theme and source, so live reload puts back an unchanged diagram at once, and the page does not jump.
const drawn = new Map();
let library;
let nextId = 0;

function loadLibrary() {
  library ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LIBRARY;
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => {
      library = null;
      reject(new Error("The diagram library did not load."));
    };
    document.head.append(script);
  });
  return library;
}

const keyOf = (source) => `${root.dataset.theme}\n${source}`;

/**
 * Wraps each mermaid block in a figure, with its source in a closed toggle
 * below. Runs synchronously, before comment ranges are taken, since moving a
 * node later would collapse any range inside it.
 */
export function prepareDiagrams(article) {
  for (const pre of article.querySelectorAll('pre.code[data-lang="mermaid"]')) {
    const block = document.createElement("div");
    block.className = "mermaid-block";
    const figure = document.createElement("figure");
    figure.className = "mermaid-diagram";
    figure.dataset.source = pre.querySelector("code").textContent;
    const toggle = document.createElement("details");
    toggle.className = "mermaid-source";
    const summary = document.createElement("summary");
    summary.textContent = "Mermaid source";
    pre.replaceWith(block);
    toggle.append(summary, pre);
    block.append(figure, toggle);
    const svg = drawn.get(keyOf(figure.dataset.source));
    if (svg) figure.innerHTML = svg;
  }
}

function showFailure(figure, err) {
  figure.classList.add("failed");
  figure.textContent = `This diagram did not render. ${err?.message ?? err}`;
  figure.nextElementSibling.open = true;
}

/** Renders every prepared figure in `article` that has no diagram yet. */
export async function drawDiagrams(article) {
  const figures = [...article.querySelectorAll("figure.mermaid-diagram")].filter((f) => !f.querySelector("svg"));
  if (!figures.length) return;
  let mermaid;
  try {
    mermaid = await loadLibrary();
  } catch (err) {
    for (const figure of figures) showFailure(figure, err);
    return;
  }
  const theme = root.dataset.theme;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: THEMES[theme] ?? "default" });
  for (const figure of figures) {
    const source = figure.dataset.source;
    try {
      const { svg } = await mermaid.render(`mermaid-${++nextId}`, source);
      drawn.set(`${theme}\n${source}`, svg);
      if (!figure.isConnected || root.dataset.theme !== theme) continue;
      figure.classList.remove("failed");
      figure.innerHTML = svg;
    } catch (err) {
      if (figure.isConnected) showFailure(figure, err);
    }
  }
  scheduleScrollUpdate();
}

/** Redraws the doc's diagrams in the other palette when the theme changes. */
export function watchDiagramTheme() {
  new MutationObserver(() => {
    const article = $("#doc");
    for (const figure of article.querySelectorAll("figure.mermaid-diagram")) {
      const svg = drawn.get(keyOf(figure.dataset.source));
      figure.classList.remove("failed");
      figure.innerHTML = svg ?? "";
    }
    drawDiagrams(article);
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}
