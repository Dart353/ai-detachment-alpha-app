import fs from 'node:fs'
import path from 'node:path'
import { claudeDir, isWsl } from './platform'
import type { HookEvent, HookEventName } from '../shared/types'

/**
 * Hook-based notifications.
 *
 * The PTY-quiet heuristic in the renderer *guesses* when a pane finishes a task
 * or starts waiting on the user. Claude Code can tell us *exactly* via two hooks:
 *   - Stop         → the assistant finished its turn (task complete)
 *   - Notification → Claude is asking for input / permission (attention)
 *
 * We install a shell command for each that appends the hook's stdin JSON — a single
 * compact line carrying `session_id`, `cwd`, `transcript_path`, `hook_event_name`
 * and (for Notification) `message` — to a signal file under ~/.claude. This module
 * tails that file and forwards each event to the main process, which relays it to
 * the renderer as an IPC event. When the hook isn't installed the file simply never
 * grows and the renderer falls back to its heuristic.
 *
 * The transcript-JSONL shapes and the ~/.claude layout mirror `sessionWatcher.ts`.
 */

export type { HookEvent, HookEventName }

// Tests point this at a temp directory; null means the real `.claude` location,
// which is resolved lazily so WSL mode can redirect it to the Linux home's share.
let overrideDir: string | null = null

/** Redirect the settings + signal files (the unit tests use a temp dir). */
export function setHooksDir(dir: string | null): void {
  overrideDir = dir
}

function hooksDir(): string {
  return overrideDir ?? claudeDir()
}

/** Marker so we can recognise (and avoid duplicating) our own hook command. */
const SIGNAL_MARKER = 'ada-hooks.jsonl'

const settingsFile = (): string => path.join(hooksDir(), 'settings.json')
/** Claude drops one JSON line here per Stop/Notification/SubagentStop firing. */
export const signalFile = (): string => path.join(hooksDir(), SIGNAL_MARKER)
/** Keep the signal file from growing without bound once we've drained it. */
const TRUNCATE_AT_BYTES = 1024 * 1024

/**
 * Registered in ~/.claude/settings.json, and required for "hooks installed".
 *
 * SubagentStop fires when one of a pane's subagents finishes. It is NOT a turn
 * ending — it never reaches the completion gate, the ready-for-review check, or
 * the attention latch — it is only ever its own quiet notification.
 */
export const HOOK_EVENTS: HookEventName[] = ['Stop', 'Notification', 'SubagentStop']

/**
 * The subset that replaces the PTY-quiet heuristic.
 *
 * These two, and ONLY these two, are what "the agent announces itself exactly, so
 * stand the guesswork down" means. Keeping this separate from HOOK_EVENTS is
 * load-bearing: adding SubagentStop made every pre-existing settings file
 * incomplete, and if suppression asked the same question as the Settings button,
 * every existing user would have had the heuristic re-arm behind Stop and
 * Notification hooks that were still firing — two alerts and two log rows for
 * every question and completion until they happened to press Install.
 */
export const BELL_HOOK_EVENTS: HookEventName[] = ['Stop', 'Notification']

/** What the transcript says about the turn a Stop just ended. */
export interface TurnContext {
  fromTaskNotification: boolean
  agentsLaunched: boolean
}

const NO_TURN_CONTEXT: TurnContext = { fromTaskNotification: false, agentsLaunched: false }

/**
 * Read the turn out of a transcript tail (newest lines last).
 *
 * A turn starts at the last user entry carrying an `origin`/`promptSource` — the
 * prompt itself, as opposed to the tool_result entries that share its promptId.
 * Two facts about the turn matter to the completion gate:
 *
 *  - the prompt's origin: `human` (you typed it) or `task-notification` (a
 *    background subagent finished and woke the main loop to handle it);
 *  - whether the turn launched background agents of its own — the Agent tool
 *    records `toolUseResult.status: 'async_launched'` for each one, and those
 *    are the agents whose completions will wake it next.
 *
 * Pure, so tests can feed it recorded transcript lines.
 */
