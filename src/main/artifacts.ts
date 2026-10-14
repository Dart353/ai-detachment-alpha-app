import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactRecord } from '../shared/types'
import { listAccounts } from './accounts'
import { projectsRoot, toHost } from './platform'

/**
 * The artifacts Claude published: claude.ai pages created through Claude Code's
 * Artifact tool. Nothing on disk lists them, but every publish is in a session
 * transcript as a tool call (its local file, description) and a tool result
 * ("Published <file> at https://claude.ai/artifact/<id> (Version N, …)").
 * This reads those back out of every account's transcripts and merges them by URL.
 *
 * COUPLED TO THE ARTIFACT TOOL'S RESULT WORDING (`PUBLISHED_RE`): if a Claude
 * Code release rephrases it, publishes stop being found — nothing breaks, the
 * list just stops growing.
 */

/** One successful publish, as a transcript records it. */
export interface Publish {
  url: string
  /** Epoch ms of the tool call. */
  at: number
  filePath: string | null
  description: string | null
  title: string | null
  version: number | null
  cwd: string | null
}

const PUBLISHED_RE =
  /Published (.+?) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+)(?: \(Version (\d+))?/

/** Subagent transcripts sit two folders below the project; nothing lives deeper. */
const MAX_WALK_DEPTH = 3
/** Enough of an HTML file to find its <title> in the <head>. */
const TITLE_SCAN_BYTES = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** A tool result's text, whether it arrived as a string or as text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
    .join('\n')
}

/** Every successful page publish in one transcript's text, in file order. */
export function publishesFromTranscript(text: string): Publish[] {
  // Most transcripts never published anything; skip the line parse for them.
  if (!text.includes('"name":"Artifact"')) return []
  const calls = new Map<string, { input: Record<string, unknown>; at: number; cwd: string | null }>()
  const out: Publish[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('Artifact') && !line.includes('tool_result')) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry) || !isRecord(entry['message'])) continue
    const content = entry['message']['content']
    if (!Array.isArray(content)) continue
    const at = Date.parse(String(entry['timestamp'] ?? ''))
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block['type'] === 'tool_use' && block['name'] === 'Artifact' && typeof block['id'] === 'string') {
        const input = isRecord(block['input']) ? block['input'] : {}
        const action = input['action'] ?? 'publish'
        // Asset uploads publish into an artifact's store, not a page of their own.
        if (action !== 'publish' || input['asset'] === true) continue
        calls.set(block['id'], { input, at: Number.isNaN(at) ? 0 : at, cwd: str(entry['cwd']) })
        continue
      }
      if (block['type'] !== 'tool_result' || block['is_error'] === true) continue
      const call = typeof block['tool_use_id'] === 'string' ? calls.get(block['tool_use_id']) : undefined
      if (!call) continue
      const match = PUBLISHED_RE.exec(resultText(block['content']))
      if (!match) continue
      out.push({
        url: match[2],
        at: call.at,
        filePath: str(call.input['file_path']) ?? match[1],
        description: str(call.input['description']),
        title: str(call.input['title']),
        version: match[3] ? Number(match[3]) : null,
        cwd: call.cwd
      })
    }
  }
  return out
}

/** A name for a page with no readable <title>: its file, or its folder for an index page. */
export function nameFromPath(filePath: string | null, url: string): string {
  if (!filePath) return url.slice(url.lastIndexOf('/') + 1)
  const parts = filePath.split(/[/\\]/).filter(Boolean)
  const file = parts.at(-1) ?? filePath
  const stem = file.replace(/\.[^.]+$/, '')
  if (stem.toLowerCase() === 'index' && parts.length > 1) return parts.at(-2) ?? stem
  return stem
}

/**
 * Publishes grouped by URL, newest artifact first. The latest publish decides the
 * file and folder; the description is the latest one any publish gave.
 */
export function mergePublishes(
  publishes: Publish[],
  readTitle: (filePath: string) => string | null,
  exists: (filePath: string) => boolean
): ArtifactRecord[] {
  const byUrl = new Map<string, Publish[]>()
  for (const publish of publishes) {
    const list = byUrl.get(publish.url)
    if (list) list.push(publish)
    else byUrl.set(publish.url, [publish])
  }
  const records: ArtifactRecord[] = []
  for (const [url, list] of byUrl) {
    list.sort((a, b) => a.at - b.at)
    const latest = list[list.length - 1]
    const filePath = latest.filePath
    const fileExists = filePath ? exists(filePath) : false
    const describedBy = [...list].reverse().find((publish) => publish.description)
    const titled = [...list].reverse().find((publish) => publish.title)
    const versions = list.map((publish) => publish.version).filter((v): v is number => v !== null)
    records.push({
      url,
      title:
        (filePath && fileExists ? readTitle(filePath) : null) ??
        titled?.title ??
        nameFromPath(filePath, url),
      description: describedBy?.description ?? null,
      filePath,
      fileExists,
      cwd: latest.cwd,
      version: versions.length > 0 ? Math.max(...versions) : null,
      firstPublishedAt: list[0].at,
      lastPublishedAt: latest.at,
      publishCount: list.length
    })
  }
  return records.sort((a, b) => b.lastPublishedAt - a.lastPublishedAt)
}

/** The text of an HTML page's <title>, entities left as written. */
export function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = match?.[1].replace(/\s+/g, ' ').trim()
  return title ? title : null
}

/* === the scan =============================================================== */

/** Parsed publishes per transcript, kept while the file is unchanged. */
const cache = new Map<string, { mtimeMs: number; size: number; publishes: Publish[] }>()

async function walk(dir: string, depth: number, found: string[]): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_WALK_DEPTH) await walk(entryPath, depth + 1, found)
    } else if (entry.name.endsWith('.jsonl')) {
      found.push(entryPath)
    }
  }
}

/** The projects folder of the user's own ~/.claude and of every added account. */
function projectRoots(): string[] {
  const roots = new Set([projectsRoot()])
  for (const account of listAccounts()) {
    if (account.configDir) roots.add(path.join(account.configDir, 'projects'))
  }
  return [...roots]
}

async function publishesIn(filePath: string): Promise<Publish[]> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    cache.delete(filePath)
    return []
  }
  const cached = cache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.publishes
  let publishes: Publish[] = []
  try {
    publishes = publishesFromTranscript(await fs.promises.readFile(filePath, 'utf8'))
  } catch {
    // unreadable right now; try again next scan
  }
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, publishes })
  return publishes
}

function readTitle(filePath: string): string | null {
  if (!/\.html?$/i.test(filePath)) return null
  try {
    const fd = fs.openSync(toHost(filePath), 'r')
    try {
      const buffer = Buffer.alloc(TITLE_SCAN_BYTES)
      const read = fs.readSync(fd, buffer, 0, TITLE_SCAN_BYTES, 0)
      return htmlTitle(buffer.subarray(0, read).toString('utf8'))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Every artifact found in this machine's transcripts, newest first. */
export async function listArtifacts(): Promise<ArtifactRecord[]> {
  const files: string[] = []
  for (const root of projectRoots()) await walk(root, 1, files)
  const publishes: Publish[] = []
  for (const file of files) publishes.push(...(await publishesIn(file)))
  const live = new Set(files)
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)
  return mergePublishes(publishes, readTitle, (filePath) => fs.existsSync(toHost(filePath)))
}
