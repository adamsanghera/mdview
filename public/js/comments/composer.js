/** The floating Comment button beside a selection, and the composer it opens. */
import { releaseReload } from "../doc.js";
import { $, autosize, toast } from "../dom.js";
import { keyHint } from "../lib/keys.js";
import { state } from "../state.js";
import { anchorFromRange, blockAt } from "./anchors.js";
import { paintMarks } from "./marks.js";
import { deactivate } from "./rail.js";

export function updateCommentButton() {
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

export function openComposer() {
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
  // The version the selection came from, so the comment anchors to what was selected even if the doc moves on before it is sent.
  comments.selection = { ...anchor, sha: state.doc.sha, range: range.cloneRange() };
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  const composer = $("#composer");
  $("#composer-quote").textContent = anchor.quote;
  composer.hidden = false;
  composer.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - composer.offsetWidth - 8)) + scrollX}px`;
  composer.style.top = `${rect.bottom + scrollY + 8}px`;
  $("#comment-btn").hidden = true;
  const batching = comments.pendingCount > 0;
  $("#composer-submit").textContent = batching ? "Add to batch" : "Comment";
  $("#composer-alt").textContent = batching ? "Send just this" : "Start batch";
  $("#composer-hint").textContent = keyHint(batching);
  const input = $("#composer-text");
  input.value = comments.composerText;
  autosize(input);
  input.focus({ preventScroll: true });
  paintMarks();
}

/** Live reload waits while this is true, so the text never moves under a comment being written. */
export function composerOpen() {
  return !$("#composer").hidden;
}

/** Closes the composer. Then, unless `release` is false, a live reload that waited for it applies. */
export function closeComposer({ release = true } = {}) {
  if ($("#composer").hidden) return false;
  $("#composer").hidden = true;
  state.comments.selection = null;
  paintMarks();
  if (release) releaseReload();
  return true;
}
