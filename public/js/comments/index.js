/** Wires the comment UI's events to the modules that handle them. */
import { $, autosize, root } from "../dom.js";
import { isSubmitKey } from "../lib/keys.js";
import { state } from "../state.js";
import { deleteMessage, deleteThread, discardBatch, sendBatch, sendReply, setThreadStatus, submitComment } from "./actions.js";
import { threadAtPoint } from "./anchors.js";
import { openBatchMenu, setBatching } from "./batch.js";
import { closeComposer, openComposer, updateCommentButton } from "./composer.js";
import { activate, deactivate, jumpToThread, openClickedCard, openThreadMenu, renderRail, scheduleLayout, updateRailMode } from "./rail.js";
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
    } else if (action === "list" || action === "rail-mode") {
      const listing = action === "list" ? !state.comments.listMode : event.target.closest("[data-mode]").dataset.mode === "list";
      if (listing === state.comments.listMode) return;
      state.comments.listMode = listing;
      updateRailMode();
      renderRail();
    } else if (action === "close") {
      root.classList.remove("drawer-open");
    } else if (action === "resolved" || action === "open") {
      setThreadStatus(Number(card.dataset.thread), action);
    } else if (action === "thread-menu") {
      openThreadMenu(event.target.closest("[data-action]"));
    } else if (action === "delete-thread") {
      openThreadMenu(null);
      deleteThread(Number(card.dataset.thread));
    } else if (action === "delete-message") {
      deleteMessage(Number(card.dataset.thread), Number(event.target.closest("[data-message]").dataset.message));
    } else if (card && !card.classList.contains("expanded") && !event.target.closest("a")) {
      openClickedCard(card);
    }
  });
  rail.addEventListener("keydown", (event) => {
    const input = event.target.closest("textarea.reply");
    if (!input) return;
    if (isSubmitKey(event)) {
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
  $("#composer-cancel").addEventListener("click", () => {
    state.comments.composerText = "";
    closeComposer();
  });
  $("#composer-text").addEventListener("keydown", (event) => {
    if (isSubmitKey(event)) {
      event.preventDefault();
      submitComment();
    } else if (event.key === "Escape") {
      state.comments.composerText = "";
      closeComposer();
    }
  });
  $("#composer-text").addEventListener("input", (event) => autosize(event.target));

  $("#batch-send").addEventListener("click", sendBatch);
  $("#batch-discard").addEventListener("click", discardBatch);
  $("#version").addEventListener("click", toggleVersionsMenu);
  // Submit buttons and their batch menus, in the composer and in every open card.
  document.addEventListener("click", (event) => {
    const submit = event.target.closest("[data-submit]");
    const chevron = event.target.closest("[data-batch-menu]");
    const choice = event.target.closest("[data-batch-choice]");
    if (choice) setBatching(choice.dataset.batchChoice === "on");
    openBatchMenu(chevron);
    if (submit?.closest("#composer")) submitComment();
    else if (submit) sendReply(submit.closest(".thread").querySelector("textarea.reply"));
    if (!event.target.closest("#versions-menu, #version")) closeVersionsMenu();
    if (!event.target.closest(".thread-more")) openThreadMenu(null);
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
