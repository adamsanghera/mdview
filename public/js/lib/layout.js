/** Whether the comment rail fits beside the doc in `contentWidth` px; otherwise it opens as a drawer. */
export function railFits({ contentWidth, docWidth, railWidth, railGap }) {
  return contentWidth >= docWidth + railWidth + railGap;
}
