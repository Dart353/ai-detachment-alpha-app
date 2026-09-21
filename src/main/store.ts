import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  type ArchiveEntry,
  type PersistedState,
  type RecentWorkspace,
  type SavedLayout,
  type Settings
} from '../shared/types'

/**
 * Persistence: workspaces → panes, layouts, recents, settings.
 *
 * One small JSON file per concern rather than one big one. State is rewritten
 * wholesale on every change; recents, archive, layouts and settings each have
 * their own cadence and their own writer, and keeping them apart means a save
 * of one can never clobber another. Every write is atomic (temp file + rename),
 * so a crash mid-write leaves the previous file intact rather than a truncated
 * one.
 */

let overrideDir: string | null = null

/**
 * Point persistence somewhere else — the unit tests use a temp dir. Set before
 * the first read/write so nothing is left behind in the real profile.
 */
export function setStoreDir(dir: string): void {
  overrideDir = dir
}

function storeDir(): string {
  if (overrideDir) return overrideDir
  // Electron is required lazily, and only on the path that actually needs it,
  // so this module can be imported by a plain vitest run (no Electron runtime)
  // as long as the test points it at a temp dir first.
  const electron = require('electron') as typeof import('electron')
  return electron.app.getPath('userData')
}

function file(name: string): string {
  return path.join(storeDir(), name)
}

function readJson(f: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(f: string, data: unknown): void {
  try {
    // PID in the temp name: two instances on one profile (two checkouts both
    // running the app) would otherwise race on a single shared .tmp path and one
    // could rename a half-written file into place. This doesn't make concurrent
    // writes coherent — last writer still wins the whole file — but it does keep
    // either outcome a VALID file rather than a truncated one.
    const tmp = `${f}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, f)
  } catch (err) {
    console.error('Failed to persist', f, err)
  }
}

/** An absent or corrupt file reads as "no state yet", never as a crash. */
export function loadState(): PersistedState | null {
  const raw = readJson(file('ada-state.json'))
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PersistedState) : null
}

export function saveState(state: PersistedState): void {
  writeJsonAtomic(file('ada-state.json'), state)
}

/**
 * Closed workspaces. Their own file so a workspace survives being closed:
 * ada-state.json drops it entirely, but the archive keeps its panes and layout
 * keyed by root directory, so reopening the same folder can offer them back.
 */
export function loadArchive(): ArchiveEntry[] {
  const raw = readJson(file('ada-archive.json'))
  return Array.isArray(raw) ? (raw as ArchiveEntry[]) : []
}

export function saveArchive(archive: ArchiveEntry[]): void {
  writeJsonAtomic(file('ada-archive.json'), archive)
}

/**
 * Recent workspace folders for the open dialog. Outside ada-state.json for the
 * same reason as the archive: a folder you closed is exactly the one still
 * worth offering.
 */
export function loadRecents(): RecentWorkspace[] {
  const raw = readJson(file('ada-recents.json'))
  return Array.isArray(raw) ? (raw as RecentWorkspace[]) : []
}

export function saveRecents(recents: RecentWorkspace[]): void {
  writeJsonAtomic(file('ada-recents.json'), recents)
}

/** Saved zone arrangements, reusable across every workspace. */
export function loadLayouts(): SavedLayout[] {
  const raw = readJson(file('ada-layouts.json'))
  return Array.isArray(raw) ? (raw as SavedLayout[]) : []
}

export function saveLayouts(layouts: SavedLayout[]): void {
  writeJsonAtomic(file('ada-layouts.json'), layouts)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Stored settings over the defaults, one nested object at a time. A shallow
 * spread would let a stored `{ notifications: { muted: true } }` erase the
 * banner/sound sub-objects the UI reads unconditionally, so every nested group
 * is merged on its own terms.
 */
function mergeSettings(base: Settings, stored: Record<string, unknown>): Settings {
  const notifications = isRecord(stored['notifications']) ? stored['notifications'] : {}
  return {
    ...base,
    ...(stored as Partial<Settings>),
    wsl: { ...base.wsl, ...(isRecord(stored['wsl']) ? stored['wsl'] : {}) },
    cliPaths: { ...base.cliPaths, ...(isRecord(stored['cliPaths']) ? stored['cliPaths'] : {}) },
    relay: { ...base.relay, ...(isRecord(stored['relay']) ? stored['relay'] : {}) },
    notifications: {
      ...base.notifications,
      ...notifications,
      attention: {
        ...base.notifications.attention,
        ...(isRecord(notifications['attention']) ? notifications['attention'] : {})
      },
      done: {
        ...base.notifications.done,
        ...(isRecord(notifications['done']) ? notifications['done'] : {})
      }
    }
  } as Settings
}

/** Every field always present: stored values deep-merged over the defaults. */
export function loadSettings(): Settings {
  const raw = readJson(file('ada-settings.json'))
  return isRecord(raw) ? mergeSettings(DEFAULT_SETTINGS, raw) : { ...DEFAULT_SETTINGS }
}

/**
 * The relay pairing key, encrypted. Its own file because it is the one secret
 * the store holds: nothing that reads settings should ever be handed it by
 * accident, and rotating it must not rewrite anything else.
 */
export function loadRelayKeyCiphertext(): string | null {
  const raw = readJson(file('ada-relay.json'))
  const key = isRecord(raw) ? raw['key'] : null
  return typeof key === 'string' && key ? key : null
}

export function saveRelayKeyCiphertext(ciphertext: string): void {
  writeJsonAtomic(file('ada-relay.json'), { key: ciphertext })
}

/**
 * Merge a partial save into what is already on disk and return the result, so
 * a lone field (the keyboard zoom's termFontSize, say) never wipes the rest.
 */
export function saveSettings(partial: Partial<Settings>): Settings {
  const merged = mergeSettings(loadSettings(), partial as Record<string, unknown>)
  writeJsonAtomic(file('ada-settings.json'), merged)
  return merged
}
