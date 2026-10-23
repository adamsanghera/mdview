/** The document: loading and rendering it, its outline and breadcrumbs, and live reload. */
import { $, copyText, getJson, root } from "./dom.js";
import { ago, escapeHtml } from "./lib/format.js";
import { encodePath } from "./lib/paths.js";
import { updateScroll } from "./scroll.js";
import { expandAncestors, refreshTree, renderTree, revealActiveFile } from "./sidebar.js";
import { state } from "./state.js";
import { layoutTables } from "./tables.js";

const COPY_ICON = '<svg class="icon" aria-hidden="true"><use href="#i-copy"/></svg>';

const LIVE_ON = "Live reload: on. The page updates when the file changes.";

/**
 * Set by main.js, so this module need not know about comments. `leaving`
 * runs before another doc (or an error) replaces this one, `replaced` right
 * after the article's HTML changes, `loaded` once the doc is on screen, and
 * `commentsChanged` when the server reports a write to the comment store.
 * While `holdReload` returns true, a change to the file waits for
 * releaseReload instead of reloading the page.
 */
export const docHooks = { leaving() {}, replaced() {}, loaded() {}, commentsChanged() {}, holdReload: () => false };

let reloadWaiting = false;

function renderFrontMatter(text) {
  return `<details class="frontmatter"><summary>Front matter</summary><pre>${escapeHtml(text)}</pre></details>`;
}

function enhance(article) {
  for (const heading of article.querySelectorAll(":is(h1, h2, h3, h4, h5, h6)[id]")) {
    const link = document.createElement("a");
    link.className = "heading-anchor";
    link.href = `#${heading.id}`;
    link.textContent = "#";
    link.setAttribute("aria-hidden", "true");
    heading.prepend(link);
  }
  for (const pre of article.querySelectorAll("pre.code")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      if (await copyText(pre.querySelector("code").innerText)) {
        button.textContent = "Copied";
        setTimeout(() => (button.textContent = "Copy"), 1200);
      }
    });
    pre.append(button);
  }
  for (const img of article.querySelectorAll("img")) {
    img.addEventListener("click", () => window.open(img.src, "_blank", "noopener"));
  }
}

function renderToc(toc) {
  const items = toc.filter((h) => h.level >= 2 && h.id);
  root.classList.toggle("no-toc", items.length < 2);
  $("#toc").innerHTML = items
    .map((h) => `<a class="l${h.level}" href="#${escapeHtml(h.id)}" data-id="${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`)
    .join("");
  state.headings = items.map((h) => document.getElementById(h.id)).filter(Boolean);
}

function renderCrumbs(rel) {
  const parts = rel.split("/");
  const folders = [state.info?.rootName, ...parts.slice(0, -1)].filter(Boolean);
  const crumbs = $("#crumbs");
  crumbs.innerHTML =
    folders.map((p) => `<span>${escapeHtml(p)}</span><span class="sep">/</span>`).join("") +
    `<span class="here">${escapeHtml(parts.at(-1))}</span>` +
    COPY_ICON;
  crumbs.title = state.doc ? `Copy ${state.doc.abs}` : "";
  crumbs.setAttribute("aria-label", state.doc ? `Copy the file's absolute path, ${state.doc.abs}` : "");
}

export function renderMeta() {
  const doc = state.doc;
  if (!doc) return;
  $("#meta").textContent = `${doc.words.toLocaleString()} words · ${doc.minutes} min read · edited ${ago(doc.mtimeMs)}`;
}

export function showError(rel, err) {
  state.doc = null;
  docHooks.leaving();
  $("#doc").innerHTML = `<h1>Couldn't open this file</h1><p class="doc-error"><code>${escapeHtml(rel || "/")}</code>: ${escapeHtml(err.message)}</p>`;
  $("#toc").innerHTML = "";
  $("#meta").textContent = "";
  root.classList.add("no-toc");
}

