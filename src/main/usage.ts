import fs from 'node:fs'
import path from 'node:path'
import { projectsRoot } from './platform'

/**
 * Per-session token attribution for the current limit window.
 *
 * The /usage endpoint reports how much of a window is gone but never says who
 * spent it, so the split across panes is reconstructed locally from the
 * transcripts under ~/.claude/projects. Token counts here are exact (they are
 * the API's own usage numbers); only the attribution is ours.
 *
 * Transcripts are read INCREMENTALLY: we remember each file's consumed byte
 * offset and its parsed per-message records, and on each refresh read only the
 * bytes appended since last time. Window bucketing is recomputed from the
 * cached records every call, so a moving window boundary stays correct without
 * ever re-reading a whole file.
 */

/** subagent transcripts live at <project>/<sessionId>/subagents/agent-*.jsonl */
const MAX_WALK_DEPTH = 4
/** how far back of already-parsed history to keep, so memory stays bounded */
const RETAIN_MS = 5 * 60 * 60 * 1000

export interface SessionWindowTokens {
  /** tokens spent in the window, keyed by Claude session id */
  bySessionId: Record<string, number>
  /** total tokens spent in the window */
  windowTokens: number
}

/** One usage-bearing message extracted from a transcript line. */
interface UsageRecord {
  ts: number
  tokens: number
  /** dedup key: `${message.id}:${requestId}` (or ':' when unknown) */
  key: string
}

interface FileCache {
  /** bytes consumed so far (always ends on a line boundary) */
  offset: number
  mtimeMs: number
  records: UsageRecord[]
}

const fileCache = new Map<string, FileCache>()

/** Read raw bytes [from, to) of a file without slurping the whole thing. */
function readRange(filePath: string, from: number, to: number): string {
  const length = to - from
  if (length <= 0) return ''
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    fs.readSync(fd, buffer, 0, length, from)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function parseUsageLine(line: string, fallbackTs: number): UsageRecord | null {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const message = entry?.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, number> | undefined
  if (!usage) return null
  const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  // Cache READS are excluded: they are re-served context, not new spend, and
  // counting them would swamp every other number in the split.
  const tokens =
    (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  return {
    ts: Number.isFinite(timestamp) ? timestamp : fallbackTs,
    tokens,
    key: `${(message?.id as string) ?? ''}:${(entry.requestId as string) ?? ''}`
  }
}

/**
 * Bring a file's cache up to date, reading only the bytes appended since the
 * last refresh. Returns all of its parsed records, pruned to the retained span.
 */
function recordsFor(filePath: string, stat: fs.Stats, keepFromMs: number): UsageRecord[] {
  let cache = fileCache.get(filePath)
  // truncated / rotated → start over
  if (cache && stat.size < cache.offset) cache = undefined
  if (!cache) cache = { offset: 0, mtimeMs: 0, records: [] }

  if (stat.size > cache.offset) {
    const chunk = readRange(filePath, cache.offset, stat.size)
    // only consume up to the last newline; a trailing partial line waits for next time
    const lastNewline = chunk.lastIndexOf('\n')
    if (lastNewline >= 0) {
      const complete = chunk.slice(0, lastNewline)
      cache.offset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8')
      for (const line of complete.split('\n')) {
        if (!line) continue
        const record = parseUsageLine(line, stat.mtimeMs)
        if (record) cache.records.push(record)
      }
    }
    cache.mtimeMs = stat.mtimeMs
  }

  if (cache.records.length && cache.records[0].ts < keepFromMs) {
    cache.records = cache.records.filter((record) => record.ts >= keepFromMs)
  }

  fileCache.set(filePath, cache)
  return cache.records
}

/** A transcript file discovered under a project folder. */
interface FoundFile {
  filePath: string
  stat: fs.Stats
  /** the session this file's spend belongs to */
  sessionId: string
}

/**
 * Walk one project folder, attributing every transcript to a session. A
 * top-level `<project>/<sessionId>.jsonl` is that session; a subagent file at
 * `<project>/<sessionId>/subagents/agent-*.jsonl` is spend the PARENT session
 * caused, so `sessionDir` (the folder named after the session) carries down the
 * recursion and claims it.
 */
function walkProject(
  dirPath: string,
  sessionDir: string | null,
  depth: number,
  found: FoundFile[]
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      // Recurse: subagent transcripts live below the session folder and carry
      // real usage that a one-level listing silently drops (whole models can go
      // missing from the tally). A directory at project level names its session.
      if (depth < MAX_WALK_DEPTH) {
        walkProject(entryPath, depth === 1 ? entry.name : sessionDir, depth + 1, found)
      }
      continue
    }
    if (!entry.name.endsWith('.jsonl')) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(entryPath)
    } catch {
      continue
    }
    found.push({
      filePath: entryPath,
      stat,
      sessionId: depth === 1 || !sessionDir ? path.basename(entry.name, '.jsonl') : sessionDir
    })
  }
}

/**
 * Tokens spent between `windowStartMs` and `windowEndMs`, split by session id.
 * `root` is injectable so tests can point it at a temp projects tree.
 */
export function sessionWindowTokens(
  windowStartMs: number,
  windowEndMs: number,
  root = projectsRoot()
): SessionWindowTokens {
  const keepFromMs = windowStartMs - RETAIN_MS

  let projectDirs: string[]
  try {
    projectDirs = fs.readdirSync(root)
  } catch {
    return { bySessionId: {}, windowTokens: 0 }
  }

  const found: FoundFile[] = []
  for (const dir of projectDirs) walkProject(path.join(root, dir), null, 1, found)

  // One record per dedup key, keeping the LARGEST usage: transcripts re-write
  // the same message id with progressively growing output_tokens as a response
  // streams, so first-wins undercounts output.
  const best = new Map<string, { record: UsageRecord; sessionId: string }>()
  const keyless: { record: UsageRecord; sessionId: string }[] = []
  const livePaths = new Set<string>() // for pruning cache entries of vanished files

  for (const file of found) {
    if (file.stat.mtimeMs < windowStartMs) {
      fileCache.delete(file.filePath) // nothing in this window; drop any stale cache
      continue
    }
    livePaths.add(file.filePath)

    for (const record of recordsFor(file.filePath, file.stat, keepFromMs)) {
      if (record.key === ':') {
        keyless.push({ record, sessionId: file.sessionId })
        continue
      }
      const previous = best.get(record.key)
      if (!previous || record.tokens > previous.record.tokens) {
        best.set(record.key, { record, sessionId: file.sessionId })
      }
    }
  }

  // evict cache entries for files no longer present this pass
  for (const cached of fileCache.keys()) {
    if (!livePaths.has(cached)) fileCache.delete(cached)
  }

  const bySessionId: Record<string, number> = {}
  let windowTokens = 0
  for (const { record, sessionId } of [...best.values(), ...keyless]) {
    if (record.ts < windowStartMs || record.ts > windowEndMs) continue
    bySessionId[sessionId] = (bySessionId[sessionId] ?? 0) + record.tokens
    windowTokens += record.tokens
  }
  return { bySessionId, windowTokens }
}
