import { $, root } from "./dom.js";

const THEMES = ["auto", "light", "dark"];
export const PREFERS_DARK = matchMedia("(prefers-color-scheme: dark)");

export function applyTheme() {
  const pref = localStorage.getItem("mdview.theme") || "auto";
  const dark = pref === "dark" || (pref === "auto" && PREFERS_DARK.matches);
  root.dataset.theme = dark ? "dark" : "light";
  $("#hljs-light").disabled = dark;
  $("#hljs-dark").disabled = !dark;
  const button = $("#theme");
  button.dataset.pref = pref;
  button.title = `Theme: ${pref}. Click to change.`;
}

export function cycleTheme() {
  const pref = localStorage.getItem("mdview.theme") || "auto";
  localStorage.setItem("mdview.theme", THEMES[(THEMES.indexOf(pref) + 1) % THEMES.length]);
  applyTheme();
}
