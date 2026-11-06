/** What the human's comment controls send to the server. */
import { $, postJson, toast } from "../dom.js";
import { releaseReload, reloadDoc } from "../doc.js";
import { state } from "../state.js";
import { closeComposer } from "./composer.js";
import { loadComments } from "./model.js";
import { activate } from "./rail.js";

export async function sendBatch() {
  try {
    const { sent } = await postJson("/api/comments/batch/send", {});
    toast(`Sent ${sent} comment${sent === 1 ? "" : "s"} to the agent`);
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

export async function discardBatch() {
  const count = state.comments.pendingCount;
  if (!confirm(`Discard ${count} pending comment${count === 1 ? "" : "s"}? This cannot be undone.`)) return;
  try {
    await postJson("/api/comments/batch/discard", {});
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

export async function setThreadStatus(id, status) {
  try {
    // A reopen's note joins the batch while batching, so the agent hears about it with the rest.
    await postJson(`/api/comments/${id}/status`, { status, pending: status === "open" && state.comments.batch });
    if (status === "resolved" && state.comments.active === id) state.comments.active = null;
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

/** Deletes a thread with no dialog: it is picked from the card's ⋯ menu, and picking it is the confirmation. */
export async function deleteThread(id) {
  try {
    await postJson(`/api/comments/${id}/delete`, {});
    if (state.comments.active === id) state.comments.active = null;
    state.comments.replyText.delete(id);
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

export async function deleteMessage(threadId, messageId) {
  if (!confirm("Delete this message? This cannot be undone.")) return;
  try {
    await postJson(`/api/comments/${threadId}/messages/${messageId}/delete`, {});
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

/** Adds a reply: into the batch while batching, else sent at once. */
export async function sendReply(input) {
  const id = Number(input.closest(".thread").dataset.thread);
  const body = input.value.trim();
  if (!body) return;
  input.disabled = true;
  try {
    await postJson(`/api/comments/${id}/messages`, { body, pending: state.comments.batch });
    state.comments.replyText.delete(id);
    await loadComments();
  } catch (err) {
    input.disabled = false;
    toast(err.message);
  }
}

/** Starts the thread the composer holds: into the batch while batching, else sent at once. */
export async function submitComment() {
  const comments = state.comments;
  const input = $("#composer-text");
  const body = input.value.trim();
  if (!body || !comments.selection) return;
  const { blockIndex, quote, start, sha } = comments.selection;
  try {
    const { id } = await postJson("/api/comments", { path: state.doc.path, sha, blockIndex, quote, start, body, pending: comments.batch });
    comments.composerText = "";
    // The new thread is drawn on the text it was made on before a reload that waited moves the doc on.
    closeComposer({ release: false });
    getSelection().removeAllRanges();
    await loadComments();
    activate(id);
    releaseReload();
  } catch (err) {
    if (err.status !== 409) {
      toast(err.message);
      return;
    }
    comments.composerText = input.value;
    closeComposer({ release: false });
    toast("The doc changed while you typed. Select the text again; your draft is kept.");
    await reloadDoc();
  }
}
