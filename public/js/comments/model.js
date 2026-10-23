/** Loading a doc's threads from the server and drawing everything that depends on them. */
import { getJson, root } from "../dom.js";
import { state, threadById } from "../state.js";
import { layoutTables } from "../tables.js";
import { rangeFor } from "./anchors.js";
import { closeComposer } from "./composer.js";
import { paintMarks } from "./marks.js";
import { activate, renderRail, updateRailMode } from "./rail.js";
import { renderCommentChrome } from "./topbar.js";

export async function loadComments() {
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
  comments.pendingCount = data.pendingCount ?? 0;
  renderComments();
  const queued = comments.activateAfterLoad;
  comments.activateAfterLoad = null;
  if (queued !== null && threadById(queued)) activate(queued, { scroll: true });
}

export function resetComments() {
  const comments = state.comments;
  closeComposer({ release: false });
  comments.threads = [];
  comments.version = null;
  comments.active = null;
  comments.replyText.clear();
  root.classList.remove("drawer-open");
  renderComments();
}

/** Drops highlights that point into a document that was just replaced. */
export function forgetRanges() {
  state.comments.ranges = new Map();
  state.comments.nowRanges = new Map();
  paintMarks();
}

export function renderComments() {
  const comments = state.comments;
  comments.ranges = new Map();
  comments.nowRanges = new Map();
  for (const thread of comments.threads) {
    if (thread.status === "resolved") continue;
    const range = thread.blockIndex !== null && rangeFor(thread);
    if (range) comments.ranges.set(thread.id, range);
    const now = thread.nowReads && rangeFor({ blockIndex: thread.nowReads.blockIndex, quote: "", start: 0 });
    if (now) comments.nowRanges.set(thread.id, now);
  }
  if (comments.active !== null && !threadById(comments.active)) comments.active = null;
  updateRailMode();
  layoutTables();
  renderCommentChrome();
  renderRail();
  paintMarks();
}
