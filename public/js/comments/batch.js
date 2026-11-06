/** The sticky batch mode, and the split submit buttons that show and switch it. */
import { state } from "../state.js";

// state.js reads this key when the page loads.
const BATCH_KEY = "mdview.batch";

/** Sets the batch mode, keeps it for the next visit, and brings every submit button and its menu up to date. */
export function setBatching(batch) {
  state.comments.batch = batch;
  localStorage.setItem(BATCH_KEY, batch ? "on" : "off");
  for (const button of document.querySelectorAll("[data-submit]")) button.textContent = batch ? "Add to batch" : button.dataset.labelNow;
  for (const choice of document.querySelectorAll("[data-batch-choice]")) choice.setAttribute("aria-checked", String((choice.dataset.batchChoice === "on") === batch));
}

/** Opens a submit button's menu, closing any other, or closes them all with null. Returns whether a menu was open before. */
export function openBatchMenu(chevron) {
  let wasOpen = false;
  for (const other of document.querySelectorAll("[data-batch-menu]")) {
    const expanded = other.getAttribute("aria-expanded") === "true";
    const open = other === chevron && !expanded;
    wasOpen ||= expanded;
    other.setAttribute("aria-expanded", String(open));
    other.parentElement.querySelector(".split-menu").hidden = !open;
  }
  return wasOpen;
}
