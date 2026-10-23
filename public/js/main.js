/**
 * The viewer's entry point. It wires the modules together and starts them.
 *
 * Modules depend downward only: lib/ holds pure functions (no DOM, so
 * node --test imports them); dom.js and state.js sit under everything else;
 * doc.js and sidebar.js know nothing of comments, and announce what happens
 * through hook objects that this file fills in; comments/ builds on all of
 * them. Keeping it one-way is what lets each part be read, and tested, alone.
 */
import { composerOpen } from "./comments/composer.js";
import { forgetRanges, initComments, loadComments, onLayoutChange, resetComments } from "./comments/index.js";
import { $, copyText, getJson, toast } from "./dom.js";
import { docHooks, loadDoc, renderMeta, showError } from "./doc.js";
import { encodePath, relFromPathname, versionFromSearch } from "./lib/paths.js";
import { watchNavigation } from "./nav.js";
import { scheduleScrollUpdate, updateScroll } from "./scroll.js";
import { watchShortcuts } from "./shortcuts.js";
import { refreshTree, renderTree, sidebarHooks, toggleSidebar } from "./sidebar.js";
import { state } from "./state.js";
import { layoutTables, scheduleTableLayout } from "./tables.js";
import { applyTheme, cycleTheme, PREFERS_DARK } from "./theme.js";

docHooks.leaving = resetComments;
docHooks.replaced = forgetRanges;
docHooks.loaded = loadComments;
docHooks.commentsChanged = loadComments;
docHooks.holdReload = composerOpen;
sidebarHooks.resized = () => {
  onLayoutChange();
  layoutTables();
};

async function init() {
  applyTheme();
  PREFERS_DARK.addEventListener("change", applyTheme);
  $("#theme").addEventListener("click", cycleTheme);
  $("#toggle-sidebar").addEventListener("click", toggleSidebar);
  $("#filter").addEventListener("input", renderTree);
  $("#crumbs").addEventListener("click", async () => {
    if (state.doc && (await copyText(state.doc.abs))) toast(`Copied ${state.doc.abs}`);
  });
  $("#copy-md").addEventListener("click", async () => {
    if (!state.doc) return;
    const res = await fetch(`/raw/${encodePath(state.doc.path)}`, { cache: "no-store" });
    if (await copyText(await res.text())) toast("Copied the Markdown");
  });
  addEventListener("focus", refreshTree);
  addEventListener("scroll", scheduleScrollUpdate, { passive: true });
  addEventListener("resize", updateScroll);
  addEventListener("resize", onLayoutChange);
  addEventListener("resize", scheduleTableLayout);
  watchNavigation();
  watchShortcuts();
  setInterval(renderMeta, 30_000);

  try {
    const [info, tree] = await Promise.all([getJson("/api/info"), getJson("/api/tree")]);
    state.info = info;
    state.files = tree.files;
  } catch (err) {
    showError("", err);
    return;
  }
  initComments();
  renderTree();
  await loadDoc(relFromPathname(location.pathname), { version: versionFromSearch(location.search) });
}

init();
