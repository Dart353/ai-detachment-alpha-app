import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from './platform'

/**
 * Reads the connectable `Host` aliases out of the user's ssh_config, so the
 * renderer can offer them as "Connect to server" targets. A pick becomes a pane
 * whose command is `ssh <host>`.
 *
 * Paths route through `homeDir()` rather than `os.homedir()`: in WSL mode the
 * config we want lives in the *Linux* home, not the Windows one. The home is an
 * explicit parameter so tests can point the parser at a temp tree.
 *
 * Nothing is cached: the user may edit the config while the app runs, and a
 * host list is cheap enough to reread on every ask.
 */

/** `Include` can nest; cap the chain rather than trusting the file. */
const MAX_DEPTH = 10

/** Host patterns in file order, deduped. Empty when there is no readable config. */
export function sshHosts(home: string = homeDir()): string[] {
  const hosts: string[] = []
  const seenHosts = new Set<string>()
  const visitedFiles = new Set<string>()
  parseFile(path.join(home, '.ssh', 'config'), 0, home, visitedFiles, hosts, seenHosts)
  return hosts
}

function parseFile(
  file: string,
  depth: number,
  home: string,
  visitedFiles: Set<string>,
  hosts: string[],
  seenHosts: Set<string>
): void {
  if (depth > MAX_DEPTH) return

  // Resolve through symlinks before the visited check so `Include`-ing the same
  // file by two different paths still terminates.
  let resolved: string
  let text: string
  try {
    resolved = fs.realpathSync(file)
    if (visitedFiles.has(resolved)) return
    visitedFiles.add(resolved)
    text = fs.readFileSync(resolved, 'utf8')
  } catch {
    return // no config, a directory, unreadable — all normal, not an error
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    // ssh accepts `Host foo` and `Host=foo` alike
    const [keyword, ...args] = line.split(/[\s=]+/)
    const kw = keyword.toLowerCase()

    if (kw === 'host') {
      // one line may declare several aliases: `Host web1 web2`
      for (const pattern of args) {
        if (!connectable(pattern) || seenHosts.has(pattern)) continue
        seenHosts.add(pattern)
        hosts.push(pattern)
      }
    } else if (kw === 'include') {
      for (const token of args) {
        for (const included of expandInclude(token, home)) {
          parseFile(included, depth + 1, home, visitedFiles, hosts, seenHosts)
        }
      }
    }
  }
}

/**
 * Wildcard patterns (`Host *`) and negations (`Host !bad`) configure other hosts
 * rather than naming one, so they are never something you can `ssh` to.
 */
function connectable(pattern: string): boolean {
  return pattern.length > 0 && !pattern.startsWith('!') && !/[*?]/.test(pattern)
}

/**
 * Resolve one `Include` token to concrete files. Relative tokens are relative to
 * `~/.ssh` (the ssh_config rule for user configs). Only the final path segment may
 * glob — that covers the usual `Include ~/.ssh/config.d/*`; `**` is not supported.
 */
function expandInclude(token: string, home: string): string[] {
  let expanded = token
  if (expanded === '~') expanded = home
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(home, expanded.slice(2))
  }
  if (!path.isAbsolute(expanded)) expanded = path.join(home, '.ssh', expanded)

  const dir = path.dirname(expanded)
  const base = path.basename(expanded)
  if (!/[*?]/.test(base)) return [expanded]

  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  // escape regex metacharacters except the glob ones, then map those
  const pattern = new RegExp(
    '^' +
      base
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]') +
      '$'
  )
  // sorted so the host order is stable across runs
  return names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(dir, name))
}
