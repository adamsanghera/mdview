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

/** Grows a textarea to fit its text. */
export function autosize(input) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + 2}px`;
}
