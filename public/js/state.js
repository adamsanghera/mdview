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
    replyText: new Map(),
    selection: null,
    composerText: "",
    pendingCount: 0,
  },
};

export function threadById(id) {
  return state.comments.threads.find((t) => t.id === id);
}
