/**
 * Live, throwaway state: everything the app knows about a pane RIGHT NOW that
 * would be meaningless after a relaunch — transcript info, status, activity
 * stamps, usage and accounts. None of it is persisted, and nothing in here
 * describes the workspace tree; that is `store/app.ts`.
 *
 * Two things are deliberately kept OUT of the zustand state:
 *
 *   • the focus and prompt-probe registries. A pane registering its imperative
 *     handles is not a state change — putting them in the store would re-render
 *     every subscriber each time a terminal mounts.
 *   • the per-chunk activity stamp. PTY output arrives thousands of times a
 *     second; writing that into a store would be a render storm. The authority
 *     is a module-level Map read through `getLastActivity`, and the reactive
 *     `lastActivity` record is a throttled shadow of it (at most one update per
 *     pane per second) for the parts of the UI that want to re-render on it.
 */
import { create } from 'zustand'
import type { ClaudeAccount, PaneStatus, SessionInfo, UsageSnapshot } from '../../../shared/types'

/** How often at most an activity stamp is published into reactive state. */
const ACTIVITY_PUBLISH_MS = 1000

/** Default quiet window after a gesture, so a drag never fires a notification. */
const DEFAULT_HOLD_MS = 1500

export interface RuntimeState {
  /** paneId → what the transcript watcher last reported. */
  sessions: Record<string, SessionInfo>
  status: Record<string, PaneStatus>
  /** paneId → epoch ms, throttled; `getLastActivity` is the precise value. */
  lastActivity: Record<string, number>
  exited: Record<string, boolean>
  /** A turn ended while the pane was not focused; focusing clears it. */
  unseenDone: Record<string, boolean>
  promptOnScreen: Record<string, boolean>
  /** Bumped to force a pane's terminal to remount from scratch. */
  remountKey: Record<string, number>
  usage: UsageSnapshot | null
  accounts: ClaudeAccount[]
  hooksInstalled: boolean
  /** Epoch ms until which notifications are suppressed. */
  notificationsHeldUntil: number

  noteActivity: (paneId: string, at?: number) => void
  setSessions: (updates: SessionInfo[]) => void
  setStatus: (map: Record<string, PaneStatus>) => void
  setExited: (paneId: string, value: boolean) => void
  setUnseenDone: (paneId: string, value: boolean) => void
  setPromptOnScreen: (paneId: string, value: boolean) => void
  resetPane: (paneId: string) => void
  forgetPane: (paneId: string) => void
  setUsage: (usage: UsageSnapshot | null) => void
  setAccounts: (accounts: ClaudeAccount[]) => void
  setHooksInstalled: (installed: boolean) => void
  holdNotifications: (ms?: number) => void
}

/* === non-reactive registries ================================================ */

const focusFns = new Map<string, () => void>()
const promptProbes = new Map<string, () => boolean>()
const selectionFns = new Map<string, () => string>()
/** The precise activity stamp per pane, written on every PTY chunk. */
const activityAt = new Map<string, number>()
/** The last stamp published into `lastActivity`, for the throttle. */
const publishedAt = new Map<string, number>()

/** Let a pane offer "put the cursor in me". Returns the unregister function. */
export function registerFocusFn(paneId: string, fn: () => void): () => void {
  focusFns.set(paneId, fn)
  return () => {
    if (focusFns.get(paneId) === fn) focusFns.delete(paneId)
  }
}

export function getFocusFn(paneId: string): (() => void) | undefined {
  return focusFns.get(paneId)
}

/**
 * Let a pane answer "is a prompt visible on your screen right now?" — the
 * terminal owns the buffer, and the status engine has to ask it synchronously.
 */
export function registerPromptProbe(paneId: string, fn: () => boolean): () => void {
  promptProbes.set(paneId, fn)
  return () => {
    if (promptProbes.get(paneId) === fn) promptProbes.delete(paneId)
  }
}

export function getPromptProbe(paneId: string): (() => boolean) | undefined {
  return promptProbes.get(paneId)
}

/**
 * Let a pane answer "what is selected inside you?". xterm paints its selection
 * itself and keeps it out of the document, so `window.getSelection()` reports
 * nothing for a terminal pane; only the terminal instance knows.
 */
