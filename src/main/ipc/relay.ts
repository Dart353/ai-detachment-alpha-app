import { app, ipcMain, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CH } from '../../shared/ipc'
import { ATTACH_MAX_BYTES, ATTACH_MIME_RE, type Attach, type Feed } from '../../shared/relayProtocol'
import { shellQuote } from '../../shared/shellQuote'
import type { HostSnapshot, RelaySettings, RelayStatus, RelayViewer } from '../../shared/types'
import { probeModels } from '../cliPath'
import { log } from '../log'
import { paneTap } from '../paneTap'
import { isWsl, toHost } from '../platform'
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
/** paneId → stop streaming it; one entry per pane a phone is watching. */
const watched = new Map<string, () => void>()
let snapshot: HostSnapshot = { workspaces: [], recents: [], updatedAt: 0 }
let status: RelayStatus = { state: 'off', hostId: null, viewers: 0, phones: [], keyPersisted: true }
/** The key when it cannot be persisted; null while it can. */
let sessionKey: string | null = null
/** What `--model` takes here, probed once the link is first opened. */
let models: string[] = []

/** Attachments older than this are swept at launch. */
const ATTACH_KEEP_MS = 7 * 24 * 3600_000
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

/**
 * Where a phone's pictures land. Panes in WSL mode run inside the distro, so
 * the file goes into the distro's /tmp (written through the share path) and
 * the pane is handed the Linux path; elsewhere it is the OS temp folder.
 */
function attachDir(): { stored: string; host: string } {
  const stored = isWsl() ? '/tmp/ada-attachments' : path.join(app.getPath('temp'), 'ada-attachments')
  return { stored, host: toHost(stored) }
}

/**
 * Save a phone's picture and type its path into the pane, followed by a space,
 * exactly as dropping the file on the pane would — the agent reads it as a
 * local file. The name is reduced to a safe stem; the extension comes from the
 * mime type, never from the phone.
 */
function receiveAttachment(attach: Attach): void {
  const ext = ATTACH_MIME_RE.test(attach.mime) ? MIME_EXT[attach.mime] : undefined
  const bytes = attach.data instanceof ArrayBuffer ? Buffer.from(attach.data) : Buffer.from(attach.data as Uint8Array)
  if (!ext || bytes.length === 0 || bytes.length > ATTACH_MAX_BYTES) {
    log.warn(`relay: attachment for ${attach.paneId} refused (${attach.mime}, ${bytes.length} bytes)`)
    return
  }
  if (!paneTap.has(attach.paneId)) {
    log.warn(`relay: attachment for unknown pane ${attach.paneId} dropped`)
    return
  }
  const stem =
    path
      .basename(attach.name)
      .replace(/\.[^.]*$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 48) || 'image'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const file = `${stamp}-${stem}${ext}`
  const dir = attachDir()
  try {
    fs.mkdirSync(dir.host, { recursive: true })
    fs.writeFileSync(path.join(dir.host, file), bytes)
  } catch (err) {
    log.warn(`relay: could not save attachment: ${String(err)}`)
    return
  }
  const stored = isWsl() ? `${dir.stored}/${file}` : path.join(dir.stored, file)
  paneTap.write(attach.paneId, shellQuote(stored) + ' ')
  log.info(`relay: attached ${file} to ${attach.paneId}`)
}

/** Drop pictures nobody will look at again. */
function sweepAttachments(): void {
  const dir = attachDir().host
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - ATTACH_KEEP_MS
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
    } catch {
      /* gone already */
    }
  }
}

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
  return () => ({ ...snapshot, host: { name, version: app.getVersion(), models } })
}

function setStatus(ctx: IpcCtx, next: Omit<RelayStatus, 'keyPersisted' | 'phones'> & { phones?: RelayViewer[] }): void {
  // The phone list only changes when the relay says so; a link state change
  // keeps it, and a link going away empties it.
  const phones = next.phones ?? (next.state === 'connected' ? status.phones : [])
  status = { ...next, phones, keyPersisted: keyPersisted() }
  ctx.send(CH.relayChanged, status)
}

/**
 * Bring the link in line with the settings: drop it, and open it again if
 * Remote is on. A bad url lands in `status.error` for Settings to show.
 */
export function applyRelaySettings(ctx: IpcCtx, settings: RelaySettings): void {
  link?.close()
  link = null
  for (const off of watched.values()) off()
  watched.clear()
  if (!settings.enabled) {
    setStatus(ctx, { state: 'off', hostId: null, viewers: 0, phones: [] })
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
  // The phone's New agent sheet lists this machine's model aliases; they are
  // read once and go out with the next feed after the probe answers.
  if (models.length === 0) {
    void probeModels().then((list) => {
      models = list
      link?.publish()
    })
  }
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
    },
    // A phone opened a pane: replay what is on screen, then stream what
    // follows. Every watch gets a screen (a second phone needs its own), but
    // the stream is wired once per pane.
    onWatch: (paneId) => {
      const screen = paneTap.screen(paneId)
      if (!screen) return // not a live pane on this machine
      link?.sendScreen({ paneId, ...screen })
      if (!watched.has(paneId)) {
        watched.set(paneId, paneTap.listen(paneId, (id, data) => link?.sendOutput(id, data)))
      }
    },
    onUnwatch: (paneId) => {
      watched.get(paneId)?.()
      watched.delete(paneId)
    },
    onInput: ({ paneId, data }) => {
      if (!paneTap.write(paneId, data)) log.warn(`relay: input for unknown pane ${paneId} dropped`)
    },
    onAttach: receiveAttachment,
    // The renderer owns the workspace tree: main only carries the ask across.
    onAddPane: ({ workspaceId, kind }) => ctx.send(CH.relayCommand, { type: 'addPane', workspaceId, kind }),
    onOpenWorkspace: ({ rootDir }) => ctx.send(CH.relayCommand, { type: 'openWorkspace', rootDir }),
    onViewers: (list) => setStatus(ctx, { ...status, viewers: list.length, phones: list })
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

  ipcMain.on(CH.relayDisconnectViewer, (_event, viewerId: string) => {
    if (typeof viewerId === 'string' && viewerId) link?.disconnectViewer(viewerId)
  })

  ipcMain.on(CH.relayPublish, (_event, next: HostSnapshot) => {
    if (!next || !Array.isArray(next.workspaces)) return
    snapshot = next
    link?.publish()
  })

  applyRelaySettings(ctx, loadSettings().relay)
  sweepAttachments()
  app.on('will-quit', () => {
    link?.close()
    link = null
  })
}
