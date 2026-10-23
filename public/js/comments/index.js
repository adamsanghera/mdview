/** Wires the comment UI's events to the modules that handle them. */
import { $, autosize, root } from "../dom.js";
import { submitMode } from "../lib/keys.js";
import { state } from "../state.js";
import { deleteMessage, deleteThread, discardBatch, sendBatch, sendReply, setThreadStatus, submitComment } from "./actions.js";
import { threadAtPoint } from "./anchors.js";
import { closeComposer, openComposer, updateCommentButton } from "./composer.js";
import { activate, deactivate, jumpToThread, renderRail, scheduleLayout, updateRailMode } from "./rail.js";
import { closeVersionsMenu, toggleVersionsMenu } from "./topbar.js";

export { forgetRanges, loadComments, resetComments } from "./model.js";
export { onLayoutChange } from "./rail.js";

export function initComments() {
  state.comments.enabled = Boolean(state.info.comments);
  if (!state.comments.enabled) return;

  const rail = $("#rail");
  rail.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const card = event.target.closest(".thread");
    const versionLink = event.target.closest("a[data-thread-link]");
    if (versionLink) {
      // The document-level link handler navigates; open the thread once that version loads.
      state.comments.activateAfterLoad = Number(versionLink.dataset.threadLink);
    } else if (action === "list") {
      state.comments.listMode = !state.comments.listMode;
      updateRailMode();
      renderRail();
    } else if (action === "close") {
      root.classList.remove("drawer-open");
    } else if (action === "resolved" || action === "open") {
      setThreadStatus(Number(card.dataset.thread), action);
    } else if (action === "delete-thread") {
      deleteThread(Number(card.dataset.thread));
    } else if (action === "delete-message") {
      deleteMessage(Number(card.dataset.thread), Number(event.target.closest("[data-message]").dataset.message));
    } else if (card && !card.classList.contains("expanded") && !event.target.closest("a")) {
      activate(Number(card.dataset.thread), { scroll: true });
    }
  });
  rail.addEventListener("keydown", (event) => {
    const input = event.target.closest("textarea.reply");
    if (!input) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendReply(input, submitMode(event, state.comments.pendingCount > 0));
    } else if (event.key === "Escape") {
      input.blur();
      deactivate();
    }
  });
  rail.addEventListener("input", (event) => {
    const input = event.target.closest("textarea.reply");
    if (!input) return;
    state.comments.replyText.set(Number(input.closest(".thread").dataset.thread), input.value);
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
  $("#composer-submit").addEventListener("click", () => submitComment(state.comments.pendingCount ? "batch" : "now"));
  $("#composer-alt").addEventListener("click", () => submitComment(state.comments.pendingCount ? "now" : "batch"));
  $("#composer-cancel").addEventListener("click", () => {
    state.comments.composerText = "";
    closeComposer();
  });
  $("#composer-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitComment(submitMode(event, state.comments.pendingCount > 0));
    } else if (event.key === "Escape") {
      state.comments.composerText = "";
      closeComposer();
    }
  });
  $("#composer-text").addEventListener("input", (event) => autosize(event.target));

  $("#batch-send").addEventListener("click", sendBatch);
  $("#batch-discard").addEventListener("click", discardBatch);
  $("#version").addEventListener("click", toggleVersionsMenu);
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#versions-menu, #version")) closeVersionsMenu();
  });

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
  $("#toc").addEventListener("click", (event) => {
    const mark = event.target.closest(".toc-mark");
    if (mark) jumpToThread(Number(mark.dataset.thread));
  });
  new ResizeObserver(scheduleLayout).observe($("#doc"));
}
