/** In-page navigation: links to other docs and versions load without a page reload. */
import { root, toast } from "./dom.js";
import { loadDoc, scrollToHash } from "./doc.js";
import { relFromPathname, threadFromSearch, versionFromSearch } from "./lib/paths.js";
import { state } from "./state.js";

/**
 * Set by main.js, so this module need not know about comments: `inbox`
 * shows the /inbox page, and `thread` opens a thread on the doc shown.
 */
export const navHooks = { inbox() {}, thread() {} };

export function navigate(url) {
  const rel = relFromPathname(url.pathname);
  const version = versionFromSearch(url.search);
  history.pushState(null, "", url.pathname + url.search + url.hash);
  root.classList.remove("sidebar-open");
  if (url.pathname === "/inbox") {
    navHooks.inbox();
    return;
  }
  const thread = threadFromSearch(url.search);
  if (rel === state.doc?.path && version === state.viewVersion) {
    if (thread) navHooks.thread(thread);
    else scrollToHash(url.hash);
    return;
  }
  // Opened once the doc's comments load.
  state.comments.activateAfterLoad = thread;
  loadDoc(rel, { hash: url.hash, version });
}

export function watchNavigation() {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[href]");
    if (!link || link.target === "_blank") return;
    if (link.classList.contains("outside-root")) {
      event.preventDefault();
      toast(link.title);
      return;
    }
    const url = new URL(link.getAttribute("href"), location.href);
    if (url.origin === location.origin && (url.pathname.startsWith("/view") || url.pathname === "/inbox")) {
      event.preventDefault();
      navigate(url);
    }
  });

  addEventListener("popstate", () => {
    if (location.pathname === "/inbox") {
      navHooks.inbox();
      return;
    }
    const rel = relFromPathname(location.pathname);
    const version = versionFromSearch(location.search);
    if (rel === state.doc?.path && version === state.viewVersion) scrollToHash(location.hash);
    else loadDoc(rel, { version });
  });
}
