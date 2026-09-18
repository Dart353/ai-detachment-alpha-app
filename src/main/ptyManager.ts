import { spawn as nodePtySpawn } from 'node-pty'
import type { IPty } from 'node-pty'
import os from 'node:os'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { isWsl, wslDistro } from './platform'
import { applyAccountEnv, type AccountEnv } from './accounts'
import type { SpawnOpts } from '../shared/types'

type DataHandler = (id: string, data: string) => void
type ExitHandler = (id: string, exitCode: number) => void

/** The node-pty entry point, injectable so the readiness gate can be unit tested. */
export type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: Record<string, string>
  }
) => IPty

export interface PtyManagerDeps {
  /** Gates Claude Code's fullscreen renderer; read per spawn so a settings
   *  change reaches the next pane. */
  fullscreenTui: () => boolean
  /** The user's shell override for panes, or undefined for the login shell. */
  shellPath: () => string | undefined
  /** The credentials a pane runs under, or undefined for the default account. */
  accountEnv: (accountId?: string) => AccountEnv | undefined
  /** Test seam: replaces node-pty's spawn. */
  spawnPty?: PtySpawn
}

/** Run a command, resolving to its stdout ('' on any failure). Never rejects. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, encoding: 'utf8' }, (err, stdout) => {
      // lsof exits non-zero when some pids are gone but still prints the rest, so
      // we take whatever stdout we got rather than discarding it on error.
      resolve(err && !stdout ? '' : (stdout ?? ''))
    })
  })
}

function isDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * `root` plus every process descended from it, deepest first. One `ps` call — the
 * pane menu opens on a right-click, so this sits in the user's interaction path.
 */
async function descendantsDeepestFirst(root: number): Promise<number[]> {
  const out = await run('ps', ['-Ao', 'pid=,ppid='])
  const children = new Map<number, number[]>()
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (pid === ppid) continue // defensive: a self-parent would loop below
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }

  // Breadth-first from the pty, then reverse so the deepest generation leads.
  const ordered: number[] = []
  const seen = new Set<number>()
  let level = [root]
  while (level.length > 0) {
    const next: number[] = []
    for (const pid of level) {
      if (seen.has(pid)) continue // cycle guard; ps output is untrusted input
      seen.add(pid)
      ordered.push(pid)
      next.push(...(children.get(pid) ?? []))
    }
    level = next
  }
  return ordered.reverse()
}

/** A process's cwd: /proc on Linux, one batched `lsof` on macOS/BSD. */
async function cwdOfPid(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
  // -Fn asks for machine-readable output; -a -d cwd narrows it to the cwd entry,
  // which arrives as an `n`-prefixed line after the `p<pid>` header.
  const out = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'])
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1)
  }
  return null
}

/**
 * zle/readline announces "I am reading a line now" by switching the terminal
 * into bracketed-paste mode. Until that appears, anything typed into the pty
 * sits in the tty input buffer where a startup script that reads from the tty
 * (oh-my-zsh's update prompt is the one that bit us) can steal leading
 * characters — a `claude …` injection arrived at the shell as `laude …`.
 * Waiting for this sequence is the only reliable gate: output quiescence lies
 * (a pending `read` is silent) and the tty echoes buffered input before
 * anyone consumes it, so echo checks pass right before the theft.
 */
const PROMPT_READY_SIGNAL = '\x1b[?2004h'

/**
 * How long to wait for the prompt signal before typing anyway. A shell whose
 * line editor never enables bracketed paste (bash 3.2, `unset
 * zle_bracketed_paste`) pays this full wait once per injected command; chosen
 * deliberately over a shorter wait, which would resurrect the eaten-character
 * bug under any shell init slower than the cutoff.
 */
const PROMPT_READY_TIMEOUT_MS = 5000

/**
 * One step of the split-safe scan for PROMPT_READY_SIGNAL: the sequence can
 * straddle a chunk boundary, so each step prepends the tail kept from the
 * previous one. Exported for tests.
 */
export function scanPromptSignal(tail: string, data: string): { found: boolean; tail: string } {
  const window = tail + data
  if (window.includes(PROMPT_READY_SIGNAL)) return { found: true, tail: '' }
  return { found: false, tail: window.slice(-(PROMPT_READY_SIGNAL.length - 1)) }
}

/** Per-pane record of whether its shell has shown a prompt yet (see
 *  PROMPT_READY_SIGNAL). `waiters` are command injections queued on it. */
interface PromptReadiness {
  proc: IPty
  ready: boolean
  tail: string
  waiters: (() => void)[]
}

