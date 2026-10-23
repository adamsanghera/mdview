/** Comment marks: highlights in the text, and ticks on the outline's line. */
import { $ } from "../dom.js";
import { escapeHtml, truncate } from "../lib/format.js";
import { placeTick } from "../lib/ticks.js";
import { state, threadById } from "../state.js";

const MARK_PREVIEW_CHARS = 80;
const HIGHLIGHTS =
  "highlights" in CSS
    ? {
        open: new Highlight(),
        suggested: new Highlight(),
        draft: new Highlight(),
        active: new Highlight(),
        selection: new Highlight(),
        now: new Highlight(),
      }
    : null;

if (HIGHLIGHTS) {
  HIGHLIGHTS.active.priority = 1;
  HIGHLIGHTS.selection.priority = 1;
  for (const [name, highlight] of Object.entries(HIGHLIGHTS)) CSS.highlights.set(`mdview-comment-${name}`, highlight);
}

/** Paints every comment mark: the highlights in the text and the ticks on the TOC's line. */
export function paintMarks() {
  renderTocMarks();
  if (!HIGHLIGHTS) return;
  for (const highlight of Object.values(HIGHLIGHTS)) highlight.clear();
  const comments = state.comments;
  for (const [id, range] of comments.ranges) {
    const thread = threadById(id);
    HIGHLIGHTS[thread?.pending ? "draft" : thread?.status === "suggested" ? "suggested" : "open"].add(range);
    if (id === comments.active) HIGHLIGHTS.active.add(range);
  }
  const now = comments.nowRanges.get(comments.active);
  if (now) HIGHLIGHTS.now.add(now);
  if (comments.selection) HIGHLIGHTS.selection.add(comments.selection.range);
}

/**
 * Draws a tick on the TOC's left line for each comment attached to text, at
 * the entry for the section the comment sits in, placed by placeTick.
 * Comments above the first entry go at its top. The open thread's tick is
 * drawn last, on top.
 */
export function renderTocMarks() {
  const comments = state.comments;
  const toc = $("#toc");
  toc.querySelector(".toc-marks")?.remove();
  const pageTop = (el) => el.getBoundingClientRect().top + scrollY;
  const sections = [...toc.querySelectorAll("a[data-id]")]
    .map((link) => ({ link, heading: document.getElementById(link.dataset.id) }))
    .filter((s) => s.heading)
    .map((s) => ({ link: s.link, top: pageTop(s.heading) }));
  if (!sections.length || !comments.ranges.size) return;
  const docEnd = $("#doc").getBoundingClientRect().bottom + scrollY;
  const tops = sections.map((s) => s.top);

  const marks = [];
  for (const [id, range] of comments.ranges) {
    const thread = threadById(id);
    if (!thread) continue;
    const { index, share } = placeTick(tops, range.getBoundingClientRect().top + scrollY, docEnd);
    const { link } = sections[index];
    marks.push({ id, thread, top: link.offsetTop + share * link.offsetHeight });
  }
  marks.sort((a, b) => (a.id === comments.active) - (b.id === comments.active));

  const layer = document.createElement("div");
  layer.className = "toc-marks";
  layer.innerHTML = marks
    .map(({ id, thread, top }) => {
      const kind = id === comments.active ? "active" : thread.pending ? "pending" : thread.status;
      const preview = truncate(thread.messages[0].body.replace(/\s+/g, " "), MARK_PREVIEW_CHARS);
      return `<button class="toc-mark" type="button" tabindex="-1" data-thread="${id}" data-kind="${kind}" style="top: ${top.toFixed(1)}px" title="#${id}: ${escapeHtml(preview)}"></button>`;
    })
    .join("");
  toc.append(layer);
}
