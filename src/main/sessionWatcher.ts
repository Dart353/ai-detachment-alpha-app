import fs from 'node:fs'
import path from 'node:path'
import { projectsRoot } from './platform'
import { accountConfigDir, accountProjectsRoot } from './accounts'
import { log } from './log'
import type { JsonlStatus, PaneReg, SessionInfo, TurnState } from '../shared/types'

/**
 * Watches Claude Code session transcripts to derive per-pane info:
 * task title, model, permission mode, and a coarse status hint.
 *
 * Claude Code writes one JSONL per session under
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * where <encoded-cwd> replaces every non-alphanumeric char with '-'.
 *
 * This module speaks plain data: sessionId, model, permissionMode,
 * 'pending-tool'. Naming for the user's eyes happens in the renderer.
 */

export type { JsonlStatus, PaneReg, SessionInfo, TurnState }

// projectsRoot() is resolved lazily (via platform.ts) so WSL mode can redirect it
// to the Linux home's share; do not cache it at module load.
const TAIL_BYTES = 256 * 1024 // read the last chunk — recent status + latest title/prompt live near the end
const CLAIM_SLACK_MS = 8000 // a fresh session file may predate our spawn signal slightly
// A tool_use that has only just been written is far more likely to be an in-flight
// tool about to return than a prompt genuinely blocked on the user. Hold off
// reporting 'pending-tool' until the state has persisted this long, so short
// auto-running tools never trip the renderer's "needs input" detection.
const PENDING_SETTLE_MS = 2500

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The projects root a pane's transcripts live under (account-aware). */
function rootFor(accountId?: string): string {
  return accountProjectsRoot(accountId) ?? projectsRoot()
}

/** Narrow a parsed JSON value to a plain object, or null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The object blocks of a message.content array; empty for a string content. */
function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  const blocks: Record<string, unknown>[] = []
  for (const entry of content) {
    const block = asRecord(entry)
    if (block) blocks.push(block)
  }
  return blocks
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : 0
}

// The transcript never records the *configured* model alias: message.model echoes
// the API id (e.g. "claude-opus-5") without the "[1m]" long-context suffix, so a
// 1M window is invisible in the JSONL. The default alias in ~/.claude/settings.json
// is what a plain `claude` launch runs with; read it (mtime-cached, we poll every
// 1.5s) and report the window it implies. Panes launched with an explicit --model
// override this in the renderer.
const settingsWindowCache = new Map<string, { mtimeMs: number; window: number | null }>()
function defaultContextWindow(accountId?: string): number | null {
  // accountConfigDir, not the account's env: this runs on every poll tick, and
  // resolving the env would decrypt the credential and run the share-healing
  // pass 40 times a minute — and throw out of the interval when the keychain
  // cannot decrypt. Healing belongs to the spawn, which resolves the env once.
  const file = path.join(accountConfigDir(accountId), 'settings.json')
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const cached = settingsWindowCache.get(file)
  if (!cached || cached.mtimeMs !== stat.mtimeMs) {
    let window: number | null = null
    try {
      const settings = asRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
      const model = settings?.model
      // An explicit "[1m]" forces the 1M window; otherwise Opus / Sonnet default to
      // it on the plans Claude Code runs under (never echoed into the transcript).
      if (typeof model === 'string')
        window = model.includes('[1m]') || /opus|sonnet/.test(model) ? 1_000_000 : 200_000
    } catch {
      /* unreadable settings → no hint */
    }
    settingsWindowCache.set(file, { mtimeMs: stat.mtimeMs, window })
  }
  return settingsWindowCache.get(file)?.window ?? null
}

/** Absolute path to a session transcript for a given cwd + session id. */
export function transcriptPath(cwd: string, sessionId: string, accountId?: string): string {
  return path.join(rootFor(accountId), encodeCwd(cwd), sessionId + '.jsonl')
}

/** Does a resumable transcript still exist for this cwd + session id? */
export function transcriptExists(cwd: string, sessionId: string, accountId?: string): boolean {
  try {
    return fs.existsSync(transcriptPath(cwd, sessionId, accountId))
  } catch {
    return false
  }
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const len = stat.size - start
    const buf = Buffer.allocUnsafe(len)
    fs.readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf8')
    // if we started mid-file, drop the first (likely partial) line
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text
  } finally {
    fs.closeSync(fd)
  }
}

