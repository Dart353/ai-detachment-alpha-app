import { net, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { toHost } from './platform'

/**
 * `ada-file://` — the one way the sandboxed renderer gets a local file's bytes
 * into an `<img>`. Inlining them as base64 data URLs would mean copying every
 * image through IPC; this streams from disk instead.
 */

/**
 * Declare custom schemes as privileged. MUST be called at module load, before
 * `app.whenReady()`: Electron locks the scheme registry once the app is ready,
 * and a scheme registered later gets none of the privileges the renderer needs.
 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'ada-file', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
  ])
}

/** Attach the handlers that serve those schemes. Called after the app is ready. */
export function installProtocolHandlers(): void {
  // Serve one file's bytes to the viewer pane. The gate is simply "an existing
  // regular file": `fs:readFile` already serves arbitrary paths over IPC, so this
  // widens no trust boundary. In WSL mode the stored (Linux) path is translated to
  // its host share via toHost before touching disk.
  protocol.handle('ada-file', async (request) => {
    const raw = decodeURIComponent(request.url.replace(/^ada-file:\/\/local/, ''))
    const resolved = path.resolve(raw)
    const host = toHost(resolved)
    try {
      const stat = await fs.promises.stat(host)
      if (!stat.isFile()) return new Response('not found', { status: 404 })
    } catch {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(host).toString())
  })
}
