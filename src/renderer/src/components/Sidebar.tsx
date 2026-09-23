import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Terminal,
  X
} from 'lucide-react'
import SidebarUsage from './SidebarUsage'
import { Button, ContextMenu, TextInput, type MenuItem } from './ui'
import { selectActiveWorkspace, useApp } from '../store/app'
import { useRuntime } from '../store/runtime'
import { STATUS_LABEL } from '../lib/status'
import { useGitStatus } from '../hooks/useGitStatus'
import { usePaneShare } from '../hooks/useUsage'
import type { Pane, PaneStatus, Workspace } from '../../../shared/types'
import './Sidebar.css'

/**
 * Our own drag payload type for a workspace row. A private MIME keeps a reorder
 * from being confused with a file drop, a pane drag or a drop from another app:
 * anything not carrying this type is simply not a reorder.
 */
const WORKSPACE_ROW_MIME = 'application/x-ada-workspace-row'

/** The same for a pane row, which reorders only within its own workspace. */
const PANE_ROW_MIME = 'application/x-ada-pane-row'

/** Icon size for every glyph in the sidebar (design: 12–14px, muted grey). */
const ICON = 13

/** Characters the footer path is allowed before it is middle-ellipsized. */
const PATH_MAX_CHARS = 34

interface MenuAnchor {
  kind: 'workspace' | 'pane'
  id: string
  x: number
  y: number
}

interface Renaming {
  kind: 'workspace' | 'pane'
  id: string
}

/**
 * The navigation tree: every open workspace as a collapsible parent row with its
 * panes nested beneath it under the names the user gave them. Clicking a pane row
 * focuses it in the grid (switching workspace when it belongs to another one),
 * double-click renames in place, and workspaces drag to reorder.
 *
 * Collapsed, the whole column becomes a 46px rail of status dots — the same
 * information at a glance, with the names traded for the screen space.
 */
export default function Sidebar(): JSX.Element {
  const collapsed = useApp((state) => state.sidebarCollapsed)

  return (
    <aside className={`ada-sidebar${collapsed ? ' ada-sidebar--rail' : ''}`}>
      {collapsed ? <SidebarRail /> : <SidebarTree />}
    </aside>
  )
}

/* === the expanded tree ====================================================== */

