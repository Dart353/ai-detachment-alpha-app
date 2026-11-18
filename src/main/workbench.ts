import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  WORKBENCH_CAPTURES_DIR,
  WORKBENCH_FILE,
  WORKBENCH_INSTRUCTIONS,
  WORKBENCH_INSTRUCTIONS_VERSION,
  WORKBENCH_MAX_BYTES,
  WORKBENCH_RULES_FILE,
  WORKBENCH_SKELETON,
  parseWorkbench
} from '../shared/workbench'
import type {
  WorkbenchRulesState,
  WorkbenchSetupResult,
  WorkbenchSetupState,
  WorkbenchSnapshot
} from '../shared/types'
import { toHost } from './platform'

/**
 * The workbench on disk: setting a workspace up for one, and watching the page
 * its agents keep.
 *
 * Setup is the only time ADA writes into the user's project, and it writes
 * three things: the rule Claude reads (`.claude/rules/ada-workbench.md`), the
 * page's starting skeleton (only if there is no page yet), and the captures
 * folder. All three are listed in the repository's `.git/info/exclude` — never
 * `.gitignore`, which is the user's and is usually committed — so nothing ADA
 * adds shows up in `git status`.
 *
 * After setup the page belongs to the agents. The watcher only ever reads it.
 *
 * Paths arrive in stored form (Linux, in WSL mode) and are translated with
 * `toHost` at the disk touch, as everywhere else in main.
 */

/** The first line of an installed rule: which version, and the hash of what we wrote. */
const MARKER_RE = /^<!-- ada:workbench v(\d+) sha256:([0-9a-f]{64}) -->\r?\n/

const EXCLUDE_HEADER = '# AI Detachment Alpha workbench (local only, never committed)'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The rule file's full text as this build installs it. */
export function rulesFileText(): string {
  return `<!-- ada:workbench v${WORKBENCH_INSTRUCTIONS_VERSION} sha256:${sha256(WORKBENCH_INSTRUCTIONS)} -->\n${WORKBENCH_INSTRUCTIONS}`
}

