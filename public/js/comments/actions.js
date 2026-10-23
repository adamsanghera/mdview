/** What the human's comment controls send to the server. */
import { $, postJson, toast } from "../dom.js";
import { releaseReload, reloadDoc } from "../doc.js";
import { state, threadById } from "../state.js";
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
    // A reopen's note joins an open batch, so the agent hears about it with the rest.
    await postJson(`/api/comments/${id}/status`, { status, pending: state.comments.pendingCount > 0 });
    if (status === "resolved" && state.comments.active === id) state.comments.active = null;
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

export async function deleteThread(id) {
  const thread = threadById(id);
  const replies = thread.messages.length - 1;
  const what = replies ? `thread #${id} and its ${replies} repl${replies === 1 ? "y" : "ies"}` : `thread #${id}`;
  if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
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

export async function sendReply(input, mode) {
  const id = Number(input.closest(".thread").dataset.thread);
  const body = input.value.trim();
  if (!body) return;
  input.disabled = true;
  try {
    await postJson(`/api/comments/${id}/messages`, { body, pending: mode !== "now" });
    state.comments.replyText.delete(id);
    if (mode === "send") await sendBatch();
    else await loadComments();
  } catch (err) {
    input.disabled = false;
    toast(err.message);
  }
}

export async function submitComment(mode) {
  const comments = state.comments;
  const input = $("#composer-text");
  const body = input.value.trim();
  if (!body || !comments.selection) return;
  const { blockIndex, quote, start, sha } = comments.selection;
  try {
    const { id } = await postJson("/api/comments", { path: state.doc.path, sha, blockIndex, quote, start, body, pending: mode !== "now" });
    comments.composerText = "";
    // The new thread is drawn on the text it was made on before a reload that waited moves the doc on.
    closeComposer({ release: false });
    getSelection().removeAllRanges();
    if (mode === "send") await sendBatch();
    else await loadComments();
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
