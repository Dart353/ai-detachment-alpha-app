import { app } from 'electron'
import type { UpdateStatus } from '../shared/types'
import { log } from './log'
import {
  friendlyUpdateError,
  initialUpdateStatus,
  progressPercent,
  unsupportedReason
} from './updateStatus'

/**
 * Self-update against this repo's GitHub releases.
 *
 * electron-builder writes the provider into `app-update.yml` at package time
 * (see `build.publish` in package.json), so nothing here names the repo: the
 * installed build already knows where its releases live, and the repo is public,
 * so no token is involved. The release workflow attaches `latest.yml` /
 * `latest-linux.yml` next to the installers, which is the file this reads.
 *
 * The download runs in the background and the swap happens on quit, so an update
 * never interrupts a running agent. Nothing is installed without the user either
 * pressing Restart or quitting the app themselves.
 *
 * electron-updater is required lazily: importing it reads the app's own
 * metadata, which a plain `vitest` run has none of. The pure decisions live in
 * `updateStatus.ts` and are tested there.
 */

type Listener = (status: UpdateStatus) => void

let status: UpdateStatus = initialUpdateStatus()
let listener: Listener | null = null
let wired = false
/** A check already in flight; a second ask rides along instead of stacking. */
let inFlight: Promise<UpdateStatus> | null = null

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next }
  listener?.(status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/** The renderer's subscription; replacing it drops the previous one. */
export function onUpdateStatus(next: Listener | null): void {
  listener = next
}

function reason(): string | null {
  return unsupportedReason({
    packaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env['APPIMAGE']
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function updater(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
  if (!wired) {
    wired = true
    // Fetch as soon as one is found, but never swap the app out from under a
    // running session: the installer runs on quit.
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null

    autoUpdater.on('checking-for-update', () => set({ stage: 'checking', error: undefined }))
    autoUpdater.on('update-available', (info: { version: string }) => {
      log.info(`update available: ${info.version}`)
      set({ stage: 'available', version: info.version, percent: 0, checkedAt: Date.now() })
    })
    autoUpdater.on('update-not-available', () => {
      set({ stage: 'current', version: null, percent: 0, checkedAt: Date.now() })
    })
    autoUpdater.on('download-progress', (p: { percent?: number }) => {
      set({ stage: 'downloading', percent: progressPercent(p?.percent) })
    })
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      log.info(`update ready: ${info.version}`)
      set({ stage: 'ready', version: info.version, percent: 100, checkedAt: Date.now() })
    })
    autoUpdater.on('error', (err: Error) => {
      log.error('update failed', err)
      set({ stage: 'error', error: friendlyUpdateError(err), checkedAt: Date.now() })
    })
  }
  return autoUpdater
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Ask GitHub what the newest release is. Resolves with the status the check
 * settled on, so the caller that pressed the button gets an answer even if the
 * push arrives first.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const blocked = reason()
  if (blocked) {
    set({ stage: 'unsupported', error: blocked, checkedAt: Date.now() })
    return status
  }
  // A download in progress IS the answer to "is there an update?" — re-checking
  // mid-download restarts it.
  if (status.stage === 'downloading' || status.stage === 'ready') return status
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      await updater().checkForUpdates()
    } catch (err) {
      set({ stage: 'error', error: friendlyUpdateError(err), checkedAt: Date.now() })
    } finally {
      inFlight = null
    }
    return status
  })()
  return inFlight
}

/** Quit and install what was downloaded. A no-op unless an update is ready. */
export function installUpdate(): void {
  if (status.stage !== 'ready') return
  // isSilent false so Windows shows the installer's progress; isForceRunAfter
  // true so the app comes back up where the user left it.
  updater().quitAndInstall(false, true)
}

/**
 * The check that runs on its own, a beat after launch so it never competes with
 * the window opening or the first panes spawning. Silent about everything except
 * what it finds: the About screen reads the status, and a build that cannot
 * update simply says so there.
 */
export function scheduleStartupCheck(delayMs = 10_000): NodeJS.Timeout | null {
  if (reason()) {
    set({ stage: 'unsupported', error: reason() ?? undefined })
    return null
  }
  const timer = setTimeout(() => void checkForUpdate(), delayMs)
  timer.unref?.()
  return timer
}
