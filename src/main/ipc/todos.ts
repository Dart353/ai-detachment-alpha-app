import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import path from 'node:path'
import { CH } from '../../shared/ipc'
import type {
  TodoBoardState,
  TodoItem,
  TodoSendRequest,
  TodoTargets
} from '../../shared/types'
import {
  loadTodoWindowPrefs,
  loadTodos,
  sanitizeTodos,
  saveTodoWindowPrefs,
  saveTodos,
  type TodoWindowPrefs
} from '../store'
import { guardWebContents, loadRenderer } from '../windows'
import type { IpcCtx } from './index'

/**
 * The todo board. Main owns the list and where the board is showing, because
 * two renderers show it — the main window's docked panel and the popped-out
 * window — and each must see the other's edits. Main owns nothing about panes:
 * a send is forwarded to the main window, which has them, and the main window
 * publishes the pane picture the popped-out board renders its chips from.
 */

const WINDOW_WIDTH = 380
const WINDOW_HEIGHT = 620
const MIN_WIDTH = 300
const MIN_HEIGHT = 240
/** Rolled up, the window is just its 40px header. */
const COLLAPSED_HEIGHT = 40
const SAVE_BOUNDS_MS = 400

let ctxRef: IpcCtx | null = null
let todoWin: BrowserWindow | null = null
/** True while main closes the window itself, so `closed` leaves the prefs alone. */
let closingForQuit = false
let prefs: TodoWindowPrefs = { poppedOut: false, alwaysOnTop: true }
let board: TodoBoardState = { docked: false, poppedOut: false, alwaysOnTop: true, collapsed: false }
let targets: TodoTargets = { ready: false, workspaces: [] }
/** The height to restore when a rolled-up window is expanded again. */
let expandedHeight = WINDOW_HEIGHT
let boundsTimer: ReturnType<typeof setTimeout> | null = null

/** Every live board renderer except `except` (the one that made the change). */
function boardContents(except?: WebContents): WebContents[] {
  const all = [ctxRef?.win(), todoWin]
    .filter((win): win is BrowserWindow => !!win && !win.isDestroyed())
    .map((win) => win.webContents)
  return all.filter((contents) => contents !== except)
}

function broadcast(channel: string, payload: unknown, except?: WebContents): void {
  for (const contents of boardContents(except)) contents.send(channel, payload)
}

function savePrefs(): void {
  prefs = { ...prefs, poppedOut: board.poppedOut, alwaysOnTop: board.alwaysOnTop }
  saveTodoWindowPrefs(prefs)
}

/** A saved spot on a monitor that has since been unplugged opens nowhere. */
function onScreen(bounds: NonNullable<TodoWindowPrefs['bounds']>): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      bounds.x < workArea.x + workArea.width &&
      bounds.x + bounds.width > workArea.x &&
      bounds.y < workArea.y + workArea.height &&
      bounds.y + bounds.height > workArea.y
    )
  })
}

function rememberBounds(): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    boundsTimer = null
    if (!todoWin || todoWin.isDestroyed()) return
    const bounds = todoWin.getBounds()
    // Rolled up, the height on screen is the header's; the one worth keeping is
    // the height it unrolls to.
    prefs = { ...prefs, bounds: { ...bounds, height: board.collapsed ? expandedHeight : bounds.height } }
    saveTodoWindowPrefs(prefs)
  }, SAVE_BOUNDS_MS)
}

