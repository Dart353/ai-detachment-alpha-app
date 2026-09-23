/**
 * The explorer: a VS Code-style file tree rooted at the workspace's folder, sitting
 * between the sidebar and the grid and wearing the sidebar's visual language.
 *
 * headless-tree gives us the flat, keyboard-accessible node list; every pixel is
 * styled here. All filesystem access flows through the sandboxed `window.api` seam:
 * lazy directory loads, one watcher per expanded directory, and the file management
 * gestures — rename (F2 / context menu), create, move-to-trash behind a confirm, and
 * drag to move a row into another folder. A row dragged out onto a terminal carries
 * its absolute path as `text/plain`, which the terminal pastes shell-quoted.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import {
  asyncDataLoaderFeature,
  dragAndDropFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  type DragTarget,
  type ItemInstance,
  type TreeState
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus2,
  FolderPlus,
  RefreshCw
} from 'lucide-react'
import type { FileTreeEntry } from '../../../shared/types'
import { ExplorerTreeCache } from '../lib/explorerTreeCache'
import { iconForFile, iconForFolder } from '../lib/explorerIcons'
import { treeRowIndentStyle } from '../lib/treeIndentGuides'
import { baseName } from '../lib/ids'
import { useApp } from '../store/app'
import { setPendingDraft, useRuntime } from '../store/runtime'
import { fileMention } from '../lib/draftGate'
import { Button, ContextMenu, Modal, type MenuItem } from './ui'
import { revealLabel } from './paneMenu'
import './ExplorerPanel.css'

export interface ExplorerPanelProps {
  workspaceId: string
}

/** Panel width bounds — a comfortable rail that never crowds the panes. */
const MIN_WIDTH = 160
const MAX_WIDTH = 480
export const DEFAULT_EXPLORER_WIDTH = 240

/** Row indent per depth level (px), plus the base gutter before depth 0. */
const INDENT = 14
const GUTTER = 8
const ROW_METRICS = { indent: INDENT, gutter: GUTTER }

/**
 * Backstop sweep over every watched directory. `fs.watch` is best-effort — a dropped
 * event is invisible by construction, and on Linux/Windows a watched directory that
 * gets replaced (temp-dir-then-rename, which agent tooling does) leaves the handle
 * bound to the old inode, still open, still silent. A quiet sweep costs one readDir
 * per expanded folder and no re-render (an unchanged listing never touches the tree),
 * so this is cheap enough to run regardless.
 */
const RECONCILE_MS = 15000

/** Names that read as machinery rather than work, drawn a shade dimmer. */
const DIMMED_NAMES = new Set(['node_modules', '.git'])

/** Containing directory of a stored-form path (its parent). Anchored to the last
 *  separator; every explorer path sits under the workspace root, so this never
 *  climbs past it. */
function parentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index > 0 ? trimmed.slice(0, index) : trimmed
}

/** A row's path relative to the workspace root (for Copy relative path); falls back
 *  to the absolute path when the row somehow sits outside the root. */
function relativeToRoot(root: string, path: string): string {
  const base = root.replace(/[/\\]+$/, '')
  if (path === base) return baseName(path)
  if (path.startsWith(base + '/') || path.startsWith(base + '\\')) {
    return path.slice(base.length + 1)
  }
  return path
}

/** A path is inside node_modules if any of its segments is exactly that. */
function inNodeModules(path: string): boolean {
  return /(^|[/\\])node_modules([/\\]|$)/.test(path)
}

