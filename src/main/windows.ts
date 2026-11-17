import { shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import { writeCrashReport } from './log'
import { hostPathOf } from './protocol'

/**
 * Files a link in a shown page may hand to their default app. Anything else is
 * only revealed in the file manager: an agent-written page must not be able to
 * launch a script or an app by being clicked.
 */
const OPENABLE_RE =
  /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|mov|m4v|webm|mp3|wav|m4a|pdf|txt|md|markdown|json|csv|log)$/i

/** A link out of a page shown in a viewer frame: open it beside the app, never inside. */
function openFromPage(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url)
    return
  }
  if (!/^ada-file:/i.test(url)) return
  const target = hostPathOf(url)
  if (OPENABLE_RE.test(target)) void shell.openPath(target)
  else shell.showItemInFolder(target)
}

/** Two `ada-file://` URLs name the same file (they may differ in query or fragment). */
function sameFile(a: string, b: string): boolean {
  return a.replace(/[?#].*$/s, '') === b.replace(/[?#].*$/s, '')
}

/**
 * What every app window shares: how it loads the renderer, and the guards that
 * keep a stray link from turning it into a browser. The main window and the
 * popped-out todo board are the same renderer bundle, told apart by `query`.
 */

/**
 * Load the renderer into `win`. The e2e smoke test drives the app through the
 * renderer's own stores, and `?e2e=1` is what asks the renderer to expose them.
 * It rides on ADA_USER_DATA, so the flag can only ever appear in a throwaway
 * profile.
 */
export function loadRenderer(win: BrowserWindow, query: Record<string, string> = {}): void {
  const params = { ...query }
  if (process.env['ADA_USER_DATA']) params['e2e'] = '1'
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: params })
  }
}

export function guardWebContents(win: BrowserWindow): void {
  // Nothing in the app is meant to spawn a child window. Left unhandled, any
  // window.open — xterm's OSC 8 default, a stray target=_blank — gets Electron's
  // default answer: a new BrowserWindow with no address bar and no way to
  // navigate. Deny the popup and hand the URL to the OS browser instead.
  const webContents = win.webContents
  webContents.setWindowOpenHandler(({ url }) => {
    openFromPage(url)
    return { action: 'deny' }
  })

  // A page shown in a viewer frame (a workbench, an HTML file) stays on itself.
  // The viewer's own loads and reloads are the same file; an in-page #anchor is
  // too. Any other navigation — a link to a screenshot, a website — is opened
  // beside the app instead, so the pane never wanders off its page.
  webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    const current = details.frame?.url ?? ''
    const fresh = current === '' || current === 'about:blank'
    if (/^ada-file:/i.test(details.url) && (fresh || sameFile(current, details.url))) return
    // The viewer hands the frame its page as `srcdoc`.
    if (details.url === 'about:blank' || details.url === 'about:srcdoc') return
    details.preventDefault()
    openFromPage(details.url)
  })

  // Same reasoning for top-level navigation: following an external link in place
  // would replace the app with a web page, and this window has no chrome to get
  // back from it. Same-origin navigation still passes so the dev server's
  // reloads keep working.
  webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === new URL(webContents.getURL()).origin) return
    } catch {
      /* unparsable current or target URL — fall through to the guard */
    }
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // A renderer crash blanks the window with no dialog and no console left to
  // read; the report is the only trace of why.
  webContents.on('render-process-gone', (_event, details) => {
    writeCrashReport('render-process-gone', details)
  })
}
