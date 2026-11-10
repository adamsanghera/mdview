/**
 * Pictures in the doc open over the page, in a <dialog>, instead of in a new
 * tab. Escape, the close button, or a click anywhere off the picture closes
 * it. A picture inside a link stays a link, and ⌘ or Ctrl-click still opens
 * the picture in a new tab.
 */
import { $ } from "./dom.js";

export function closeLightbox() {
  const box = $("#lightbox");
  if (!box.open) return false;
  box.close();
  return true;
}

function openLightbox(img) {
  const box = $("#lightbox");
  const shown = $("#lightbox-img");
  shown.src = img.currentSrc || img.src;
  shown.alt = img.alt;
  box.setAttribute("aria-label", img.alt ? `Image: ${img.alt}` : "Image");
  box.showModal();
}

export function watchImages() {
  $("#doc").addEventListener("click", (event) => {
    const img = event.target.closest("img");
    if (!img || img.closest("a[href]") || event.button !== 0 || !getSelection().isCollapsed) return;
    if (event.metaKey || event.ctrlKey) {
      window.open(img.currentSrc || img.src, "_blank", "noopener");
      return;
    }
    event.preventDefault();
    openLightbox(img);
  });

  const box = $("#lightbox");
  box.addEventListener("click", (event) => {
    if (event.target !== $("#lightbox-img")) box.close();
  });
  // The dialog closes itself on Escape. Stop the key here so it does not also close comments behind it.
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  box.addEventListener("close", () => $("#lightbox-img").removeAttribute("src"));
}
