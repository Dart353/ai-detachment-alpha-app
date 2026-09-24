/**
 * Typing a draft into a freshly launched Claude pane — the explorer's "Open in
 * Claude Code" pre-fills `@file ` without submitting it.
 *
 * The PTY's prompt-ready gate only knows when the *shell* is ready; `claude`
 * then takes a second or two to boot, may stop on a trust dialog first, and
 * negotiates keyboard modes as it draws. Text written before its input box is up
 * lands in the shell or, worse, picks a numbered option in a dialog. So the
 * draft waits until the screen shows the input box, no blocking prompt, and the
 * output has settled.
 *
 * COUPLED TO CLAUDE CODE'S TUI: the input box is a `❯` line (older releases: a
 * `>` inside a `│` box) directly under a `─` rule. A shell prompt that uses `❯`
 * (starship, pure) has no rule above it, and a dialog's cursor sits on a
 * numbered option (`❯ 1. Yes`), so neither passes.
 */
import { BLOCKING_PROMPT_MARKERS } from './status'

/** Output must have been quiet this long before the draft is typed. */
export const DRAFT_SETTLE_MS = 300
/** Past this, the pane never showed an input box; the draft is dropped. */
export const DRAFT_GIVE_UP_MS = 120_000

const RULE_RE = /^\s*[─╭]─{8,}/
const INPUT_RE = /^[\s│]*[❯>](\s|$)/
const MENU_OPTION_RE = /^[\s│]*[❯>]\s*\d+\./

/** Is Claude Code's empty-or-not input box on these visible rows? */
export function claudeInputReady(rows: string[]): boolean {
  if (BLOCKING_PROMPT_MARKERS.test(rows.join('\n'))) return false
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? ''
    if (INPUT_RE.test(row) && !MENU_OPTION_RE.test(row) && RULE_RE.test(rows[i - 1] ?? '')) {
      return true
    }
  }
  return false
}

export type DraftDecision = 'wait' | 'write' | 'give-up'

export function draftDecision(input: {
  rows: string[]
  now: number
  startedAt: number
  lastOutputAt: number
}): DraftDecision {
  if (input.now - input.startedAt > DRAFT_GIVE_UP_MS) return 'give-up'
  if (input.now - input.lastOutputAt < DRAFT_SETTLE_MS) return 'wait'
  return claudeInputReady(input.rows) ? 'write' : 'wait'
}

/**
 * The `@` mention for a file, relative to the pane's cwd, with a trailing space
 * so the completion menu closes. A path with whitespace is double-quoted, the
 * form Claude Code's own completion inserts.
 */
export function fileMention(relativePath: string): string {
  const path = relativePath.replace(/\\/g, '/')
  return /\s/.test(path) ? `@"${path}" ` : `@${path} `
}