function openTodoWindow(focus: boolean): void {
  if (todoWin && !todoWin.isDestroyed()) {
    todoWin.show()
    if (focus) todoWin.focus()
    return
  }
  const saved = prefs.bounds && onScreen(prefs.bounds) ? prefs.bounds : undefined
  expandedHeight = saved?.height ?? WINDOW_HEIGHT
  const win = new BrowserWindow({
    width: saved?.width ?? WINDOW_WIDTH,
    height: expandedHeight,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Todo board',
    frame: false,
    show: false,
    alwaysOnTop: board.alwaysOnTop,
    backgroundColor: '#202025',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  todoWin = win
  loadRenderer(win, { view: 'todo' })
  guardWebContents(win)
  win.once('ready-to-show', () => {
    if (focus) win.show()
    else win.showInactive()
  })
  win.on('moved', rememberBounds)
  win.on('resized', rememberBounds)
  win.on('closed', () => {
    todoWin = null
    // Closed from outside the board (Alt+F4, the taskbar): the board is no
    // longer out. Closed by main on the way out of the app: it stays out, so
    // it comes back next launch.
    if (closingForQuit || !board.poppedOut) return
    applyBoard({ poppedOut: false, collapsed: false })
  })
}

function setCollapsed(collapsed: boolean): void {
  const win = todoWin
  if (!win || win.isDestroyed()) return
  const [width] = win.getSize()
  if (collapsed) {
    expandedHeight = win.getSize()[1]
    win.setMinimumSize(MIN_WIDTH, COLLAPSED_HEIGHT)
    win.setSize(width, COLLAPSED_HEIGHT)
    win.setResizable(false)
  } else {
    win.setResizable(true)
    win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
    win.setSize(width, Math.max(expandedHeight, MIN_HEIGHT))
  }
}

function applyBoard(partial: Partial<TodoBoardState>, focus = true): void {
  const before = board
  const next: TodoBoardState = { ...board, ...partial }
  // One board on screen at a time: out means not docked, and only a popped-out
  // window can be rolled up.
  if (next.poppedOut) next.docked = false
  if (!next.poppedOut) next.collapsed = false
  board = next

  // Asking for the board while it is already out brings its window forward.
  if (next.poppedOut && (!before.poppedOut || partial.poppedOut === true)) {
    openTodoWindow(focus && partial.poppedOut === true)
  } else if (!next.poppedOut && before.poppedOut && todoWin && !todoWin.isDestroyed()) {
    todoWin.close()
  }

  if (todoWin && !todoWin.isDestroyed()) {
    if (next.alwaysOnTop !== before.alwaysOnTop) todoWin.setAlwaysOnTop(next.alwaysOnTop)
    if (next.collapsed !== before.collapsed) setCollapsed(next.collapsed)
  }
  // Docking back means looking at the main window.
  if (next.docked && !before.docked && before.poppedOut) {
    const main = ctxRef?.win()
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.focus()
    }
  }

  if (next.poppedOut !== before.poppedOut || next.alwaysOnTop !== before.alwaysOnTop) savePrefs()
  broadcast(CH.todoBoardChanged, board)
}

/** Bring the board's window back if it was out when the app last closed. */
export function restoreTodoWindow(): void {
  if (board.poppedOut) openTodoWindow(false)
}

/** The main window is going; the board's window goes with it. */
export function closeTodoWindow(): void {
  if (!todoWin || todoWin.isDestroyed()) return
  closingForQuit = true
  todoWin.close()
  closingForQuit = false
}

export function registerTodosIpc(ctx: IpcCtx): void {
  ctxRef = ctx
  prefs = loadTodoWindowPrefs()
  board = { docked: false, poppedOut: prefs.poppedOut, alwaysOnTop: prefs.alwaysOnTop, collapsed: false }

  ipcMain.handle(CH.todosLoad, () => loadTodos())

  // Whole-list writes, last writer wins: one person edits from at most two
  // windows, and the list is small enough that a merge would cost more than
  // the race it settles.
  ipcMain.on(CH.todosSave, (event, items: TodoItem[]) => {
    const clean = sanitizeTodos(items)
    saveTodos(clean)
    broadcast(CH.todosChanged, clean, event.sender)
  })

  ipcMain.handle(CH.todoTargetsGet, () => targets)
  ipcMain.on(CH.todoTargetsPublish, (event, next: TodoTargets) => {
    targets = next
    broadcast(CH.todoTargetsChanged, targets, event.sender)
  })

  ipcMain.on(CH.todoSend, (_event, request: TodoSendRequest) => {
    ctx.send(CH.todoCommand, { type: 'send', request })
  })

  ipcMain.on(CH.todoOpenPane, (_event, paneId: string) => {
    const main = ctx.win()
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    }
    ctx.send(CH.todoCommand, { type: 'openPane', paneId })
  })

  ipcMain.handle(CH.todoBoardGet, () => board)
  ipcMain.on(CH.todoBoardSet, (_event, partial: Partial<TodoBoardState>) => applyBoard(partial))
}