export function registerSelectionFn(paneId: string, fn: () => string): () => void {
  selectionFns.set(paneId, fn)
  return () => {
    if (selectionFns.get(paneId) === fn) selectionFns.delete(paneId)
  }
}

export function getSelectionFn(paneId: string): (() => string) | undefined {
  return selectionFns.get(paneId)
}

const pendingDrafts = new Map<string, string>()

/**
 * Leave text for a Claude pane to type into its input once Claude is ready
 * (see `lib/draftGate`). Set right after `addPane`, before the pane mounts; the
 * pane takes it exactly once, so a remount or a restored pane never re-types it.
 */
export function setPendingDraft(paneId: string, text: string): void {
  pendingDrafts.set(paneId, text)
}

export function takePendingDraft(paneId: string): string | undefined {
  const text = pendingDrafts.get(paneId)
  pendingDrafts.delete(paneId)
  return text
}

/** The exact epoch ms of a pane's last PTY output, or 0 if it never spoke. */
export function getLastActivity(paneId: string): number {
  return activityAt.get(paneId) ?? 0
}

/* === the store ============================================================== */

function sameStatus(a: Record<string, PaneStatus>, b: Record<string, PaneStatus>): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  return keys.every((key) => a[key] === b[key])
}

/** Drop one key from a record, returning a new one (or the same when absent). */
function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

export const useRuntime = create<RuntimeState>()((set, get) => ({
  sessions: {},
  status: {},
  lastActivity: {},
  exited: {},
  unseenDone: {},
  promptOnScreen: {},
  remountKey: {},
  usage: null,
  accounts: [],
  hooksInstalled: false,
  notificationsHeldUntil: 0,

  noteActivity: (paneId, at = Date.now()) => {
    activityAt.set(paneId, at)
    const published = publishedAt.get(paneId) ?? 0
    if (at - published < ACTIVITY_PUBLISH_MS) return
    publishedAt.set(paneId, at)
    set((state) => ({ lastActivity: { ...state.lastActivity, [paneId]: at } }))
  },

  setSessions: (updates) => {
    if (updates.length === 0) return
    set((state) => {
      const sessions = { ...state.sessions }
      for (const update of updates) sessions[update.paneId] = update
      return { sessions }
    })
  },

  setStatus: (map) => {
    if (sameStatus(get().status, map)) return
    set({ status: map })
  },

  setExited: (paneId, value) => {
    if (!!get().exited[paneId] === value) return
    set((state) => ({ exited: { ...state.exited, [paneId]: value } }))
  },

  setUnseenDone: (paneId, value) => {
    if (!!get().unseenDone[paneId] === value) return
    set((state) => ({ unseenDone: { ...state.unseenDone, [paneId]: value } }))
  },

  setPromptOnScreen: (paneId, value) => {
    if (!!get().promptOnScreen[paneId] === value) return
    set((state) => ({ promptOnScreen: { ...state.promptOnScreen, [paneId]: value } }))
  },

  resetPane: (paneId) => {
    activityAt.delete(paneId)
    publishedAt.delete(paneId)
    set((state) => ({
      sessions: omit(state.sessions, paneId),
      exited: omit(state.exited, paneId),
      unseenDone: omit(state.unseenDone, paneId),
      lastActivity: omit(state.lastActivity, paneId),
      remountKey: { ...state.remountKey, [paneId]: (state.remountKey[paneId] ?? 0) + 1 }
    }))
  },

  forgetPane: (paneId) => {
    pendingDrafts.delete(paneId)
    activityAt.delete(paneId)
    publishedAt.delete(paneId)
    set((state) => ({
      sessions: omit(state.sessions, paneId),
      status: omit(state.status, paneId),
      lastActivity: omit(state.lastActivity, paneId),
      exited: omit(state.exited, paneId),
      unseenDone: omit(state.unseenDone, paneId),
      promptOnScreen: omit(state.promptOnScreen, paneId),
      remountKey: omit(state.remountKey, paneId)
    }))
  },

  setUsage: (usage) => set({ usage }),
  setAccounts: (accounts) => set({ accounts }),
  setHooksInstalled: (hooksInstalled) => set({ hooksInstalled }),
  holdNotifications: (ms = DEFAULT_HOLD_MS) =>
    set({ notificationsHeldUntil: Date.now() + ms })
}))
