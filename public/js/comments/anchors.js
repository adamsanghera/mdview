/** Between DOM selections and a block's text: what the server anchors to, and what a thread highlights. */
import { $ } from "../dom.js";
import { findQuote } from "../lib/quote.js";
import { state } from "../state.js";

const DECORATIONS = ".heading-anchor, .code-copy";

export function blockAt(node) {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const block = el?.closest("[data-block]");
  return block && $("#doc").contains(block) ? block : null;
}

/** A block's own text nodes, leaving out mdview's decorations and any nested block. */
function ownTextNodes(block) {
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement.closest("[data-block]") === block && !node.parentElement.closest(DECORATIONS)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

/** The character offset of a DOM point within the concatenated text of `nodes`. */
function textOffset(nodes, container, offset) {
  const point = document.createRange();
  point.setStart(container, offset);
  let total = 0;
  for (const node of nodes) {
    if (node === container) return total + offset;
    if (point.comparePoint(node, node.length) > 0) break;
    total += node.length;
  }
  return total;
}

function domPoint(nodes, offset) {
  for (const node of nodes) {
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
  }
  const last = nodes.at(-1);
  return [last, last.length];
}

/** What the server needs to anchor a selection: its block, the quote trimmed to that block, and its offset. */
export function anchorFromRange(range) {
  const block = blockAt(range.startContainer);
  if (!block) return null;
  const nodes = ownTextNodes(block);
  const text = nodes.map((n) => n.data).join("");
  const start = textOffset(nodes, range.startContainer, range.startOffset);
  const end = block.contains(range.endContainer) ? textOffset(nodes, range.endContainer, range.endOffset) : text.length;
  const raw = text.slice(start, end);
  const quote = raw.trim();
  if (!quote) return null;
  return { blockIndex: Number(block.dataset.block), quote, start: start + raw.length - raw.trimStart().length };
}

/** The Range a thread highlights: its quote inside its block, or the whole block when the quote is not there. */
export function rangeFor(thread) {
  const block = $(`#doc [data-block="${thread.blockIndex}"]`);
  const nodes = block ? ownTextNodes(block) : [];
  if (!nodes.length) return null;
  const text = nodes.map((n) => n.data).join("");
  const [start, end] = findQuote(text, thread.quote, thread.start) ?? [0, text.length];
  const range = document.createRange();
  range.setStart(...domPoint(nodes, start));
  range.setEnd(...domPoint(nodes, end));
  return range;
}

export function threadAtPoint(x, y) {
  let node;
  let offset;
  if (document.caretPositionFromPoint) {
    ({ offsetNode: node, offset } = document.caretPositionFromPoint(x, y) ?? {});
  } else {
    ({ startContainer: node, startOffset: offset } = document.caretRangeFromPoint?.(x, y) ?? {});
  }
  if (!node) return null;
  for (const [id, range] of state.comments.ranges) {
    if (range.isPointInRange(node, offset)) return id;
  }
  return null;
}
