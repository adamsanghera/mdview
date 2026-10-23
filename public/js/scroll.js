/** The reading-progress bar and the outline entry for the section in view. */
import { $, root } from "./dom.js";
import { state } from "./state.js";

export const SPY_OFFSET_PX = 80;

let queued = false;
export function updateScroll() {
  queued = false;
  const max = root.scrollHeight - innerHeight;
  $("#progress").style.setProperty("--p", max > 0 ? `${Math.min(100, (scrollY / max) * 100)}%` : "0%");

  let current = null;
  for (const heading of state.headings) {
    if (heading.getBoundingClientRect().top - SPY_OFFSET_PX <= 0) current = heading;
    else break;
  }
  if (max > 0 && scrollY >= max - 2) current = state.headings.at(-1) ?? current;
  let activeLink = null;
  for (const link of document.querySelectorAll("#toc a")) {
    const active = link.dataset.id === current?.id;
    link.classList.toggle("active", active);
    if (active) activeLink = link;
  }
  const pane = $("#toc-pane");
  if (activeLink && (activeLink.offsetTop < pane.scrollTop || activeLink.offsetTop > pane.scrollTop + pane.clientHeight - 40)) {
    pane.scrollTop = activeLink.offsetTop - pane.clientHeight / 3;
  }
}

export function scheduleScrollUpdate() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(updateScroll);
}
