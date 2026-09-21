import { app, ipcMain, type WebContents } from 'electron'
import { CH } from '../../shared/ipc'
import type { PtyDataEvent, PtyExitEvent, SpawnOpts } from '../../shared/types'
import { mintCommandFor, resolveAccountEnv } from '../accounts'
import { feedMintOutput } from '../accountMint'
import { log } from '../log'
import { paneTap } from '../paneTap'
import { isWsl, toStored } from '../platform'
import { PtyManager } from '../ptyManager'
import { loadSettings } from '../store'
import { finishMintFromOutput } from './accounts'
import type { IpcCtx } from './index'

/**
 * Which WebContents spawned each PTY, captured at pty:spawn. PTY output must
 * reach the window that owns the terminal and no other, and a window going away
 * kills exactly the PTYs it owned.
 */
const ptyOwners = new Map<string, WebContents>()

/** Windows already wired to a teardown listener, so we add it only once. */
const watchedOwners = new WeakSet<WebContents>()

function sendPtyEvent(id: string, channel: string, payload: PtyDataEvent | PtyExitEvent): void {
  const owner = ptyOwners.get(id)
  if (!owner || owner.isDestroyed()) return
  owner.send(channel, payload)
}

export function registerPtyIpc(ctx: IpcCtx): void {
  const ptys = new PtyManager({
    fullscreenTui: () => loadSettings().fullscreenTui,
    shellPath: () => loadSettings().shellPath,
    accountEnv: (accountId) => resolveAccountEnv(accountId)
  })
  // Keystrokes from a phone (via the relay) land here; the tap only forwards
  // them for panes it has seen output from, so nothing else is reachable.
  paneTap.setWriter((id, data) => ptys.write(id, data))

  /** Kill every PTY a departed window owned; nothing else can reach them. */
  const killOwnedBy = (owner: WebContents): void => {
    for (const [id, wc] of [...ptyOwners]) {
      if (wc !== owner) continue
      ptyOwners.delete(id)
      ptys.kill(id)
    }
  }

  ipcMain.handle(CH.ptySpawn, (event, opts: SpawnOpts) => {
    // Stored paths are already Linux-side in WSL mode, but a path that came back
    // from a host-native API would be a `\\wsl…` share path, which `--cd` cannot
    // use. toStored() is its inverse and a no-op on an already-Linux path.
    const cwd = isWsl() && opts.cwd ? toStored(opts.cwd) : opts.cwd
    let spawnOpts: SpawnOpts = { ...opts, cwd }

    // A mint spawn is only honoured when it matches a pending mint main itself
    // created (id AND staging dir), and it runs MAIN's command: the renderer's
    // command, pane kind and account are all discarded, so this path can never
    // be turned into "run anything with a custom environment".
    const isMint = Boolean(opts.mint)
    if (opts.mint) {
      const command = mintCommandFor(opts.id, opts.mint.configDir)
      if (!command) return false
      spawnOpts = { ...spawnOpts, command, kind: 'terminal', accountId: undefined }
    }

    // The spawning WebContents owns this PTY: its output streams back to that
    // window and no other (see sendPtyEvent).
    ptyOwners.set(opts.id, event.sender)
    if (!watchedOwners.has(event.sender)) {
      watchedOwners.add(event.sender)
      event.sender.once('destroyed', () => killOwnedBy(event.sender))
    }

    if (!isMint && opts.cols && opts.rows) paneTap.resize(opts.id, opts.cols, opts.rows)
    try {
      ptys.spawn(
        spawnOpts,
        (id, data) => {
          sendPtyEvent(id, CH.ptyData, { id, data })
          // The tap keeps the tail of every pane's output for a phone that opens
          // it later, and streams the rest to one watching now. A mint run is
          // never tapped: its output carries a credential.
          if (!isMint) paneTap.push(id, data)
          // The token a setup-token run prints is captured HERE: main already
          // has the output, so the credential never travels to the renderer.
          if (!isMint) return
          const token = feedMintOutput(id, data)
          if (token) finishMintFromOutput(ctx, id, token)
        },
        (id, code) => {
          sendPtyEvent(id, CH.ptyExit, { id, code })
          ptyOwners.delete(id)
          paneTap.drop(id)
        }
      )
    } catch (err) {
      // A pane bound to an account whose credential can no longer be read fails
      // here. Report it as a refused spawn rather than an opaque IPC rejection,
      // and never echo the reason — it can name paths — back to the renderer.
      ptyOwners.delete(opts.id)
      log.warn('pty spawn failed:', err instanceof Error ? err.message : String(err))
      return false
    }
    return true
  })

  /**
   * Only a PTY's owner may act on it. A pane id can be respawned by a new window
   * while the old one is still tearing down, and that teardown (a kill, or a last
   * pause/resize) must not reach into the live process — it presents as a group
   * of silently dead terminals.
   */
  const ownedByOr = (id: string, sender: WebContents): boolean => {
    const owner = ptyOwners.get(id)
    return !owner || owner === sender
  }

  ipcMain.on(CH.ptyWrite, (event, { id, data }: { id: string; data: string }) => {
    if (ownedByOr(id, event.sender)) ptys.write(id, data)
  })

  ipcMain.on(
    CH.ptyResize,
    (event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
      if (!ownedByOr(id, event.sender)) return
      ptys.resize(id, cols, rows)
      if (cols > 0 && rows > 0) paneTap.resize(id, cols, rows)
    }
  )

  ipcMain.on(CH.ptyKill, (event, { id }: { id: string }) => {
    if (!ownedByOr(id, event.sender)) return
    ptys.kill(id)
    ptyOwners.delete(id)
    paneTap.drop(id)
  })

  // Renderer-driven flow control: pause/resume a PTY when its terminal backs up.
  ipcMain.on(CH.ptyPause, (event, { id }: { id: string }) => {
    if (ownedByOr(id, event.sender)) ptys.pause(id)
  })

  ipcMain.on(CH.ptyResume, (event, { id }: { id: string }) => {
    if (ownedByOr(id, event.sender)) ptys.resume(id)
  })

  // The pane's live working directory (null when it can't be resolved), so
  // "Copy path" / "Reveal" follow a `cd` instead of reporting the spawn-time cwd
  // the pane was stored with.
  ipcMain.handle(CH.ptyCwd, (_event, { id }: { id: string }) => ptys.cwd(id))

  // Quitting with live children would leave orphaned shells behind.
  app.on('before-quit', () => {
    ptyOwners.clear()
    ptys.killAll()
  })
}
