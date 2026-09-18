import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitStatus } from '../shared/types'
import { isWsl, wslDistro } from './platform'

/**
 * The branch + dirty flag the workspace header shows. Read through the git CLI
 * rather than a library: the CLI is already whatever the user's repo needs
 * (worktrees, submodules, credential helpers) and it is the same git the panes run.
 */

const run = promisify(execFile)

/** A repo read must never hang the header; git that is this slow is git that is wedged. */
const TIMEOUT_MS = 4000

/**
 * Run `git <args>` in `cwd`. In WSL mode git lives inside WSL and cwd is a Linux
 * path, so we invoke it through `wsl.exe --cd <cwd> git …`; natively we spawn git
 * directly with the given cwd. Returns git's stdout/stderr either way.
 */
function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  if (isWsl()) {
    const distro = wslDistro()
    return run('wsl.exe', [...(distro ? ['-d', distro] : []), '--cd', cwd, 'git', ...args], {
      timeout: TIMEOUT_MS
    })
  }
  return run('git', args, { cwd, timeout: TIMEOUT_MS })
}

/**
 * Branch name and working-tree cleanliness for `cwd`. Outside a repository — or
 * with no git at all — this is `{ branch: null, dirty: false }`, which is exactly
 * how the UI renders a plain folder, so it never throws across IPC.
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const branch = await currentBranch(cwd)
  if (branch === undefined) return { branch: null, dirty: false }
  let dirty = false
  try {
    const { stdout } = await git(['status', '--porcelain'], cwd)
    dirty = stdout.trim().length > 0
  } catch {
    /* status failed after branch succeeded — report clean rather than guessing */
  }
  return { branch, dirty }
}

/**
 * The checked-out branch, `null` on a detached HEAD (where the short SHA is the
 * honest label), or `undefined` when this is not a repository at all — the one
 * case the caller answers with a blank status.
 */
async function currentBranch(cwd: string): Promise<string | null | undefined> {
  let name: string
  try {
    name = (await git(['branch', '--show-current'], cwd)).stdout.trim()
  } catch {
    return undefined
  }
  if (name) return name
  // Empty output means a detached HEAD: show what it is detached at.
  try {
    return (await git(['rev-parse', '--short', 'HEAD'], cwd)).stdout.trim() || null
  } catch {
    return null
  }
}
