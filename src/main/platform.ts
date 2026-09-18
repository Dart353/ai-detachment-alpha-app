import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * WSL mode — the single source of truth for "where does `.claude` live".
 *
 * On a native Windows build the app runs as a Windows process, but a WSL user's
 * Claude Code, transcripts and settings live in the Linux home
 * (`/home/<user>/.claude`). When WSL mode is enabled we redirect every `.claude`
 * path into that Linux home via its `\\wsl.localhost\<distro>\…` network share
 * (falling back to the legacy `\\wsl$\…`), and terminal panes spawn `wsl.exe`.
 *
 * Everything here is a no-op off Windows (the Linux build resolves native paths),
 * so `isWsl()` gates the behaviour: false unless the setting is on AND platform
 * is win32. Consumers call claudeDir()/projectsRoot() for `.claude` paths and
 * toHost()/toStored() to translate workspace folder paths across the
 * Linux↔Windows boundary.
 */

export interface WslConfig {
  enabled: boolean
  distro?: string
}

let cfg: WslConfig = { enabled: false }
// resolved lazily from `wsl.exe`; reset whenever the config changes.
let resolved = false
let linuxHome = '' // e.g. /home/suessalex
let uncRoot = '' // e.g. \\wsl.localhost\Ubuntu-20.04
let uncHome = '' // e.g. \\wsl.localhost\Ubuntu-20.04\home\suessalex

/** Apply new settings; discovery re-runs on next path resolution if they changed. */
export function configureWsl(next: WslConfig | undefined): void {
  const config = next ?? { enabled: false }
  if (config.enabled !== cfg.enabled || config.distro !== cfg.distro) {
    resolved = false
    linuxHome = ''
    uncRoot = ''
    uncHome = ''
  }
  cfg = config
}

/** True only when WSL mode is on AND we're a Windows process (else a no-op). */
export function isWsl(): boolean {
  return cfg.enabled && process.platform === 'win32'
}

export function wslDistro(): string | undefined {
  return cfg.distro
}

/** Discover the WSL user's Linux $HOME and the working `\\wsl…` share prefix. */
function resolve(): void {
  if (resolved || !isWsl() || !cfg.distro) return
  const distro = cfg.distro
  let home = ''
  try {
    home = execFileSync('wsl.exe', ['-d', distro, 'sh', '-c', 'printf %s "$HOME"'], {
      encoding: 'utf8',
      timeout: 5000
    }).trim()
  } catch {
    return // leave unresolved; callers fall back to native paths
  }
  if (!home) return
  linuxHome = home
  const tail = home.replace(/\//g, '\\')
  // Prefer the modern \\wsl.localhost\ share; fall back to legacy \\wsl$\.
  for (const root of [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`]) {
    try {
      if (fs.existsSync(root + tail)) {
        uncRoot = root
        break
      }
    } catch {
      /* keep trying */
    }
  }
  if (!uncRoot) uncRoot = `\\\\wsl.localhost\\${distro}` // best effort
  uncHome = uncRoot + tail
  resolved = true
}

/**
 * Pure transform (exported for testing): join an absolute Linux path onto a
 * `\\wsl…\<distro>` share root, converting separators. e.g.
 * ('\\\\wsl.localhost\\Ubuntu', '/home/x/.claude') → '\\\\wsl.localhost\\Ubuntu\\home\\x\\.claude'.
 */
export function joinWinShare(root: string, linuxPath: string): string {
  return root + linuxPath.replace(/\//g, '\\')
}

/** Pure inverse of joinWinShare: strip the share root back to a Linux path. */
export function stripWinShare(root: string, winPath: string): string {
  if (root && winPath.toLowerCase().startsWith(root.toLowerCase())) {
    const rest = winPath.slice(root.length).replace(/\\/g, '/')
    return rest || '/'
  }
  return winPath
}

/** Convert an absolute Linux path to its Windows `\\wsl…` share equivalent. */
export function linuxToWin(p: string): string {
  resolve()
  if (!uncRoot) return p
  return joinWinShare(uncRoot, p)
}

/** Convert a `\\wsl…` share path back to its Linux path (or return unchanged). */
export function winToLinux(p: string): string {
  resolve()
  return stripWinShare(uncRoot, p)
}

/**
 * A stored path (Linux, in WSL mode) → a path Node's fs can actually open.
 * Off WSL, or for paths already host-native, returns the input unchanged.
 */
export function toHost(p: string): string {
  if (!isWsl() || !p) return p
  if (p.startsWith('/')) return linuxToWin(p)
  return p
}

/**
 * A host path (e.g. from the native folder dialog) → the form we persist.
 * In WSL mode a `\\wsl…` selection becomes its Linux path so it matches how
 * Claude Code (running inside WSL) encodes its project directories.
 */
export function toStored(p: string): string {
  if (!isWsl() || !p) return p
  return winToLinux(p)
}

/** Absolute host path to the `.claude` directory (native home or WSL home). */
export function claudeDir(configDir?: string): string {
  if (configDir) return configDir
  if (!isWsl()) return path.join(os.homedir(), '.claude')
  resolve()
  if (!uncHome) return path.join(os.homedir(), '.claude') // discovery failed → native
  return uncHome + '\\.claude'
}

export function projectsRoot(configDir?: string): string {
  return path.join(claudeDir(configDir), 'projects')
}

/** Host path to the (Linux or native) home directory, for `~` expansion. */
export function homeDir(): string {
  if (!isWsl()) return os.homedir()
  resolve()
  return uncHome || os.homedir()
}

/** Installed WSL distributions, for the shell-profile picker. Empty off Windows. */
export function listDistros(): string[] {
  if (process.platform !== 'win32') return []
  try {
    // `wsl -l -q` emits UTF-16LE, one distro name per line.
    const out = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', timeout: 5000 })
    return out
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}
