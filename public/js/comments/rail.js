/** The comment rail: docked in the margin beside the doc when there is room, else a drawer. */
import { $, autosize, openTogglesAround, root } from "../dom.js";
import { stackCards } from "../lib/card-stack.js";
import { railHead, railList, threadCard } from "../lib/cards.js";
import { railLayout } from "../lib/layout.js";
import { SPY_OFFSET_PX } from "../scroll.js";
import { state } from "../state.js";
import { visibleRect } from "./anchors.js";
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
  if (comments.threads.some((t) => t.status !== "resolved")) comments.railHeld = true;
  const { docked, tocYields } = railLayout({
    wanted: comments.listMode || comments.railHeld,
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
  return { expanded: t.id === state.comments.active, batching: state.comments.batch, docPath: state.doc?.path ?? "" };
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
    ? railList(comments.threads, { active: comments.active, batching: comments.batch, docPath: state.doc?.path ?? "" })
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
      return range && { card, target: visibleRect(range).top - railTop, height: card.offsetHeight };
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
  const range = comments.ranges.get(id) ?? comments.nowRanges.get(id);
  if (range) openTogglesAround(range.startContainer);
  comments.active = id;
  if (!root.classList.contains("rail-docked")) root.classList.add("drawer-open");
  renderRail();
  paintMarks();
  if (scroll && range) {
    const rect = range.getBoundingClientRect();
    if (rect.top < SPY_OFFSET_PX || rect.bottom > innerHeight) scrollBy({ top: rect.top - innerHeight / 3, behavior: "smooth" });
  }
  if ($("#rail").classList.contains("listing")) $(`#rail .thread[data-thread="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

/** Opens a card's ⋯ menu, closing any other, or closes them all with null. Returns whether a menu was open before. */
export function openThreadMenu(button) {
  let wasOpen = false;
  for (const other of document.querySelectorAll('#rail [data-action="thread-menu"]')) {
    const expanded = other.getAttribute("aria-expanded") === "true";
    const open = other === button && !expanded;
    wasOpen ||= expanded;
    other.setAttribute("aria-expanded", String(open));
    other.nextElementSibling.hidden = !open;
    other.closest(".thread").classList.toggle("menu-open", open);
  }
  return wasOpen;
}

export function deactivate() {
  if (state.comments.active === null) return false;
  state.comments.active = null;
  renderRail();
  paintMarks();
  return true;
}

/**
 * Opens a card the reader clicked, with its reply box focused. In the margin,
 * the open card sits level with its text, which can be a screen away from
 * where stacking had put it, so the page scrolls by as much: the card stays
 * under the pointer and its text comes to it.
 */
export function openClickedCard(card) {
  const id = Number(card.dataset.thread);
  const listing = $("#rail").classList.contains("listing");
  const clickedAt = card.getBoundingClientRect().top;
  activate(id, { scroll: listing });
  const opened = $(`#rail .thread[data-thread="${id}"]`);
  if (opened && !listing) scrollBy({ top: opened.getBoundingClientRect().top - clickedAt, behavior: "instant" });
  opened?.querySelector("textarea.reply")?.focus({ preventScroll: true });
}

/** Jumps straight to a thread's text, with no scroll animation, and opens the thread. */
export function jumpToThread(id) {
  const range = state.comments.ranges.get(id);
  if (range) {
    openTogglesAround(range.startContainer);
    scrollBy({ top: range.getBoundingClientRect().top - innerHeight / 3, behavior: "instant" });
  }
  activate(id);
}
