/** The comment controls in the top bar: the comments button, the batch bar, and the version chip and menu. */
import { $, getJson, toast } from "../dom.js";
import { ago } from "../lib/format.js";
import { encodePath } from "../lib/paths.js";
import { state } from "../state.js";

export function renderCommentChrome() {
  const comments = state.comments;
  const unresolved = comments.threads.filter((t) => t.status !== "resolved");
  const waiting = unresolved.filter((t) => t.waitingOn === "human").length;
  const button = $("#comments-btn");
  button.hidden = !comments.threads.length;
  button.classList.toggle("attention", waiting > 0);
  button.title = `${unresolved.length} unresolved, ${waiting} waiting on you`;
  $("#comments-count").textContent = unresolved.length || "";
  $("#batch").hidden = !comments.pendingCount;
  $("#batch-count").textContent = `${comments.pendingCount} pending`;
  $("#batch-count").title = "Comments and replies in your batch, across all docs. Agents see them only after you send.";
  const chip = $("#version");
  const version = comments.version;
  chip.hidden = !version;
  if (version) {
    const old = version.seq !== version.latestSeq;
    chip.textContent = old ? `v${version.seq} of ${version.latestSeq}` : `v${version.seq}`;
    chip.classList.toggle("old", old);
    chip.title = `Version ${version.seq} of this doc. Each comment remembers the version it was made on. Click for every version.`;
  }
}

export async function toggleVersionsMenu() {
  if (closeVersionsMenu() || !state.doc) return;
  const doc = state.doc;
  let versions;
  try {
    ({ versions } = await getJson(`/api/versions?path=${encodeURIComponent(doc.path)}`));
  } catch (err) {
    toast(err.message);
    return;
  }
  const viewing = state.viewVersion ?? versions[0]?.seq;
  const menu = $("#versions-menu");
  menu.innerHTML = versions
    .map((v, i) => {
      const href = `/view/${encodePath(doc.path)}${i === 0 ? "" : `?v=${v.seq}`}`;
      const notes = [i === 0 && "latest", ago(Date.parse(v.observedAt)), v.threads && `${v.threads} new comment${v.threads === 1 ? "" : "s"}`];
      return `<a href="${href}"${v.seq === viewing ? ' class="here"' : ""}><span>v${v.seq}</span><span class="notes">${notes.filter(Boolean).join(" · ")}</span></a>`;
    })
    .join("");
  menu.hidden = false;
  const chip = $("#version").getBoundingClientRect();
  menu.style.top = `${chip.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(chip.left, innerWidth - menu.offsetWidth - 8))}px`;
}

export function closeVersionsMenu() {
  const menu = $("#versions-menu");
  if (menu.hidden) return false;
  menu.hidden = true;
  return true;
}