function SidebarTree(): JSX.Element {
  const workspaces = useApp((state) => state.workspaces)
  const activeWorkspaceId = useApp((state) => state.activeWorkspaceId)
  const defaultPaneKind = useApp((state) => state.settings.defaultPaneKind)
  const openWorkspace = useApp((state) => state.openWorkspace)
  const openAddWorkspace = useApp((state) => state.openAddWorkspace)
  const closeWorkspace = useApp((state) => state.closeWorkspace)
  const renameWorkspace = useApp((state) => state.renameWorkspace)
  const reorderWorkspaces = useApp((state) => state.reorderWorkspaces)
  const reorderPanes = useApp((state) => state.reorderPanes)
  const selectWorkspace = useApp((state) => state.selectWorkspace)
  const toggleWorkspaceCollapsed = useApp((state) => state.toggleWorkspaceCollapsed)
  const addPane = useApp((state) => state.addPane)
  const closePane = useApp((state) => state.closePane)
  const renamePane = useApp((state) => state.renamePane)
  const duplicatePane = useApp((state) => state.duplicatePane)
  const startFresh = useApp((state) => state.startFresh)
  const focusPane = useApp((state) => state.focusPane)

  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  /** Where the dragged row would land, as an insertion point between rows. */
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const dragIndex = dragId ? workspaces.findIndex((candidate) => candidate.id === dragId) : -1

  const clearDrag = (): void => {
    setDragId(null)
    setDropIndex(null)
  }

  /** A drop that would put the row back exactly where it started: no line, no splice. */
  const isNoop = (to: number): boolean => dragIndex >= 0 && (to === dragIndex || to === dragIndex + 1)

  const isRowDrag = (event: ReactDragEvent): boolean =>
    event.dataTransfer.types.includes(WORKSPACE_ROW_MIME)

  /** Insertion index for a pointer over row `index`: above it on the top half. */
  const edgeFor = (event: ReactDragEvent<HTMLElement>, index: number): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? index : index + 1
  }

  const onRowDragOver = (event: ReactDragEvent<HTMLElement>, index: number): void => {
    if (!isRowDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const to = edgeFor(event, index)
    setDropIndex((current) => (current === to ? current : to))
  }

  const dropAt = (to: number, sourceId: string): void => {
    clearDrag()
    const from = workspaces.findIndex((candidate) => candidate.id === sourceId)
    // `to` is an insertion index in the pre-move array, so both `from` and
    // `from + 1` leave the order untouched.
    if (from < 0 || to === from || to === from + 1) return
    // Removing the row first shifts everything after it up one, so an insertion
    // point past the source is one index lower once it is gone.
    reorderWorkspaces(from, to > from ? to - 1 : to)
  }

  const onRowDrop = (event: ReactDragEvent<HTMLElement>, index: number): void => {
    if (!isRowDrag(event)) return
    event.preventDefault()
    dropAt(edgeFor(event, index), event.dataTransfer.getData(WORKSPACE_ROW_MIME))
  }

  // The tree's own padding below the last row means "put it last". Gated on
  // `target` so a row's bubbling dragover never overrides its own edge.
  const onTreeDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || !isRowDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropIndex(workspaces.length)
  }

  const onTreeDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || !isRowDrag(event)) return
    event.preventDefault()
    dropAt(workspaces.length, event.dataTransfer.getData(WORKSPACE_ROW_MIME))
  }

  const onTreeDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropIndex(null)
  }

  // --- pane rows: the same insertion-line reorder, confined to one workspace ---

  /** Which edge of pane row `index` shows the drop line, if any. */
  const paneDropEdge = (workspace: Workspace, index: number): 'before' | 'after' | null => {
    if (paneDrag?.wsId !== workspace.id || paneDropIndex === null) return null
    const from = workspace.panes.findIndex((candidate) => candidate.id === paneDrag.id)
    if (paneDropIndex === from || paneDropIndex === from + 1) return null
    if (paneDropIndex === index) return 'before'
    if (paneDropIndex === workspace.panes.length && index === workspace.panes.length - 1) {
      return 'after'
    }
    return null
  }

  const [paneDrag, setPaneDrag] = useState<{ wsId: string; id: string } | null>(null)
  const [paneDropIndex, setPaneDropIndex] = useState<number | null>(null)

  const clearPaneDrag = (): void => {
    setPaneDrag(null)
    setPaneDropIndex(null)
  }

  /** A pane drag this workspace's rows may take: it came from one of them. */
  const isPaneDragFor = (event: ReactDragEvent, wsId: string): boolean =>
    event.dataTransfer.types.includes(PANE_ROW_MIME) && paneDrag?.wsId === wsId

  const onPaneDragOver = (
    event: ReactDragEvent<HTMLElement>,
    workspace: Workspace,
    index: number
  ): void => {
    if (!isPaneDragFor(event, workspace.id)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const to = edgeFor(event, index)
    setPaneDropIndex((current) => (current === to ? current : to))
  }

  const onPaneDrop = (
    event: ReactDragEvent<HTMLElement>,
    workspace: Workspace,
    index: number
  ): void => {
    if (!isPaneDragFor(event, workspace.id)) return
    event.preventDefault()
    event.stopPropagation()
    const to = edgeFor(event, index)
    const sourceId = event.dataTransfer.getData(PANE_ROW_MIME)
    clearPaneDrag()
    const from = workspace.panes.findIndex((candidate) => candidate.id === sourceId)
    // Insertion index semantics as for workspaces: `from` and `from + 1` are no-ops.
    if (from < 0 || to === from || to === from + 1) return
    reorderPanes(workspace.id, from, to > from ? to - 1 : to)
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api?.pickDir()
    if (dir) openWorkspace(dir)
  }

  const workspaceMenuItems = (workspace: Workspace): MenuItem[] => [
    {
      label: 'New agent (Claude Code)',
      icon: <span className="ada-sb-glyph">✻</span>,
      onClick: () => addPane(workspace.id, { kind: 'claude' })
    },
    {
      label: 'New terminal',
      icon: <Terminal size={ICON} />,
      onClick: () => addPane(workspace.id, { kind: 'terminal' })
    },
    {
      label: 'Rename',
      icon: <Pencil size={ICON} />,
      divider: true,
      onClick: () => setRenaming({ kind: 'workspace', id: workspace.id })
    },
    {
      label: 'Reveal in file manager',
      icon: <FolderOpen size={ICON} />,
      onClick: () => void window.api?.revealPath(workspace.rootDir)
    },
    {
      label: 'Close workspace',
      icon: <X size={ICON} />,
      divider: true,
      onClick: () => closeWorkspace(workspace.id)
    }
  ]

  const paneMenuItems = (pane: Pane): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: 'Rename',
        icon: <Pencil size={ICON} />,
        onClick: () => setRenaming({ kind: 'pane', id: pane.id })
      },
      {
        label: 'Duplicate',
        icon: <Copy size={ICON} />,
        onClick: () => duplicatePane(pane.id)
      }
    ]
    if (pane.kind === 'claude') {
      items.push({
        label: 'Start fresh session',
        icon: <RotateCcw size={ICON} />,
        danger: true,
        onClick: () => startFresh(pane.id)
      })
    }
    items.push({
      label: 'Close pane',
      icon: <X size={ICON} />,
      divider: true,
      onClick: () => closePane(pane.id)
    })
    return items
  }

  const menuItems = (): MenuItem[] => {
    if (!menu) return []
    if (menu.kind === 'workspace') {
      const workspace = workspaces.find((candidate) => candidate.id === menu.id)
      return workspace ? workspaceMenuItems(workspace) : []
    }
    for (const workspace of workspaces) {
      const pane = workspace.panes.find((candidate) => candidate.id === menu.id)
      if (pane) return paneMenuItems(pane)
    }
    return []
  }

  return (
    <>
      <div className="ada-sidebar-head">
        <span className="ada-sidebar-title">WORKSPACES</span>
        <Button
          variant="icon"
          size="sm"
          aria-label="Add a workspace"
          title="Add a workspace"
          onClick={() => openAddWorkspace()}
        >
          <Plus size={ICON} />
        </Button>
      </div>

      <div
        className="ada-sidebar-tree"
        onDragOver={onTreeDragOver}
        onDrop={onTreeDrop}
        onDragLeave={onTreeDragLeave}
        onDragEnd={clearDrag}
      >
        {workspaces.length === 0 && (
          <div className="ada-sb-empty">
            <span className="ada-sb-empty-text">No workspaces open</span>
            <Button variant="outline" size="sm" onClick={() => void pickFolder()}>
              Open folder…
            </Button>
          </div>
        )}

        {workspaces.map((workspace, index) => {
          const active = workspace.id === activeWorkspaceId
          const rowClasses = ['ada-sb-row', 'ada-sb-ws']
          if (active) rowClasses.push('ada-sb-ws--active')
          if (dragId === workspace.id) rowClasses.push('ada-sb-row--dragging')
          if (dropIndex === index && !isNoop(index)) rowClasses.push('ada-sb-row--drop-before')
          if (
            dropIndex === workspaces.length &&
            index === workspaces.length - 1 &&
            !isNoop(workspaces.length)
          ) {
            rowClasses.push('ada-sb-row--drop-after')
          }
          const renamingThis = renaming?.kind === 'workspace' && renaming.id === workspace.id

          return (
            <div key={workspace.id} className="ada-sb-node">
              <div
                className={rowClasses.join(' ')}
                role="button"
                tabIndex={0}
                title={workspace.rootDir}
                // The row is its own drag handle — but never while it is being
                // renamed, so the field keeps normal text selection.
                draggable={!renamingThis}
                onDragStart={(event) => {
                  event.dataTransfer.setData(WORKSPACE_ROW_MIME, workspace.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDragId(workspace.id)
                }}
                onDragOver={(event) => onRowDragOver(event, index)}
                onDrop={(event) => onRowDrop(event, index)}
                onClick={(event) => {
                  // The second click of a double-click opens the rename; it must
                  // not also re-select the workspace and pull focus away.
                  if (event.detail > 1) return
                  // Clicking the workspace you are already in folds its panes
                  // away, the way an explorer's section header does; clicking
                  // any other one switches to it.
                  if (active) toggleWorkspaceCollapsed(workspace.id)
                  else selectWorkspace(workspace.id)
                }}
                onDoubleClick={() => setRenaming({ kind: 'workspace', id: workspace.id })}
                onKeyDown={(event) => onRowKeyDown(event, () => selectWorkspace(workspace.id))}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({
                    kind: 'workspace',
                    id: workspace.id,
                    x: event.clientX,
                    y: event.clientY
                  })
                }}
              >
                <button
                  type="button"
                  className="ada-sb-chevron"
                  aria-label={workspace.collapsed ? 'Expand workspace' : 'Collapse workspace'}
                  aria-expanded={!workspace.collapsed}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleWorkspaceCollapsed(workspace.id)
                  }}
                >
                  {workspace.collapsed ? (
                    <ChevronRight size={ICON} />
                  ) : (
                    <ChevronDown size={ICON} />
                  )}
                </button>
                {renamingThis ? (
                  <RenameField
                    initial={workspace.name}
                    onCommit={(name) => {
                      renameWorkspace(workspace.id, name)
                      setRenaming(null)
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <>
                    <span className="ada-sb-ws-name">{workspace.name}</span>
                    <span className="ada-sb-count">{workspace.panes.length}</span>
                  </>
                )}
              </div>

              {!workspace.collapsed && (
                <div className="ada-sb-children">
                  {workspace.panes.map((pane, paneIndex) => (
                    <PaneRow
                      key={pane.id}
                      pane={pane}
                      dragging={paneDrag?.id === pane.id}
                      dropEdge={paneDropEdge(workspace, paneIndex)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(PANE_ROW_MIME, pane.id)
                        event.dataTransfer.effectAllowed = 'move'
                        setPaneDrag({ wsId: workspace.id, id: pane.id })
                      }}
                      onDragEnd={clearPaneDrag}
                      onDragOver={(event) => onPaneDragOver(event, workspace, paneIndex)}
                      onDrop={(event) => onPaneDrop(event, workspace, paneIndex)}
                      active={active && workspace.focusedPaneId === pane.id}
                      renaming={renaming?.kind === 'pane' && renaming.id === pane.id}
                      onSelect={() => focusPane(pane.id)}
                      onStartRename={() => setRenaming({ kind: 'pane', id: pane.id })}
                      onCommitRename={(name) => {
                        renamePane(pane.id, name)
                        setRenaming(null)
                      }}
                      onCancelRename={() => setRenaming(null)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setMenu({ kind: 'pane', id: pane.id, x: event.clientX, y: event.clientY })
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className="ada-sb-new"
                    onClick={() => addPane(workspace.id, { kind: defaultPaneKind })}
                  >
                    <span className="ada-sb-new-plus" aria-hidden="true">
                      +
                    </span>
                    {defaultPaneKind === 'claude' ? 'New agent' : 'New terminal'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <SidebarFooter />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </>
  )
}

/* === rows =================================================================== */

interface PaneRowProps {
  pane: Pane
  /** This is the focused pane of the active workspace. */
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void
  dragging: boolean
  dropEdge: 'before' | 'after' | null
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void
}

/**
 * One pane under its workspace. It subscribes to its OWN status and nothing
 * else, so a status tick repaints one row rather than the whole tree.
 */
function PaneRow({
  pane,
  active,
  renaming,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  dragging,
  dropEdge,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: PaneRowProps): JSX.Element {
  const status = useRuntime((state) => state.status[pane.id]) ?? 'idle'
  const share = usePaneShare(pane.id)

  const classes = ['ada-sb-row', 'ada-sb-pane']
  if (active) classes.push('ada-sb-pane--active')
  if (dragging) classes.push('ada-sb-row--dragging')
  if (dropEdge) classes.push(`ada-sb-row--drop-${dropEdge}`)

  return (
    <div
      className={classes.join(' ')}
      role="button"
      tabIndex={0}
      title={pane.name}
      // Drag to reorder within the workspace — never while renaming, so the
      // field keeps normal text selection.
      draggable={!renaming}
      onDragStart={(event) => {
        // The workspace row's drag state must not see this one.
        event.stopPropagation()
        onDragStart(event)
      }}
      onDragEnd={(event) => {
        event.stopPropagation()
        onDragEnd()
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={(event) => {
        if (event.detail > 1) return
        onSelect()
      }}
      onDoubleClick={onStartRename}
      onKeyDown={(event) => onRowKeyDown(event, onSelect)}
      onContextMenu={onContextMenu}
    >
      <span className={`ada-sb-dot ada-sb-dot--${status}`} aria-hidden="true" />
      {renaming ? (
        <RenameField initial={pane.name} onCommit={onCommitRename} onCancel={onCancelRename} />
      ) : (
        <>
          <span className="ada-sb-label">
            <span className="ada-sb-pane-name">{pane.name}</span>
            <span className="ada-sb-sub">{paneSubtitle(pane, status)}</span>
          </span>
          {pane.kind === 'claude' ? (
            share !== null && <span className="ada-sb-share">{share}%</span>
          ) : (
            <span className="ada-sb-share ada-sb-share--none">—</span>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The inline rename field. It owns its draft so typing never re-renders the
 * tree, and `TextInput` keeps every keystroke inside itself — without that, a
 * rename would fire the app's global shortcuts and feed a focused terminal.
 */
function RenameField({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(initial)
  // Escape blurs the field on its way out; without this the blur that follows
  // would commit the very draft the user just abandoned.
  const settled = useRef(false)

  const commit = (): void => {
    if (settled.current) return
    settled.current = true
    onCommit(draft)
  }

  return (
    <TextInput
      className="ada-sb-rename"
      size="sm"
      autoFocus
      value={draft}
      onChange={setDraft}
      onEnter={commit}
      onEscape={() => {
        settled.current = true
        onCancel()
      }}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  )
}

/* === footer ================================================================= */

function SidebarFooter(): JSX.Element {
  const workspace = useApp(selectActiveWorkspace)
  const home = useHomeDir()
  const git = useGitStatus(workspace?.rootDir)

  return (
    <div className="ada-sidebar-foot">
      <SidebarUsage />
      {workspace && (
        <div className="ada-sb-path" title={workspace.rootDir}>
          {displayPath(workspace.rootDir, home)}
        </div>
      )}
      {git?.branch && (
        <div className="ada-sb-git">
          <span
            className={`ada-sb-git-dot${git.dirty ? ' ada-sb-git-dot--dirty' : ''}`}
            aria-hidden="true"
          />
          {git.branch} · {git.dirty ? 'dirty' : 'clean'}
        </div>
      )}
    </div>
  )
}

/* === the collapsed rail ===================================================== */

function SidebarRail(): JSX.Element {
  const workspace = useApp(selectActiveWorkspace)
  const defaultPaneKind = useApp((state) => state.settings.defaultPaneKind)
  const addPane = useApp((state) => state.addPane)
  const focusPane = useApp((state) => state.focusPane)
  const setView = useApp((state) => state.setView)

  return (
    <div className="ada-sidebar-rail">
      {workspace?.panes.map((pane) => (
        <RailDot key={pane.id} pane={pane} onSelect={() => focusPane(pane.id)} />
      ))}
      {workspace && (
        <button
          type="button"
          className="ada-sb-rail-add"
          aria-label="New pane"
          title="New pane"
          onClick={() => addPane(workspace.id, { kind: defaultPaneKind })}
        >
          +
        </button>
      )}
      <span className="ada-sb-rail-spacer" />
      <button
        type="button"
        className="ada-sb-rail-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => setView('settings')}
      >
        <Settings size={12} />
      </button>
    </div>
  )
}

function RailDot({ pane, onSelect }: { pane: Pane; onSelect: () => void }): JSX.Element {
  const status = useRuntime((state) => state.status[pane.id]) ?? 'idle'
  return (
    <button
      type="button"
      className={`ada-sb-rail-dot ada-sb-dot--${status}`}
      title={pane.name}
      aria-label={pane.name}
      onClick={onSelect}
    />
  )
}

/* === helpers ================================================================ */

/** Enter or Space on the row itself (never on a control inside it) activates it. */
function onRowKeyDown(event: ReactKeyboardEvent<HTMLElement>, activate: () => void): void {
  if (event.target !== event.currentTarget) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}

/** The second line of a pane row: what it runs, and how it is doing. */
function paneSubtitle(pane: Pane, status: PaneStatus): string {
  if (pane.kind === 'viewer') return 'File'
  if (pane.kind === 'ssh') return `ssh · ${pane.sshHost ?? 'host'}`
  const kind = pane.kind === 'claude' ? 'Claude Code' : 'Terminal'
  return `${kind} · ${STATUS_LABEL[status].toLowerCase()}`
}

/** The user's home directory, read once — the footer shortens paths against it. */
function useHomeDir(): string {
  const [home, setHome] = useState('')
  useEffect(() => {
    let cancelled = false
    void window.api?.homeDir().then((dir) => {
      if (!cancelled) setHome(dir)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return home
}

/** `/home/me/dev/thing` → `~/dev/thing`, middle-ellipsized if it is still long. */
function displayPath(path: string, home: string): string {
  const short = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  if (short.length <= PATH_MAX_CHARS) return short
  // The head names the drive and the tail names the folder; the middle is the
  // part nobody reads, so that is what goes.
  const keep = PATH_MAX_CHARS - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${short.slice(0, head)}…${short.slice(short.length - tail)}`
}