export function turnContextFromTail(tail: string): TurnContext {
  const lines = tail.split('\n')
  let agentsLaunched = false
  for (let index = lines.length - 1; index >= 0; index--) {
    const raw = lines[index].trim()
    if (!raw) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(raw)
    } catch {
      continue // a clipped first line, or a partial write
    }
    const result = entry.toolUseResult as { status?: unknown } | undefined
    if (result && typeof result === 'object' && result.status === 'async_launched') {
      agentsLaunched = true
    }
    if (entry.type !== 'user') continue
    const origin = entry.origin as { kind?: unknown } | undefined
    const source = entry.promptSource
    if (!origin && typeof source !== 'string') continue // a tool_result, not the prompt
    const kind = origin && typeof origin === 'object' ? origin.kind : undefined
    return {
      fromTaskNotification: kind === 'task-notification' || source === 'system',
      agentsLaunched
    }
  }
  return { fromTaskNotification: false, agentsLaunched }
}

/**
 * Tail we read per Stop; a turn's worth of JSONL, generously. A turn longer than
 * this loses its prompt boundary and reads as "no context", which fails OPEN:
 * that Stop fires as it did before the gate existed — an extra alert at worst,
 * never a swallowed one.
 */
const TAIL_BYTES = 512 * 1024

/** turnContextFromTail against the real file; any trouble reads as "no context". */
function readTurnContext(transcriptPath: string | null): TurnContext {
  if (!transcriptPath) return NO_TURN_CONTEXT
  try {
    const size = fs.statSync(transcriptPath).size
    const start = Math.max(0, size - TAIL_BYTES)
    const len = size - start
    if (len <= 0) return NO_TURN_CONTEXT
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, start)
      return turnContextFromTail(buf.toString('utf8'))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return NO_TURN_CONTEXT
  }
}

/**
 * Subagent transcripts live at `<project>/<sessionId>/subagents/agent-*.jsonl`.
 * Any hook line quoting one was fired by a subagent session, never by a pane's own
 * session, so it is dropped before the renderer ever sees it.
 */
const SUBAGENT_TRANSCRIPT_RE = /[/\\]subagents[/\\]/

/**
 * A subagent transcript path names its parent session in the directory above
 * `subagents/`: `<project>/<sessionId>/subagents/agent-*.jsonl`. When a
 * SubagentStop arrives stamped with the subagent's own path rather than the
 * session's, this is how the renderer still finds the pane that owns it.
 * Null for anything that isn't a subagent transcript.
 */
export function parentSessionOf(transcriptPath: string | null): string | null {
  if (!transcriptPath || !SUBAGENT_TRANSCRIPT_RE.test(transcriptPath)) return null
  const parts = transcriptPath.split(/[/\\]/)
  const at = parts.lastIndexOf('subagents')
  const parent = at > 0 ? parts[at - 1] : ''
  return parent || null
}

/** Background task types that mean "an agent is working", as opposed to a shell. */
const AGENT_TASK_TYPES = new Set(['teammate', 'agent', 'subagent', 'task'])

/** True when `background_tasks` still lists a running agent (shells don't count). */
function hasRunningAgent(tasks: unknown): boolean {
  if (!Array.isArray(tasks)) return false
  return tasks.some((task) => {
    if (!task || typeof task !== 'object') return false
    const record = task as { type?: unknown; status?: unknown }
    if (typeof record.type !== 'string' || !AGENT_TASK_TYPES.has(record.type)) return false
    // status has only ever been 'running' on the wire; a missing one counts too
    return record.status == null || record.status === 'running'
  })
}

/**
 * Parse one signal-file line into a HookEvent, or null when it isn't one of ours.
 * Pure (the caller supplies `ts`, and the turn context) so tests can exercise the
 * subagent filter without a filesystem; the watcher passes readTurnContext.
 */
