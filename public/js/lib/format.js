/** Text helpers for the viewer's HTML and labels. */

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How long before `now` the time `ms` was: "just now", "5m ago", "3h ago", or a date. */
export function ago(ms, now = Date.now()) {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