/** Compare an installed rule file's text with the one this build ships. */
export function rulesStateOf(text: string | null): WorkbenchRulesState {
  if (text === null) return 'missing'
  const marker = MARKER_RE.exec(text)
  // No marker: a file someone else put at our path. Never ours to overwrite.
  if (!marker) return 'modified'
  const body = text.slice(marker[0].length)
  if (sha256(body) !== marker[2]) return 'modified'
  return body === WORKBENCH_INSTRUCTIONS ? 'current' : 'outdated'
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/* === git exclude ======================================================== */

interface RepoInfo {
  /** Where `info/exclude` lives: the common git dir, shared by every worktree. */
  infoDir: string
  /** The workspace root relative to the repository's top, '/'-separated, '' at the top. */
  prefix: string
}

/**
 * The repository a folder belongs to, found by walking up to the nearest
 * `.git`. A `.git` *file* is a worktree or submodule pointer (`gitdir: …`);
 * a worktree's git dir names the shared one in `commondir`, and `info/exclude`
 * is read from there.
 */
export function findRepo(hostRoot: string): RepoInfo | null {
  let dir = path.resolve(hostRoot)
  for (;;) {
    const dotGit = path.join(dir, '.git')
    let gitDir: string | null = null
    try {
      const stat = fs.statSync(dotGit)
      if (stat.isDirectory()) gitDir = dotGit
      else if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
        if (pointer) gitDir = path.resolve(dir, pointer[1])
      }
    } catch {
      /* no .git here — keep walking */
    }
    if (gitDir) {
      const common = readText(path.join(gitDir, 'commondir'))?.trim()
      const commonDir = common ? path.resolve(gitDir, common) : gitDir
      const prefix = path.relative(dir, path.resolve(hostRoot)).split(path.sep).join('/')
      return { infoDir: path.join(commonDir, 'info'), prefix }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The exclude patterns for a workspace at `prefix` within its repository. */
export function excludePatterns(prefix: string): string[] {
  const base = prefix ? `/${prefix}/` : '/'
  return [`${base}${WORKBENCH_FILE}`, `${base}${WORKBENCH_CAPTURES_DIR}/`, `${base}${WORKBENCH_RULES_FILE}`]
}

function excludedState(hostRoot: string): boolean | null {
  const repo = findRepo(hostRoot)
  if (!repo) return null
  const lines = new Set((readText(path.join(repo.infoDir, 'exclude')) ?? '').split(/\r?\n/))
  return excludePatterns(repo.prefix).every((pattern) => lines.has(pattern))
}

/** Append whichever of our patterns `info/exclude` lacks. Idempotent. */
function ensureExcluded(hostRoot: string): void {
  const repo = findRepo(hostRoot)
  if (!repo) return
  const file = path.join(repo.infoDir, 'exclude')
  const existing = readText(file) ?? ''
  const lines = new Set(existing.split(/\r?\n/))
  const missing = excludePatterns(repo.prefix).filter((pattern) => !lines.has(pattern))
  if (missing.length === 0) return
  const block = [...(lines.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER]), ...missing].join('\n')
  const lead = existing === '' || existing.endsWith('\n') ? '' : '\n'
  fs.mkdirSync(repo.infoDir, { recursive: true })
  fs.appendFileSync(file, `${lead}${block}\n`)
}

/* === setup ============================================================== */

/** What a workspace folder has of the workbench, without changing anything. */
export function workbenchState(rootDir: string): WorkbenchSetupState {
  const hostRoot = toHost(rootDir)
  return {
    rules: rulesStateOf(readText(path.join(hostRoot, WORKBENCH_RULES_FILE))),
    page: isFile(path.join(hostRoot, WORKBENCH_FILE)),
    excluded: excludedState(hostRoot)
  }
}

export interface SetupOptions {
  /** Overwrite a rule file that was edited by hand. Off unless the user chose it. */
  replaceModifiedRules?: boolean
}

/**
 * Give a workspace a workbench: the rule, the page (when there is none), the
 * captures folder, and the exclude lines. Safe to run again — it only fills
 * in what is missing or out of date, and never touches an existing page.
 */
export function setupWorkbench(rootDir: string, options: SetupOptions = {}): WorkbenchSetupResult {
  const hostRoot = toHost(rootDir)
  try {
    if (!fs.statSync(hostRoot).isDirectory()) return { ok: false, error: 'Not a folder.' }
  } catch {
    return { ok: false, error: 'The folder no longer exists.' }
  }
  try {
    // Excluded first, so not even a moment of `git status` shows the new files.
    ensureExcluded(hostRoot)

    const rulesFile = path.join(hostRoot, WORKBENCH_RULES_FILE)
    const rules = rulesStateOf(readText(rulesFile))
    if (rules !== 'current' && (rules !== 'modified' || options.replaceModifiedRules)) {
      fs.mkdirSync(path.dirname(rulesFile), { recursive: true })
      fs.writeFileSync(rulesFile, rulesFileText())
    }

    const page = path.join(hostRoot, WORKBENCH_FILE)
    // 'wx' fails when the file exists: an agent's page is never replaced.
    try {
      fs.writeFileSync(page, WORKBENCH_SKELETON, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    fs.mkdirSync(path.join(hostRoot, WORKBENCH_CAPTURES_DIR), { recursive: true })
    return { ok: true, state: workbenchState(rootDir) }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/* === reading and watching the page ======================================= */

/** The page as it is on disk now. A missing or oversized page has no sections. */
export function readWorkbench(rootDir: string): WorkbenchSnapshot {
  const file = path.join(toHost(rootDir), WORKBENCH_FILE)
  const snapshot = (exists: boolean, html = ''): WorkbenchSnapshot => ({
    rootDir,
    exists,
    sections: html ? parseWorkbench(html) : [],
    readAt: Date.now()
  })
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return snapshot(false)
    if (stat.size > WORKBENCH_MAX_BYTES) return snapshot(true)
    return snapshot(true, fs.readFileSync(file, 'utf8'))
  } catch {
    return snapshot(false)
  }
}

/** A burst of writes (an agent's write, then its edit) is one read. */
const DEBOUNCE_MS = 150

/**
 * How often the page's size and mtime are checked as well. `fs.watch` is the
 * fast path, but it is not a promise: macOS can drop an event that lands just
 * as the watch starts, and WSL's network share delivers none at all. One stat
 * per open workspace every couple of seconds catches whatever it missed.
 */
const POLL_MS = 2000

export interface WorkbenchWatcherOptions {
  debounceMs?: number
  pollMs?: number
  /** Tests switch the fs.watch fast path off to prove the poll alone suffices. */
  useFsWatch?: boolean
}

/** The page's size and mtime, or '' when there is no page. */
function fingerprint(rootDir: string): string {
  try {
    const stat = fs.statSync(path.join(toHost(rootDir), WORKBENCH_FILE))
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return ''
  }
}

interface RootWatch {
  watcher: fs.FSWatcher | null
  poll: ReturnType<typeof setInterval> | null
  /** The page's size and mtime when last looked at, for the poll. */
  seen: string
  subscribers: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** What was last pushed, so an unchanged rewrite (a touch) pushes nothing. */
  last: string | null
  lastSnapshot: WorkbenchSnapshot | null
}

/**
 * Watches each workspace root for its page, refcounted per root so any number
 * of subscribers cost one `fs.watch`. The watch is on the root folder, not the
 * file: agents write by replacing the file, and a watch on a replaced file goes
 * deaf. Only the root's own entries are seen — never the whole tree.
 */
export class WorkbenchWatcher {
  private roots = new Map<string, RootWatch>()
  private debounceMs: number
  private pollMs: number
  private useFsWatch: boolean

  constructor(
    private onChange: (snapshot: WorkbenchSnapshot) => void,
    options: WorkbenchWatcherOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS
    this.pollMs = options.pollMs ?? POLL_MS
    this.useFsWatch = options.useFsWatch ?? true
  }

  /**
   * Subscribe. The first subscriber arms the watch; every subscriber is sent
   * the page as it stands, because a renderer that reloaded subscribes again
   * under the same id with an empty picture and nothing else would fill it.
   */
  watch(id: string, rootDir: string): void {
    const existing = this.roots.get(rootDir)
    if (existing) {
      existing.subscribers.add(id)
      if (existing.lastSnapshot) this.onChange(existing.lastSnapshot)
      return
    }
    const entry: RootWatch = {
      watcher: null,
      poll: null,
      seen: fingerprint(rootDir),
      subscribers: new Set([id]),
      timer: null,
      last: null,
      lastSnapshot: null
    }
    this.roots.set(rootDir, entry)
    entry.poll = setInterval(() => {
      if (fingerprint(rootDir) !== entry.seen) this.schedule(rootDir)
    }, this.pollMs)
    entry.poll.unref?.()
    if (this.useFsWatch) this.armFsWatch(rootDir, entry)
    this.push(rootDir)
  }

  private armFsWatch(rootDir: string, entry: RootWatch): void {
    try {
      entry.watcher = fs.watch(toHost(rootDir), (_event, filename) => {
        // Some platforms report no name; then any change could be ours.
        if (!filename || filename.toString() === WORKBENCH_FILE) this.schedule(rootDir)
      })
      entry.watcher.on('error', () => {
        entry.watcher?.close()
        entry.watcher = null
      })
    } catch {
      /* the folder is gone; the poll notices if it comes back */
    }
  }

  unwatch(id: string, rootDir: string): void {
    const entry = this.roots.get(rootDir)
    if (!entry) return
    entry.subscribers.delete(id)
    if (entry.subscribers.size > 0) return
    this.stop(entry)
    this.roots.delete(rootDir)
  }

  private stop(entry: RootWatch): void {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.poll) clearInterval(entry.poll)
    entry.watcher?.close()
  }

  /** Re-read a root now, e.g. right after setup wrote its page. */
  refresh(rootDir: string): void {
    if (this.roots.has(rootDir)) this.push(rootDir)
  }

  dispose(): void {
    for (const entry of this.roots.values()) this.stop(entry)
    this.roots.clear()
  }

  /** How many roots hold a live subscription. Leak instrumentation for the tests. */
  get rootCount(): number {
    return this.roots.size
  }

  private schedule(rootDir: string): void {
    const entry = this.roots.get(rootDir)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.push(rootDir)
    }, this.debounceMs)
  }

  private push(rootDir: string): void {
    const entry = this.roots.get(rootDir)
    if (!entry) return
    entry.seen = fingerprint(rootDir)
    const snapshot = readWorkbench(rootDir)
    const key = JSON.stringify([snapshot.exists, snapshot.sections])
    if (key === entry.last) return
    entry.last = key
    entry.lastSnapshot = snapshot
    this.onChange(snapshot)
  }
}