export function parseHookLine(
  line: string,
  ts: number,
  turnContext: (transcriptPath: string | null) => TurnContext = () => NO_TURN_CONTEXT
): HookEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null // partial/corrupt line — skip
  }
  if (!obj || typeof obj !== 'object') return null
  const name = obj.hook_event_name
  if (name !== 'Stop' && name !== 'Notification' && name !== 'SubagentStop') return null
  const transcriptPath = typeof obj.transcript_path === 'string' ? obj.transcript_path : null
  // A subagent's own Stop is never a session's turn ending. Scoped to plain Stops
  // on purpose: SubagentStop is the event that IS about a subagent, and whether
  // Claude Code stamps it with the subagent's transcript path or the parent's is
  // version-dependent — dropping it on that basis would silently discard the very
  // signal we registered the hook for.
  if (name === 'Stop' && transcriptPath && SUBAGENT_TRANSCRIPT_RE.test(transcriptPath)) return null
  // only a session's own Stop needs the transcript read; a question is answered on
  // the spot, and a SubagentStop never enters the turn machinery at all
  const turn = name === 'Stop' ? turnContext(transcriptPath) : NO_TURN_CONTEXT
  return {
    event: name,
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : null,
    parentSessionId: parentSessionOf(transcriptPath),
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    transcriptPath,
    message: typeof obj.message === 'string' ? obj.message : null,
    promptId: typeof obj.prompt_id === 'string' ? obj.prompt_id : null,
    agentsRunning: hasRunningAgent(obj.background_tasks),
    fromTaskNotification: turn.fromTaskNotification,
    agentsLaunched: turn.agentsLaunched,
    ts
  }
}

/**
 * The shell command we register in Claude's settings. It appends the hook's stdin
 * (a single compact JSON object) plus a newline to the signal file, creating the
 * file if needed. Portable to the default macOS shell; no dependency on this app.
 */
export function hookCommand(): string {
  // In WSL mode the hook runs *inside* WSL (claude lives there), so `$HOME` is the
  // Linux home and the POSIX form is correct — only a native-Windows shell needs
  // the PowerShell variant.
  if (process.platform === 'win32' && !isWsl()) {
    // Windows: Claude Code runs hook commands through the shell (PowerShell). Read
    // all of stdin (the compact JSON record) and append it as one newline-terminated
    // line to the signal file under %USERPROFILE%\.claude. Add-Content adds the line
    // terminator, mirroring the POSIX `printf '\n'`.
    return `powershell -NoProfile -Command "$in=[Console]::In.ReadToEnd(); Add-Content -Path \\"$env:USERPROFILE\\.claude\\${SIGNAL_MARKER}\\" -Value $in"`
  }
  // POSIX: `{ cat; printf '\n'; } >> file` opens the file once and guarantees the
  // record is newline-terminated so the tailer can split cleanly.
  return `{ cat; printf '\\n'; } >> "$HOME/.claude/${SIGNAL_MARKER}"`
}

