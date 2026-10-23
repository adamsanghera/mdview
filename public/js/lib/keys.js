/**
 * What a submit key does: "now" sends at once, "batch" adds to the batch, and
 * "send" adds to the batch and sends it. Plain Enter sends now until a batch
 * is open, then adds to it. ⌘Enter also sends the batch, and ⌥Enter does
 * whichever of the two Enter does not.
 */
export function submitMode({ altKey, metaKey, ctrlKey }, batching) {
  if (altKey) return batching ? "now" : "batch";
  if (metaKey || ctrlKey) return batching ? "send" : "now";
  return batching ? "batch" : "now";
}

/** The keys for the composer and reply boxes, which change once a batch is open. */
export function keyHint(batching) {
  return batching
    ? "Enter adds to your batch · ⌘Enter sends the batch · ⌥Enter sends just this"
    : "Enter sends · ⌥Enter starts a batch";
}
