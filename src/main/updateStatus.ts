import type { UpdateStatus } from '../shared/types'

/**
 * The pure half of the updater: what the status starts as, whether this build
 * can update itself at all, and how a thrown error reads to a user. Kept out of
 * `updater.ts` so it can be tested without electron-updater, which reaches for
 * the app's own metadata the moment it is imported.
 */

export function initialUpdateStatus(): UpdateStatus {
  return { stage: 'idle', version: null, percent: 0, checkedAt: null }
}

/**
 * Why this build cannot update itself, or null when it can. A dev run has no
 * installer to replace, and on Linux only the AppImage knows how to swap itself
 * out — a `dir` build (or a distro package) has to be updated the way it was
 * installed. Saying so is kinder than letting the check fail with a stack trace.
 */
export function unsupportedReason(env: {
  packaged: boolean
  platform: NodeJS.Platform
  appImage: string | undefined
}): string | null {
  if (!env.packaged) return 'Updates are only available in an installed build.'
  if (env.platform === 'linux' && !env.appImage) {
    return 'Updates are only available in the AppImage build on Linux.'
  }
  return null
}

/** Download progress as a whole percent inside 0–100. */
export function progressPercent(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * An electron-updater failure in words. Its errors arrive as whatever the
 * network or GitHub produced, so the common ones are named and anything else
 * falls back to its own message rather than a generic "update failed".
 */
export function friendlyUpdateError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? '')
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ECONNREFUSED/i.test(text)) {
    return 'Could not reach GitHub — check your connection.'
  }
  // A repo with no published release yet, or assets that were never attached.
  if (/404|No published versions|Cannot find channel/i.test(text)) {
    return 'No published release to update to yet.'
  }
  if (/rate limit/i.test(text)) return 'GitHub rate-limited the check — try again later.'
  return text.trim() || 'The update check failed.'
}
