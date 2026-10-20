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
  comments: {
    enabled: false,
    threads: [],
    version: null,
    ranges: new Map(),
    active: null,
    listMode: false,
    drafts: new Map(),
    pending: null,
    composerDraft: "",
  },
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
  onLayoutChange();
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
  resetComments();
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
  const sameDoc = state.doc?.path === doc.path;
  state.doc = doc;
  if (!sameDoc) resetComments();
  const canonical = `/view/${encodePath(doc.path)}${hash || ""}`;
  if (location.pathname + location.hash !== canonical) history.replaceState(null, "", canonical);

  const article = $("#doc");
  article.innerHTML = (doc.frontMatter ? renderFrontMatter(doc.frontMatter) : "") + doc.html;
  forgetRanges();
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
  loadComments();
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
  source.addEventListener("comments", loadComments);
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
addEventListener("resize", onLayoutChange);

/* Keyboard */

addEventListener("keydown", (event) => {
  const typing = event.target.matches("input, textarea, select, [contenteditable]");
  // Notion's ⌘⇧M, or Google Docs' ⌘⌥M where the browser keeps ⌘⇧M for itself.
  if ((event.metaKey || event.ctrlKey) && event.code === "KeyM" && (event.shiftKey || event.altKey)) {
    event.preventDefault();
    openComposer();
  } else if (event.key === "Escape" && !typing) {
    if (!closeComposer() && !deactivate()) root.classList.remove("drawer-open");
  } else if (event.key === "/" && !typing) {
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

/* Comments */

// RAIL_WIDTH_PX and RAIL_GAP_PX must match .rail-docked in style.css.
const RAIL_WIDTH_PX = 300;
const RAIL_GAP_PX = 24;
const CARD_GAP_PX = 10;
const DECORATIONS = ".heading-anchor, .code-copy";
const HIGHLIGHTS =
  "highlights" in CSS
    ? { open: new Highlight(), suggested: new Highlight(), active: new Highlight(), pending: new Highlight() }
    : null;

// The list view's sections, in order. Each thread goes in the first one that takes it.
const GROUPS = [
  ["Waiting on you", (t) => t.status !== "resolved" && t.state !== "outdated" && t.waitingOn === "human"],
  ["Waiting on the agent", (t) => t.status !== "resolved" && t.state !== "outdated"],
  ["On older versions", (t) => t.status !== "resolved"],
  ["Resolved", () => true],
];

if (HIGHLIGHTS) {
  HIGHLIGHTS.active.priority = 1;
  HIGHLIGHTS.pending.priority = 1;
  for (const [name, highlight] of Object.entries(HIGHLIGHTS)) CSS.highlights.set(`mdview-comment-${name}`, highlight);
}

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

function threadById(id) {
  return state.comments.threads.find((t) => t.id === id);
}

function autosize(input) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + 2}px`;
}

/* Comments: between DOM selections and a block's text */

function blockAt(node) {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const block = el?.closest("[data-block]");
  return block && $("#doc").contains(block) ? block : null;
}

/** A block's own text nodes, leaving out mdview's decorations and any nested block. */
function ownTextNodes(block) {
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement.closest("[data-block]") === block && !node.parentElement.closest(DECORATIONS)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

/** The character offset of a DOM point within the concatenated text of `nodes`. */
function textOffset(nodes, container, offset) {
  const point = document.createRange();
  point.setStart(container, offset);
  let total = 0;
  for (const node of nodes) {
    if (node === container) return total + offset;
    if (point.comparePoint(node, node.length) > 0) break;
    total += node.length;
  }
  return total;
}

function domPoint(nodes, offset) {
  for (const node of nodes) {
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
  }
  const last = nodes.at(-1);
  return [last, last.length];
}

/**
 * Finds `quote` in `text`, treating any run of whitespace as one space, so a
 * reflowed paragraph still matches. Picks the occurrence nearest `hint`.
 * Returns [start, end) offsets into `text`, or null.
 */
function findQuote(text, quote, hint) {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  let flat = "";
  const from = [];
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]);
    if (space && flat.endsWith(" ")) continue;
    flat += space ? " " : text[i];
    from.push(i);
  }
  let best = null;
  for (let at = flat.indexOf(needle); at !== -1; at = flat.indexOf(needle, at + 1)) {
    const span = [from[at], from[at + needle.length - 1] + 1];
    if (!best || Math.abs(span[0] - hint) < Math.abs(best[0] - hint)) best = span;
  }
  return best;
}

/** What the server needs to anchor a selection: its block, the quote trimmed to that block, and its offset. */
function anchorFromRange(range) {
  const block = blockAt(range.startContainer);
  if (!block) return null;
  const nodes = ownTextNodes(block);
  const text = nodes.map((n) => n.data).join("");
  const start = textOffset(nodes, range.startContainer, range.startOffset);
  const end = block.contains(range.endContainer) ? textOffset(nodes, range.endContainer, range.endOffset) : text.length;
  const raw = text.slice(start, end);
  const quote = raw.trim();
  if (!quote) return null;
  return { blockIndex: Number(block.dataset.block), quote, start: start + raw.length - raw.trimStart().length };
}

/** The Range a thread highlights: its quote inside its block, or the whole block when the quote is not there. */
function rangeFor(thread) {
  const block = $(`#doc [data-block="${thread.blockIndex}"]`);
  const nodes = block ? ownTextNodes(block) : [];
  if (!nodes.length) return null;
  const text = nodes.map((n) => n.data).join("");
  const [start, end] = findQuote(text, thread.quote, thread.start) ?? [0, text.length];
  const range = document.createRange();
  range.setStart(...domPoint(nodes, start));
  range.setEnd(...domPoint(nodes, end));
  return range;
}

function threadAtPoint(x, y) {
  let node;
  let offset;
  if (document.caretPositionFromPoint) {
    ({ offsetNode: node, offset } = document.caretPositionFromPoint(x, y) ?? {});
  } else {
    ({ startContainer: node, startOffset: offset } = document.caretRangeFromPoint?.(x, y) ?? {});
  }
  if (!node) return null;
  for (const [id, range] of state.comments.ranges) {
    if (range.isPointInRange(node, offset)) return id;
  }
  return null;
}

/* Comments: loading and drawing */

async function loadComments() {
  const comments = state.comments;
  const doc = state.doc;
  if (!comments.enabled || !doc) return;
  let data;
  try {
    data = await getJson(`/api/comments?path=${encodeURIComponent(doc.path)}&sha=${doc.sha}`);
  } catch {
    return; // The server may be restarting. The next live-reload event retries.
  }
  if (state.doc !== doc) return;
  comments.threads = data.threads;
  comments.version = data.version;
  renderComments();
}

function resetComments() {
  const comments = state.comments;
  closeComposer();
  comments.threads = [];
  comments.version = null;
  comments.active = null;
  comments.drafts.clear();
  root.classList.remove("drawer-open");
  renderComments();
}

/** Drops highlights that point into a document that was just replaced. */
function forgetRanges() {
  state.comments.ranges = new Map();
  paintHighlights();
}

function renderComments() {
  const comments = state.comments;
  comments.ranges = new Map();
  for (const thread of comments.threads) {
    if (thread.blockIndex === null || thread.status === "resolved") continue;
    const range = rangeFor(thread);
    if (range) comments.ranges.set(thread.id, range);
  }
  if (comments.active !== null && !threadById(comments.active)) comments.active = null;
  updateRailMode();
  renderCommentChrome();
  renderRail();
  paintHighlights();
}

function paintHighlights() {
  if (!HIGHLIGHTS) return;
  for (const highlight of Object.values(HIGHLIGHTS)) highlight.clear();
  const comments = state.comments;
  for (const [id, range] of comments.ranges) {
    HIGHLIGHTS[threadById(id)?.status === "suggested" ? "suggested" : "open"].add(range);
    if (id === comments.active) HIGHLIGHTS.active.add(range);
  }
  if (comments.pending) HIGHLIGHTS.pending.add(comments.pending.range);
}

function renderCommentChrome() {
  const comments = state.comments;
  const unresolved = comments.threads.filter((t) => t.status !== "resolved");
  const waiting = unresolved.filter((t) => t.waitingOn === "human").length;
  const button = $("#comments-btn");
  button.hidden = !comments.threads.length;
  button.classList.toggle("attention", waiting > 0);
  button.title = `${unresolved.length} unresolved, ${waiting} waiting on you`;
  $("#comments-count").textContent = unresolved.length || "";
  const chip = $("#version");
  chip.hidden = !comments.version;
  if (comments.version) {
    chip.textContent = `v${comments.version.seq}`;
    chip.title = `Version ${comments.version.seq} of this doc. Each comment remembers the version it was made on.`;
  }
}

/** Docks the rail beside the doc when there is room for both. Otherwise it opens as a drawer. */
function updateRailMode() {
  const comments = state.comments;
  root.classList.toggle("has-comments", comments.threads.length > 0);
  const wanted = comments.listMode || comments.threads.some((t) => t.status !== "resolved");
  const docWidth = parseFloat(getComputedStyle($("#doc")).maxWidth);
  const docked = wanted && $(".content").clientWidth >= docWidth + RAIL_WIDTH_PX + RAIL_GAP_PX;
  root.classList.toggle("rail-docked", docked);
  if (docked) root.classList.remove("drawer-open");
}

function onLayoutChange() {
  if (!state.comments.threads.length) return;
  const wasDocked = root.classList.contains("rail-docked");
  updateRailMode();
  if (root.classList.contains("rail-docked") !== wasDocked) renderRail();
  else scheduleLayout();
}

function threadChips(t) {
  const chips = [];
  if (t.status === "suggested") chips.push('<span class="chip chip-suggested">Agent suggests resolving</span>');
  if (t.status === "resolved") chips.push('<span class="chip">Resolved</span>');
  if (t.state === "carried") {
    chips.push(`<span class="chip" title="Made on v${t.madeOn.seq}. Its text has not changed since.">from v${t.madeOn.seq}</span>`);
  }
  if (t.state === "outdated") {
    chips.push(`<span class="chip chip-outdated" title="Its text changed after v${t.madeOn.seq}.">outdated · made on v${t.madeOn.seq}</span>`);
  }
  return chips.join("");
}

function messageItem(m) {
  const time = Date.parse(m.createdAt);
  const badge = m.authorKind === "agent" ? '<span class="badge">agent</span>' : "";
  return `<li class="message" data-kind="${m.authorKind}">
    <div class="message-meta"><span class="author">${escapeHtml(m.author)}</span>${badge}<span class="when" title="${escapeHtml(new Date(time).toLocaleString())}">${ago(time)} · v${m.versionSeq}</span></div>
    <div class="message-body">${m.bodyHtml}</div>
  </li>`;
}

function threadControls(t) {
  const placeholder = t.status === "suggested" ? "Reply and reopen…" : "Reply…";
  const reopen = t.status === "open" ? "" : '<button class="btn" type="button" data-action="open">Reopen</button>';
  const resolve = t.status === "resolved" ? "" : '<button class="btn btn-primary" type="button" data-action="resolved">Resolve</button>';
  return `<textarea class="reply" rows="1" placeholder="${placeholder}" aria-label="Reply"></textarea>
    <div class="thread-actions">${reopen}${resolve}</div>`;
}

/** A thread card. Collapsed cards show the first and last messages; the open card shows all of them and its controls. */
function threadCard(t, expanded) {
  const shown = expanded || t.messages.length <= 2 ? t.messages : [t.messages[0], t.messages.at(-1)];
  const items = shown.map(messageItem);
  const hidden = t.messages.length - shown.length;
  if (hidden) items.splice(1, 0, `<li class="message more">${hidden} more</li>`);
  const quote = t.quote ? `<blockquote class="thread-quote">${escapeHtml(t.quote)}</blockquote>` : "";
  return `<section class="thread${expanded ? " expanded" : ""}" data-thread="${t.id}" data-status="${t.status}">
    <header class="thread-head"><span class="thread-id">#${t.id}</span>${threadChips(t)}</header>
    ${quote}
    <ol class="messages">${items.join("")}</ol>
    ${expanded ? threadControls(t) : ""}
  </section>`;
}

function railHead(listing, docked) {
  const unresolved = state.comments.threads.filter((t) => t.status !== "resolved");
  const older = unresolved.filter((t) => t.state === "outdated").length;
  const olderLink = older && !listing ? ` · <button class="link" data-action="list">${older} on older versions</button>` : "";
  const toggle = docked
    ? `<button class="link" data-action="list">${listing ? "Show in margin" : "All comments"}</button>`
    : '<button class="link" data-action="close">Close</button>';
  return `<div class="rail-head"><span>${unresolved.length} unresolved${olderLink}</span>${toggle}</div>`;
}

function railCards() {
  const comments = state.comments;
  return comments.threads
    .filter((t) => comments.ranges.has(t.id))
    .map((t) => threadCard(t, t.id === comments.active))
    .join("");
}

function railList() {
  const comments = state.comments;
  const groups = GROUPS.map(([title]) => ({ title, threads: [] }));
  for (const thread of comments.threads) groups[GROUPS.findIndex(([, takes]) => takes(thread))].threads.push(thread);
  const html = groups
    .filter((g) => g.threads.length)
    .map(
      (g) =>
        `<h3 class="rail-group">${g.title} <span>${g.threads.length}</span></h3>` +
        g.threads.map((t) => threadCard(t, t.id === comments.active)).join(""),
    )
    .join("");
  return html || '<p class="rail-empty">No comments on this doc yet. Select some text to add one.</p>';
}

function renderRail() {
  const comments = state.comments;
  const rail = $("#rail");
  const docked = root.classList.contains("rail-docked");
  const listing = comments.listMode || !docked;
  const focused = document.activeElement?.closest?.("#rail .thread")?.dataset.thread;
  rail.classList.toggle("listing", listing);
  rail.style.minHeight = "";
  rail.innerHTML = railHead(listing, docked) + (listing ? railList() : railCards());
  for (const input of rail.querySelectorAll("textarea.reply")) {
    input.value = comments.drafts.get(Number(input.closest(".thread").dataset.thread)) ?? "";
    autosize(input);
  }
  const refocus = focused && rail.querySelector(`.thread[data-thread="${focused}"] textarea`);
  if (refocus) {
    refocus.focus({ preventScroll: true });
    refocus.setSelectionRange(refocus.value.length, refocus.value.length);
  }
  if (!listing) layoutRail();
}

/**
 * Sets each margin card level with its highlight. The open card sits exactly
 * at its highlight. Cards below it stack downward and cards above it stack
 * upward, so none overlap; if that pushes the top card past the rail's
 * header, every card shifts down together.
 */
function layoutRail() {
  const rail = $("#rail");
  if (rail.classList.contains("listing")) return;
  const railTop = rail.getBoundingClientRect().top;
  const head = rail.querySelector(".rail-head");
  const minTop = head ? head.offsetTop + head.offsetHeight + CARD_GAP_PX : 0;
  const items = [...rail.querySelectorAll(".thread")]
    .map((card) => {
      const range = state.comments.ranges.get(Number(card.dataset.thread));
      return range && { card, target: range.getBoundingClientRect().top - railTop, height: card.offsetHeight };
    })
    .filter(Boolean)
    .sort((a, b) => a.target - b.target);
  if (!items.length) return;

  const pivot = Math.max(0, items.findIndex((item) => item.card.classList.contains("expanded")));
  items[pivot].top = Math.max(items[pivot].target, minTop);
  for (let i = pivot + 1; i < items.length; i++) {
    const above = items[i - 1];
    items[i].top = Math.max(items[i].target, above.top + above.height + CARD_GAP_PX);
  }
  for (let i = pivot - 1; i >= 0; i--) {
    const below = items[i + 1];
    items[i].top = Math.min(items[i].target, below.top - CARD_GAP_PX - items[i].height);
  }
  const shift = Math.max(0, minTop - items[0].top);
  for (const item of items) item.card.style.top = `${item.top + shift}px`;
  const last = items.at(-1);
  rail.style.minHeight = `${last.top + shift + last.height}px`;
}

let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutRail();
  });
}