export class PtyManager {
  private procs = new Map<string, IPty>()
  private promptReadiness = new Map<string, PromptReadiness>()
  private spawnPty: PtySpawn

  constructor(private deps: PtyManagerDeps) {
    this.spawnPty = deps.spawnPty ?? nodePtySpawn
  }

  spawn(opts: SpawnOpts, onData: DataHandler, onExit: ExitHandler): void {
    this.kill(opts.id)

    // WSL mode: launch the Linux login shell via wsl.exe, entering the pane's
    // Linux cwd with --cd. `opts.cwd` is a stored Linux path (e.g.
    // /home/you/proj), which isn't a valid *Windows* cwd for the wsl.exe process
    // itself — so wsl.exe runs from the Windows home and --cd does the chdir
    // inside WSL. Native platforms keep their normal shell.
    let shell: string
    let args: string[]
    let spawnCwd: string
    if (isWsl()) {
      const distro = wslDistro()
      shell = 'wsl.exe'
      args = [...(distro ? ['-d', distro] : []), '--cd', opts.cwd || '~']
      spawnCwd = os.homedir()
    } else {
      shell =
        this.deps.shellPath() ||
        process.env.SHELL ||
        (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
      args = process.platform === 'win32' ? [] : ['-l']
      spawnCwd = opts.cwd || os.homedir()
    }

    // The app is often launched from inside a Claude Code session (the dev loop,
    // or an agent opening the app). That session's identity env leaks into our
    // PTYs, and a `claude` spawned there adopts the PARENT's session id — its
    // transcript then lands under the wrong id, so the session watcher (titles,
    // model, awaiting detection) never finds it. Panes must be their own
    // sessions: strip session-identity vars before spawning.
    const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    // oh-my-zsh's periodic update check does a blocking `read` from the tty
    // before the first prompt: it stalls the prompt-ready gate below until the
    // user answers, and past the fallback timeout it steals the first typed
    // character (the `laude: command not found` bug). These are app-managed
    // panes, so opt out of the interactive updater here; the user's own
    // terminals still get the prompt. Harmless for shells without oh-my-zsh.
    env.DISABLE_AUTO_UPDATE = 'true'
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_SESSION_ID
    delete env.CLAUDE_CODE_CHILD_SESSION
    delete env.CLAUDE_CODE_ENTRYPOINT
    // Electron sets this when it re-execs itself as Node; a `claude` inheriting
    // it would boot as plain Node rather than as itself.
    delete env.ELECTRON_RUN_AS_NODE

    // Launch Claude Code in fullscreen (alternate-screen) rendering. In the classic
    // renderer a paste too small to be collapsed into a chip renders inline and the
    // input box grows upward without bound; in a short grid pane it outgrows the
    // viewport and can't be scrolled. Fullscreen pins the input box to the bottom
    // and gives Claude Code its own scroll handling, which fixes that. This env var
    // is Claude Code's own (equivalent to `/tui fullscreen`), so it only applies to
    // a Claude pane — plain shells never get it. The setting can turn it off, in
    // which case we also strip any inherited value so classic rendering wins.
    // Either way we strip any inherited value from non-Claude panes.
    if (opts.kind === 'claude' && this.deps.fullscreenTui()) {
      env.CLAUDE_CODE_NO_FLICKER = '1'
    } else {
      delete env.CLAUDE_CODE_NO_FLICKER
    }

    if (opts.mint) {
      // The setup-token session runs against its own staging config dir with
      // every inherited Anthropic credential stripped, so the sign-in it walks
      // the user through is the ONLY identity in play.
      applyAccountEnv(env, { configDir: opts.mint.configDir })
    } else {
      applyAccountEnv(env, this.deps.accountEnv(opts.accountId))
    }

    const proc = this.spawnPty(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: spawnCwd,
      env
    })

    this.procs.set(opts.id, proc)
    // Native PowerShell starts ready: PSReadLine's bracketed-paste emission is
    // version-dependent, and Windows profiles don't have the stdin-eating
    // startup pattern, so waiting there would only add the fallback delay.
    // WSL panes run a Linux shell and wait like the Unix platforms.
    const readiness: PromptReadiness = {
      proc,
      ready: process.platform === 'win32' && !isWsl(),
      tail: '',
      waiters: []
    }
    this.promptReadiness.set(opts.id, readiness)
    proc.onData((data) => {
      if (!readiness.ready) {
        const scan = scanPromptSignal(readiness.tail, data)
        readiness.tail = scan.tail
        if (scan.found) {
          readiness.ready = true
          const waiters = readiness.waiters
          readiness.waiters = []
          for (const waiter of waiters) waiter()
        }
      }
      onData(opts.id, data)
    })
    proc.onExit(({ exitCode }) => {
      // "Start fresh" kills the old PTY then respawns into the SAME id. The old
      // claude can hold the pty slave open long enough that its exit lands after
      // the new proc is already registered — deleting the entry then would evict
      // the new proc and silently drop every keystroke. Only act while this proc
      // is still the current one registered under this id.
      if (this.procs.get(opts.id) !== proc) return
      this.procs.delete(opts.id)
      this.promptReadiness.delete(opts.id)
      onExit(opts.id, exitCode)
    })

    if (opts.command) {
      this.writeCommandWhenReady(opts.id, proc, opts.command)
    }
  }

