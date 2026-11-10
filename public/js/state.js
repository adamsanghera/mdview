/** The viewer's shared state. Modules read and write it directly; main.js decides who renders when. */

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export const state = {
  info: null,
  files: [],
  /** Threads waiting on the human, by root-relative doc path. Docs with none are left out. */
  waiting: {},
  doc: null,
  headings: [],
  events: null,
  expanded: new Set(readJson("mdview.expanded", [])),
  viewVersion: null,
  comments: {
    enabled: false,
    threads: [],
    version: null,
    loaded: null,
    ranges: new Map(),
    nowRanges: new Map(),
    activateAfterLoad: null,
    active: null,
    listMode: false,
    /** Set once the margin has held a thread on the doc shown, so resolving the last one does not take the margin away and move the doc sideways. */
    railHeld: false,
    replyText: new Map(),
    selection: null,
    composerText: "",
    pendingCount: 0,
    /** Whether new comments and replies go into the batch, as the submit buttons' menus set it. */
    batch: localStorage.getItem("mdview.batch") === "on",
  },
};

export function threadById(id) {
  return state.comments.threads.find((t) => t.id === id);
}