export function scrollToHash(hash, behavior = "smooth") {
  if (!hash || hash === "#") return;
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // Use the raw fragment.
  }
  document.getElementById(id)?.scrollIntoView({ behavior, block: "start" });
}

function versionBanner(doc) {
  return `<div class="version-banner">You are reading v${doc.version.seq} of ${doc.version.latestSeq}, as it stood ${ago(doc.mtimeMs)}. Comments made after it are hidden. <a href="/view/${encodePath(doc.path)}">Back to the latest</a></div>`;
}

export async function loadDoc(rel, { keepScroll = false, hash = location.hash, version = state.viewVersion } = {}) {
  let doc;
  $("#versions-menu").hidden = true;
  try {
    doc = await getJson(`/api/doc?path=${encodeURIComponent(rel)}${version ? `&v=${version}` : ""}`);
  } catch (err) {
    showError(rel, err);
    return;
  }
  if (doc.raw !== undefined) {
    location.href = `/raw/${encodePath(doc.raw)}`;
    return;
  }

  const scrollY = window.scrollY;
  const sameDoc = state.doc?.path === doc.path;
  state.doc = doc;
  state.viewVersion = doc.old ? doc.version.seq : null;
  if (!sameDoc) {
    setReloadWaiting(false);
    docHooks.leaving();
  }
  const canonical = `/view/${encodePath(doc.path)}${state.viewVersion ? `?v=${state.viewVersion}` : ""}${hash || ""}`;
  if (location.pathname + location.search + location.hash !== canonical) history.replaceState(null, "", canonical);

  const article = $("#doc");
  article.innerHTML =
    (doc.old ? versionBanner(doc) : "") + (doc.frontMatter ? renderFrontMatter(doc.frontMatter) : "") + doc.html;
  docHooks.replaced();
  enhance(article);
  layoutTables();
  renderToc(doc.toc);
  renderCrumbs(doc.path);
  renderMeta();
  document.title = `${doc.title} · mdview`;
  $("#open-editor").href = `cursor://file${encodeURI(doc.abs)}`;

  expandAncestors(doc.path);
  renderTree();
  revealActiveFile();
  watch(doc.path);

  if (keepScroll) window.scrollTo(0, scrollY);
  else if (hash) scrollToHash(hash, "auto");
  else window.scrollTo(0, 0);
  updateScroll();
  docHooks.loaded();
}

function setReloadWaiting(waiting) {
  reloadWaiting = waiting;
  const live = $("#live");
  live.classList.toggle("held", waiting);
  if (waiting) live.title = "Live reload: waiting until you finish the comment you are writing";
  else if (live.classList.contains("on")) live.title = LIVE_ON;
}

/** Reloads the doc in place because its file changed, keeping the scroll position. */
export async function reloadDoc() {
  setReloadWaiting(false);
  await loadDoc(state.doc?.path ?? state.events.rel, { keepScroll: true });
  const live = $("#live");
  live.classList.remove("flash");
  void live.offsetWidth;
  live.classList.add("flash");
  refreshTree();
}

/** Applies a reload that waited on docHooks.holdReload, if one did. */
export function releaseReload() {
  if (reloadWaiting) reloadDoc();
}

function watch(rel) {
  if (state.events?.rel === rel) return;
  state.events?.source.close();
  const live = $("#live");
  live.classList.remove("on");
  const source = new EventSource(`/api/events?path=${encodeURIComponent(rel)}`);
  source.onopen = () => {
    live.classList.add("on");
    if (!reloadWaiting) live.title = LIVE_ON;
  };
  source.onerror = () => {
    live.classList.remove("on");
    live.title = "Live reload: reconnecting";
  };
  source.addEventListener("change", () => {
    if (docHooks.holdReload()) setReloadWaiting(true);
    else reloadDoc();
  });
  source.addEventListener("comments", () => docHooks.commentsChanged());
  state.events = { rel, source };
}
