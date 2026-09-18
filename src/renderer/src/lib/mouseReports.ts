/**
 * Filtering the mouse reports xterm sends to a PTY.
 *
 * A TUI that turns on mouse tracking (Claude Code does) receives every button
 * press as an escape sequence. Two of those are the app's, not the TUI's:
 *
 *   • right-button presses and releases — right-click opens the pane menu, and
 *     Claude Code reads a right-button press as "paste the clipboard", so the
 *     same click both opened the menu and dumped the clipboard into the prompt;
 *   • pure motion while the pane is unfocused — hovering must not repaint the TUI
 *     (the status engine would read the repaint as the agent working).
 *
 * SGR reports (mode 1006) are `ESC [ < Cb ; X ; Y (M|m)`. The low two bits of Cb
 * are the button (0 left, 1 middle, 2 right, 3 none), 4/8/16 are Shift/Meta/Ctrl,
 * 32 marks motion and 64 the wheel. Legacy X10 reports are `ESC [ M` followed by
 * three bytes, the first being 32 + Cb.
 */

const SGR = /\x1b\[<(\d+);\d+;\d+[Mm]/g
const X10 = /\x1b\[M([\s\S])[\s\S]{2}/g

/** A right-button press, release or drag — any modifiers, never the wheel. */
function isRightButton(cb: number): boolean {
  return (cb & 64) === 0 && (cb & 3) === 2
}

/** Motion with no button held: hover. */
function isHover(cb: number): boolean {
  return (cb & 32) !== 0 && (cb & 64) === 0 && (cb & 3) === 3
}

export interface MouseFilter {
  /** Drop hover reports too — true while the pane does not own focus. */
  dropHover: boolean
}

/** The data with the app-owned mouse reports removed; '' when nothing is left. */
export function filterMouseReports(data: string, filter: MouseFilter): string {
  if (!data.includes('\x1b[')) return data
  const drop = (cb: number): boolean => isRightButton(cb) || (filter.dropHover && isHover(cb))
  return data
    .replace(SGR, (whole, cb: string) => (drop(Number(cb)) ? '' : whole))
    .replace(X10, (whole, byte: string) => (drop(byte.charCodeAt(0) - 32) ? '' : whole))
}
