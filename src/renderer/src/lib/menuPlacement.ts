/**
 * Where a dropdown menu `width` wide goes across, for a trigger spanning
 * `triggerLeft`–`triggerRight` in a window `viewportWidth` wide.
 *
 * Left edges line up while the menu fits; otherwise right edges do, so a trigger
 * near the window's right side (the Todo board's workspace filter, say) opens its
 * menu leftward instead of off the edge. Either way it stays `pad` off both sides.
 * The menu's own width is what decides this — its rows are often far wider than
 * the button that opens them.
 */
export function menuLeft(
  triggerLeft: number,
  triggerRight: number,
  width: number,
  viewportWidth: number,
  pad: number
): number {
  const fitsLeftAligned = triggerLeft + width <= viewportWidth - pad
  const left = fitsLeftAligned ? triggerLeft : triggerRight - width
  return Math.max(pad, Math.min(left, viewportWidth - width - pad))
}