  /**
   * Type `command` into the pane's shell, but only once its line editor is
   * actually reading (see PROMPT_READY_SIGNAL) — or after the fallback timeout
   * for shells that never signal. Everything funnels through the proc-identity
   * guard so a waiter or timer left over from a killed pane fires into nothing.
   */
  private writeCommandWhenReady(id: string, proc: IPty, command: string): void {
    const fire = (): void => {
      if (this.procs.get(id) !== proc) return
      try {
        proc.write(command + '\r')
      } catch {
        // The pane exited between the readiness signal and the write.
      }
    }
    const readiness = this.promptReadiness.get(id)
    if (!readiness || readiness.proc !== proc || readiness.ready) {
      fire()
      return
    }
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      fire()
    }, PROMPT_READY_TIMEOUT_MS)
    readiness.waiters.push(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      fire()
    })
  }

  write(id: string, data: string): void {
    const proc = this.procs.get(id)
    if (!proc) {
      // A dropped write is how "the pane typed nothing" presents; leave a trace.
      console.warn(`[pty] write dropped: no proc for id ${id} (${data.length} bytes)`)
      return
    }
    proc.write(data)
  }

  /**
   * The pane's *live* working directory, or null if it can't be determined.
   *
   * A pane's stored `cwd` is only ever its spawn-time directory — nothing writes
   * it back when the shell (or the agent running in it) chdirs. So "Copy path" on a
   * pane that had `cd`'d into a worktree still handed back the workspace root. Rather
   * than trying to track every `cd`, we ask the OS what the process tree is actually
   * sitting in, which is correct regardless of how the directory changed (cd, pushd,
   * a subshell, an agent's own chdir).
   *
   * We walk the pty's descendants and prefer the deepest one: with `claude` running
   * under the login shell, the agent's cwd is the directory the user means, and it's
   * the shell's cwd that goes stale. Falls back up the chain to the shell itself.
   *
   * Unsupported on Windows and under WSL (the pty there is wsl.exe, whose Windows
   * cwd says nothing about the Linux path the shell is in) — callers fall back to
   * the stored cwd.
   */
  async cwd(id: string): Promise<string | null> {
    const proc = this.procs.get(id)
    if (!proc) return null
    if (process.platform === 'win32' || isWsl()) return null

    let pids: number[]
    try {
      pids = await descendantsDeepestFirst(proc.pid)
    } catch {
      return null
    }

    for (const pid of pids) {
      const dir = await cwdOfPid(pid)
      // Guard against a race: the process can exit between listing and lookup, and
      // a stale/relative answer is worse than falling back to the stored cwd.
      if (dir && dir.startsWith('/') && isDir(dir)) return dir
    }
    return null
  }

  /**
   * Flow control (renderer-driven backpressure). When one terminal's xterm write
   * buffer backs up, the renderer asks us to pause that PTY so node-pty stops
   * draining the child's output. Without this, many panes streaming their
   * full-screen TUI at once flood the single renderer thread and freeze the whole
   * UI (keyboard included). Resume once the terminal has caught up.
   */
  pause(id: string): void {
    try {
      this.procs.get(id)?.pause()
    } catch {
      // proc may have exited
    }
  }

  resume(id: string): void {
    try {
      this.procs.get(id)?.resume()
    } catch {
      // proc may have exited
    }
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      try {
        this.procs.get(id)?.resize(cols, rows)
      } catch {
        // proc may have exited between check and resize
      }
    }
  }

  kill(id: string): void {
    const proc = this.procs.get(id)
    this.promptReadiness.delete(id)
    if (proc) {
      this.procs.delete(id)
      try {
        proc.kill()
      } catch {
        // already dead
      }
    }
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id)
  }
}
