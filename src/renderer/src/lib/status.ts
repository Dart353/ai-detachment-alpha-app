/**
 * Pane status: the blend of PTY activity, transcript state and what is on the
 * screen that decides which pill a pane wears. Pure — no React, no IPC — so the
 * whole truth table is unit-testable.
 */
import type { PaneKind, PaneStatus, SessionInfo } from '../../../shared/types'

// Thresholds tuned to cut false "needs input" on long-running tools: a genuine
// permission prompt sits silent indefinitely, whereas an in-flight tool that
// emits nothing to the terminal (e.g. a network/MCP call) usually settles
// within a few seconds — so we wait longer before calling it attention.
/** PTY output within this window = actively working. */
export const ATTENDING_WINDOW_MS = 4000
/** transcript pending-tool + PTY quiet this long = waiting on the user. */
export const AWAITING_QUIET_MS = 8000
/**
 * A transcript that says "turn over" only overrules live PTY output once it has
 * held for this long: submitting a prompt paints the terminal a beat before the
 * watcher's next poll sees the new entry, and without the grace that gap would
 * flash the pane back to idle.
 */
export const ENDED_SETTLE_MS = 2500
/** sustained idle after work = "task complete" (avoids mid-task pauses). */
export const COMPLETE_GRACE_MS = 6000

/** Non-Claude panes have no transcript, so their status is pure PTY liveness. */
const SHELL_ACTIVE_MS = 1500

export interface StatusInput {
  kind: PaneKind
  /** the PTY is gone */
  exited: boolean
  now: number
  /** epoch ms of the last *real* PTY output (see `isRealOutput`) */
  lastActivityMs: number | undefined
  session?: SessionInfo
  /** a blocking prompt is visible on the terminal right now */
  promptOnScreen: boolean
  /** a turn ended while this pane was unfocused and the user hasn't looked yet */
  unseenDone: boolean
}

export function resolveStatus(input: StatusInput): PaneStatus {
  if (input.exited) return 'exited'
  if (input.kind === 'viewer') return 'idle'

  const quietFor = input.now - (input.lastActivityMs ?? 0)

  if (input.kind !== 'claude') return quietFor < SHELL_ACTIVE_MS ? 'working' : 'idle'

  const session = input.session
  // PTY bytes prove the pane is *painting*, not that anyone is working: a
  // finished Claude still redraws (background-agent counters, footer hints,
  // cursor housekeeping), which used to pin the pane at "Working" forever. So a
  // live pane must ALSO have an open turn in its transcript. The 'ended' verdict
  // has to settle first — pressing Enter writes the new prompt on the next
  // watcher poll, and without the grace the pill would blink to idle in between.
  const settledEnded =
    session?.turnState === 'ended' && input.now - (session.lastWriteMs || 0) > ENDED_SETTLE_MS
  if (quietFor < ATTENDING_WINDOW_MS && !settledEnded) return 'working'

  // A blocking prompt visible on the terminal is definitive (permission / trust
  // dialogs never reach the transcript); the transcript's pending-tool + long
  // quiet is the fallback signal.
  const needsInput =
    input.promptOnScreen ||
    (session?.jsonlStatus === 'pending-tool' && quietFor > AWAITING_QUIET_MS)
  if (needsInput) return 'attention'

  return input.unseenDone ? 'done' : 'idle'
}

// Claude Code's TUI asks the terminal where its cursor is five times a second —
// ESC[?6n / ESC[6n — for as long as the pane lives, working or not, and xterm
// dutifully answers each one. Those five-byte pokes are a heartbeat, not output:
// counting them as activity kept every Claude pane's PTY permanently "busy", so
// a pane that had long since finished still read "Working". The terminal must
// still receive them (it owes a reply), but a chunk that carries nothing else is
// not the agent doing anything.
export const CURSOR_QUERY_RE = /\x1b\[\??6n/g

/** Does this PTY chunk carry anything beyond cursor-position polling? */
export function isRealOutput(data: string): boolean {
  // Only the small chunks can be pure heartbeat; skip the scan for real streams.
  if (data.length > 64) return true
  return data.replace(CURSOR_QUERY_RE, '').length > 0
}

// Markers Claude Code's TUI draws for blocking prompts — permission dialogs
// ("Esc to cancel"), trust/confirm screens ("Enter to confirm"), and the shared
// "Do you want…" lead-in. Deliberately NOT "esc to interrupt", which shows while
// working. COUPLED TO CLAUDE CODE'S WORDING: if a release rephrases its dialogs,
// update this list (or install the hooks, which are exact and version-proof).
export const BLOCKING_PROMPT_MARKERS = /Do you want|Esc to cancel|Enter to confirm/i

export const STATUS_LABEL: Record<PaneStatus, string> = {
  working: 'Working',
  attention: 'Needs input',
  idle: 'Idle',
  done: 'Done',
  exited: 'Exited'
}