function readSettings(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * True when EVERY event we register is present in Claude's settings.
 *
 * Requiring all of HOOK_EVENTS is what makes an install predating SubagentStop
 * read as incomplete, so the Settings button reappears and one click tops it up.
 * installHooks adds only the events actually missing, so that re-run cannot
 * duplicate the Stop/Notification entries already there.
 */
export function isHookInstalled(): boolean {
  return everyHookPresent(HOOK_EVENTS)
}

/**
 * True when the two alert hooks are registered — the question the renderer asks
 * before standing its PTY-quiet heuristic down. Deliberately NOT isHookInstalled:
 * see BELL_HOOK_EVENTS for why conflating them double-fires every alert.
 */
export function areBellHooksInstalled(): boolean {
  return everyHookPresent(BELL_HOOK_EVENTS)
}

function everyHookPresent(events: HookEventName[]): boolean {
  const settings = readSettings()
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object') return false
  const record = hooks as Record<string, unknown>
  return events.every((event) => hasOurHook(record, event))
}

function hasOurHook(hooks: Record<string, unknown>, event: HookEventName): boolean {
  const groups = hooks[event]
  if (!Array.isArray(groups)) return false
  for (const group of groups) {
    const inner = group && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : null
    if (!Array.isArray(inner)) continue
    for (const hook of inner) {
      if (!hook || typeof hook !== 'object') continue
      const command = (hook as { command?: unknown }).command
      if (typeof command === 'string' && command.includes(SIGNAL_MARKER)) return true
    }
  }
  return false
}

/**
 * Install our hooks into ~/.claude/settings.json, merging with whatever the user
 * already has. Idempotent per EVENT, not just overall: a settings file carrying
 * our Stop and Notification entries but not SubagentStop gains only the missing
 * one, so topping up an older install never leaves duplicate commands behind.
 * Returns an already-installed / installed / error result so the UI can inform
 * the user.
 */
export function installHooks():
  | { ok: true; alreadyInstalled: boolean }
  | { ok: false; error: string } {
  try {
    if (isHookInstalled()) return { ok: true, alreadyInstalled: true }

    const settings = readSettings()
    const hooks =
      settings.hooks && typeof settings.hooks === 'object'
        ? (settings.hooks as Record<string, unknown>)
        : {}

    for (const event of HOOK_EVENTS) {
      // Already ours for this event (an install predating a newly added event):
      // leave it exactly as it is rather than appending a second copy.
      if (hasOurHook(hooks, event)) continue
      const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
      // matcher '' matches every occurrence (none of ours are tool-scoped).
      groups.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand() }] })
      hooks[event] = groups
    }
    settings.hooks = hooks

    fs.mkdirSync(hooksDir(), { recursive: true })
    const tmp = settingsFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
    fs.renameSync(tmp, settingsFile())
    return { ok: true, alreadyInstalled: false }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Tails the signal file and emits a HookEvent per line. Starts at the current
 * end-of-file so stale pre-launch events aren't replayed. Uses fs.watch for
 * immediacy with a slow poll as a backstop (watch can miss on some filesystems).
 */
export class HookWatcher {
  private emit: (event: HookEvent) => void
  private offset = 0
  private leftover = '' // partial trailing line carried between reads
  private watcher: fs.FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private draining = false

  constructor(emit: (event: HookEvent) => void) {
    this.emit = emit
  }

  start(): void {
    try {
      fs.mkdirSync(hooksDir(), { recursive: true })
      // create if missing so we can watch it, and start from the end (skip history)
      const fd = fs.openSync(signalFile(), 'a')
      this.offset = fs.fstatSync(fd).size
      fs.closeSync(fd)
    } catch {
      this.offset = 0
    }

    try {
      this.watcher = fs.watch(signalFile(), () => this.drain())
    } catch {
      /* fall back to the poll below */
    }
    this.timer = setInterval(() => this.drain(), 1000)
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      let size: number
      try {
        size = fs.statSync(signalFile()).size
      } catch {
        return
      }
      if (size < this.offset) {
        // file was truncated/rotated out from under us — restart from the top
        this.offset = 0
        this.leftover = ''
      }
      if (size <= this.offset) return

      const fd = fs.openSync(signalFile(), 'r')
      try {
        const len = size - this.offset
        const buf = Buffer.allocUnsafe(len)
        fs.readSync(fd, buf, 0, len, this.offset)
        this.offset = size
        const text = this.leftover + buf.toString('utf8')
        const lines = text.split('\n')
        this.leftover = lines.pop() ?? '' // last piece may be an incomplete line
        for (const line of lines) this.handleLine(line)
      } finally {
        fs.closeSync(fd)
      }

      // keep the file bounded once we've consumed everything
      if (this.offset >= size && size > TRUNCATE_AT_BYTES && !this.leftover) {
        try {
          fs.truncateSync(signalFile(), 0)
          this.offset = 0
        } catch {
          /* best-effort */
        }
      }
    } finally {
      this.draining = false
    }
  }

  private handleLine(line: string): void {
    const event = parseHookLine(line, Date.now(), readTurnContext)
    if (event) this.emit(event)
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
