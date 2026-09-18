import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { loadSettings } from './store'
import type { CliProbe } from '../shared/types'

/**
 * Where anything running the `claude` binary outside a pane finds it.
 *
 * The bug this file exists to fix: the interactive panes spawn `$SHELL -l` on a
 * PTY, which is a login AND interactive shell, so zsh sources ~/.zshrc. A
 * headless run spawns `$SHELL -lc`, which is login but NOT interactive, and zsh
 * sources ~/.zshrc for interactive shells only. Anyone whose PATH export or
 * version-manager init (nvm/fnm/volta) lives in ~/.zshrc (the common case)
 * therefore had working Claude panes but a headless run that died with
 * "command not found".
 *
 * Rather than make the real run interactive (an interactive rc file can print
 * banners over stdout and, worse, read from the stdin we feed the prompt on), we
 * probe ONCE with a throwaway interactive login shell whose stdin is /dev/null,
 * take the absolute path it reports, and hand that to the ordinary `-lc` run.
 * The prompt-carrying spawn stays exactly as safe as it was.
 *
 * Settings → "Claude CLI path" overrides the probe outright, for installs no
 * login shell can see (wrappers, aliases, unusual prefixes).
 */

/** How the binary was located, for the Settings check row. */
export type CliSource =
  /** the explicit path in Settings */
  | 'setting'
  /** found by probing the user's interactive login shell */
  | 'login-shell'
  /** not found: the bare name, left for the shell to fail on and report */
  | 'bare'

export interface CliResolution {
  /** What to actually invoke: an absolute path, or the bare name as a last resort. */
  command: string
  source: CliSource
}

/** The binary this module resolves. */
const CLI_NAME = 'claude'

/** Long enough for a slow rc file (nvm, conda), short enough not to hang a run. */
const PROBE_TIMEOUT_MS = 8_000

/**
 * The resolved path, one probe per app session. Only SUCCESSES are cached: a
 * user who installs the CLI after seeing the error should be able to hit retry
 * without restarting the app, and the re-probe only costs the failure path.
 */
let cached: CliResolution | null = null

/** Drop the cached probe (called when the path setting changes). */
export function clearCliPathCache(): void {
  cached = null
}

/** The explicit path from Settings, or null when unset/blank. */
function cliOverride(): string | null {
  const raw = loadSettings().cliPaths?.claude
  const trimmed = (raw || '').trim()
  return trimmed || null
}

/**
 * The command to invoke. Never throws and never rejects: when nothing is found
 * it returns the bare name, so the spawn fails the way it always did and the
 * caller reports it.
 */
export async function resolveCli(): Promise<CliResolution> {
  const override = cliOverride()
  // An override that doesn't point at an executable is ignored rather than
  // honoured into a confusing failure; the Settings "Check" button is where a
  // bad path gets called out.
  if (override && isExecutableFile(override)) return { command: override, source: 'setting' }

  if (cached) return cached

  const found = await probeLoginShell()
  if (!found) return { command: CLI_NAME, source: 'bare' }
  const resolution: CliResolution = { command: found, source: 'login-shell' }
  cached = resolution
  return resolution
}

/**
 * Re-test the CLI for the Settings panel, bypassing the cache. Unlike resolveCli
 * this reports a broken override instead of quietly falling through to the probe,
 * because the user is standing right there looking at the field they just typed.
 *
 * `candidate` is that unsaved field: pass it so Check tests what is on screen
 * rather than what was last saved. Omit it to test the saved setting.
 */
export async function probeCli(candidate?: string): Promise<CliProbe> {
  const override = candidate === undefined ? cliOverride() : candidate.trim() || null
  if (override && !isExecutableFile(override)) {
    return {
      ok: false,
      command: override,
      source: 'setting',
      error: fs.existsSync(override)
        ? 'That path exists but is not an executable file.'
        : 'No file at that path.'
    }
  }

  // A valid override answers on its own: no probe, and no reading of whatever
  // path happens to be saved (the candidate may not be saved yet).
  if (override) {
    return { ok: true, command: override, source: 'setting', version: await readVersion(override) }
  }

  cached = null
  const found = await probeLoginShell()
  if (!found) {
    return {
      ok: false,
      command: CLI_NAME,
      source: 'bare',
      error: `Could not find \`${CLI_NAME}\` on the PATH your login shell provides. Run \`which ${CLI_NAME}\` in a terminal and paste the path above.`
    }
  }

  cached = { command: found, source: 'login-shell' }
  return { ok: true, command: found, source: 'login-shell', version: await readVersion(found) }
}

/**
 * A child env fit for running the agent CLI: ELECTRON_RUN_AS_NODE stripped so
 * the binary boots as itself rather than as plain Node, and the session-identity
 * vars stripped so it starts its own session (mirrors ptyManager).
 */
export function cleanChildEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_CODE_CHILD_SESSION
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

/**
 * Ask the user's login shell where the CLI is. Interactive first (`-lic`, what
 * the panes get and where ~/.zshrc runs), then plain login (`-lc`) in case an
 * interactive rc file is broken enough to fail the whole shell.
 */
async function probeLoginShell(): Promise<string | null> {
  // No POSIX login shell to consult. (WSL mode never reaches here: those panes
  // already run their login shell inside the distro, so its PATH is correct.)
  if (process.platform === 'win32') return null

  const shell = process.env.SHELL || '/bin/zsh'
  for (const flags of ['-lic', '-lc']) {
    const out = await runProbe(shell, [flags, `command -v ${CLI_NAME}`])
    const hit = firstAbsolutePath(out)
    if (hit && isExecutableFile(hit)) return hit
  }
  return null
}

/** First line that looks like an absolute path. */
function firstAbsolutePath(out: string): string | null {
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    // `command -v` prints the definition for an alias or shell function; neither
    // is something we can spawn, and neither starts with a slash.
    if (trimmed.startsWith('/')) return trimmed
  }
  return null
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First line of `<command> --version`, or undefined if it didn't answer. */
async function readVersion(command: string): Promise<string | undefined> {
  const out = await runProbe(command, ['--version'], false)
  const first = out.split('\n').find((line) => line.trim())
  return first?.trim() || undefined
}

/**
 * Run a short read-only command and collect stdout. stdin is /dev/null so a
 * chatty rc file can't block on a read, and the child is killed at the timeout.
 * Resolves '' on any failure; every caller treats "no answer" as "not found".
 *
 * `acceptNonZero` is on for shell probes: a login shell can exit non-zero from
 * some unrelated rc-file line while still having printed the path we asked for.
 * A `--version` run gets no such benefit of the doubt.
 */
function runProbe(command: string, args: string[], acceptNonZero = true): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: os.homedir(),
        env: cleanChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve('')
      return
    }

    let out = ''
    let done = false
    const finish = (value: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish('')
    }, PROBE_TIMEOUT_MS)

    child.stdout?.on('data', (chunk) => (out += chunk.toString()))
    child.on('error', () => finish(''))
    child.on('close', (code) => finish(code === 0 || acceptNonZero ? out : ''))
  })
}
