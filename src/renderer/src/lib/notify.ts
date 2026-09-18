/**
 * The notification brain: when a pane deserves a bell, and what the bell says.
 *
 * Pure — no React, no IPC, no clock of its own — so the whole state machine can
 * be driven through a test tick by tick. The hook feeds it one input per pane
 * per tick and acts on the effects it returns.
 *
 * Two hard-won rules live here, and both exist because of false bells:
 *
 *   • a completion is ARMED by the transcript's `lastWriteMs` advancing, never
 *     by PTY output. Clicking into a pane makes Claude Code repaint its whole
 *     TUI, which reads as activity; arming off that fired a "task complete" the
 *     moment you clicked away again.
 *   • an attention bell LATCHES per question and re-arms only on evidence the
 *     question actually went away — the prompt has left the screen AND the
 *     transcript has been written since we rang. Resizing a pane sends SIGWINCH,
 *     the TUI repaints, the pane flips to working and back to attention on the
 *     same unanswered prompt, and clearing the latch on any status change turned
 *     every divider drag into a fresh bell.
 */
import type { PaneStatus, Settings } from '../../../shared/types'
import { COMPLETE_GRACE_MS } from './status'

/** Bells the app knows how to ring. */
export type NotifyKind = 'attention' | 'done'

/**
 * Spawning and resuming panes paints a great deal at launch; nothing rings
 * until this long after the engine starts.
 */
export const LAUNCH_GRACE_MS = 5000

/** How much of the detail line a banner carries before it is clipped. */
export const DETAIL_MAX_CHARS = 140

export interface NotifyPaneState {
  /** a real transcript write has happened, so a completion is worth announcing */
  armed: boolean
  /** epoch ms the pane went quiet while armed; null when it is not quiet */
  idleSince: number | null
  /** the attention bell has rung for the question currently on screen */
  attentionNotified: boolean
  /** the transcript write time as it stood when that bell rang */
  attentionWroteAt: number | null
  /**
   * The last transcript write seen for this pane. 0 means "never seen one yet":
   * the first observation only records, so a pane adopting an existing
   * transcript on mount does not arm a completion it had no part in.
   */
  lastSeenWriteMs: number
}

export interface NotifyInput {
  now: number
  status: PaneStatus
  /** the transcript's last write, or undefined when the pane has no session yet */
  lastWriteMs: number | undefined
  promptOnScreen: boolean
  /** the user is looking straight at this pane */
  focusedAndVisible: boolean
  /** a gesture or the launch grace is suppressing bells right now */
  held: boolean
  /** Claude Code's hooks are installed and own the bells for this pane */
  hooksOwnBells: boolean
}

/**
 * What the caller must do. `mark-unseen-done` is the pill, not a bell: it is
 * emitted even while the hooks own the bells, because the status pill's logic
 * is the same either way.
 */
export type NotifyEffect = 'attention' | 'done' | 'mark-unseen-done'

export interface NotifyStep {
  next: NotifyPaneState
  effects: NotifyEffect[]
}

export function initialNotifyState(): NotifyPaneState {
  return {
    armed: false,
    idleSince: null,
    attentionNotified: false,
    attentionWroteAt: null,
    lastSeenWriteMs: 0
  }
}

/**
 * A pane that has finished but whose completion the user has not looked at yet
 * wears 'done' rather than 'idle'. Both are quiet, so both keep the completion
 * grace running — otherwise a second turn could never announce while an earlier
 * unseen completion was still on the pill.
 */
function isQuiet(status: PaneStatus): boolean {
  return status === 'idle' || status === 'done'
}

export function stepNotify(prev: NotifyPaneState, input: NotifyInput): NotifyStep {
  const next: NotifyPaneState = { ...prev }
  const effects: NotifyEffect[] = []
  const wrote = input.lastWriteMs ?? 0

  // --- arm off genuine transcript progress -------------------------------
  if (input.lastWriteMs !== undefined) {
    if (prev.lastSeenWriteMs > 0 && wrote > prev.lastSeenWriteMs) next.armed = true
    next.lastSeenWriteMs = wrote
  }

  // --- the question bell, latched per question ---------------------------
  if (input.status === 'attention') {
    if (!next.attentionNotified && !input.held) {
      if (!input.hooksOwnBells) effects.push('attention')
      next.attentionNotified = true
      next.attentionWroteAt = wrote
    }
  } else if (next.attentionNotified) {
    // A pane with no transcript to read falls back to the prompt probe alone,
    // which is the only signal it has.
    const spokeSince = wrote === 0 || wrote > (next.attentionWroteAt ?? 0)
    if (!input.promptOnScreen && spokeSince) {
      next.attentionNotified = false
      next.attentionWroteAt = null
    }
  }

  // --- the completion bell, after a sustained quiet ----------------------
  if (isQuiet(input.status) && next.armed) {
    if (next.idleSince === null) {
      next.idleSince = input.now
    } else if (input.now - next.idleSince >= COMPLETE_GRACE_MS && !input.held) {
      // The hold keeps the pane armed rather than disarming it, so a completion
      // that lands mid-gesture rings once the gesture settles instead of being
      // lost.
      if (!input.hooksOwnBells) effects.push('done')
      if (!input.focusedAndVisible) effects.push('mark-unseen-done')
      next.armed = false
      next.idleSince = null
    }
  } else if (!isQuiet(input.status)) {
    next.idleSince = null
  }

  return { next, effects }
}

/**
 * The single gate every banner and every sound passes through: the master mute
 * first, then the pane you are actively watching (which never gets a bell about
 * itself), then this kind's row of the Settings matrix.
 */
export function shouldDeliver(
  prefs: Settings['notifications'],
  kind: NotifyKind,
  ctx: { focusedAndVisible: boolean }
): { banner: boolean; sound: boolean } {
  if (prefs.muted) return { banner: false, sound: false }
  if (ctx.focusedAndVisible) return { banner: false, sound: false }
  const row = prefs[kind]
  return { banner: row.banner, sound: row.sound }
}

/** Clip at a word boundary so a banner never cuts mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 3 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export interface NotificationContext {
  workspaceName: string
  paneName: string
  /** the question text for attention, the session title or last prompt for done */
  detail?: string | null
}

export function formatNotification(
  kind: NotifyKind,
  ctx: NotificationContext
): { title: string; body: string } {
  const title = kind === 'attention' ? 'Needs input' : 'Done'
  const where = `${ctx.workspaceName} · ${ctx.paneName}`
  const detail = ctx.detail?.trim()
  const body = detail ? `${where}\n${clip(detail, DETAIL_MAX_CHARS)}` : where
  return { title, body }
}
