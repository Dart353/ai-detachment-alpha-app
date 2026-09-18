/**
 * The completion gate — one "task complete" per pane turn.
 *
 * An agent that orchestrates background agents does NOT stop once. Every agent
 * that reports in re-invokes the agent's main loop, that short handling turn
 * ends, and Claude Code fires another perfectly genuine `Stop` hook for the
 * pane's OWN session. One orchestrated run observed in the wild fired thirteen
 * of them for a single instruction — thirteen sounds, thirteen banners, none of
 * which meant the work was done.
 *
 * Three facts, read off the hook payload and the transcript, make those
 * separable from a real end of turn:
 *
 *  - the turn's ORIGIN. A subagent reporting in is written into the transcript
 *    as a prompt of its own, stamped `origin.kind: "task-notification"` /
 *    `promptSource: "system"`. A Stop ending such a turn is, by definition, a
 *    per-subagent completion.
 *  - AGENTS LAUNCHED this turn (`toolUseResult.status: 'async_launched'`): the
 *    agent dispatched a fleet and is going to be woken by it, so its stop is
 *    the start of the work, not the end of it.
 *  - AGENTS RUNNING, off `background_tasks` — the same thing for Claude Code
 *    teammates, which (unlike the Agent tool) keep the instruction's prompt_id
 *    across every wake-up.
 *
 * A Stop carrying any of the three is HELD rather than announced; a Stop
 * carrying none of them is a plain agent finishing a plain turn and announces
 * at once.
 *
 * `prompt_id` then backs that up: it identifies the instruction for the
 * teammate flavour of the problem (thirteen stops, one prompt_id), so once a
 * notification has fired for an instruction the rest of its stops are dropped
 * outright.
 *
 * The held notification fires once the pane has been quiet (no further Stop, no
 * transcript write) for SETTLE_MS, and the gate then latches for that
 * instruction: the remaining agent-completion Stops are dropped outright — no
 * sound, no banner. A pane with no agents in flight is untouched: its Stop
 * announces immediately, exactly as it always did.
 *
 * Pure state in / state out, no timers and no clock of its own, so a whole
 * orchestrated run can be driven through it in a test.
 */

export interface CompletionGate {
  /** the instruction the last Stop belonged to (null = unknown/legacy payload) */
  promptId: string | null
  /** we have already announced for that instruction */
  rang: boolean
  /** epoch ms of the Stop whose notification is being held; null when nothing is held */
  heldAt: number | null
}

/** How long the pane must stay quiet before a held completion announces. */
export const SETTLE_MS = 120_000
/**
 * The stopping turn's own transcript write lands around the Stop itself, so a
 * write this close to it is not "the agent spoke again" and must not re-arm.
 */
export const WRITE_GRACE_MS = 5_000

export function newGate(): CompletionGate {
  return { promptId: null, rang: false, heldAt: null }
}

/** announce now / hold for the settle window / drop as an intermediate. */
export type StopVerdict = 'ring' | 'hold' | 'drop'

/** The three "this pane is working with a fleet" tells, off one HookEvent. */
export interface StopSignals {
  promptId: string | null
  agentsRunning: boolean
  fromTaskNotification: boolean
  agentsLaunched: boolean
}

/** True when a Stop is about a fleet rather than about the agent finishing. */
export function isSubagentTurn(ev: StopSignals): boolean {
  return ev.fromTaskNotification || ev.agentsLaunched || ev.agentsRunning
}

/**
 * Decide what a `Stop` hook is worth. The signals come straight off the hook
 * event; `now` is the event's timestamp.
 */
export function onStop(
  gate: CompletionGate,
  ev: StopSignals,
  now: number
): { verdict: StopVerdict; gate: CompletionGate } {
  // A payload with no prompt_id (an older Claude Code) can't identify a turn, so
  // it never latches — that path behaves as it did before the gate existed.
  const fresh = ev.promptId === null || ev.promptId !== gate.promptId
  const next: CompletionGate = fresh
    ? { promptId: ev.promptId, rang: false, heldAt: null }
    : { ...gate }

  if (next.rang) {
    // this instruction has been announced; the rest of the fleet's noise is dropped
    next.heldAt = null
    return { verdict: 'drop', gate: next }
  }
  if (isSubagentTurn(ev)) {
    next.heldAt = now // (re)start the quiet window — the agent isn't finished
    return { verdict: 'hold', gate: next }
  }
  next.rang = true
  next.heldAt = null
  return { verdict: 'ring', gate: next }
}

/**
 * Called when the settle window elapses. `lastWriteMs` is the pane's last
 * transcript write: if it advanced since the held Stop the agent is working
 * again, so the window restarts from that write rather than announcing early.
 *
 * 'idle' means nothing is held (drop the timer); 'wait' asks for another
 * `waitMs` of patience; 'ring' means the turn is over.
 */
export function onSettle(
  gate: CompletionGate,
  now: number,
  lastWriteMs: number,
  settleMs: number = SETTLE_MS
): { verdict: 'ring' | 'wait' | 'idle'; gate: CompletionGate; waitMs: number } {
  if (gate.heldAt === null || gate.rang) return { verdict: 'idle', gate, waitMs: 0 }
  const spokeSince = lastWriteMs > gate.heldAt + WRITE_GRACE_MS
  const active = spokeSince ? lastWriteMs : gate.heldAt
  const elapsed = now - active
  if (elapsed >= settleMs) {
    return { verdict: 'ring', gate: { ...gate, rang: true, heldAt: null }, waitMs: 0 }
  }
  return { verdict: 'wait', gate: { ...gate, heldAt: active }, waitMs: settleMs - elapsed }
}
