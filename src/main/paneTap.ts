import { SCREEN_MAX_CHARS } from '../shared/relayProtocol'

/**
 * A tap on every pane's PTY: the recent output, the last known size, and who
 * wants to hear the live stream. Main already sees every byte a PTY produces
 * on its way to the renderer; this keeps the tail of it so a phone that opens
 * a pane an hour into a session sees what is on screen, and forwards what
 * comes next to whoever is watching.
 *
 * Replay is raw bytes into a terminal of the same size. It is not a screen
 * snapshot, but a TUI repaints its whole frame often enough that the tail of
 * the stream always contains a complete one, and a plain shell's scrollback
 * is exactly the bytes anyway.
 *
 * Pure of Electron and of node-pty, so it is unit tested as data in, data out.
 */

export type OutputListener = (paneId: string, data: string) => void

interface Tapped {
  /** The retained tail of the output, trimmed to `maxChars`. */
  buffer: string
  cols: number
  rows: number
}

export type InputWriter = (paneId: string, data: string) => void

export class PaneTap {
  private readonly panes = new Map<string, Tapped>()
  private readonly listeners = new Map<string, Set<OutputListener>>()
  private writer: InputWriter | null = null

  constructor(private readonly maxChars = SCREEN_MAX_CHARS) {}

  /** Where remote keystrokes go: the PTY manager registers itself here. */
  setWriter(writer: InputWriter | null): void {
    this.writer = writer
  }

  /**
   * Type into a pane on a phone's behalf. Only a pane main has seen output
   * from — a live, tapped PTY — is writable; an unknown id is dropped, so a
   * stale or invented pane id from the wire reaches no process.
   */
  write(paneId: string, data: string): boolean {
    if (!this.writer || !this.panes.has(paneId)) return false
    this.writer(paneId, data)
    return true
  }

  /** A PTY produced `data`. */
  push(paneId: string, data: string): void {
    const pane = this.panes.get(paneId) ?? this.create(paneId)
    pane.buffer += data
    // Trim in slabs rather than on every chunk: a busy TUI writes thousands of
    // small chunks a second, and re-slicing a 256 KB string for each would be
    // most of the work main does for that pane.
    if (pane.buffer.length > this.maxChars * 1.5) pane.buffer = pane.buffer.slice(-this.maxChars)
    const listeners = this.listeners.get(paneId)
    if (listeners) for (const listener of listeners) listener(paneId, data)
  }

  /** The PTY was resized; a watcher's terminal has to match. */
  resize(paneId: string, cols: number, rows: number): void {
    const pane = this.panes.get(paneId) ?? this.create(paneId)
    pane.cols = cols
    pane.rows = rows
  }

  /** The PTY is gone: nothing more to replay, no one left to tell. */
  drop(paneId: string): void {
    this.panes.delete(paneId)
    this.listeners.delete(paneId)
  }

  /** What a watcher replays, or null for a pane main has never seen. */
  screen(paneId: string): { data: string; cols: number; rows: number } | null {
    const pane = this.panes.get(paneId)
    if (!pane) return null
    return { data: pane.buffer.slice(-this.maxChars), cols: pane.cols, rows: pane.rows }
  }

  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  /** Hear the live stream of one pane; returns the unsubscribe. */
  listen(paneId: string, listener: OutputListener): () => void {
    let set = this.listeners.get(paneId)
    if (!set) {
      set = new Set()
      this.listeners.set(paneId, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(paneId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(paneId)
    }
  }

  private create(paneId: string): Tapped {
    const pane: Tapped = { buffer: '', cols: 80, rows: 24 }
    this.panes.set(paneId, pane)
    return pane
  }
}

/** The one tap every PTY in main feeds and the relay link reads. */
export const paneTap = new PaneTap()