export interface ParsedTail {
  sessionId: string | null
  title: string | null
  lastPrompt: string | null
  model: string | null
  permissionMode: string | null
  gitBranch: string | null
  jsonlStatus: JsonlStatus
  turnState: TurnState
  contextTokens?: number
}

/** Output of a slash command that ran locally — proof it never reached the model. */
const LOCAL_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>/
/** The wrapper a slash command leaves around its own invocation. */
const COMMAND_WRAPPER_RE = /^\s*<(command-name|command-message|command-args)>/
/** A bare slash command as typed, e.g. "/compact" or "/model sonnet". */
const SLASH_COMMAND_RE = /^\s*\/[a-zA-Z][\w:-]*(\s.*)?$/s
/** Esc mid-turn writes this as a user text block; the turn is over, not pending. */
const INTERRUPT_RE = /\[Request interrupted by user/

/** Plain text of a user entry, whose content is either a string or block array. */
function userText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  return blocksOf(content)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

const UNPARSED_TAIL: ParsedTail = {
  sessionId: null,
  title: null,
  lastPrompt: null,
  model: null,
  permissionMode: null,
  gitBranch: null,
  jsonlStatus: 'unknown',
  turnState: 'unknown'
}

export function parseTail(text: string): ParsedTail {
  const out: ParsedTail = { ...UNPARSED_TAIL }

  const entries: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = asRecord(JSON.parse(line))
      if (entry) entries.push(entry)
    } catch {
      // ignore partial/corrupt lines
    }
  }
  if (entries.length === 0) return out

  const resolvedToolResultIds = new Set<string>()

  // forward pass: collect latest scalar fields + tool_result ids
  for (const entry of entries) {
    if (typeof entry.sessionId === 'string') out.sessionId = entry.sessionId
    if (typeof entry.gitBranch === 'string') out.gitBranch = entry.gitBranch
    if (typeof entry.permissionMode === 'string') out.permissionMode = entry.permissionMode
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') out.title = entry.aiTitle
    if (entry.type === 'last-prompt' && typeof entry.lastPrompt === 'string')
      out.lastPrompt = entry.lastPrompt
    const message = asRecord(entry.message)
    if (!message) continue
    // '<synthetic>' marks locally-generated entries (e.g. API-retry notices), not
    // a real model — showing it on the pane's model chip only confuses.
    if (typeof message.model === 'string' && message.model !== '<synthetic>')
      out.model = message.model
    if (message.role === 'user') {
      for (const block of blocksOf(message.content)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          resolvedToolResultIds.add(block.tool_use_id)
        }
      }
    }
  }

  // status: is the last assistant turn blocked on an unresolved tool_use, and is a
  // turn still in flight at all? Two classes of entry are skipped, because neither
  // says anything about what the main conversation is doing:
  //   - subagent (Task tool) turns, written here with isSidechain=true — a
  //     background agent still churning must not make the session look busy
  //   - transcript bookkeeping: compaction summaries, caveats, and the echoes a
  //     slash command leaves behind (a session parked after /compact ends on a
  //     run of user-role entries that no assistant will ever answer)
  let localCommandDone = false
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (
      entry.isSidechain === true ||
      entry.isMeta === true ||
      entry.isCompactSummary === true ||
      entry.isVisibleInTranscriptOnly === true
    ) {
      continue
    }
    const message = asRecord(entry.message)
    if (!message) continue
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const blocks = blocksOf(message.content)
      const toolUses = blocks.filter((block) => block.type === 'tool_use')
      if (toolUses.length > 0) {
        const pending = toolUses.some(
          (block) => typeof block.id !== 'string' || !resolvedToolResultIds.has(block.id)
        )
        out.jsonlStatus = pending ? 'pending-tool' : 'turn-idle'
        // Either the tool is still running or its result is on its way back; in
        // both cases the turn is unfinished.
        out.turnState = 'open'
      } else {
        out.jsonlStatus = 'turn-idle'
        // A turn closes on an assistant message that calls no tool AND says
        // something. An entry carrying only thinking blocks is mid-turn, so
        // require real prose before declaring the pane finished — erring towards
        // 'open' only costs us the old PTY-driven behaviour.
        const spoke = blocks.some(
          (block) =>
            block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
        )
        out.turnState = spoke ? 'ended' : 'open'
      }
      break
    }
    if (message.role === 'user') {
      const text = userText(message)
      // A slash command that already printed its own output ran locally and asked
      // the model for nothing — skip its output, its wrapper and the typed command
      // itself, so a session parked after /compact doesn't read as "model thinking".
      // Seeing no local output yet means the command may still be a real turn in
      // flight (a custom command that prompts the model), so it counts as one.
      if (LOCAL_OUTPUT_RE.test(text)) {
        localCommandDone = true
        continue
      }
      if (localCommandDone && (COMMAND_WRAPPER_RE.test(text) || SLASH_COMMAND_RE.test(text)))
        continue
      // A user entry last means either a fresh prompt or a tool_result just
      // handed back — the model owes a reply either way, so the turn is open.
      // The exception is an interrupt, which ends the turn where it stands.
      // 'turn-idle' stays for the awaiting heuristic, which keys off pending-tool.
      out.jsonlStatus = 'turn-idle'
      out.turnState = INTERRUPT_RE.test(text) ? 'ended' : 'open'
      break
    }
  }

  // context meter: size of the LAST assistant turn carrying usage. Skip synthetic
  // models (locally-generated notices) just as the model field above does; leave
  // contextTokens undefined when the tail has no usage so the UI can hide the meter.
  for (let index = entries.length - 1; index >= 0; index--) {
    // Skip subagent (Task tool) turns: on some Claude Code versions their usage is
    // written into this same transcript with isSidechain=true, and pairing the meter
    // to one would show a subagent's context instead of the main session's.
    if (entries[index].isSidechain === true) continue
    const message = asRecord(entries[index].message)
    if (!message || message.role !== 'assistant') continue
    if (message.model === '<synthetic>') continue
    const usage = asRecord(message.usage)
    if (!usage) continue
    out.contextTokens =
      numberAt(usage, 'input_tokens') +
      numberAt(usage, 'cache_read_input_tokens') +
      numberAt(usage, 'cache_creation_input_tokens')
    break
  }

  return out
}

