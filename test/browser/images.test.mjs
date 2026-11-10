import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { startViewer } from "../helpers/viewer.mjs";
import { click } from "../helpers/viewer-page.mjs";

const PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#2f6feb"/></svg>';

const DOC = `# Pictures

The home page, before:

![The home page](home.svg)

A picture that links somewhere else:

[![The other page](home.svg)](other.md)

The end.
`;

const chrome = sharedChrome();

/** A viewer on doc.md, and a tab on it whose window.open only records what it was asked to open. */
async function setup(t, port) {
  const viewer = await startViewer({ files: { "doc.md": DOC, "home.svg": PICTURE, "other.md": "# Other\n\nSomewhere else.\n" }, initial: "doc.md", port });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  await page.waitFor(
    () => {
      const imgs = [...document.querySelectorAll("#doc img")];
      return imgs.length === 2 && imgs.every((img) => img.complete && img.naturalWidth > 0);
    },
    { what: "the pictures to load" },
  );
  await page.eval(() => {
    window.opened = [];
    window.open = (url) => window.opened.push(url);
  });
  return page;
}

const lightboxOpen = (page) => page.eval(() => document.querySelector("#lightbox").open);

async function openPicture(page) {
  await click(page, '#doc img[alt="The home page"]');
  await page.waitFor(() => document.querySelector("#lightbox").open, { what: "the picture to open" });
}

async function mouseClick(page, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

test("a picture opens over the doc, not in a new tab, and Escape closes it", { skip: chromeMissing }, async (t) => {
  const page = await setup(t, 47490);
  const before = await page.eval(() => location.href);
  await openPicture(page);

  const shown = await page.eval(() => {
    const img = document.querySelector("#lightbox-img");
    return { src: new URL(img.src).pathname, alt: img.alt, onTop: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === img };
  });
  assert.deepEqual(shown, { src: "/raw/home.svg", alt: "The home page", onTop: true });
  assert.deepEqual(await page.eval(() => window.opened), []);
  assert.equal(await page.eval(() => location.href), before);

  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.waitFor(() => !document.querySelector("#lightbox").open, { what: "Escape to close the picture" });
  await page.waitFor(() => !document.querySelector("#lightbox-img").hasAttribute("src"), { what: "the closed picture to let go of its image" });
});

test("a click off the picture or on the close button closes it, and a click on the picture does not", { skip: chromeMissing }, async (t) => {
  const page = await setup(t, 47491);
  await openPicture(page);

  const center = await page.eval(() => {
    const box = document.querySelector("#lightbox-img").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await mouseClick(page, center.x, center.y);
  assert.equal(await lightboxOpen(page), true, "a click on the picture keeps it open");

  await mouseClick(page, 10, center.y);
  await page.waitFor(() => !document.querySelector("#lightbox").open, { what: "a click outside to close the picture" });

  await openPicture(page);
  await click(page, "#lightbox-close");
  await page.waitFor(() => !document.querySelector("#lightbox").open, { what: "the close button to close the picture" });
  assert.deepEqual(await page.eval(() => window.opened), []);
});

test("a picture inside a link follows the link, and ⌘-click still opens a picture in a new tab", { skip: chromeMissing }, async (t) => {
  const page = await setup(t, 47492);

  await page.eval(() => {
    const img = document.querySelector('#doc img[alt="The home page"]');
    img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
  });
  assert.equal(await lightboxOpen(page), false);
  assert.deepEqual(await page.eval(() => window.opened.map((url) => new URL(url).pathname)), ["/raw/home.svg"]);

  await click(page, '#doc img[alt="The other page"]');
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Other"), { what: "the link to open other.md" });
  assert.equal(await lightboxOpen(page), false);
  assert.equal(await page.eval(() => window.opened.length), 1);
});
