/** The comment rail: docked in the margin beside the doc when there is room, else a drawer. */
import { $, autosize, root } from "../dom.js";
import { stackCards } from "../lib/card-stack.js";
import { railHead, railList, threadCard } from "../lib/cards.js";
import { railFits } from "../lib/layout.js";
import { SPY_OFFSET_PX } from "../scroll.js";
import { state } from "../state.js";
import { paintMarks, renderTocMarks } from "./marks.js";

// RAIL_WIDTH_PX and RAIL_GAP_PX must match .rail-docked in style.css.
const RAIL_WIDTH_PX = 300;
const RAIL_GAP_PX = 24;
const CARD_GAP_PX = 10;

/** Docks the rail beside the doc when there is room for both. Otherwise it opens as a drawer. */
export function updateRailMode() {
  const comments = state.comments;
  root.classList.toggle("has-comments", comments.threads.length > 0);
  const wanted = comments.listMode || comments.threads.some((t) => t.status !== "resolved");
  const docWidth = parseFloat(getComputedStyle($("#doc")).maxWidth);
  const docked = wanted && railFits({ contentWidth: $(".content").clientWidth, docWidth, railWidth: RAIL_WIDTH_PX, railGap: RAIL_GAP_PX });
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
    refocus.setSelectionRange(refocus.value.length, refocus.value.length);
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
