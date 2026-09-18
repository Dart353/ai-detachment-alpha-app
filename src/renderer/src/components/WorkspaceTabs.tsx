import { useState, type DragEvent as ReactDragEvent, type JSX } from 'react'
import { ContextMenu, TextInput, type MenuItem } from './ui'
import { useApp } from '../store/app'
import './WorkspaceTabs.css'

/**
 * Our own drag payload type. A private MIME keeps a workspace drag from being
 * mistaken for a file, a pane or a drop from another app: anything that does not
 * carry this type is simply not a reorder.
 */
const WORKSPACE_MIME = 'application/x-ada-workspace'

interface MenuAnchor {
  workspaceId: string
  x: number
  y: number
}

/**
 * The workspace tabs in the title bar: one per open folder, plus a trailing `+`.
 * Click switches, double-click renames in place, drag reorders, and middle-click
 * or the context menu closes (the store archives the panes on the way out).
 */
export default function WorkspaceTabs(): JSX.Element {
  const workspaces = useApp((state) => state.workspaces)
  const activeWorkspaceId = useApp((state) => state.activeWorkspaceId)
  const selectWorkspace = useApp((state) => state.selectWorkspace)
  const closeWorkspace = useApp((state) => state.closeWorkspace)
  const renameWorkspace = useApp((state) => state.renameWorkspace)
  const reorderWorkspaces = useApp((state) => state.reorderWorkspaces)
  const openWorkspace = useApp((state) => state.openWorkspace)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  /** Where the dragged tab would land, as an insertion point between tabs. */
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const startRename = (id: string, name: string): void => {
    setRenamingId(id)
    setDraftName(name)
  }

  const commitRename = (): void => {
    if (renamingId) renameWorkspace(renamingId, draftName)
    setRenamingId(null)
  }

  const clearDrag = (): void => {
    setDragFrom(null)
    setDropIndex(null)
  }

  const onDragOverTab = (event: ReactDragEvent<HTMLDivElement>, index: number): void => {
    if (!event.dataTransfer.types.includes(WORKSPACE_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const before = event.clientX < rect.left + rect.width / 2
    setDropIndex(before ? index : index + 1)
  }

  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(WORKSPACE_MIME)) return
    event.preventDefault()
    const from = Number(event.dataTransfer.getData(WORKSPACE_MIME))
    const insertAt = dropIndex
    clearDrag()
    if (!Number.isInteger(from) || insertAt === null) return
    // Removing the tab first shifts everything after it one to the left, so an
    // insertion point past the source is one index lower once it is gone.
    const to = insertAt > from ? insertAt - 1 : insertAt
    if (to === from) return
    reorderWorkspaces(from, to)
  }

  const menuItems = (workspaceId: string, name: string, rootDir: string): MenuItem[] => [
    { label: 'Rename', onClick: () => startRename(workspaceId, name) },
    { label: 'Reveal in file manager', onClick: () => void window.api?.revealPath(rootDir) },
    { label: 'Close workspace', divider: true, onClick: () => closeWorkspace(workspaceId) }
  ]

  return (
    <div className="ada-ws-tabs ada-nodrag" onDrop={onDrop} onDragEnd={clearDrag}>
      {workspaces.map((workspace, index) => {
        const active = workspace.id === activeWorkspaceId
        const classes = ['ada-ws-tab']
        if (active) classes.push('ada-ws-tab--active')
        if (dropIndex === index) classes.push('ada-ws-tab--drop-before')
        if (dropIndex === workspaces.length && index === workspaces.length - 1) {
          classes.push('ada-ws-tab--drop-after')
        }
        if (renamingId === workspace.id) {
          return (
            <div key={workspace.id} className={classes.join(' ')}>
              <TextInput
                className="ada-ws-tab-input"
                size="sm"
                autoFocus
                value={draftName}
                onChange={setDraftName}
                onEnter={commitRename}
                onEscape={() => setRenamingId(null)}
                onBlur={commitRename}
              />
            </div>
          )
        }
        return (
          <div
            key={workspace.id}
            className={classes.join(' ')}
            role="tab"
            aria-selected={active}
            tabIndex={-1}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(WORKSPACE_MIME, String(index))
              event.dataTransfer.effectAllowed = 'move'
              setDragFrom(index)
            }}
            onDragOver={(event) => onDragOverTab(event, index)}
            onClick={() => selectWorkspace(workspace.id)}
            onDoubleClick={() => startRename(workspace.id, workspace.name)}
            onAuxClick={(event) => {
              if (event.button === 1) closeWorkspace(workspace.id)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ workspaceId: workspace.id, x: event.clientX, y: event.clientY })
            }}
            title={workspace.rootDir}
            data-dragging={dragFrom === index || undefined}
          >
            <span className="ada-ws-tab-name">{workspace.name}</span>
            <span className="ada-ws-tab-count">{workspace.panes.length}</span>
          </div>
        )
      })}

      <button
        type="button"
        className="ada-ws-tab ada-ws-tab-add"
        aria-label="Open a folder as a workspace"
        title="Open a folder as a workspace"
        onClick={async () => {
          const dir = await window.api?.pickDir()
          if (dir) openWorkspace(dir)
        }}
      >
        +
      </button>

      {menu &&
        (() => {
          const workspace = workspaces.find((candidate) => candidate.id === menu.workspaceId)
          if (!workspace) return null
          return (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              items={menuItems(workspace.id, workspace.name, workspace.rootDir)}
              onClose={() => setMenu(null)}
            />
          )
        })()}
    </div>
  )
}
