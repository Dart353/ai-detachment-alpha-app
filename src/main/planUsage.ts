import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { claudeDir } from './platform'

/**
 * Live plan/rate-limit usage — the data behind Claude Code's `/usage`.
 *
 * There is no local file with the live utilization; `/usage` fetches it from an
 * (undocumented, internal) Anthropic endpoint using the OAuth access token that
 * Claude Code stores in ~/.claude/.credentials.json. We call the same endpoint
 * with the same headers. Being undocumented, it may change or break — every path
 * here degrades to a readable error rather than throwing, and results are
 * TTL-cached so we never hammer it (it rate-limits aggressively without the
 * claude-code User-Agent).
 */

export interface PlanWindow {
  /**
   * Stable identifier for the window. The endpoint's `limits[]` kinds map
   * straight through ('session', 'weekly_all', 'weekly_scoped:<model>'), and the
   * legacy top-level keys are aliased onto the same ids ('five_hour' → 'session')
   * so consumers can find "the 5-hour window" without caring which response
   * shape produced it.
   */
  key: string
  /** Human label, e.g. "Weekly · Opus". Unknown kinds get a humanized fallback. */
  label: string
  /** percent of the window consumed, as reported (callers clamp for display) */
  pct: number
  /** epoch ms the window resets, or null if the endpoint didn't provide one */
  resetsAt: number | null
}

export type PlanUsageResult =
  | { ok: true; plan: string | null; windows: PlanWindow[] }
  | { ok: false; error: string; expired?: boolean }

/** The session ("5-hour") window length, and the weekly one. */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// The meter polls every 30s, so a 25s success TTL means each poll is a real
// reading rather than the same cached one served twice; errors back off longer.
const SUCCESS_TTL_MS = 25_000
const ERROR_TTL_MS = 15_000
let cache: { at: number; ttl: number; result: PlanUsageResult } | null = null

interface Creds {
  token: string
  subscriptionType: string | null
  expiresAt: number
}

/** Parse the credentials JSON blob (same shape from the file or the Keychain). */
function parseCreds(raw: unknown): Creds | null {
  const oauth = (raw as { claudeAiOauth?: Record<string, unknown> })?.claudeAiOauth
  if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) {
    return {
      token: oauth.accessToken,
      subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
    }
  }
  return null
}

/**
 * On macOS, Claude Code stores its OAuth credentials in the login Keychain rather
 * than ~/.claude/.credentials.json. Reading them spawns `security`, so we cache the
 * result briefly to avoid launching a process on every poll. Both the account-name
 * and no-account-name forms are tried (the entry is created either way).
 */
const KEYCHAIN_TTL_MS = 60_000
let keychainCache: { at: number; creds: Creds | null } | null = null

function readKeychainCreds(): Creds | null {
  if (process.platform !== 'darwin') return null
  if (keychainCache && Date.now() - keychainCache.at < KEYCHAIN_TTL_MS) return keychainCache.creds

  const attempts: string[][] = [
    ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    ['find-generic-password', '-a', os.userInfo().username, '-s', 'Claude Code-credentials', '-w']
  ]
  let creds: Creds | null = null
  for (const args of attempts) {
    try {
      const out = execFileSync('security', args, { encoding: 'utf8', timeout: 5000 }).trim()
      if (out) {
        creds = parseCreds(JSON.parse(out))
        if (creds) break
      }
    } catch {
      /* locked keychain, no entry, or bad JSON → try the next form */
    }
  }
  keychainCache = { at: Date.now(), creds }
  return creds
}

function readCreds(): Creds | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(claudeDir(), '.credentials.json'), 'utf8'))
    const creds = parseCreds(raw)
    if (creds) return creds
  } catch {
    /* no/unreadable credentials → fall through to the macOS Keychain */
  }
  return readKeychainCreds()
}

/** claude-code/<version> for the User-Agent (the endpoint throttles hard without it). */
function claudeVersion(): string {
  try {
    const result = JSON.parse(
      fs.readFileSync(path.join(claudeDir(), '.last-update-result.json'), 'utf8')
    )
    if (typeof result?.version_to === 'string') return result.version_to
    if (typeof result?.version_from === 'string') return result.version_from
  } catch {
    /* fall through */
  }
  return '2.1.203'
}

/** The plan badge shown next to the meters: "max20x" → "Max 20x". */
const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  max5x: 'Max 5x',
  max20x: 'Max 20x',
  team: 'Team',
  enterprise: 'Enterprise'
}

export function planLabel(subscriptionType: string | null): string | null {
  if (!subscriptionType) return null
  return PLAN_LABELS[subscriptionType] ?? humanize(subscriptionType)
}

/** "weekly_scoped" → "Weekly scoped" — the fallback label for a kind we've never seen. */
function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : key
}

/** ISO-8601 → epoch ms, null when absent or unparseable. */
function toMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Labels for the window kinds we know; anything else falls back to humanize(). */
const WINDOW_LABELS: Record<string, string> = {
  session: 'Current session',
  weekly_all: 'Weekly · all models',
  weekly_opus: 'Weekly · Opus',
  weekly_sonnet: 'Weekly · Sonnet'
}

/** Legacy top-level keys aliased onto the `limits[]` kinds, so 'session' always finds the 5h window. */
const LEGACY_KEY_ALIASES: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'weekly_all',
  seven_day_opus: 'weekly_opus',
  seven_day_sonnet: 'weekly_sonnet'
}

