/**
 * mdview as a peanut app: one document type, a Markdown file keyed by its
 * realpath, whose threads sit on its blocks.
 *
 * markdown.block parses with mdview's own markdown-it (lib/render.mjs), so
 * a thread's block is the same block the page tags with data-block, front
 * matter and plugins included.
 */
import fs from "node:fs";
import path from "node:path";
import { markdownBlock } from "peanut";
import { blockTokens } from "./render.mjs";

export const DOC = "mdview.doc";
export const BLOCK = "markdown.block";

/** A file's text, or null when it cannot be read. */
export function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export const mdviewApp = {
  name: "mdview",
  anchorTypes: [markdownBlock({ tokenize: blockTokens })],
  documentTypes: [
    {
      name: DOC,
      noun: "doc",
      anchorTypes: [BLOCK],
      readContent(key) {
        const content = readOrNull(key);
        return content === null ? null : { content };
      },
      displayName: (key) => path.basename(key),
    },
  ],
};
