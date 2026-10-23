/**
 * Where a comment's tick goes on the outline. `sectionTops` are the page
 * offsets of the outline's headings, in order; `y` is the comment's. Returns
 * the section the comment sits in (the first one for comments above it) and
 * how far into that section it is, from 0 to 1, so several comments in one
 * section spread out instead of stacking.
 */
export function placeTick(sectionTops, y, docEnd) {
  const index = Math.max(0, sectionTops.findLastIndex((top) => top <= y));
  const start = sectionTops[index];
  const end = sectionTops[index + 1] ?? docEnd;
  const share = Math.min(1, Math.max(0, (y - start) / Math.max(1, end - start)));
  return { index, share };
}
