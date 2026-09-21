import { app, ipcMain, safeStorage } from 'electron'
import os from 'node:os'
import { CH } from '../../shared/ipc'
import type { Feed } from '../../shared/relayProtocol'
import type { HostSnapshot, RelaySettings, RelayStatus } from '../../shared/types'
import { log } from '../log'
import { RelayLink, isKey, mintKey, normalizeRelayUrl } from '../relay'
import { loadRelayKeyCiphertext, loadSettings, saveRelayKeyCiphertext } from '../store'
import type { IpcCtx } from './index'

/**
 * Remote's IPC area: the relay link's lifecycle, the pairing key, and the
 * snapshot the renderer keeps the link fed with.
 *
 * The key lives encrypted on disk (`safeStorage`, like account secrets) and is
 * decrypted once per launch. Where there is no keychain to encrypt with (a WSL
 * or headless Linux box, typically) it is minted per launch and kept in memory
 * only — the phone pairs again after a relaunch, which beats writing it in the
 * clear. It does cross to the renderer — Settings has to show it so the user
 * can type it into the phone — but only on an explicit `relayKey` ask, never
 * as part of settings or status.
 */

let link: RelayLink | null = null
let snapshot: HostSnapshot = { workspaces: [], updatedAt: 0 }
let status: RelayStatus = { state: 'off', hostId: null, viewers: 0, keyPersisted: true }
/** The key when it cannot be persisted; null while it can. */
let sessionKey: string | null = null

function keyPersisted(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function readKey(): string {
  if (!keyPersisted()) {
    sessionKey ??= mintKey()
    return sessionKey
  }
  const ciphertext = loadRelayKeyCiphertext()
  if (ciphertext) {
    try {
      const key = safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
      if (isKey(key)) return key
      log.warn('relay key on disk is malformed, minting a new one')
    } catch (err) {
      log.warn(`relay key unreadable, minting a new one: ${String(err)}`)
    }
  }
  return writeKey(mintKey())
}

function writeKey(key: string): string {
  if (keyPersisted()) {
    saveRelayKeyCiphertext(safeStorage.encryptString(key).toString('base64'))
  } else {
    sessionKey = key
  }
  return key
}

function feed(settings: RelaySettings): () => Feed {
  const name = settings.name.trim() || os.hostname()
  return () => ({ ...snapshot, host: { name, version: app.getVersion() } })
}

function setStatus(ctx: IpcCtx, next: Omit<RelayStatus, 'keyPersisted'>): void {
  status = { ...next, keyPersisted: keyPersisted() }
  ctx.send(CH.relayChanged, status)
}

/**
 * Bring the link in line with the settings: drop it, and open it again if
 * Remote is on. A bad url lands in `status.error` for Settings to show.
 */
export function applyRelaySettings(ctx: IpcCtx, settings: RelaySettings): void {
  link?.close()
  link = null
  if (!settings.enabled) {
    setStatus(ctx, { state: 'off', hostId: null, viewers: 0 })
    return
  }
  const url = normalizeRelayUrl(settings.url)
  if (!url) {
    setStatus(ctx, {
      state: 'error',
      hostId: null,
      viewers: 0,
      error: 'Enter the relay address, e.g. https://ada.example.com'
    })
    return
  }
  const key = readKey()
  log.info(`relay: connecting to ${url}`)
  link = new RelayLink({
    url,
    key,
    name: settings.name.trim() || os.hostname(),
    version: app.getVersion(),
    feed: feed(settings),
    onChange: (event) => {
      if (event.state === 'connected') log.info(`relay: registered as ${event.hostId.slice(0, 12)}…`)
      else if (event.state === 'error') log.warn(`relay: refused — ${event.error}`)
      setStatus(ctx, {
        state: event.state,
        hostId: event.hostId,
        viewers: event.viewers,
        ...(event.error ? { error: event.error } : {})
      })
    }
  })
}

export function registerRelayIpc(ctx: IpcCtx): void {
  ipcMain.handle(CH.relayStatus, () => status)
  ipcMain.handle(CH.relayKey, () => readKey())

  // A new key means the running link is registered under the old id; reopen
  // it so the two can never disagree.
  ipcMain.handle(CH.relayRotateKey, () => {
    const key = writeKey(mintKey())
    applyRelaySettings(ctx, loadSettings().relay)
    return key
  })

  ipcMain.on(CH.relayPublish, (_event, next: HostSnapshot) => {
    if (!next || !Array.isArray(next.workspaces)) return
    snapshot = next
    link?.publish()
  })

  applyRelaySettings(ctx, loadSettings().relay)
  app.on('will-quit', () => {
    link?.close()
    link = null
  })
}
