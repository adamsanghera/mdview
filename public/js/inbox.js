/**
 * The inbox, at /inbox: every unresolved thread under the root that waits on
 * the human, grouped by doc, each linking to its thread. It lists the same
 * threads as `mdview comments list <root> --waiting-on human`, and redraws
 * whenever the comment store changes.
 */
import { getJson } from "./dom.js";
import { showPage } from "./doc.js";
import { ago, escapeHtml } from "./lib/format.js";
import { encodePath } from "./lib/paths.js";
import { refreshTree } from "./sidebar.js";
import { state } from "./state.js";

const EXCERPT_CHARS = 280;

let doorbell = null;

function excerpt(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

function threadItem(doc, t) {
  const href = `/view/${encodePath(doc)}?thread=${t.id}`;
  const turn = t.status === "suggested" ? "Suggested resolved" : "Your turn";
  const where = [t.heading, t.lines && `line ${t.lines[0]}`, t.state === "outdated" && "on an older version"].filter(Boolean).join(" · ");
  const last = t.last
    ? `<p class="inbox-last"><span class="inbox-author">${escapeHtml(t.last.author)}</span> ${escapeHtml(excerpt(t.last.body))} <span class="inbox-when">${escapeHtml(ago(Date.parse(t.last.createdAt)))}</span></p>`
    : "";
  return `<li class="inbox-thread ${t.status}" data-thread="${t.id}">
    <a class="inbox-open" href="${href}"><span class="inbox-turn">${turn}</span> #${t.id}${where ? ` · ${escapeHtml(where)}` : ""}</a>
    ${t.quote ? `<blockquote class="thread-quote">${escapeHtml(t.quote)}</blockquote>` : ""}
    ${last}
  </li>`;
}

function inboxHtml(docs) {
  const total = docs.reduce((sum, d) => sum + d.threads.length, 0);
  if (!total) return `<h1>Waiting on you</h1><p class="inbox-empty">Nothing is waiting on you.</p>`;
  const sections = docs.map(
    (d) => `<section class="inbox-doc" data-path="${escapeHtml(d.path)}">
      <h2><a href="/view/${encodePath(d.path)}">${escapeHtml(d.path)}</a></h2>
      <ul class="inbox-threads">${d.threads.map((t) => threadItem(d.path, t)).join("")}</ul>
    </section>`,
  );
  return `<h1>Waiting on you</h1><p class="inbox-summary">${total} ${total === 1 ? "thread waits" : "threads wait"} on you in ${docs.length} ${docs.length === 1 ? "doc" : "docs"}.</p>${sections.join("")}`;
}

async function render() {
  if (location.pathname !== "/inbox") return;
  let docs = [];
  try {
    ({ docs } = await getJson("/api/inbox"));
  } catch (err) {
    showPage({ title: "Waiting on you", html: `<h1>Waiting on you</h1><p class="doc-error">${escapeHtml(err.message)}</p>` });
    return;
  }
  if (location.pathname !== "/inbox") return;
  showPage({ title: "Waiting on you", html: inboxHtml(docs) });
}

/** Shows the inbox, and keeps it current until the reader leaves it. */
export async function showInbox() {
  if (!state.info?.comments) {
    showPage({ title: "Waiting on you", html: `<h1>Waiting on you</h1><p class="inbox-empty">Comments are off, so nothing can wait on you.</p>` });
    return;
  }
  await render();
  if (doorbell) return;
  doorbell = new EventSource("/api/store-events");
  doorbell.addEventListener("change", () => {
    if (location.pathname !== "/inbox") {
      doorbell.close();
      doorbell = null;
      return;
    }
    render();
    refreshTree();
  });
}