/** node_modules is visible but never auto-expanded from restored state. */
function sanitizeExpanded(paths: string[] | undefined): string[] {
  return (paths ?? []).filter((path) => !inNodeModules(path))
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** An in-flight "New file"/"New folder" edit: which folder it lands in, and the draft. */
interface Creating {
  parent: string
  kind: 'file' | 'dir'
  draft: string
}

/** Which context menu is open, and what it is about. */
type ExplorerMenu =
  | { kind: 'item'; x: number; y: number; path: string; isFolder: boolean }
  | { kind: 'whitespace'; x: number; y: number }

/**
 * The inline rename / create input. headless-tree registers a *native* bubble-phase
 * keydown listener on the tree container (which would complete/abort a rename on
 * Enter/Escape before a React handler could run), so this input owns its keys with a
 * native listener on the element itself: it stops propagation at the target before the
 * container ever sees the event. Focus + select-all happen once on mount.
 */
function InlineInput({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
  ariaLabel
}: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
  placeholder: string
  ariaLabel: string
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const commitRef = useRef(onCommit)
  const cancelRef = useRef(onCancel)
  commitRef.current = onCommit
  cancelRef.current = onCancel

  useEffect(() => {
    const element = inputRef.current
    if (!element) return
    element.focus()
    element.select()
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation() // keep every keystroke out of the tree's hotkeys
      if (event.key === 'Enter') {
        event.preventDefault()
        commitRef.current()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancelRef.current()
      }
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <input
      ref={inputRef}
      className="ada-explorer-input"
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      // headless-tree re-asserts DOM focus onto its focused row via an async focus()
      // right after this input mounts (updateDomFocus). That spurious blur must not
      // abort the edit, so when focus is pulled back onto a tree row we bounce it
      // straight back to the input. A genuine click-away (a pane, empty space, the
      // header) lands off the rows and cancels; Enter / Escape commit / cancel
      // directly, never through blur.
      onBlur={(event) => {
        const next = event.relatedTarget as HTMLElement | null
        if (next?.closest('[role="treeitem"]')) {
          inputRef.current?.focus()
          return
        }
        cancelRef.current()
      }}
    />
  )
}

export default function ExplorerPanel({ workspaceId }: ExplorerPanelProps): JSX.Element | null {
  const workspace = useApp((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  )
  const setExplorer = useApp((state) => state.setExplorer)
  const addPane = useApp((state) => state.addPane)
  const openAddWorkspace = useApp((state) => state.openAddWorkspace)
  const pushToast = useApp((state) => state.pushToast)

  const root = workspace?.rootDir ?? ''
  const explorer = workspace?.explorer

  const [menu, setMenu] = useState<ExplorerMenu | null>(null)
  /** The row a "Move to trash" is waiting on, behind the confirm dialog. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The in-flight create edit (null = none). Rename uses headless-tree's own state. */
  const [creating, setCreating] = useState<Creating | null>(null)
  /** Inline error under the active rename/create input (kept open on failure). */
  const [opError, setOpError] = useState<string | null>(null)

  /** A stable subscriber id, so watch/unwatch refcounting in main pairs cleanly
   *  with this panel alone. */
  const subscriberId = `explorer:${workspaceId}`

  // Every directory listing this panel shows comes through here — headless-tree's lazy
  // loads and the fs:changed pushes both — so a change that lands mid-read is re-read
  // rather than lost, and vanished paths are dropped rather than left as ghost rows.
  // Seeded with the root, which has no parent directory to list it.
  const cacheRef = useRef<ExplorerTreeCache>()
  if (!cacheRef.current) {
    cacheRef.current = new ExplorerTreeCache((dir) => window.api.readDir(dir))
    if (root) cacheRef.current.seed({ name: baseName(root), path: root, kind: 'dir' })
  }
  const cache = cacheRef.current

  // Controlled tree state: expanded/selection/focus/renaming live in React so the
  // expanded set can be restored on launch and persisted back to the store.
  const [treeState, setTreeState] = useState<Partial<TreeState<FileTreeEntry>>>(() => ({
    expandedItems: sanitizeExpanded(explorer?.expanded)
  }))

  /** Forget folders that no longer exist. Without this a deleted-or-renamed folder
   *  stays in the expanded set forever, holding a watcher on a path that is gone. */
  const dropExpanded = useCallback((paths: string[]): void => {
    const gone = new Set(paths)
    setTreeState((state) => {
      const current = state.expandedItems ?? []
      const next = current.filter((path) => !gone.has(path))
      return next.length === current.length ? state : { ...state, expandedItems: next }
    })
  }, [])

  const fail = useCallback(
    (message: string): void => {
      pushToast(message, { kind: 'error' })
    },
    [pushToast]
  )

  const tree = useTree<FileTreeEntry>({
    state: treeState,
    setState: setTreeState,
    rootItemId: root,
    getItemName: (item) => item.getItemData()?.name ?? '',
    isItemFolder: (item) => item.getItemData()?.kind === 'dir',
    createLoadingItemData: () => ({ name: '', path: '', kind: 'file' }),
    dataLoader: {
      getItem: (id) => cache.get(id) ?? { name: baseName(id), path: id, kind: 'dir' },
      getChildren: async (id) => {
        const { ids, removed } = await cache.load(id)
        if (removed.length) dropExpanded(removed)
        return ids
      }
    },
    // --- rename (F2 / context menu) ---
    // The root cannot be renamed; onRename is deliberately unset — we drive the commit
    // ourselves so an async filesystem failure keeps the input open (see commitRename).
    canRename: (item) => !!root && item.getId() !== root,
    // --- drag-and-drop move (within the tree) ---
    canReorder: false, // only dropping INTO folders, never reordering siblings
    canDrag: (items) => !!root && items.every((item) => item.getId() !== root),
    canDrop: (items, target) => {
      const destination = target.item
      const source = items[0]
      if (!destination || !source || !destination.isFolder()) return false
      const destinationPath = destination.getId()
      // no-op: already a direct child of the destination
      if (source.getParent()?.getId() === destinationPath) return false
      // a folder cannot be moved into itself or its own subtree
      if (destinationPath === source.getId() || destination.isDescendentOf(source.getId())) {
        return false
      }
      return true
    },
    // Tag the drag with the row's absolute path as text/plain so a foreign target — a
    // terminal pane — can read it and paste it shell-quoted. Intra-tree drag and drop
    // uses the library's own internal state, so the two coexist without any manual
    // dataTransfer wiring.
    createForeignDragObject: (items) => ({
      format: 'text/plain',
      data: items[0]?.getItemData()?.path ?? items[0]?.getId() ?? ''
    }),
    onDrop: async (items, target: DragTarget<FileTreeEntry>) => {
      const source = items[0]
      const destination = target.item
      if (!source || !destination) return
      const result = await window.api.movePath(source.getId(), destination.getId())
      if (!result.ok) fail(result.message)
      // success → the source and destination watchers push fs:changed and rows re-parent
    },
    // renamingFeature last so its `overwrites: ['drag-and-drop']` takes effect (a row
    // being renamed is not draggable).
    features: [
      asyncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature
    ]
  })

  const expandedItems = treeState.expandedItems ?? []
  const expandedKey = expandedItems.join('\n')

  // ---- persist the expanded set to the store ----
  const lastPersisted = useRef<string[]>(sanitizeExpanded(explorer?.expanded))
  useEffect(() => {
    if (arraysEqual(expandedItems, lastPersisted.current)) return
    lastPersisted.current = expandedItems
    setExplorer(workspaceId, { expanded: expandedItems })
    // guarded by value: the array's identity changes on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKey])

  /**
   * Re-read one directory and fold the result into the tree. This is the whole live
   * update path, and every part of it exists because of a way a simpler one drops
   * changes:
   *
   *  - `getItemInstance` rather than `getItems().find()` — the flat list only holds
   *    VISIBLE rows, so a folder that is still expanded (and still watched) but sits
   *    under a collapsed ancestor would be unreachable, and its events would go nowhere.
   *  - `cache.refresh` rather than `invalidateChildrenIds` — headless-tree de-dupes a
   *    load by subscribing to one already running, so an invalidation that arrived
   *    during a read would resolve with that read's older snapshot and never retry.
   *  - the promise is awaited and its failure handled — `void`-ing it would leave the
   *    panel stale after a rejected read with nothing to notice.
   *  - `changed` gates the tree write, so `fs.watch` firing on a plain content write
   *    (or the backstop sweep) costs one readDir and no re-render.
   */
  const refreshDir = useCallback(
    async (dir: string): Promise<void> => {
      let load: Awaited<ReturnType<ExplorerTreeCache['refresh']>>
      try {
        load = await cache.refresh(dir)
      } catch {
        // One retry: a read can lose a race with the very rename that triggered it.
        try {
          load = await cache.refresh(dir)
        } catch (error) {
          console.warn(`[explorer] could not refresh ${dir}:`, error)
          return
        }
      }
      // A path can change kind under us (an agent replaces note.txt with a note.txt/
      // folder). Nothing else re-reads item data, so the row would keep its old icon
      // and refuse to expand for the rest of the session.
      for (const entry of load.restated) {
        tree.getItemInstance(entry.path).updateCachedData(entry, true)
      }
      if (load.changed || load.restated.length > 0) {
        tree.getItemInstance(dir).updateCachedChildrenIds(load.ids)
      }
      if (load.removed.length) dropExpanded(load.removed)
    },
    // `tree` is stable for the life of the panel (useTree keeps one instance in a ref
    // and only re-sets its config), so this closure never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // ---- watch lifecycle: one fs.watch per expanded dir (+ the root) ----
  const watchedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const desired = new Set<string>()
    if (root) desired.add(root)
    for (const path of expandedItems) desired.add(path)
    const watched = watchedRef.current
    for (const dir of desired) {
      if (watched.has(dir)) continue
      window.api.watchDir(subscriberId, dir)
      watched.add(dir)
      // Collapsing a folder drops its watcher, and re-expanding it serves the children
      // headless-tree already cached — so anything an agent wrote while it was closed
      // would stay invisible until the panel was unmounted. Re-read on the way back in.
      // (First load excluded: it has no cached children yet, and the lazy loader is
      // already fetching them.)
      if (cache.hasChildren(dir)) void refreshDir(dir)
    }
    for (const dir of Array.from(watched)) {
      if (desired.has(dir)) continue
      window.api.unwatchDir(subscriberId, dir)
      watched.delete(dir)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKey, root])

  // ---- live updates: an agent's edit (or our own file op) refreshes the rows ----
  // Subscribed once; on unmount we also release every watcher this panel still holds.
  useEffect(() => {
    const unsubscribe = window.api.onFsChanged((dir) => {
      // fs:changed goes to the whole window, so other workspaces' panels see it too.
      // Only act on directories THIS panel subscribed to.
      if (!watchedRef.current.has(dir)) return
      void refreshDir(dir)
    })
    return () => {
      unsubscribe()
      for (const dir of Array.from(watchedRef.current)) window.api.unwatchDir(subscriberId, dir)
      watchedRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Re-read every watched directory: the header's Refresh, and the backstop sweep. */
  const refreshAll = useCallback((): void => {
    for (const dir of Array.from(watchedRef.current)) void refreshDir(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- backstop: a dropped watch event is invisible, so sweep periodically ----
  useEffect(() => {
    const reconcile = (): void => {
      if (document.hidden) return
      refreshAll()
    }
    const timer = window.setInterval(reconcile, RECONCILE_MS)
    window.addEventListener('focus', reconcile)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', reconcile)
    }
  }, [refreshAll])

  // ---- drag-to-resize the right edge ----
  const [width, setWidth] = useState(() =>
    clamp(explorer?.width ?? DEFAULT_EXPLORER_WIDTH, MIN_WIDTH, MAX_WIDTH)
  )
  const startResize = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    // Every frame of the drag resizes the grid, which SIGWINCHes the terminals into a
    // full repaint — activity the status engine would otherwise hear as an agent
    // stirring. Keep the notifications down for the drag and a moment after it.
    useRuntime.getState().holdNotifications()
    const onMove = (moveEvent: MouseEvent): void => {
      setWidth(clamp(startWidth + (moveEvent.clientX - startX), MIN_WIDTH, MAX_WIDTH))
      useRuntime.getState().holdNotifications()
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      useRuntime.getState().holdNotifications()
      setWidth((current) => {
        setExplorer(workspaceId, { width: current })
        return current
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /** Open a file in a viewer pane; the store focuses one that is already open. */
  // A Claude pane at the workspace root (so the project's CLAUDE.md and settings
  // apply) with `@file ` typed into its input, unsubmitted, once Claude is up.
  const openInClaude = (path: string): void => {
    const paneId = addPane(workspaceId, { kind: 'claude', name: baseName(path) })
    if (paneId) setPendingDraft(paneId, fileMention(relativeToRoot(root, path)))
  }

  const openFile = (path: string): void => {
    addPane(workspaceId, { kind: 'viewer', filePath: path })
  }

  // ---- rename commit / cancel ----
  const commitRename = async (item: ItemInstance<FileTreeEntry>): Promise<void> => {
    const value = tree.getRenamingValue().trim()
    if (!value || value === item.getItemName()) {
      setOpError(null)
      tree.abortRenaming()
      return
    }
    const result = await window.api.renamePath(item.getId(), value)
    if (result.ok) {
      setOpError(null)
      tree.abortRenaming() // success → fs:changed refreshes the row with the new name
    } else {
      setOpError(result.message) // keep the input open with what was typed
    }
  }
  const cancelRename = (): void => {
    setOpError(null)
    tree.abortRenaming()
  }

  // ---- create: resolve the target directory, then open the inline input there ----
  const resolveSelectionTarget = (): string | undefined => {
    if (!root) return undefined
    const first = tree.getSelectedItems()[0]
    if (!first) return root // nothing selected → the workspace root
    return first.isFolder() ? first.getId() : first.getParent()?.getId() ?? parentPath(first.getId())
  }
  const startCreate = (kind: 'file' | 'dir', fromPath?: string, fromIsFolder?: boolean): void => {
    if (!root) return
    const target = fromPath
      ? fromIsFolder
        ? fromPath
        : parentPath(fromPath)
      : resolveSelectionTarget()
    if (!target) return
    tree.abortRenaming()
    setOpError(null)
    // expand the target folder so the input appears among its children (root always shows)
    if (target !== root) tree.getItemInstance(target).expand()
    setCreating({ parent: target, kind, draft: '' })
  }
  const commitCreate = async (): Promise<void> => {
    if (!creating) return
    const name = creating.draft.trim()
    if (!name) {
      setCreating(null)
      setOpError(null)
      return
    }
    const result =
      creating.kind === 'file'
        ? await window.api.createFile(creating.parent, name)
        : await window.api.createDir(creating.parent, name)
    if (result.ok) {
      setCreating(null)
      setOpError(null) // fs:changed brings the new row in
    } else {
      setOpError(result.message) // keep the input open
    }
  }
  const cancelCreate = (): void => {
    setCreating(null)
    setOpError(null)
  }

  // ---- trash: the confirm dialog holds the path until it is answered ----
  const doTrash = async (): Promise<void> => {
    const path = confirming
    setConfirming(null)
    if (!path) return
    const result = await window.api.trashPath(path)
    if (!result.ok) fail(result.message)
    // success → the parent directory's watcher pushes fs:changed and the row disappears
  }

  if (!workspace) return null

  const style: CSSProperties = { width }
  const items = tree.getItems()

  // A click on true tree whitespace (below the last row) drops both highlights,
  // VS Code-style. Selection empties and the focused item clears, so New file /
  // New folder fall back to the workspace root (resolveSelectionTarget). Rows keep
  // their keyboard reachability: the next focus falls back to the first item inside
  // headless-tree.
  const deselectAll = (): void => {
    tree.setSelectedItems([])
    setTreeState((state) => ({ ...state, focusedItem: null }))
  }

  const collapseAll = (): void => {
    setTreeState((state) => ({ ...state, expandedItems: [] }))
  }

  // Spread headless-tree's container props first and extend its handlers (today it
  // wires drag/drop, focus and key handling — but if a future feature adds its own
  // onClick/onContextMenu, it still runs before the whitespace guard).
  const containerProps = tree.getContainerProps('Workspace files')

  /** The inline create input, on its own row at the top of the folder it lands in. */
  const renderCreateInput = (draft: Creating, level: number): JSX.Element => {
    const CreateGlyph = draft.kind === 'dir' ? iconForFolder(false) : iconForFile(draft.draft)
    return (
      <div className="ada-explorer-row is-editing" style={treeRowIndentStyle(level, ROW_METRICS)}>
        <span className="ada-explorer-chevron" />
        <CreateGlyph size={13} strokeWidth={1.5} className="ada-explorer-icon" />
        <InlineInput
          value={draft.draft}
          onChange={(value) =>
            setCreating((current) => (current ? { ...current, draft: value } : current))
          }
          onCommit={() => void commitCreate()}
          onCancel={cancelCreate}
          placeholder={draft.kind === 'file' ? 'New file name' : 'New folder name'}
          ariaLabel={draft.kind === 'file' ? 'New file name' : 'New folder name'}
        />
      </div>
    )
  }

  const menuItems = (open: ExplorerMenu): MenuItem[] => {
    if (open.kind === 'whitespace') {
      return [
        { label: 'New file…', onClick: () => startCreate('file', root, true) },
        { label: 'New folder…', onClick: () => startCreate('dir', root, true) }
      ]
    }
    const path = open.path
    const rows: MenuItem[] = []
    if (open.isFolder) {
      rows.push(
        { label: 'New file…', onClick: () => startCreate('file', path, true) },
        { label: 'New folder…', onClick: () => startCreate('dir', path, true) },
        // A folder in the tree is one step from being its own workspace: hand it
        // to the Add screen with the folder already filled in.
        { label: 'Open as workspace…', divider: true, onClick: () => openAddWorkspace(path) }
      )
    } else {
      rows.push(
        { label: 'Open', onClick: () => openFile(path) },
        { label: 'Open in Claude Code', onClick: () => openInClaude(path) }
      )
    }
    rows.push({ label: 'Copy path', divider: true, onClick: () => window.api.copyText(path) })
    if (!open.isFolder) {
      rows.push({
        label: 'Copy relative path',
        onClick: () => window.api.copyText(relativeToRoot(root, path))
      })
    }
    rows.push(
      { label: revealLabel(window.api.platform), onClick: () => void window.api.revealPath(path) },
      {
        label: 'Rename…',
        divider: true,
        onClick: () => tree.getItemInstance(path).startRenaming()
      },
      { label: 'Move to trash', danger: true, onClick: () => setConfirming(path) }
    )
    return rows
  }

  return (
    <div className="ada-explorer" style={style} aria-label="Explorer">
      <div className="ada-explorer-head">
        <span className="ada-explorer-title">EXPLORER</span>
        <span className="ada-explorer-root" title={root}>
          {baseName(root)}
        </span>
        <button
          className="ada-explorer-act"
          title="New file"
          aria-label="New file"
          onClick={() => startCreate('file')}
        >
          <FilePlus2 size={13} strokeWidth={1.5} />
        </button>
        <button
          className="ada-explorer-act"
          title="New folder"
          aria-label="New folder"
          onClick={() => startCreate('dir')}
        >
          <FolderPlus size={13} strokeWidth={1.5} />
        </button>
        <button
          className="ada-explorer-act"
          title="Refresh"
          aria-label="Refresh"
          onClick={refreshAll}
        >
          <RefreshCw size={13} strokeWidth={1.5} />
        </button>
        <button
          className="ada-explorer-act"
          title="Collapse all"
          aria-label="Collapse all"
          onClick={collapseAll}
        >
          <ChevronsDownUp size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div
        className="ada-explorer-tree"
        {...containerProps}
        // Whitespace only: rows, chevrons and inline inputs are children, so their
        // clicks arrive with a different target and pass through untouched.
        onClick={(event) => {
          containerProps.onClick?.(event)
          if (event.target !== event.currentTarget) return
          deselectAll()
        }}
        onContextMenu={(event) => {
          containerProps.onContextMenu?.(event)
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          deselectAll()
          setMenu({ kind: 'whitespace', x: event.clientX, y: event.clientY })
        }}
      >
        {/* a create at the workspace root shows at the top of the tree */}
        {creating && creating.parent === root && (
          <>
            {renderCreateInput(creating, 0)}
            {opError && <div className="ada-explorer-error">{opError}</div>}
          </>
        )}
        {items.length === 0 && !creating ? (
          <div className="ada-explorer-quiet">Empty or unreadable folder.</div>
        ) : (
          items.map((item) => {
            const data = item.getItemData()
            const isFolder = item.isFolder()
            const open = item.isExpanded()
            const Glyph = isFolder ? iconForFolder(open) : iconForFile(data?.name ?? '')
            const level = item.getItemMeta().level
            const path = item.getId()
            const name = item.getItemName()
            const renaming = item.isRenaming()
            const itemProps = item.getProps()
            const classes = [
              'ada-explorer-row',
              isFolder ? 'is-folder' : 'is-file',
              item.isSelected() ? 'is-selected' : '',
              // raw state, not item.isFocused(): the library falls back to the first
              // row when focusedItem is null, which would re-light row 0 the moment a
              // whitespace click clears focus
              treeState.focusedItem === path ? 'is-focused' : '',
              item.isDragTarget() ? 'is-drop-target' : '',
              renaming ? 'is-editing' : '',
              name.startsWith('.') || DIMMED_NAMES.has(name) ? 'is-dimmed' : ''
            ]
              .filter(Boolean)
              .join(' ')
            const rowStyle = treeRowIndentStyle(level, ROW_METRICS)

            return (
              <Fragment key={path}>
                {renaming ? (
                  // Rename: a non-button row (an input inside a <button> is invalid and
                  // fights the drag handle) whose input replaces the label.
                  <div className={classes} style={rowStyle}>
                    <span className="ada-explorer-chevron">
                      {isFolder ? (
                        open ? (
                          <ChevronDown size={12} strokeWidth={1.5} />
                        ) : (
                          <ChevronRight size={12} strokeWidth={1.5} />
                        )
                      ) : null}
                    </span>
                    <Glyph size={13} strokeWidth={1.5} className="ada-explorer-icon" />
                    <InlineInput
                      value={tree.getRenamingValue()}
                      onChange={(value) =>
                        setTreeState((state) => ({ ...state, renamingValue: value }))
                      }
                      onCommit={() => void commitRename(item)}
                      onCancel={cancelRename}
                      placeholder="Name"
                      ariaLabel="Rename"
                    />
                  </div>
                ) : (
                  <button
                    {...itemProps}
                    className={classes}
                    style={rowStyle}
                    // A single click opens a file in a viewer pane; folders keep the
                    // library's click-to-expand behaviour.
                    onClick={(event) => {
                      itemProps.onClick?.(event)
                      if (!isFolder) openFile(path)
                    }}
                    // Enter opens the focused file. A native button fires click on Enter
                    // (which would only re-select), so intercept it here; every other key
                    // goes on to the library's arrow-key navigation.
                    onKeyDown={(event) => {
                      if ((event.key === 'Enter' || event.key === 'NumpadEnter') && !isFolder) {
                        event.preventDefault()
                        event.stopPropagation()
                        openFile(path)
                        return
                      }
                      itemProps.onKeyDown?.(event)
                    }}
                    // Right-click selects the row (VS Code behaviour) and opens the menu.
                    onContextMenu={(event) => {
                      event.preventDefault()
                      item.setFocused()
                      tree.setSelectedItems([path]) // replace selection (single-select)
                      setMenu({ kind: 'item', x: event.clientX, y: event.clientY, path, isFolder })
                    }}
                  >
                    <span className="ada-explorer-chevron">
                      {isFolder ? (
                        open ? (
                          <ChevronDown size={12} strokeWidth={1.5} />
                        ) : (
                          <ChevronRight size={12} strokeWidth={1.5} />
                        )
                      ) : null}
                    </span>
                    <Glyph size={13} strokeWidth={1.5} className="ada-explorer-icon" />
                    <span className="ada-explorer-name">{name}</span>
                  </button>
                )}
                {/* the inline error sits directly beneath the row it belongs to */}
                {renaming && opError && <div className="ada-explorer-error">{opError}</div>}
                {/* a create inside this folder shows as its first child */}
                {creating && creating.parent === path && (
                  <>
                    {renderCreateInput(creating, level + 1)}
                    {opError && <div className="ada-explorer-error">{opError}</div>}
                  </>
                )}
              </Fragment>
            )
          })
        )}
      </div>

      <div
        className="ada-explorer-resize"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
      />

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      )}

      <Modal
        open={!!confirming}
        title="Move to trash"
        width={380}
        onClose={() => setConfirming(null)}
        footer={
          <>
            <Button onClick={() => setConfirming(null)}>Cancel</Button>
            <Button variant="primary" danger onClick={() => void doTrash()}>
              Move to trash
            </Button>
          </>
        }
      >
        <p className="ada-explorer-confirm">
          Move <strong>{confirming ? baseName(confirming) : ''}</strong> to the trash?
        </p>
      </Modal>
    </div>
  )
}
