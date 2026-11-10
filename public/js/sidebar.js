/** The file list: its folders, the filter, and showing or hiding it. */
import { $, getJson, root } from "./dom.js";
import { escapeHtml } from "./lib/format.js";
import { encodePath } from "./lib/paths.js";
import { buildTree } from "./lib/tree.js";
import { state } from "./state.js";

export const NARROW = matchMedia("(max-width: 820px)");
const CHEVRON = '<svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>';

/** Set by main.js: `resized` runs after showing or hiding the list changes the page's layout. */
export const sidebarHooks = { resized() {} };

export function toggleSidebar() {
  if (NARROW.matches) {
    root.classList.toggle("sidebar-open");
    return;
  }
  const hidden = root.classList.toggle("no-sidebar");
  localStorage.setItem("mdview.sidebar", hidden ? "hidden" : "shown");
  sidebarHooks.resized();
}

export function showSidebar() {
  if (NARROW.matches) root.classList.add("sidebar-open");
  else if (root.classList.contains("no-sidebar")) toggleSidebar();
}

/** A count of threads waiting on the human, or nothing when there are none. */
function waitingBadge(count) {
  if (!count) return null;
  const badge = document.createElement("span");
  badge.className = "waiting-badge";
  badge.textContent = String(count);
  badge.title = `${count} ${count === 1 ? "thread waits" : "threads wait"} on you`;
  return badge;
}

/** How many threads wait on the human in docs under the folder `dirPath`. */
function waitingUnder(dirPath) {
  let total = 0;
  for (const [file, count] of Object.entries(state.waiting)) if (file.startsWith(`${dirPath}/`)) total += count;
  return total;
}

/** The sidebar's link to the inbox, with how many threads wait on the human in all. */
function renderInboxLink() {
  const link = $("#inbox-link");
  link.hidden = !state.info?.comments;
  const total = Object.values(state.waiting).reduce((sum, n) => sum + n, 0);
  $("#inbox-count").textContent = total ? String(total) : "";
  link.classList.toggle("active", location.pathname === "/inbox");
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
    // An open folder shows its docs' badges, so only a closed one sums them.
    if (!open) button.append(waitingBadge(waitingUnder(dirPath)) ?? "");
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
    const badge = waitingBadge(state.waiting[file]);
    if (badge) link.append(badge);
    item.append(link);
    list.append(item);
  }
  return list;
}

export function renderTree() {
  renderInboxLink();
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
export function expandAncestors(rel) {
  const parts = rel.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) state.expanded.add(parts.slice(0, i).join("/"));
  saveExpanded();
}

export function revealActiveFile() {
  const active = $("#tree .file.active");
  const box = $("#sidebar");
  if (!active) return;
  const top = active.offsetTop;
  if (top < box.scrollTop || top + active.offsetHeight > box.scrollTop + box.clientHeight) {
    box.scrollTop = top - box.clientHeight / 3;
  }
}

export async function refreshTree() {
  try {
    const tree = await getJson("/api/tree");
    state.files = tree.files;
    state.waiting = tree.waiting ?? {};
    renderTree();
  } catch {
    // The server may be restarting. The next focus or change retries.
  }
}
