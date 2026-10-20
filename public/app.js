const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const NARROW = matchMedia("(max-width: 820px)");
const PREFERS_DARK = matchMedia("(prefers-color-scheme: dark)");
const THEMES = ["auto", "light", "dark"];
const SPY_OFFSET_PX = 80;
const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';

const state = {
  info: null,
  files: [],
  doc: null,
  headings: [],
  events: null,
  expanded: new Set(readJson("mdview.expanded", [])),
};

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

function relFromPathname(pathname) {
  try {
    return pathname.replace(/^\/view\/?/, "").split("/").map(decodeURIComponent).join("/");
  } catch {
    return "";
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast("The browser blocked clipboard access");
    return false;
  }
}

function ago(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* Theme */

function applyTheme() {
  const pref = localStorage.getItem("mdview.theme") || "auto";
  const dark = pref === "dark" || (pref === "auto" && PREFERS_DARK.matches);
  root.dataset.theme = dark ? "dark" : "light";
  $("#hljs-light").disabled = dark;
  $("#hljs-dark").disabled = !dark;
  const button = $("#theme");
  button.dataset.pref = pref;
  button.title = `Theme: ${pref}. Click to change.`;
}

function cycleTheme() {
  const pref = localStorage.getItem("mdview.theme") || "auto";
  localStorage.setItem("mdview.theme", THEMES[(THEMES.indexOf(pref) + 1) % THEMES.length]);
  applyTheme();
}

/* Sidebar and file tree */

function toggleSidebar() {
  if (NARROW.matches) {
    root.classList.toggle("sidebar-open");
    return;
  }
  const hidden = root.classList.toggle("no-sidebar");
  localStorage.setItem("mdview.sidebar", hidden ? "hidden" : "shown");
}

function showSidebar() {
  if (NARROW.matches) root.classList.add("sidebar-open");
  else if (root.classList.contains("no-sidebar")) toggleSidebar();
}

function buildTree(files) {
  const top = { dirs: new Map(), files: [] };
  for (const file of files) {
    let node = top;
    for (const dir of file.split("/").slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push(file);
  }
  return top;
}

function renderNode(node, prefix, expandAll) {
  const list = document.createElement("ul");
  for (const [name, child] of node.dirs) {
    const dirPath = prefix ? `${prefix}/${name}` : name;
    const open = expandAll || state.expanded.has(dirPath);
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "dir-label";
    button.setAttribute("aria-expanded", String(open));
    button.innerHTML = `${CHEVRON}<span>${escapeHtml(name)}</span>`;
    button.addEventListener("click", () => {
      if (state.expanded.has(dirPath)) state.expanded.delete(dirPath);
      else state.expanded.add(dirPath);
      saveExpanded();
      renderTree();
    });
    item.append(button);
    if (open) item.append(renderNode(child, dirPath, expandAll));
    list.append(item);
  }
  for (const file of node.files) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "file";
    link.href = `/view/${encodePath(file)}`;
    link.title = file;
    link.dataset.path = file;
    link.textContent = file.split("/").pop().replace(/\.(md|markdown|mdx)$/i, "");
    if (file === state.doc?.path) link.classList.add("active");
    item.append(link);
    list.append(item);
  }
  return list;
}

function renderTree() {
  const query = $("#filter").value.trim().toLowerCase();
  const files = query ? state.files.filter((f) => f.toLowerCase().includes(query)) : state.files;
  const nav = $("#tree");
  if (!files.length) {
    nav.innerHTML = `<div class="tree-empty">${query ? "No matching files" : "No Markdown files here"}</div>`;
    return;
  }
  nav.replaceChildren(renderNode(buildTree(files), "", Boolean(query)));
}

function saveExpanded() {
  localStorage.setItem("mdview.expanded", JSON.stringify([...state.expanded]));
}

/** Folders start collapsed. Opening a document expands the folders above it. */
function expandAncestors(rel) {
  const parts = rel.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) state.expanded.add(parts.slice(0, i).join("/"));
  saveExpanded();
}

function revealActiveFile() {
  const active = $("#tree .file.active");
  const box = $("#sidebar");
  if (!active) return;
  const top = active.offsetTop;
  if (top < box.scrollTop || top + active.offsetHeight > box.scrollTop + box.clientHeight) {
    box.scrollTop = top - box.clientHeight / 3;
  }
}

async function refreshTree() {
  try {
    state.files = (await getJson("/api/tree")).files;
    renderTree();
  } catch {
    // The server may be restarting. The next focus or change retries.
  }
}

/* Document */

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
    `<span class="here">${escapeHtml(parts.at(-1))}</span>`;
  crumbs.title = state.doc?.abs ?? "";
}

function renderMeta() {
  const doc = state.doc;
  if (!doc) return;
  $("#meta").textContent = `${doc.words.toLocaleString()} words · ${doc.minutes} min read · edited ${ago(doc.mtimeMs)}`;
}

function showError(rel, err) {
  state.doc = null;
  $("#doc").innerHTML = `<h1>Couldn't open this file</h1><p class="doc-error"><code>${escapeHtml(rel || "/")}</code>: ${escapeHtml(err.message)}</p>`;
  $("#toc").innerHTML = "";
  $("#meta").textContent = "";
  root.classList.add("no-toc");
}

function scrollToHash(hash, behavior = "smooth") {
  if (!hash || hash === "#") return;
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // Use the raw fragment.
  }
  document.getElementById(id)?.scrollIntoView({ behavior, block: "start" });
}

