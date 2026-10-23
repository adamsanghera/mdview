/**
 * Builds the viewer's one stylesheet from the files under public/styles/.
 *
 * The server runs this on every request for /static/style.css instead of
 * serving a file built ahead of time: a few small reads cost nothing locally,
 * there is no build step to forget and no generated bundle to go stale in
 * git, and a tab reload still shows a CSS edit at once.
 */
import fs from "node:fs/promises";
import path from "node:path";

const IMPORT = /^@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;[^\S\n]*$/gm;

/**
 * Returns `entry` with each top-level `@import "file.css";` line replaced by
 * that file's contents, recursively, each preceded by a comment naming it.
 * A missing file or an import cycle throws.
 */
export async function bundleCss(entry) {
  const base = path.dirname(entry);
  async function inline(file, stack) {
    if (stack.includes(file)) throw new Error(`CSS import cycle: ${[...stack, file].map((f) => path.relative(base, f)).join(" -> ")}`);
    const text = await fs.readFile(file, "utf8");
    let out = "";
    let last = 0;
    for (const match of text.matchAll(IMPORT)) {
      const target = path.resolve(path.dirname(file), match[1]);
      out += text.slice(last, match.index);
      out += `/* ${path.relative(base, target)} */\n${await inline(target, [...stack, file])}`;
      last = match.index + match[0].length;
    }
    return out + text.slice(last);
  }
  return inline(path.resolve(entry), []);
}
