/**
 * Places a table wider than the text column the way Notion does. Its scroll
 * box is centered on the text and reaches `reach` px past both sides; the
 * table starts flush with the text's left edge, so scrolling right pans it
 * across the space on the left. In order of preference, a table sits flush
 * and runs right; wraps to fill from the text's left edge to the box's right
 * edge; moves left just enough to fit without scrolling; or starts flush and
 * scrolls.
 *
 * Widths are in px: `natural` is the table's max-content width, `narrowest`
 * its min-content width. Returns null when the table fits the text column,
 * else the box's width, the table's inset (left padding) in it, and the
 * table's width.
 */
export function placeTable({ natural, narrowest, textWidth, reach }) {
  if (natural <= textWidth) return null;
  const toRightEdge = textWidth + reach;
  const box = textWidth + 2 * reach;
  const width = natural <= toRightEdge ? natural : Math.max(toRightEdge, narrowest);
  const inset = (width <= toRightEdge || width > box) ? reach : box - width;
  return { box, inset, width };
}
