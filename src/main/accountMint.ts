import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ClaudeAccount, PendingMint } from '../shared/types'
import {
  AccountError,
  accountsRoot,
  addAccountFromMint,
  CLAUDE_SETUP_TOKEN_PREFIX,
  findAccount,
  replaceAccountOauthToken
} from './accounts'

/**
 * The subscription-account mint flow.
 *
 * Adding a subscription account means running `claude setup-token` in an
 * embedded terminal so the user can sign in with their OTHER Claude account.
 * The CLI prints a long-lived sk-ant-oat01 credential once the browser sign-in
 * completes. This module owns everything main-side about that flow:
 *
 *  - a registry of pending mints, each with its own STAGING config dir, so a
 *    PTY spawn carrying `mint` can be verified against something main created
 *    (a renderer must never be able to point the mint machinery at an arbitrary
 *    directory);
 *  - a scanner that watches the mint pane's output for the token. Capture is a
 *    convenience: the flow always offers paste-the-token as the fallback,
 *    because a token that wraps in a narrow terminal arrives split across lines
 *    and styling and may defeat any scraper;
 *  - completion, which adopts the staging dir as the new account's config dir
 *    (whatever state the sign-in wrote comes along) and encrypts the token;
 *  - cleanup for cancels and for staging dirs orphaned by a crash.
 */

/** Where a pending mint's setup-token session keeps its isolated state. */
const MINT_DIR_PREFIX = '.mint-'

const AUTO_CAPTURE_TOKEN_LENGTH = 80
const AUTO_CAPTURE_BODY_LENGTH = AUTO_CAPTURE_TOKEN_LENGTH - CLAUDE_SETUP_TOKEN_PREFIX.length
const TOKEN_RE = new RegExp(
  `(${CLAUDE_SETUP_TOKEN_PREFIX}[A-Za-z0-9_-]{${AUTO_CAPTURE_BODY_LENGTH}})(?=[^A-Za-z0-9_-])`
)

interface PendingMintRecord extends PendingMint {
  label: string
  /** Existing subscription account whose credential this mint will replace. */
  replaceAccountId?: string
  scanner: OauthTokenScanner
  /** Set once the scanner has handed a token out; auto-capture fires once. */
  captured: boolean
  /** Set once a token has been captured or pasted; blocks double completion. */
  done: boolean
}

const pending = new Map<string, PendingMintRecord>()

/** What the renderer is told: no scanner, no label, no replacement target. */
function publicMint(mint: PendingMintRecord): PendingMint {
  return { ptyId: mint.ptyId, configDir: mint.configDir, command: mint.command }
}

export function beginMint(label: string, replaceAccountId?: string): PendingMint {
  const clean = label.trim()
  if (!clean) throw new AccountError('Account label is required.')
  if (replaceAccountId) {
    const account = findAccount(replaceAccountId)
    if (!account || account.backend !== 'subscription') {
      throw new AccountError('That subscription account is no longer available to reconnect.')
    }
  }
  const nonce = crypto.randomBytes(6).toString('hex')
  const ptyId = `mint:${nonce}`
  const configDir = path.join(accountsRoot(), `${MINT_DIR_PREFIX}${nonce}`)
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const mint: PendingMintRecord = {
    ptyId,
    label: clean,
    configDir,
    ...(replaceAccountId ? { replaceAccountId } : {}),
    // Main-supplied, so nothing user-typed ever reaches the shell this way.
    command: 'claude setup-token',
    scanner: createOauthTokenScanner(),
    captured: false,
    done: false
  }
  pending.set(ptyId, mint)
  return publicMint(mint)
}

/** Does a PTY spawn's `mint` option match a pending mint main itself created? */
export function mintForSpawn(ptyId: string, configDir: string): boolean {
  return mintCommandFor(ptyId, configDir) !== null
}

/**
 * The command that matching spawn is allowed to run — main's own, never the
 * renderer's — or null when nothing is pending for it.
 */
export function mintCommandFor(ptyId: string, configDir: string): string | null {
  const mint = pending.get(ptyId)
  if (!mint || mint.done || mint.configDir !== configDir) return null
  return mint.command
}

/**
 * Feed one chunk of the mint pane's output to its scanner. Returns a complete
 * token the first time one appears, else null. It yields a token ONCE: the
 * scanner keeps matching its tail on every later chunk, and a completion that
 * failed (a locked keychain, say) must not re-fire on each repaint — the paste
 * path is the way back from that.
 */
export function feedMintOutput(ptyId: string, data: string): string | null {
  const mint = pending.get(ptyId)
  if (!mint || mint.done || mint.captured) return null
  const token = mint.scanner.feed(data)
  if (token) mint.captured = true
  return token
}

/** Turn a captured or pasted token into a real account, adopting the staging dir. */
export function completeMint(ptyId: string, token: string): ClaudeAccount {
  const mint = pending.get(ptyId)
  if (!mint) throw new AccountError('That sign-in is no longer pending.')
  if (mint.done) throw new AccountError('That sign-in already produced an account.')
  mint.done = true
  try {
    const account = mint.replaceAccountId
      ? replaceAccountOauthToken(mint.replaceAccountId, token)
      : addAccountFromMint(
          { label: mint.label, backend: 'subscription', oauthToken: token },
          mint.configDir
        )
    if (mint.replaceAccountId) {
      try {
        fs.rmSync(mint.configDir, { recursive: true, force: true })
      } catch {
        // The credential is already replaced. A later orphan sweep can retry.
      }
    }
    pending.delete(ptyId)
    return account
  } catch (error) {
    // A bad paste (wrong prefix, empty) must not burn the pending mint.
    mint.done = false
    throw error
  }
}

export function cancelMint(ptyId: string): void {
  const mint = pending.get(ptyId)
  if (!mint) return
  pending.delete(ptyId)
  fs.rmSync(mint.configDir, { recursive: true, force: true })
}

/** Delete staging dirs left behind by a crash or quit mid-mint. Startup only. */
export function sweepOrphanedMintDirs(): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(accountsRoot())
  } catch {
    return
  }
  const live = new Set([...pending.values()].map((mint) => path.basename(mint.configDir)))
  for (const entry of entries) {
    if (!entry.startsWith(MINT_DIR_PREFIX) || live.has(entry)) continue
    try {
      fs.rmSync(path.join(accountsRoot(), entry), { recursive: true, force: true })
    } catch {
      // A stubborn dir is harmless; the next sweep retries.
    }
  }
}

/* === token scanner === */

export interface OauthTokenScanner {
  /** Feed one PTY chunk; returns a complete current-format token, else null. */
  feed(data: string): string | null
}

// Erase ANSI escape sequences (CSI, OSC with either terminator, and the short
// two-byte escapes) so styling emitted mid-token cannot split a match.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

const TAIL_KEEP = 512

/**
 * Rolling scanner over the mint pane's output stream. It removes styling and
 * indented line wraps, then accepts only a complete current-format token with
 * a trailing delimiter.
 */
export function createOauthTokenScanner(): OauthTokenScanner {
  let tail = ''
  return {
    feed(data: string): string | null {
      tail = (tail + data.replace(ANSI_RE, '')).slice(-TAIL_KEEP)
      // A token may be split across PTY chunks. Capture only the complete
      // current format followed by a delimiter, never a prefix at the chunk's
      // current end. Indented terminal wraps are removed before matching.
      const unwrapped = tail.replace(/(?:\r\n|\r|\n)[\t ]+/g, '')
      const match = unwrapped.match(TOKEN_RE)
      return match ? match[1] ?? null : null
    }
  }
}
