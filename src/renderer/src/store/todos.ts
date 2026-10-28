/**
 * The todo board's store, the same in both windows that show it.
 *
 * Main holds the list on disk and is the only writer of the file: every edit
 * here sets local state and sends main the whole list, and main hands it to
 * the other window. An incoming list is applied as-is and never echoed back.
 *
 * `targets` — the workspaces and Claude panes a todo can go to — is produced by
 * the main window (`useTodoAgents`) and arrives in the popped-out one through
 * main; `board` (docked, popped out, on top) is owned by main outright.
 */
import { create } from 'zustand'
import type {
  TodoAgentLink,
  TodoBoardState,
  TodoItem,
  TodoTargets
} from '../../../shared/types'
import {
  addSub,
  newTodo,
  parseQuickAdd,
  removeSub,
  toggleSub,
  toggleTodo
} from '../lib/todos'

export interface TodosState {
  items: TodoItem[]
  hydrated: boolean
  targets: TodoTargets
  board: TodoBoardState

  /** Apply a list main sent; nothing is saved. */
  replace: (items: TodoItem[]) => void
  setTargets: (targets: TodoTargets) => void
  setBoardState: (board: TodoBoardState) => void
  /** Ask main to move the board; the answer comes back through `setBoardState`. */
  setBoard: (partial: Partial<TodoBoardState>) => void

  /** Returns the new todo's id, or null for an empty line. */
  add: (text: string, checklist?: boolean) => string | null
  /** One todo per line, each tagged with `workspace` unless it names its own. */
  addLines: (lines: string[], workspace?: string) => void
  toggle: (id: string) => void
  rename: (id: string, title: string) => void
  remove: (id: string) => void
  clearDone: () => void
  setWorkspace: (id: string, workspace: string | undefined) => void
  makeChecklist: (id: string) => void
  toggleSub: (id: string, subId: string) => void
  addSub: (id: string, title: string) => void
  renameSub: (id: string, subId: string, title: string) => void
  removeSub: (id: string, subId: string) => void
  setAgent: (id: string, agent: TodoAgentLink | undefined) => void
  /** Apply several item edits as one save (the agent watcher's tick). */
  patch: (changes: Map<string, TodoItem>) => void
}

const EMPTY_BOARD: TodoBoardState = {
  docked: false,
  poppedOut: false,
  alwaysOnTop: true,
  collapsed: false
}

export const useTodos = create<TodosState>()((set, get) => {
  /** Every edit goes through here: local first, then main and the other window. */
  const commit = (items: TodoItem[]): void => {
    set({ items })
    window.api?.saveTodos(items)
  }
  const mapItem = (id: string, fn: (item: TodoItem) => TodoItem): void => {
    let changed = false
    const items = get().items.map((item) => {
      if (item.id !== id) return item
      const next = fn(item)
      if (next !== item) changed = true
      return next
    })
    if (changed) commit(items)
  }

  return {
    items: [],
    hydrated: false,
    targets: { ready: false, workspaces: [] },
    board: EMPTY_BOARD,

    replace: (items) => set({ items }),
    setTargets: (targets) => set({ targets }),
    setBoardState: (board) => set({ board }),
    setBoard: (partial) => {
      // Optimistic, so a click answers at once; main's broadcast settles it.
      set((state) => ({ board: { ...state.board, ...partial } }))
      window.api?.setTodoBoard(partial)
    },

    add: (text, checklist = false) => {
      const item = newTodo(text, Date.now(), checklist)
      if (!item) return null
      commit([item, ...get().items])
      return item.id
    },

    addLines: (lines, workspace) => {
      const now = Date.now()
      const added: TodoItem[] = []
      for (const line of lines) {
        const item = newTodo(line, now)
        if (!item) continue
        if (!item.workspace && workspace) item.workspace = workspace
        added.push(item)
      }
      if (added.length > 0) commit([...added, ...get().items])
    },

    toggle: (id) => mapItem(id, (item) => toggleTodo(item, Date.now())),

    rename: (id, title) => {
      const clean = title.trim()
      if (!clean) return
      mapItem(id, (item) => (item.title === clean ? item : { ...item, title: clean }))
    },

    remove: (id) => commit(get().items.filter((item) => item.id !== id)),
    clearDone: () => commit(get().items.filter((item) => !item.done)),

    setWorkspace: (id, workspace) =>
      mapItem(id, (item) => {
        const next = { ...item }
        if (workspace) next.workspace = workspace
        else delete next.workspace
        return next
      }),

    makeChecklist: (id) => mapItem(id, (item) => (item.items ? item : { ...item, items: [] })),

    toggleSub: (id, subId) => mapItem(id, (item) => toggleSub(item, subId, Date.now())),
    addSub: (id, title) => mapItem(id, (item) => addSub(item, title, Date.now())),
    renameSub: (id, subId, title) => {
      const clean = title.trim()
      if (!clean) return
      mapItem(id, (item) => ({
        ...item,
        items: item.items?.map((sub) => (sub.id === subId ? { ...sub, title: clean } : sub))
      }))
    },
    removeSub: (id, subId) => mapItem(id, (item) => removeSub(item, subId, Date.now())),

    setAgent: (id, agent) =>
      mapItem(id, (item) => {
        const next = { ...item }
        if (agent) next.agent = agent
        else delete next.agent
        return next
      }),

    patch: (changes) => {
      if (changes.size === 0) return
      commit(get().items.map((item) => changes.get(item.id) ?? item))
    }
  }
})

/**
 * The titlebar button and Ctrl+Shift+T: bring a popped-out board forward, or
 * show and hide the docked one.
 */
export function toggleTodoBoard(): void {
  const { board, setBoard } = useTodos.getState()
  if (board.poppedOut) setBoard({ poppedOut: true })
  else setBoard({ docked: !board.docked })
}

/** The tag a quick-add line would get, for showing it before Enter is pressed. */
export function previewTag(text: string): string | undefined {
  return parseQuickAdd(text).workspace
}

/**
 * Load the list, the targets and the board's place, then keep them in step with
 * main. Called once by each window's root; returns the unsubscribe.
 */
export function startTodoSync(): () => void {
  const api = window.api
  if (!api) return () => {}
  const offs = [
    api.onTodosChanged((items) => useTodos.getState().replace(items)),
    api.onTodoTargets((targets) => useTodos.getState().setTargets(targets)),
    api.onTodoBoard((board) => useTodos.getState().setBoardState(board))
  ]
  void Promise.all([api.loadTodos(), api.getTodoTargets(), api.getTodoBoard()]).then(
    ([items, targets, board]) => {
      // The main window publishes its own targets; an older copy from main must
      // not overwrite a fresher local one.
      const current = useTodos.getState().targets
      useTodos.setState({
        items,
        board,
        hydrated: true,
        targets: current.ready ? current : targets
      })
    }
  )
  return () => offs.forEach((off) => off())
}
