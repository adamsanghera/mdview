/** What a person does in the viewer, done through a browser.mjs page. */

/** Selects the first occurrence of `text` in the doc, as a mouse drag would. It must sit in one text node. */
export async function select(page, text) {
  const found = await page.eval((needle) => {
    const walker = document.createTreeWalker(document.querySelector("#doc"), NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = node.data.indexOf(needle);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    }
    return false;
  }, text);
  if (!found) throw new Error(`No text node in the doc contains ${JSON.stringify(text)}`);
}

/** Opens the composer on the current selection with the keyboard shortcut. */
export async function openComposer(page) {
  await page.eval(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "M", code: "KeyM", metaKey: true, shiftKey: true, bubbles: true }));
  });
  await page.waitFor(() => !document.querySelector("#composer").hidden, { what: "the composer to open" });
}

/** Types `body` into a textarea and presses Enter, with ⌥ when `alt`. */
export async function typeAndEnter(page, selector, body, { alt = false } = {}) {
  await page.eval(
    (sel, text, altKey) => {
      const input = document.querySelector(sel);
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey, bubbles: true, cancelable: true }));
    },
    selector,
    body,
    alt,
  );
}

/** Comments on `quote`: selects it, opens the composer, and submits `body`. Batches it when `batch`. */
export async function comment(page, quote, body, { batch = false } = {}) {
  await select(page, quote);
  await openComposer(page);
  await typeAndEnter(page, "#composer-text", body, { alt: batch });
  await page.waitFor(() => document.querySelector("#composer").hidden, { what: "the composer to close" });
}

/** The text each range of the `mdview-comment-<name>` highlight covers. */
export function highlighted(page, name = "open") {
  return page.eval((key) => [...(CSS.highlights.get(`mdview-comment-${key}`) ?? [])].map((range) => range.toString()), name);
}

/** Clicks the first element matching `selector`. */
export async function click(page, selector) {
  const clicked = await page.eval((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  }, selector);
  if (!clicked) throw new Error(`Nothing matches ${selector}`);
}
