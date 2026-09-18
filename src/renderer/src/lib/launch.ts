/**
 * The command line a pane spawns with. Pure string assembly — the caller hands
 * it to the PTY.
 *
 * `undefined` means "no command": a `terminal` pane gets a plain login shell and
 * a `viewer` pane has no process at all.
 *
 * Everything interpolated here is typed into a shell, so the two values that can
 * come from outside the app — the session id read off a transcript and the ssh
 * host read from ~/.ssh/config — must look like what they claim to be before
 * they are woven in. A value that does not is left out rather than quoted: a
 * resume flag is optional, and a host that cannot be trusted is no launch.
 */
import type { Pane } from '../../../shared/types'
import { shellQuote } from './shellQuote'

/** A Claude transcript uuid: hex and dashes, long enough to be one. */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,}$/
/** An ssh host alias / user@host[:port] as ssh_config spells them. */
const SSH_HOST_RE = /^[A-Za-z0-9._@:-]+$/

export interface LaunchOpts {
  /** the transcript for `pane.sessionId` still exists on disk */
  hasTranscript: boolean
  /** an explicit CLI location from Settings, for when the login shell can't find it */
  cliPath?: string
}

export function buildLaunchCommand(pane: Pane, opts: LaunchOpts): string | undefined {
  switch (pane.kind) {
    case 'claude':
      return claudeCommand(pane, opts)
    case 'ssh':
      return sshCommand(pane)
    case 'terminal':
    case 'viewer':
      return undefined
  }
}

function claudeCommand(pane: Pane, opts: LaunchOpts): string {
  // Resume a prior chat only when its transcript still exists on disk; otherwise
  // a fresh `claude`. Plan mode is appended after the resume rewrite, so fresh
  // AND resumed sessions both start in it.
  let command = binary(opts.cliPath)
  if (opts.hasTranscript && pane.sessionId && SESSION_ID_RE.test(pane.sessionId)) {
    command += ` --resume ${pane.sessionId}`
  }
  if (pane.planMode) command += ' --permission-mode plan'
  return command
}

/** A configured path only needs quoting when it carries whitespace; leaving a
 *  plain path bare keeps the command line readable in the pane header. */
function binary(cliPath: string | undefined): string {
  if (!cliPath) return 'claude'
  return /\s/.test(cliPath) ? shellQuote(cliPath) : cliPath
}

function sshCommand(pane: Pane): string | undefined {
  if (!pane.sshHost || !SSH_HOST_RE.test(pane.sshHost)) return undefined
  return `ssh ${pane.sshHost}`
}