/** Top-level keys that are structure, not usage windows — never rendered as bars. */
const STRUCTURAL_KEYS = new Set(['limits', 'spend', 'extra_usage', 'member_dashboard_available'])

/**
 * The modern response shape: a self-describing `limits[]` array — one entry per
 * window the plan actually has, including model-scoped weeklies (a per-model
 * window is `weekly_scoped` + `scope.model.display_name`, NOT a top-level key).
 * Returns null when the array is absent so the legacy path can take over.
 */
function windowsFromLimits(raw: unknown): PlanWindow[] | null {
  if (!Array.isArray(raw)) return null
  const windows: PlanWindow[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const limit = entry as Record<string, unknown>
    if (typeof limit.percent !== 'number') continue
    const kind = typeof limit.kind === 'string' ? limit.kind : 'unknown'
    const scope = limit.scope as { model?: { display_name?: unknown } } | null | undefined
    const scopeName =
      typeof scope?.model?.display_name === 'string' ? scope.model.display_name : null
    windows.push({
      key: scopeName ? `${kind}:${scopeName}` : kind,
      label:
        kind === 'weekly_scoped' && scopeName
          ? `Weekly · ${scopeName}`
          : (WINDOW_LABELS[kind] ?? humanize(kind)),
      pct: limit.percent,
      resetsAt: toMs(limit.resets_at)
    })
  }
  return windows
}

/**
 * Fallback for older responses without `limits[]`: any top-level object carrying
 * a numeric `utilization` is a window. Known keys get their proper label; a key
 * we've never seen still renders (humanized) instead of being dropped silently.
 */
function windowsFromLegacyKeys(data: Record<string, unknown>): PlanWindow[] {
  const windows: PlanWindow[] = []
  for (const [key, value] of Object.entries(data)) {
    if (STRUCTURAL_KEYS.has(key)) continue
    if (!value || typeof value !== 'object') continue
    const window = value as Record<string, unknown>
    if (typeof window.utilization !== 'number') continue
    const alias = LEGACY_KEY_ALIASES[key] ?? key
    windows.push({
      key: alias,
      label: WINDOW_LABELS[alias] ?? humanize(key),
      pct: window.utilization,
      resetsAt: toMs(window.resets_at)
    })
  }
  return windows
}

/**
 * Every window the response carries, in the order the endpoint listed them.
 * Prefer the self-describing `limits[]` array (it is the ONLY place model-scoped
 * weeklies exist); fall back to sweeping the legacy top-level keys when an older
 * response shape omits it.
 */
export function parseUsageResponse(json: unknown): PlanWindow[] {
  if (!json || typeof json !== 'object') return []
  const data = json as Record<string, unknown>
  return windowsFromLimits(data.limits) ?? windowsFromLegacyKeys(data)
}

/**
 * When the current burn rate would hit 100%, by straight linear projection: the
 * window has spent `pct` of itself in `elapsed`, so the whole of it goes in
 * `elapsed * 100 / pct`. Returns null unless the projection says something the
 * reset time doesn't already say — a cap after the reset is simply "you're
 * fine" — and stays quiet over the first tenth of the window, where a single
 * burst makes the rate meaningless.
 */
export function projectCapAt(
  pct: number,
  windowStartMs: number,
  resetsAtMs: number,
  now: number
): number | null {
  if (pct <= 0 || pct >= 100) return null
  const windowMs = resetsAtMs - windowStartMs
  const elapsed = now - windowStartMs
  if (windowMs <= 0 || elapsed <= 0) return null
  if (elapsed < windowMs * 0.1) return null
  const capAt = windowStartMs + elapsed * (100 / pct)
  return capAt < resetsAtMs ? capAt : null
}

/** Fetch (or return cached) plan usage. `force` bypasses the TTL cache. */
export async function fetchPlanUsage(force = false): Promise<PlanUsageResult> {
  if (!force && cache && Date.now() - cache.at < cache.ttl) return cache.result

  const store = (result: PlanUsageResult, ttl: number): PlanUsageResult => {
    cache = { at: Date.now(), ttl, result }
    return result
  }

  const creds = readCreds()
  if (!creds) {
    return store(
      { ok: false, error: 'Not signed in to Claude Code (no credentials found).', expired: false },
      ERROR_TTL_MS
    )
  }
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    return store(
      {
        ok: false,
        error: 'Your Claude Code session has expired — run any Claude command to refresh it.',
        expired: true
      },
      ERROR_TTL_MS
    )
  }

  try {
    // Electron is required lazily so this module can be imported by a plain
    // vitest run (the parsers and the projection are pure and need no runtime).
    const { net } = require('electron') as typeof import('electron')
    const response = await net.fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${claudeVersion()}`,
        'Content-Type': 'application/json'
      }
    })
    if (!response.ok) {
      const expired = response.status === 401 || response.status === 403
      return store(
        {
          ok: false,
          expired,
          error: expired
            ? 'Session token rejected — run a Claude command to refresh it.'
            : `The usage endpoint returned ${response.status}. It’s undocumented and may be unavailable.`
        },
        ERROR_TTL_MS
      )
    }
    const windows = parseUsageResponse(await response.json())
    return store({ ok: true, plan: planLabel(creds.subscriptionType), windows }, SUCCESS_TTL_MS)
  } catch (err) {
    return store(
      { ok: false, expired: false, error: err instanceof Error ? err.message : String(err) },
      ERROR_TTL_MS
    )
  }
}
