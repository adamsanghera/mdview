/**
 * Stacks margin cards level with their highlights, without overlap. `items`
 * are sorted by `target`, the highlight's top, and carry their `height`. The
 * card at `pivot` (the open one) sits at its target. Cards below it stack
 * downward and cards above it upward; if that pushes the top card above
 * `minTop`, every card shifts down together. Returns each card's top.
 */
export function stackCards(items, { pivot = 0, minTop = 0, gap = 0 }) {
  const tops = [];
  tops[pivot] = Math.max(items[pivot].target, minTop);
  for (let i = pivot + 1; i < items.length; i++) {
    tops[i] = Math.max(items[i].target, tops[i - 1] + items[i - 1].height + gap);
  }
  for (let i = pivot - 1; i >= 0; i--) {
    tops[i] = Math.min(items[i].target, tops[i + 1] - gap - items[i].height);
  }
  const shift = Math.max(0, minTop - tops[0]);
  return tops.map((top) => top + shift);
}
