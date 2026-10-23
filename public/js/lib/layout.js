/**
 * Decides whether the comment rail docks beside the doc, and whether the
 * outline gives up its column for it. Widths are in px: `content` is the
 * column the doc sits in with the outline shown, and `toc` is the outline's
 * width (0 when it is hidden anyway). The rail is `wanted` while there is
 * anything to show in it. The outline yields only when the rail fits without
 * it but not with it; when the rail does not fit even then, it opens as a
 * drawer and the outline stays.
 */
export function railLayout({ wanted, content, toc, doc, rail, gap }) {
  const need = doc + rail + gap;
  if (wanted && content >= need) return { docked: true, tocYields: false };
  if (wanted && toc > 0 && content + toc >= need) return { docked: true, tocYields: true };
  return { docked: false, tocYields: false };
}
