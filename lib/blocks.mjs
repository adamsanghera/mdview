import { createHash } from "node:crypto";

const BLOCK_KIND_BY_TOKEN = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  fence: "code",
  code_block: "code",
  tr_open: "row",
};

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Collapses whitespace runs so reflowed text compares equal. */
export function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function blockText(tokens, i) {
  const token = tokens[i];
  if (token.type === "fence") return `${token.info}\n${token.content}`;
  if (token.type === "code_block") return token.content;
  if (token.type === "tr_open") {
    const cells = [];
    for (let j = i + 1; j < tokens.length && tokens[j].type !== "tr_close"; j++) {
      if (tokens[j].type === "inline") cells.push(tokens[j].content);
    }
    return cells.join(" | ");
  }
  return tokens[i + 1].content;
}

function enclosingListItem(tokens, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (tokens[j].type === "list_item_open" && tokens[j].level === tokens[i].level - 1) return tokens[j];
  }
  return tokens[i];
}

/**
 * Finds the commentable blocks in markdown-it tokens: headings, paragraphs,
 * code blocks and table rows. Tags the element that renders each block with
 * data-block="<index>" so the browser can map a selection to its block.
 *
 * A block's `sha` hashes its kind and whitespace-collapsed source text, so
 * reflowing a paragraph or renumbering a list keeps it. `ordinal` counts
 * earlier blocks with the same sha, telling apart two "TBD" paragraphs.
 * Lines are 1-based and inclusive in the file: `lineOffset` adds back the
 * front matter cut off before parsing.
 */
export function extractBlocks(tokens, lineOffset = 0) {
  const blocks = [];
  const seen = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const kind = BLOCK_KIND_BY_TOKEN[token.type];
    if (!kind || !token.map) continue;
    const text = normalizeText(blockText(tokens, i));
    const sha = sha256(`${kind}\n${text}`);
    const ordinal = seen.get(sha) ?? 0;
    seen.set(sha, ordinal + 1);
    // Paragraphs in tight lists render no <p>, so their list item carries the tag.
    const host = token.hidden ? enclosingListItem(tokens, i) : token;
    host.attrSet("data-block", String(blocks.length));
    blocks.push({
      index: blocks.length,
      kind,
      sha,
      ordinal,
      text,
      startLine: token.map[0] + lineOffset + 1,
      endLine: token.map[1] + lineOffset,
    });
  }
  return blocks;
}

/**
 * Finds where an anchor ({blockSha, ordinal}) lands among one version's
 * blocks. It attaches to the block with the same text, or is "outdated" when
 * no block has that text. Among identical blocks it takes the same ordinal,
 * or the last one when fewer remain.
 */
export function locate(anchor, blocks) {
  const same = blocks.filter((b) => b.sha === anchor.blockSha);
  if (same.length === 0) return { state: "outdated" };
  return { state: "attached", block: same[Math.min(anchor.ordinal, same.length - 1)] };
}
