/** Page helpers every module uses: element lookup, the server's JSON API, toasts and the clipboard. */

export const $ = (selector) => document.querySelector(selector);
export const root = document.documentElement;

export async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

/** POSTs `body` as JSON. A refusal throws an Error carrying the server's message and HTTP `status`. */
export async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

let toastTimer;
export function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast("The browser blocked clipboard access");
    return false;
  }
}

/**
 * The closed toggles (<details>) that hide `node`, innermost first. A
 * toggle's title (its <summary>) shows while it is closed, so a node in the
 * title is not hidden by that toggle.
 */
export function closedTogglesAround(node) {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const toggles = [];
  for (let toggle = el?.closest("details"); toggle; toggle = toggle.parentElement?.closest("details")) {
    if (!toggle.open && !toggle.querySelector(":scope > summary")?.contains(el)) toggles.push(toggle);
  }
  return toggles;
}

export function openTogglesAround(node) {
  for (const toggle of closedTogglesAround(node)) toggle.open = true;
}

/** Grows a textarea to fit its text. */
export function autosize(input) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + 2}px`;
}
