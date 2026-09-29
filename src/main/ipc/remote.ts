import { app, dialog, ipcMain, safeStorage, type OpenDialogOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { CH } from '../../shared/ipc'
import { ATTACH_MAX_BYTES, EFFORTS, type AddPane, type Effort, type HostState } from '../../shared/relayProtocol'
import type { RelaySettings, RemoteAddPane, RemoteMachine, RemoteStatus } from '../../shared/types'
import { log } from '../log'
import { hostIdFor, isKey, normalizeRelayUrl } from '../relay'
import {
  loadRelayKeyCiphertext,
  loadRemoteMachines,
  loadSettings,
  saveRemoteMachines,
  type StoredRemoteMachine
} from '../store'
import { ViewerLink } from '../viewerLink'
import type { IpcCtx } from './index'

/**
 * Remote mode's IPC area: this desktop as a viewer of other machines, through
 * the same relay a phone uses.
 *
 * Pairing keys are secrets exactly like this machine's own relay key: they go
 * to disk encrypted (`safeStorage`) and are decrypted only here, to open the
 * link. None ever crosses to the renderer — it sees host ids, labels and
 * feeds. Without a keychain the keys live in memory for this launch only, and
 * the status says so, rather than writing them in the clear.
 *
 * One link holds every key. Any change to the set, or to the relay address,
 * closes it and opens a fresh one: the relay only takes keys at connect.
 */

interface PairedMachine {
  hostId: string
  label: string
  key: string
}

type AttachResult = { ok: true } | { ok: false; error: string }

let link: ViewerLink | null = null
/** The normalised relay address the link was last built for. */
let relayUrl: string | null = null
/** hostId → the renderer's picture of a paired machine, in pairing order. */
let machines = new Map<string, RemoteMachine>()
/** The pairings when they cannot be persisted; unused while they can. */
const sessionMachines = new Map<string, PairedMachine>()
let status: RemoteStatus = { state: 'off', machines: [], keysPersisted: true }
/** `hostId paneId` → the attach waiting for the relay's answer. */
const attachWaits = new Map<string, (result: AttachResult) => void>()
/** How long an attach waits for the relay's `attached` before giving up. */
const ATTACH_WAIT_MS = 10_000
const LABEL_MAX_CHARS = 64
/** Mirrors the relay's limit on keys per viewer; ViewerLink drops any past it. */
const MAX_REMOTE_MACHINES = 32
const ATTACH_MAX_MB = Math.round(ATTACH_MAX_BYTES / 1048576)
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const ATTACH_DIALOG: OpenDialogOptions = {
  properties: ['openFile'],
  filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
}

function keysPersisted(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function decryptKey(ciphertext: string): string | null {
  try {
    const key = safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    return isKey(key) ? key : null
  } catch {
    return null
  }
}

/**
 * This machine's own relay host id, or null when it cannot be known here.
 * `readKey` in ipc/relay.ts is deliberately not exported (it mints a key as a
 * side effect), so this repeats the small decrypt. Without a keychain the
 * relay key is in that module's memory only, and the check is skipped.
 */
function ownHostId(): string | null {
  if (!keysPersisted()) return null
  const ciphertext = loadRelayKeyCiphertext()
  const key = ciphertext ? decryptKey(ciphertext) : null
  return key ? hostIdFor(key) : null
}

/** Every pairing with its key readable; ones that fail to decrypt are skipped. */
function pairedMachines(): PairedMachine[] {
  if (!keysPersisted()) return [...sessionMachines.values()]
  const paired: PairedMachine[] = []
  for (const stored of loadRemoteMachines()) {
    const key = decryptKey(stored.ciphertext)
    if (key && hostIdFor(key) === stored.hostId) paired.push({ hostId: stored.hostId, label: stored.label, key })
    else log.warn(`remote: key for ${stored.hostId.slice(0, 12)}… unreadable, skipped`)
  }
  return paired
}

/** Whether anything is stored under this id, readable or not — what forgetting can remove. */
function isStored(hostId: string): boolean {
  if (!keysPersisted()) return sessionMachines.has(hostId)
  return loadRemoteMachines().some((stored) => stored.hostId === hostId)
}

function storeMachine(paired: PairedMachine): void {
  if (!keysPersisted()) {
    sessionMachines.set(paired.hostId, paired)
    return
  }
  const stored: StoredRemoteMachine = {
    hostId: paired.hostId,
    label: paired.label,
    ciphertext: safeStorage.encryptString(paired.key).toString('base64')
  }
  // An unreadable entry under the same id is replaced, never duplicated.
  const others = loadRemoteMachines().filter((existing) => existing.hostId !== paired.hostId)
  saveRemoteMachines([...others, stored])
}

function forgetMachine(hostId: string): void {
  if (keysPersisted()) saveRemoteMachines(loadRemoteMachines().filter((stored) => stored.hostId !== hostId))
  else sessionMachines.delete(hostId)
  machines.delete(hostId)
}

/**
 * Line the machine map up with the pairings, keeping what is known about the
 * ones still paired so a rebuilt link does not blank the renderer's view.
 */
function syncMachines(paired: PairedMachine[]): void {
  const next = new Map<string, RemoteMachine>()
  for (const { hostId, label } of paired) {
    const known = machines.get(hostId)
    next.set(hostId, known ? { ...known, label } : { hostId, label, online: false, name: null, feed: null, lastSeen: 0 })
  }
  machines = next
}

function setStatus(ctx: IpcCtx, next: Pick<RemoteStatus, 'state' | 'error'>): void {
  status = {
    state: next.state,
    ...(next.error ? { error: next.error } : {}),
    machines: [...machines.values()],
    keysPersisted: keysPersisted()
  }
  ctx.send(CH.remoteChanged, status)
}

/** A machine's presence changed; going offline keeps its last name and feed. */
function applyHostState(ctx: IpcCtx, state: HostState): void {
  const known = machines.get(state.hostId)
  if (!known) return
  machines.set(state.hostId, {
    ...known,
    online: state.online,
    name: state.name ?? known.name,
    feed: state.feed ?? known.feed,
    lastSeen: !state.online && known.online ? Date.now() : known.lastSeen
  })
  setStatus(ctx, status)
}

function applyHostFeed(ctx: IpcCtx, update: { hostId: string; feed: RemoteMachine['feed'] }): void {
  const known = machines.get(update.hostId)
  if (!known) return
  machines.set(update.hostId, { ...known, online: true, feed: update.feed })
  setStatus(ctx, status)
}

/** That machine disconnected this viewer from its Settings: its key is dead. */
function handleKicked(ctx: IpcCtx, hostId: string): void {
  const label = machines.get(hostId)?.label ?? ''
  log.info(`remote: dropped by ${hostId.slice(0, 12)}…, forgetting it`)
  forgetMachine(hostId)
  ctx.send(CH.remoteNotice, { type: 'kicked', hostId, label })
  // The relay closes the socket right after a kick; reconnect for the rest.
  rebuildLink(ctx)
}

function attachWaitKey(hostId: string, paneId: string): string {
  return `${hostId} ${paneId}`
}

/** The relay's answer for this pane, or a timeout; a newer attach replaces the wait. */
function waitForAttached(hostId: string, paneId: string): Promise<AttachResult> {
  const waitKey = attachWaitKey(hostId, paneId)
  return new Promise((resolve) => {
    const settle = (result: AttachResult): void => {
      clearTimeout(timer)
      if (attachWaits.get(waitKey) === settle) attachWaits.delete(waitKey)
      resolve(result)
    }
    const timer = setTimeout(() => settle({ ok: false, error: 'No answer from the relay.' }), ATTACH_WAIT_MS)
    attachWaits.set(waitKey, settle)
  })
}

/** Answer every attach still waiting; the link it went out on is going away. */
function settleAttachWaits(result: AttachResult): void {
  for (const settle of [...attachWaits.values()]) settle(result)
}

/** Close the link and, if there is anything to watch and somewhere to watch it, open a new one. */
function rebuildLink(ctx: IpcCtx): void {
  settleAttachWaits({ ok: false, error: 'Connection reset.' })
  link?.close()
  link = null
  const paired = pairedMachines()
  syncMachines(paired)
  if (!relayUrl || paired.length === 0) {
    setStatus(ctx, { state: 'off' })
    return
  }
  log.info(`remote: connecting to ${relayUrl} for ${paired.length} machine(s)`)
  link = new ViewerLink({
    url: relayUrl,
    keys: paired.map((machine) => machine.key),
    version: app.getVersion(),
    onChange: (event) => {
      if (event.state === 'error') log.warn(`remote: refused — ${event.error}`)
      setStatus(ctx, { state: event.state, error: event.state === 'connected' ? undefined : event.error })
    },
    onHostState: (state) => applyHostState(ctx, state),
    onHostFeed: (update) => applyHostFeed(ctx, update),
    onScreen: ({ hostId, paneId, data, cols, rows }) =>
      ctx.send(CH.remoteScreen, { hostId, paneId, data, cols, rows }),
    onOutput: ({ hostId, paneId, data }) => ctx.send(CH.remoteOutput, { hostId, paneId, data }),
    onKicked: (hostId) => handleKicked(ctx, hostId),
    onAttached: ({ hostId, paneId, ok, error }) => {
      attachWaits.get(attachWaitKey(hostId, paneId))?.(ok ? { ok: true } : { ok: false, error: error ?? 'Refused.' })
      ctx.send(CH.remoteNotice, { type: 'attached', hostId, paneId, ok, ...(error ? { error } : {}) })
    }
  })
}

/**
 * Bring the link in line with the relay settings. Only the address matters to
 * a viewer; a change to anything else leaves the running link alone.
 */
export function applyRemoteSettings(ctx: IpcCtx, settings: RelaySettings): void {
  const url = normalizeRelayUrl(settings.url)
  if (url === relayUrl) return
  relayUrl = url
  rebuildLink(ctx)
}

type PairResult = { ok: true; hostId: string } | { ok: false; error: string }

function addMachine(ctx: IpcCtx, request: { key?: unknown; label?: unknown }): PairResult {
  const key = typeof request?.key === 'string' ? request.key.trim().toLowerCase() : ''
  if (!isKey(key)) return { ok: false, error: 'A pairing key is 64 hex characters.' }
  const hostId = hostIdFor(key)
  if (hostId === ownHostId()) return { ok: false, error: "That is this machine's own key." }
  // Only readable pairings count: one whose key no longer decrypts can be paired again.
  const paired = pairedMachines()
  if (paired.some((machine) => machine.hostId === hostId)) return { ok: false, error: 'Already paired.' }
  if (paired.length >= MAX_REMOTE_MACHINES) return { ok: false, error: 'At most 32 machines can be paired.' }
  const label = typeof request.label === 'string' ? request.label.trim().slice(0, LABEL_MAX_CHARS) : ''
  storeMachine({ hostId, label, key })
  log.info(`remote: paired ${hostId.slice(0, 12)}…`)
  rebuildLink(ctx)
  return { ok: true, hostId }
}

function toAddPane(request: RemoteAddPane): AddPane | null {
  if (typeof request.workspaceId !== 'string' || !request.workspaceId) return null
  if (request.kind !== 'claude' && request.kind !== 'terminal') return null
  const effort = EFFORTS.find((known): known is Effort => known === request.effort)
  return {
    workspaceId: request.workspaceId,
    kind: request.kind,
    ...(typeof request.name === 'string' ? { name: request.name } : {}),
    ...(typeof request.model === 'string' ? { model: request.model } : {}),
    ...(effort ? { effort } : {}),
    ...(typeof request.planMode === 'boolean' ? { planMode: request.planMode } : {})
  }
}

/** Ask for a picture, send it to the pane, and wait for the remote machine's answer. */
async function attachPicture(ctx: IpcCtx, hostId: string, paneId: string): Promise<AttachResult> {
  if (!link?.connected) return { ok: false, error: 'Not connected to the relay.' }
  const win = ctx.win()
  const picked = win ? await dialog.showOpenDialog(win, ATTACH_DIALOG) : await dialog.showOpenDialog(ATTACH_DIALOG)
  const file = picked.filePaths[0]
  if (picked.canceled || !file) return { ok: false, error: 'cancelled' }
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()]
  if (!mime) return { ok: false, error: 'Only PNG, JPEG, GIF and WebP pictures can be sent.' }
  const tooBig = { ok: false, error: `Pictures are capped at ${ATTACH_MAX_MB} MB.` } as const
  let bytes: Buffer
  try {
    if (fs.statSync(file).size > ATTACH_MAX_BYTES) return tooBig
    bytes = fs.readFileSync(file)
  } catch (err) {
    log.warn(`remote: could not read ${file}: ${String(err)}`)
    return { ok: false, error: 'Could not read that file.' }
  }
  if (bytes.length > ATTACH_MAX_BYTES) return tooBig // the file grew after the stat
  // The dialog may have outlived the link it was opened for, or the socket dropped meanwhile.
  if (!link?.connected) return { ok: false, error: 'Not connected to the relay.' }
  const answer = waitForAttached(hostId, paneId)
  link.attach(hostId, { paneId, name: path.basename(file), mime, data: new Uint8Array(bytes) })
  return answer
}

export function registerRemoteIpc(ctx: IpcCtx): void {
  ipcMain.handle(CH.remoteStatus, () => status)

  ipcMain.handle(CH.remoteAddMachine, (_event, request: { key?: unknown; label?: unknown }) =>
    addMachine(ctx, request ?? {})
  )

  ipcMain.on(CH.remoteForgetMachine, (_event, hostId: unknown) => {
    if (typeof hostId !== 'string' || !isStored(hostId)) return
    forgetMachine(hostId)
    log.info(`remote: forgot ${hostId.slice(0, 12)}…`)
    rebuildLink(ctx)
  })

  ipcMain.on(CH.remoteWatch, (_event, request: { hostId?: unknown; paneId?: unknown }) => {
    if (typeof request?.hostId === 'string' && typeof request.paneId === 'string') {
      link?.watch(request.hostId, request.paneId)
    }
  })

  ipcMain.on(CH.remoteUnwatch, (_event, request: { hostId?: unknown; paneId?: unknown }) => {
    if (typeof request?.hostId === 'string' && typeof request.paneId === 'string') {
      link?.unwatch(request.hostId, request.paneId)
    }
  })

  ipcMain.on(CH.remoteInput, (_event, request: { hostId?: unknown; paneId?: unknown; data?: unknown }) => {
    if (typeof request?.hostId === 'string' && typeof request.paneId === 'string' && typeof request.data === 'string') {
      link?.input(request.hostId, request.paneId, request.data)
    }
  })

  ipcMain.on(CH.remoteAddPane, (_event, request: RemoteAddPane) => {
    if (!request || typeof request.hostId !== 'string') return
    const addPane = toAddPane(request)
    if (addPane) link?.addPane(request.hostId, addPane)
  })

  ipcMain.on(CH.remoteOpenWorkspace, (_event, request: { hostId?: unknown; rootDir?: unknown }) => {
    if (typeof request?.hostId === 'string' && typeof request.rootDir === 'string' && request.rootDir) {
      link?.openWorkspace(request.hostId, request.rootDir)
    }
  })

  ipcMain.handle(CH.remoteAttach, (_event, request: { hostId?: unknown; paneId?: unknown }) => {
    if (typeof request?.hostId !== 'string' || typeof request.paneId !== 'string') {
      return { ok: false, error: 'Not a pane on a paired machine.' }
    }
    return attachPicture(ctx, request.hostId, request.paneId)
  })

  applyRemoteSettings(ctx, loadSettings().relay)
  // No address yet leaves `relayUrl` null, as it started: still report the pairings.
  if (!relayUrl) rebuildLink(ctx)
  app.on('will-quit', () => {
    link?.close()
    link = null
  })
}
