import { shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import { writeCrashReport } from './log'

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
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
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
