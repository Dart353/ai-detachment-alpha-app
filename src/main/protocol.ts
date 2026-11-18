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

const HTML_RE = /\.html?$/i

/** What an HTML page served over `ada-file://` may load. */
export const PAGE_CSP = [
  "default-src 'none'",
  "img-src ada-file: data: blob:",
  "media-src ada-file: data: blob:",
  "style-src ada-file: 'unsafe-inline'",
  "script-src ada-file: 'unsafe-inline'",
  "font-src ada-file: data:",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/**
 * An `ada-file://local/…` URL → the host path it names. A literal `?` or `#`
 * starts a query or fragment — `fileUrl` encodes them inside names — so a
 * cache-busting `?v=3` or an in-page `#anchor` never reaches the disk lookup.
 */
export function hostPathOf(url: string): string {
  const raw = url.replace(/^ada-file:\/\/local/, '').replace(/[?#].*$/s, '')
  return toHost(path.resolve(decodeURIComponent(raw)))
}

/** Attach the handlers that serve those schemes. Called after the app is ready. */
export function installProtocolHandlers(): void {
  // Serve one file's bytes to the viewer pane. The gate is simply "an existing
  // regular file": `fs:readFile` already serves arbitrary paths over IPC, so this
  // widens no trust boundary. In WSL mode the stored (Linux) path is translated to
  // its host share via toHost before touching disk.
  protocol.handle('ada-file', async (request) => {
    const host = hostPathOf(request.url)
    try {
      const stat = await fs.promises.stat(host)
      if (!stat.isFile()) return new Response('not found', { status: 404 })
    } catch {
      return new Response('not found', { status: 404 })
    }
    const response = await net.fetch(pathToFileURL(host).toString())
    if (!HTML_RE.test(host)) return response
    // A page is shown in a sandboxed frame (a workbench, an HTML file in a
    // viewer). It may draw with its own markup, styles and scripts and show the
    // project's images and recordings, and nothing more: no network, no frames,
    // no forms. Agents write these pages; this keeps one from phoning home.
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', PAGE_CSP)
    headers.set('Content-Type', 'text/html; charset=utf-8')
    return new Response(response.body, { status: response.status, headers })
  })
}
