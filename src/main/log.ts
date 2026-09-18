import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

type Level = 'info' | 'warn' | 'error'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const RING_MAX = 200

let cachedDir: string | null = null
const ring: string[] = []

function dir(): string {
  if (!cachedDir) {
    cachedDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(cachedDir, { recursive: true })
  }
  return cachedDir
}

function serialize(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (part instanceof Error) return `${part.message}\n${part.stack ?? ''}`.trim()
      if (typeof part === 'string') return part
      try {
        return JSON.stringify(part)
      } catch {
        return String(part)
      }
    })
    .join(' ')
}

function write(level: Level, parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${serialize(parts)}`
  ring.push(line)
  if (ring.length > RING_MAX) ring.shift()
  try {
    const file = path.join(dir(), 'ada.log')
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, path.join(dir(), 'ada.old.log'))
      }
    } catch {
      // no existing log to rotate
    }
    fs.appendFileSync(file, line + '\n')
  } catch {
    // logging must never throw
  }
}

export const log = {
  info: (...parts: unknown[]): void => write('info', parts),
  warn: (...parts: unknown[]): void => write('warn', parts),
  error: (...parts: unknown[]): void => write('error', parts)
}

/** The last (up to 200) log lines, for embedding in a crash report. */
export function recentLines(): string[] {
  return [...ring]
}

/**
 * Where the logs are, for the Help menu's Reveal Logs. Talking a user through
 * ⇧⌘G and a hidden Library folder is not a support flow; one menu item is.
 */
export function logsDir(): string {
  return dir()
}

/**
 * Write a self-contained crash report as JSON, synchronously so it survives an
 * imminent process death, and log a pointer to it.
 */
export function writeCrashReport(kind: string, details: object): void {
  const timestamp = new Date().toISOString()
  const report = {
    kind,
    timestamp,
    appVersion: app.getVersion(),
    versions: process.versions,
    platform: process.platform,
    uptime: process.uptime(),
    details,
    recentLogLines: recentLines()
  }
  try {
    const crashesDir = path.join(dir(), 'crashes')
    fs.mkdirSync(crashesDir, { recursive: true })
    const safe = timestamp.replace(/[:.]/g, '-')
    const file = path.join(crashesDir, `crash-${safe}-${kind}.json`)
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
    log.error(`crash report written: ${file}`)
  } catch (err) {
    log.error('failed to write crash report', err as Error)
  }
}
