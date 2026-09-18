import { app, ipcMain, Notification } from 'electron'
import { CH } from '../../shared/ipc'
import type { UsageSnapshot, UsageWindow } from '../../shared/types'
import {
  SESSION_WINDOW_MS,
  WEEKLY_WINDOW_MS,
  fetchPlanUsage,
  projectCapAt,
  type PlanWindow
} from '../planUsage'
import { sessionWindowTokens } from '../usage'
import { shouldWarn } from '../usageWarn'
import { loadSettings } from '../store'
import { log } from '../log'
import type { IpcCtx } from './index'

/**
 * The usage meters: live limit windows from Anthropic's /usage endpoint, joined
 * with the local per-session token split, polled on a timer and pushed to the
 * renderer so every pane's share of the current window stays current without the
 * UI asking.
 *
 * A failed fetch is not an error state to recover from — it is simply
 * `available: false` with a readable reason, which is what the meters render
 * when there is nothing to show.
 */

const POLL_MS = 30_000
/** First reading shortly after startup, so the window isn't blank for 30s. */
const FIRST_POLL_MS = 2_000

let snapshot: UsageSnapshot | null = null
let firstTimer: NodeJS.Timeout | null = null
let timer: NodeJS.Timeout | null = null
/** one warning per (window, reset) pair — see shouldWarn */
const warnLatch = new Set<string>()

function emptySnapshot(error?: string): UsageSnapshot {
  return {
    available: false,
    plan: null,
    updatedAt: Date.now(),
    windows: [],
    bySessionId: {},
    windowTokens: 0,
    error
  }
}

/** Percent as the meters want it: inside 0–100 and rounded to one decimal. */
function displayPct(pct: number): number {
  return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10
}

/**
 * A weekly window's projected exhaustion. Only the weeklies get one: a 5-hour
 * window is short enough that a linear projection over it says nothing a glance
 * at the bar doesn't already say.
 */
function toUsageWindow(window: PlanWindow, now: number): UsageWindow {
  const out: UsageWindow = {
    key: window.key,
    label: window.label,
    pct: displayPct(window.pct),
    resetsAt: window.resetsAt
  }
  if (window.key.startsWith('weekly') && window.resetsAt !== null) {
    out.projectedCapAt = projectCapAt(
      window.pct,
      window.resetsAt - WEEKLY_WINDOW_MS,
      window.resetsAt,
      now
    )
  }
  return out
}

async function buildSnapshot(force: boolean): Promise<UsageSnapshot> {
  const result = await fetchPlanUsage(force)
  if (!result.ok) return emptySnapshot(result.error)

  const now = Date.now()
  const windows = result.windows.map((window) => toUsageWindow(window, now))
  // The local split covers the session window the endpoint reports; with no
  // reset time to anchor to, the last five hours are the best stand-in.
  const sessionResetsAt = windows.find((window) => window.key === 'session')?.resetsAt ?? null
  const windowEndMs = sessionResetsAt ?? now
  const { bySessionId, windowTokens } = sessionWindowTokens(
    windowEndMs - SESSION_WINDOW_MS,
    windowEndMs
  )

  return {
    available: windows.length > 0,
    plan: result.plan,
    updatedAt: now,
    windows,
    bySessionId,
    windowTokens
  }
}

/** "resets 4:42 PM" for today's reset, "resets Mon 00:00" for a later one. */
function resetHint(resetsAt: number | null): string {
  if (resetsAt === null) return 'Usage is close to the limit.'
  const reset = new Date(resetsAt)
  const sameDay = reset.toDateString() === new Date().toDateString()
  const when = sameDay
    ? reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : reset.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return `resets ${when}`
}

function warnIfNeeded(windows: UsageWindow[]): void {
  const settings = loadSettings()
  if (!settings.warnEnabled) return
  if (!Notification.isSupported()) return
  for (const window of windows) {
    if (!shouldWarn(warnLatch, window, settings.warnAtPct)) continue
    new Notification({
      title: `${window.label} at ${window.pct}%`,
      body: resetHint(window.resetsAt)
    }).show()
  }
}

export function registerUsageIpc(ctx: IpcCtx): void {
  const poll = async (force = false): Promise<UsageSnapshot> => {
    try {
      snapshot = await buildSnapshot(force)
    } catch (err) {
      log.error('usage poll failed', err as Error)
      snapshot = emptySnapshot(err instanceof Error ? err.message : String(err))
    }
    if (snapshot.available) warnIfNeeded(snapshot.windows)
    ctx.send(CH.usageUpdate, snapshot)
    return snapshot
  }

  firstTimer = setTimeout(() => {
    firstTimer = null
    void poll()
    timer = setInterval(() => void poll(), POLL_MS)
  }, FIRST_POLL_MS)

  ipcMain.handle(CH.usageGet, async (_event, force?: boolean): Promise<UsageSnapshot> => {
    if (snapshot && !force) return snapshot
    return poll(force === true)
  })

  app.on('before-quit', () => {
    if (firstTimer) clearTimeout(firstTimer)
    if (timer) clearInterval(timer)
    firstTimer = null
    timer = null
  })
}