export class SessionWatcher {
  private panes = new Map<string, PaneReg>()
  private resolvedFile = new Map<string, string>() // paneId -> jsonl path
  private pendingSince = new Map<string, number>() // paneId -> first ms seen 'pending-tool'
  // Once a fresh pane's own sessionId surfaces we lock the binding, so two fresh
  // claude panes in the same folder can't drift onto each other's file.
  private sessionOwner = new Map<string, string>() // sessionId -> paneId
  private paneSession = new Map<string, string>() // paneId -> discovered sessionId
  private timer: NodeJS.Timeout | null = null
  private emit: (updates: SessionInfo[]) => void

  constructor(emit: (updates: SessionInfo[]) => void) {
    this.emit = emit
  }

  register(reg: PaneReg): void {
    this.panes.set(reg.id, reg)
    this.ensureRunning()
  }

  unregister(id: string): void {
    this.panes.delete(id)
    this.resolvedFile.delete(id)
    this.pendingSince.delete(id)
    // release any session this pane had claimed
    const sessionId = this.paneSession.get(id)
    if (sessionId) this.sessionOwner.delete(sessionId)
    this.paneSession.delete(id)
    if (this.panes.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private ensureRunning(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), 1500)
    this.poll()
  }

  /** Find the unclaimed transcript for a pane's cwd created around/after spawn. */
  private resolveFile(reg: PaneReg, claimed: Set<string>): string | null {
    // Resumed panes know their exact transcript — bind straight to it.
    if (reg.sessionId) {
      const direct = transcriptPath(reg.cwd, reg.sessionId, reg.accountId)
      if (!claimed.has(direct) && fs.existsSync(direct)) return direct
    }
    // A fresh pane whose sessionId we've already discovered binds directly too —
    // mirror the resumed path so a transient miss (or a sibling spawning in the
    // same folder) can never re-point it at another transcript.
    const owned = this.paneSession.get(reg.id)
    if (owned) {
      const direct = transcriptPath(reg.cwd, owned, reg.accountId)
      if (!claimed.has(direct) && fs.existsSync(direct)) return direct
    }
    const dir = path.join(rootFor(reg.accountId), encodeCwd(reg.cwd))
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'))
    } catch {
      return null
    }
    // Two fresh claude panes in one folder both hunt for "a transcript created
    // around our spawn". Newest *mtime* is the wrong key — an older, still active
    // session keeps a recent mtime — and lets siblings grab each other's file.
    // Rank by *birth* time, oldest-eligible first, and skip any transcript already
    // owned by another pane's discovered session. Paired with the spawn-ordered
    // iteration in poll(), the earliest-spawned pane takes the earliest-created
    // transcript, so simultaneous spawns no longer swap.
    let best: { file: string; born: number } | null = null
    for (const name of files) {
      const full = path.join(dir, name)
      if (claimed.has(full)) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      const ownerPane = this.sessionOwner.get(sessionId)
      if (ownerPane && ownerPane !== reg.id) continue // another pane's session
      let born: number
      try {
        const stat = fs.statSync(full)
        born = stat.birthtimeMs || stat.mtimeMs
      } catch {
        continue
      }
      if (born < reg.spawnedAt - CLAIM_SLACK_MS) continue
      if (!best || born < best.born) best = { file: full, born }
    }
    return best?.file ?? null
  }

  /** Log each distinct failure once; a broken poll must not spam the log 40x/min. */
  private warned = new Set<string>()

  private poll(): void {
    try {
      this.pollOnce()
    } catch (err) {
      // setInterval has nowhere to put a throw: an uncaught one here would take
      // the whole app down (see the crash handlers in main/index.ts).
      const message = err instanceof Error ? err.message : String(err)
      if (!this.warned.has(message)) {
        this.warned.add(message)
        log.warn('session poll failed:', message)
      }
    }
  }

  private pollOnce(): void {
    const updates: SessionInfo[] = []
    const claimed = new Set(this.resolvedFile.values())

    // resolve in spawn order so the earliest-spawned pane claims the earliest-created
    // transcript when siblings race for a file in the same folder.
    const regs = [...this.panes.values()].sort((a, b) => a.spawnedAt - b.spawnedAt)
    for (const reg of regs) {
      let file = this.resolvedFile.get(reg.id) ?? null
      if (file && !fs.existsSync(file)) {
        file = null
        this.resolvedFile.delete(reg.id)
      }
      if (!file) {
        file = this.resolveFile(reg, claimed)
        if (file) {
          this.resolvedFile.set(reg.id, file)
          claimed.add(file)
        }
      }

      if (!file) {
        updates.push({ paneId: reg.id, lastWriteMs: 0, ...UNPARSED_TAIL })
        continue
      }

      let mtime = 0
      let parsed: ParsedTail
      try {
        mtime = fs.statSync(file).mtimeMs
        parsed = parseTail(readTail(file))
      } catch {
        parsed = { ...UNPARSED_TAIL }
      }

      // settle 'pending-tool': only report it once it has persisted
      // PENDING_SETTLE_MS, so a tool that fires and returns quickly never reads
      // as awaiting. Any other status clears the pending clock.
      if (parsed.jsonlStatus === 'pending-tool') {
        const since = this.pendingSince.get(reg.id) ?? Date.now()
        if (!this.pendingSince.has(reg.id)) this.pendingSince.set(reg.id, since)
        if (Date.now() - since < PENDING_SETTLE_MS) parsed.jsonlStatus = 'turn-idle'
      } else {
        this.pendingSince.delete(reg.id)
      }

      // Once this pane's own sessionId surfaces, claim it: lock the pane to that
      // session for good and forbid siblings from resolving to its file. If the id
      // is already owned by another pane we mis-resolved — drop this binding so it
      // re-resolves (skipping the owned file) on the next tick.
      if (parsed.sessionId) {
        const owner = this.sessionOwner.get(parsed.sessionId)
        if (!owner) {
          this.sessionOwner.set(parsed.sessionId, reg.id)
          this.paneSession.set(reg.id, parsed.sessionId)
        } else if (owner !== reg.id) {
          this.resolvedFile.delete(reg.id)
        }
      }

      updates.push({
        paneId: reg.id,
        lastWriteMs: mtime,
        contextWindow: defaultContextWindow(reg.accountId) ?? undefined,
        ...parsed
      })
    }

    if (updates.length > 0) this.emit(updates)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.panes.clear()
    this.resolvedFile.clear()
    this.pendingSince.clear()
    this.sessionOwner.clear()
    this.paneSession.clear()
    this.warned.clear()
  }
}