async function loadDoc(rel, { keepScroll = false, hash = location.hash } = {}) {
  let doc;
  try {
    doc = await getJson(`/api/doc?path=${encodeURIComponent(rel)}`);
  } catch (err) {
    showError(rel, err);
    return;
  }
  if (doc.raw !== undefined) {
    location.href = `/raw/${encodePath(doc.raw)}`;
    return;
  }

  const scrollY = window.scrollY;
  state.doc = doc;
  const canonical = `/view/${encodePath(doc.path)}${hash || ""}`;
  if (location.pathname + location.hash !== canonical) history.replaceState(null, "", canonical);

  const article = $("#doc");
  article.innerHTML = (doc.frontMatter ? renderFrontMatter(doc.frontMatter) : "") + doc.html;
  enhance(article);
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
}

/* Live reload */

function watch(rel) {
  if (state.events?.rel === rel) return;
  state.events?.source.close();
  const live = $("#live");
  live.classList.remove("on");
  const source = new EventSource(`/api/events?path=${encodeURIComponent(rel)}`);
  source.onopen = () => {
    live.classList.add("on");
    live.title = "Live reload: on. The page updates when the file changes.";
  };
  source.onerror = () => {
    live.classList.remove("on");
    live.title = "Live reload: reconnecting";
  };
  source.addEventListener("change", async () => {
    await loadDoc(state.doc?.path ?? rel, { keepScroll: true });
    live.classList.remove("flash");
    void live.offsetWidth;
    live.classList.add("flash");
    refreshTree();
  });
  state.events = { rel, source };
}

/* Navigation */

function navigate(url) {
  const rel = relFromPathname(url.pathname);
  if (rel === state.doc?.path) {
    history.pushState(null, "", url.hash || url.pathname);
    scrollToHash(url.hash);
    return;
  }
  history.pushState(null, "", url.pathname + url.hash);
  root.classList.remove("sidebar-open");
  loadDoc(rel, { hash: url.hash });
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest("a[href]");
  if (!link || link.target === "_blank") return;
  if (link.classList.contains("outside-root")) {
    event.preventDefault();
    toast(link.title);
    return;
  }
  const url = new URL(link.getAttribute("href"), location.href);
  if (url.origin === location.origin && url.pathname.startsWith("/view")) {
    event.preventDefault();
    navigate(url);
  }
});

addEventListener("popstate", () => {
  const rel = relFromPathname(location.pathname);
  if (rel === state.doc?.path) scrollToHash(location.hash);
  else loadDoc(rel);
});

/* Scroll: reading progress and the current section */

let scrollQueued = false;
function updateScroll() {
  scrollQueued = false;
  const max = root.scrollHeight - innerHeight;
  $("#progress").style.setProperty("--p", max > 0 ? `${Math.min(100, (scrollY / max) * 100)}%` : "0%");

  let current = null;
  for (const heading of state.headings) {
    if (heading.getBoundingClientRect().top - SPY_OFFSET_PX <= 0) current = heading;
    else break;
  }
  if (max > 0 && scrollY >= max - 2) current = state.headings.at(-1) ?? current;
  let activeLink = null;
  for (const link of document.querySelectorAll("#toc a")) {
    const active = link.dataset.id === current?.id;
    link.classList.toggle("active", active);
    if (active) activeLink = link;
  }
  const pane = $("#toc-pane");
  if (activeLink && (activeLink.offsetTop < pane.scrollTop || activeLink.offsetTop > pane.scrollTop + pane.clientHeight - 40)) {
    pane.scrollTop = activeLink.offsetTop - pane.clientHeight / 3;
  }
}

addEventListener(
  "scroll",
  () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(updateScroll);
  },
  { passive: true },
);
addEventListener("resize", updateScroll);

/* Keyboard */

addEventListener("keydown", (event) => {
  const typing = event.target.matches("input, textarea, select, [contenteditable]");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    showSidebar();
    $("#filter").focus();
    $("#filter").select();
  } else if (event.key === "\\" && !typing) {
    event.preventDefault();
    toggleSidebar();
  } else if (event.target === $("#filter")) {
    if (event.key === "Escape") {
      $("#filter").value = "";
      renderTree();
      $("#filter").blur();
    } else if (event.key === "Enter") {
      const first = $("#tree .file");
      if (first) {
        $("#filter").blur();
        navigate(new URL(first.href));
      }
    }
  }
});

/* Start */

async function init() {
  applyTheme();
  PREFERS_DARK.addEventListener("change", applyTheme);
  $("#theme").addEventListener("click", cycleTheme);
  $("#toggle-sidebar").addEventListener("click", toggleSidebar);
  $("#filter").addEventListener("input", renderTree);
  $("#copy-md").addEventListener("click", async () => {
    if (!state.doc) return;
    const res = await fetch(`/raw/${encodePath(state.doc.path)}`, { cache: "no-store" });
    if (await copyText(await res.text())) toast("Copied the Markdown");
  });
  addEventListener("focus", refreshTree);
  setInterval(renderMeta, 30_000);

  try {
    const [info, tree] = await Promise.all([getJson("/api/info"), getJson("/api/tree")]);
    state.info = info;
    state.files = tree.files;
  } catch (err) {
    showError("", err);
    return;
  }
  renderTree();
  await loadDoc(relFromPathname(location.pathname));
}

init();
