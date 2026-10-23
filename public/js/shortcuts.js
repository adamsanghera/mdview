/** Keyboard shortcuts: ⌘⇧M comments, / filters files, \ toggles the file list, Escape closes things. */
import { $, root } from "./dom.js";
import { closeComposer, openComposer } from "./comments/composer.js";
import { deactivate } from "./comments/rail.js";
import { closeVersionsMenu } from "./comments/topbar.js";
import { navigate } from "./nav.js";
import { renderTree, showSidebar, toggleSidebar } from "./sidebar.js";

export function watchShortcuts() {
  addEventListener("keydown", (event) => {
    const typing = event.target.matches("input, textarea, select, [contenteditable]");
    // Notion's ⌘⇧M, or Google Docs' ⌘⌥M where the browser keeps ⌘⇧M for itself.
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyM" && (event.shiftKey || event.altKey)) {
      event.preventDefault();
      openComposer();
    } else if (event.key === "Escape" && !typing) {
      if (!closeComposer() && !closeVersionsMenu() && !deactivate()) root.classList.remove("drawer-open");
    } else if (event.key === "/" && !typing) {
      event.preventDefault();
      showSidebar();
      $("#filter").focus();
      $("#filter").select();
    } else if (event.key === "\\" && !typing) {
      event.preventDefault();
      toggleSidebar();
    } else if (event.target === $("#filter")) {
      if (event.key === "Escape") {
        $("#filter").value = "";
        renderTree();
        $("#filter").blur();
      } else if (event.key === "Enter") {
        const first = $("#tree .file");
        if (first) {
          $("#filter").blur();
          navigate(new URL(first.href));
        }
      }
    }
  });
}
