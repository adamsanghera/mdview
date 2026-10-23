/** The comment rail: docked in the margin beside the doc when there is room, else a drawer. */
import { $, autosize, root } from "../dom.js";
import { stackCards } from "../lib/card-stack.js";
import { railHead, railList, threadCard } from "../lib/cards.js";
import { railLayout } from "../lib/layout.js";
import { SPY_OFFSET_PX } from "../scroll.js";
import { state } from "../state.js";
import { paintMarks, renderTocMarks } from "./marks.js";

const CARD_GAP_PX = 10;

const tokenPx = (name) => parseFloat(getComputedStyle(root).getPropertyValue(name));

/**
 * Docks the rail beside the doc when there is room, taking the outline's
 * column only if it must (see railLayout). Otherwise the rail opens as a
 * drawer. Widths are measured with the outline in place.
 */
export function updateRailMode() {
  const comments = state.comments;
  root.classList.remove("toc-yields");
  const { docked, tocYields } = railLayout({
    wanted: comments.listMode || comments.threads.some((t) => t.status !== "resolved"),
    content: $(".content").clientWidth,
    toc: $("#toc-pane").offsetWidth,
    doc: parseFloat(getComputedStyle($("#doc")).maxWidth),
    rail: tokenPx("--rail-width"),
    gap: tokenPx("--rail-gap"),
  });
  root.classList.toggle("toc-yields", tocYields);
  root.classList.toggle("rail-docked", docked);
  if (docked) root.classList.remove("drawer-open");
}

export function onLayoutChange() {
  if (!state.comments.threads.length) return;
  const wasDocked = root.classList.contains("rail-docked");
  updateRailMode();
  if (root.classList.contains("rail-docked") !== wasDocked) renderRail();
  else scheduleLayout();
}

function cardOptions(t) {
  return { expanded: t.id === state.comments.active, batching: state.comments.pendingCount > 0, docPath: state.doc?.path ?? "" };
}

export function renderRail() {
  const comments = state.comments;
  const rail = $("#rail");
  const docked = root.classList.contains("rail-docked");
  const listing = comments.listMode || !docked;
  const focused = document.activeElement?.closest?.("#rail .thread")?.dataset.thread;
  const typing = document.activeElement?.matches?.("#rail textarea.reply") ? document.activeElement : null;
  const caret = typing && [typing.selectionStart, typing.selectionEnd, typing.selectionDirection];
  rail.classList.toggle("listing", listing);
  rail.style.minHeight = "";
  const body = listing
    ? railList(comments.threads, { active: comments.active, batching: comments.pendingCount > 0, docPath: state.doc?.path ?? "" })
    : comments.threads
        .filter((t) => comments.ranges.has(t.id))
        .map((t) => threadCard(t, cardOptions(t)))
        .join("");
  rail.innerHTML = railHead(comments.threads, { listing, docked }) + body;
  for (const input of rail.querySelectorAll("textarea.reply")) {
    input.value = comments.replyText.get(Number(input.closest(".thread").dataset.thread)) ?? "";
    autosize(input);
  }
  const refocus = focused && rail.querySelector(`.thread[data-thread="${focused}"] textarea`);
  if (refocus) {
    refocus.focus({ preventScroll: true });
    refocus.setSelectionRange(...(caret ?? [refocus.value.length, refocus.value.length]));
  }
  if (!listing) layoutRail();
}

/** Sets each margin card level with its highlight, stacked by stackCards around the open card. */
function layoutRail() {
  const rail = $("#rail");
  if (rail.classList.contains("listing")) return;
  const railTop = rail.getBoundingClientRect().top;
  const head = rail.querySelector(".rail-head");
  const minTop = head ? head.offsetTop + head.offsetHeight + CARD_GAP_PX : 0;
  const items = [...rail.querySelectorAll(".thread")]
    .map((card) => {
      const range = state.comments.ranges.get(Number(card.dataset.thread));
      return range && { card, target: range.getBoundingClientRect().top - railTop, height: card.offsetHeight };
    })
    .filter(Boolean)
    .sort((a, b) => a.target - b.target);
  if (!items.length) return;

  const pivot = Math.max(0, items.findIndex((item) => item.card.classList.contains("expanded")));
  const tops = stackCards(items, { pivot, minTop, gap: CARD_GAP_PX });
  items.forEach((item, i) => (item.card.style.top = `${tops[i]}px`));
  rail.style.minHeight = `${tops.at(-1) + items.at(-1).height}px`;
}

let layoutQueued = false;
export function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutRail();
    renderTocMarks();
  });
}

export function activate(id, { scroll = false } = {}) {
  const comments = state.comments;
  comments.active = id;
  if (!root.classList.contains("rail-docked")) root.classList.add("drawer-open");
  renderRail();
  paintMarks();
  const range = comments.ranges.get(id) ?? comments.nowRanges.get(id);
  if (scroll && range) {
    const rect = range.getBoundingClientRect();
    if (rect.top < SPY_OFFSET_PX || rect.bottom > innerHeight) scrollBy({ top: rect.top - innerHeight / 3, behavior: "smooth" });
  }
  if ($("#rail").classList.contains("listing")) $(`#rail .thread[data-thread="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

export function deactivate() {
  if (state.comments.active === null) return false;
  state.comments.active = null;
  renderRail();
  paintMarks();
  return true;
}

/** Jumps straight to a thread's text, with no scroll animation, and opens the thread. */
export function jumpToThread(id) {
  const range = state.comments.ranges.get(id);
  if (range) scrollBy({ top: range.getBoundingClientRect().top - innerHeight / 3, behavior: "instant" });
  activate(id);
}