/* Comments: actions */

function activate(id, { scroll = false } = {}) {
  const comments = state.comments;
  comments.active = id;
  if (!root.classList.contains("rail-docked")) root.classList.add("drawer-open");
  renderRail();
  paintHighlights();
  const range = comments.ranges.get(id);
  if (scroll && range) {
    const rect = range.getBoundingClientRect();
    if (rect.top < SPY_OFFSET_PX || rect.bottom > innerHeight) scrollBy({ top: rect.top - innerHeight / 3, behavior: "smooth" });
  }
  if ($("#rail").classList.contains("listing")) $(`#rail .thread[data-thread="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

function deactivate() {
  if (state.comments.active === null) return false;
  state.comments.active = null;
  renderRail();
  paintHighlights();
  return true;
}

async function setThreadStatus(id, status) {
  try {
    await postJson(`/api/comments/${id}/status`, { status });
    if (status === "resolved" && state.comments.active === id) state.comments.active = null;
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

async function sendReply(input) {
  const id = Number(input.closest(".thread").dataset.thread);
  const body = input.value.trim();
  if (!body) return;
  input.disabled = true;
  try {
    await postJson(`/api/comments/${id}/messages`, { body });
    state.comments.drafts.delete(id);
    await loadComments();
  } catch (err) {
    input.disabled = false;
    toast(err.message);
  }
}

function updateCommentButton() {
  const button = $("#comment-btn");
  const selection = getSelection();
  const range = selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  if (!state.comments.enabled || !$("#composer").hidden || !range || !blockAt(range.startContainer)) {
    button.hidden = true;
    return;
  }
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  button.hidden = false;
  button.style.left = `${Math.min(rect.right + 6, innerWidth - button.offsetWidth - 8) + scrollX}px`;
  button.style.top = `${rect.top + scrollY - 3}px`;
}

function openComposer() {
  const comments = state.comments;
  const selection = getSelection();
  if (!comments.enabled || !selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const anchor = anchorFromRange(range);
  if (!anchor) {
    toast("Select text in a paragraph, heading, list item, table row or code block");
    return;
  }
  deactivate();
  comments.pending = { ...anchor, range: range.cloneRange() };
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  const composer = $("#composer");
  $("#composer-quote").textContent = anchor.quote;
  composer.hidden = false;
  composer.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - composer.offsetWidth - 8)) + scrollX}px`;
  composer.style.top = `${rect.bottom + scrollY + 8}px`;
  $("#comment-btn").hidden = true;
  const input = $("#composer-text");
  input.value = comments.composerDraft;
  autosize(input);
  input.focus({ preventScroll: true });
  paintHighlights();
}

function closeComposer() {
  if ($("#composer").hidden) return false;
  $("#composer").hidden = true;
  state.comments.pending = null;
  paintHighlights();
  return true;
}

async function submitComment() {
  const comments = state.comments;
  const input = $("#composer-text");
  const body = input.value.trim();
  if (!body || !comments.pending) return;
  const { blockIndex, quote, start } = comments.pending;
  try {
    const { id } = await postJson("/api/comments", { path: state.doc.path, sha: state.doc.sha, blockIndex, quote, start, body });
    comments.composerDraft = "";
    closeComposer();
    getSelection().removeAllRanges();
    await loadComments();
    activate(id);
  } catch (err) {
    if (err.status !== 409) {
      toast(err.message);
      return;
    }
    comments.composerDraft = input.value;
    closeComposer();
    toast("The doc changed while you typed. Select the text again; your draft is kept.");
    await loadDoc(state.doc.path, { keepScroll: true });
  }
}

function initComments() {
  state.comments.enabled = Boolean(state.info.comments);
  if (!state.comments.enabled) return;

  const rail = $("#rail");
  rail.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const card = event.target.closest(".thread");
    if (action === "list") {
      state.comments.listMode = !state.comments.listMode;
      updateRailMode();
      renderRail();
    } else if (action === "close") {
      root.classList.remove("drawer-open");
    } else if (action === "resolved" || action === "open") {
      setThreadStatus(Number(card.dataset.thread), action);
    } else if (card && !card.classList.contains("expanded") && !event.target.closest("a")) {
      activate(Number(card.dataset.thread), { scroll: true });
    }
  });
  rail.addEventListener("keydown", (event) => {
    const input = event.target.closest("textarea.reply");
    if (!input) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendReply(input);
    } else if (event.key === "Escape") {
      input.blur();
      deactivate();
    }
  });
  rail.addEventListener("input", (event) => {
    const input = event.target.closest("textarea.reply");
    if (!input) return;
    state.comments.drafts.set(Number(input.closest(".thread").dataset.thread), input.value);
    autosize(input);
    scheduleLayout();
  });

  $("#doc").addEventListener("click", (event) => {
    if (!getSelection().isCollapsed) return;
    const id = threadAtPoint(event.clientX, event.clientY);
    if (id !== null) activate(id);
    else deactivate();
  });

  const commentButton = $("#comment-btn");
  commentButton.addEventListener("mousedown", (event) => event.preventDefault());
  commentButton.addEventListener("click", openComposer);
  $("#composer-submit").addEventListener("click", submitComment);
  $("#composer-cancel").addEventListener("click", () => {
    state.comments.composerDraft = "";
    closeComposer();
  });
  $("#composer-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitComment();
    } else if (event.key === "Escape") {
      state.comments.composerDraft = "";
      closeComposer();
    }
  });
  $("#composer-text").addEventListener("input", (event) => autosize(event.target));

  $("#comments-btn").addEventListener("click", () => {
    if (root.classList.contains("rail-docked")) {
      state.comments.listMode = !state.comments.listMode;
      updateRailMode();
    } else {
      root.classList.toggle("drawer-open");
    }
    renderRail();
  });

  // A click inside the selection collapses it only after mouseup, so check on the next tick.
  document.addEventListener("mouseup", () => setTimeout(updateCommentButton));
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key === "Shift") updateCommentButton();
  });
  document.addEventListener("selectionchange", () => {
    if (getSelection().isCollapsed) $("#comment-btn").hidden = true;
  });
  new ResizeObserver(scheduleLayout).observe($("#doc"));
}

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
  initComments();
  renderTree();
  await loadDoc(relFromPathname(location.pathname));
}

init();
