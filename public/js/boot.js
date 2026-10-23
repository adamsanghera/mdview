// A classic script in <head>: it applies the saved theme and file-list state before the first paint, so neither flashes.
(function () {
  var pref = localStorage.getItem("mdview.theme") || "auto";
  var dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.getElementById("hljs-light").disabled = dark;
  document.getElementById("hljs-dark").disabled = !dark;
  if (localStorage.getItem("mdview.sidebar") === "hidden") document.documentElement.classList.add("no-sidebar");
})();
