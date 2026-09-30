/**
 * The Remote view's navigation tree: every paired machine as a collapsible row,
 * its open workspaces nested beneath it, and their panes beneath those. Clicking
 * a pane selects it for the terminal on the right; the machine and workspace
 * rows carry the menus that act on the far desktop (open a folder, add a pane,
 * forget the machine), and the header's + pairs a new one.
 *
 * Reuses the local sidebar's row classes so both trees read as the same thing.
 */
import { useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronRight, Ellipsis, Plus } from 'lucide-react'
import { Button, ContextMenu, Modal, type MenuItem } from '../ui'
import { useRemote, waitingCount } from '../../store/remote'
import type { RemoteMachine } from '../../../../shared/types'
import type { FeedPane, FeedWorkspace } from '../../../../shared/relayProtocol'
import { dotStatus, kindLabel, machineName } from './remoteHelpers'
import { RemoteNewAgent } from './RemoteNewAgent'
import { RemoteOpenWorkspace } from './RemoteOpenWorkspace'
import { RemoteAddMachine } from './RemoteAddMachine'
import '../Sidebar.css'
import './remote.css'

/** Icon size for every glyph in the tree (design: 12–14px, muted grey). */
const ICON = 13


type MenuAnchor =
  | { kind: 'machine'; hostId: string; x: number; y: number }
  | { kind: 'workspace'; hostId: string; workspaceId: string; x: number; y: number }

interface WorkspaceTarget {
  hostId: string
  workspaceId: string
}

function machinePanes(machine: RemoteMachine): FeedPane[] {
  return (machine.feed?.workspaces ?? []).flatMap((workspace) => workspace.panes)
}

function findMachine(machines: RemoteMachine[], hostId: string): RemoteMachine | null {
  return machines.find((machine) => machine.hostId === hostId) ?? null
}

function findWorkspace(machine: RemoteMachine, workspaceId: string): FeedWorkspace | null {
  return machine.feed?.workspaces.find((workspace) => workspace.id === workspaceId) ?? null
}

export function RemoteSidebar(): JSX.Element {
  const machines = useRemote((state) => state.status.machines)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [openWorkspaceHostId, setOpenWorkspaceHostId] = useState<string | null>(null)
  const [newAgentTarget, setNewAgentTarget] = useState<WorkspaceTarget | null>(null)
  const [forgetHostId, setForgetHostId] = useState<string | null>(null)
  const [addingMachine, setAddingMachine] = useState(false)

  function menuItems(anchor: MenuAnchor): MenuItem[] {
    if (anchor.kind === 'machine') {
      return [
        { label: 'Open workspace…', onClick: () => setOpenWorkspaceHostId(anchor.hostId) },
        {
          label: 'Forget this machine',
          divider: true,
          danger: true,
          onClick: () => setForgetHostId(anchor.hostId)
        }
      ]
    }
    const target = { hostId: anchor.hostId, workspaceId: anchor.workspaceId }
    return [
      { label: 'New agent…', onClick: () => setNewAgentTarget(target) },
      {
        label: 'New terminal',
        onClick: () => window.api.addRemotePane({ ...target, kind: 'terminal' })
      }
    ]
  }

  const openWorkspaceMachine = openWorkspaceHostId ? findMachine(machines, openWorkspaceHostId) : null
  const newAgentMachine = newAgentTarget ? findMachine(machines, newAgentTarget.hostId) : null
  const newAgentWorkspace =
    newAgentMachine && newAgentTarget ? findWorkspace(newAgentMachine, newAgentTarget.workspaceId) : null
  const forgetMachine = forgetHostId ? findMachine(machines, forgetHostId) : null

  return (
    <aside className="ada-sidebar">
      <div className="ada-sidebar-head">
        <span className="ada-sidebar-title">MACHINES</span>
        <Button
          variant="icon"
          size="sm"
          aria-label="Add a machine"
          title="Add a machine"
          onClick={() => setAddingMachine(true)}
        >
          <Plus size={ICON} />
        </Button>
      </div>

      <div className="ada-sidebar-tree">
        {machines.length === 0 && (
          <div className="ada-sb-empty">
            <span className="ada-sb-empty-text">No machines paired yet</span>
            <Button variant="outline" size="sm" onClick={() => setAddingMachine(true)}>
              Add machine…
            </Button>
          </div>
        )}

        {machines.map((machine) => (
          <MachineNode
            key={machine.hostId}
            machine={machine}
            onMachineMenu={(event) =>
              setMenu({ kind: 'machine', hostId: machine.hostId, x: event.clientX, y: event.clientY })
            }
            onWorkspaceMenu={(workspaceId, event) =>
              setMenu({
                kind: 'workspace',
                hostId: machine.hostId,
                workspaceId,
                x: event.clientX,
                y: event.clientY
              })
            }
          />
        ))}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}

      {openWorkspaceMachine && (
        <RemoteOpenWorkspace
          open
          machine={openWorkspaceMachine}
          onClose={() => setOpenWorkspaceHostId(null)}
        />
      )}

      {newAgentMachine && newAgentWorkspace && (
        <RemoteNewAgent
          open
          machine={newAgentMachine}
          workspace={newAgentWorkspace}
          onClose={() => setNewAgentTarget(null)}
        />
      )}

      <RemoteAddMachine open={addingMachine} onClose={() => setAddingMachine(false)} />

      {forgetMachine && (
        <ForgetMachineDialog machine={forgetMachine} onClose={() => setForgetHostId(null)} />
      )}
    </aside>
  )
}

/* === machine ================================================================ */

interface MachineNodeProps {
  machine: RemoteMachine
  onMachineMenu: (event: ReactMouseEvent) => void
  onWorkspaceMenu: (workspaceId: string, event: ReactMouseEvent) => void
}

function MachineNode({ machine, onMachineMenu, onWorkspaceMenu }: MachineNodeProps): JSX.Element {
  const folded = useRemote((state) => state.folded[machine.hostId] === true)
  const toggleFold = useRemote((state) => state.toggleFold)
  const allPanes = machinePanes(machine)
  const waiting = waitingCount(allPanes)
  const rowClasses = ['ada-sb-row', 'ada-sb-ws']

  return (
    <div className="ada-sb-node" style={machine.online ? undefined : { opacity: 0.55 }}>
      <div className={rowClasses.join(' ')} title={machine.online ? undefined : 'Offline'}>
        <FoldChevron folded={folded} noun="machine" onToggle={() => toggleFold(machine.hostId)} />
        <span
          className={`ada-sb-dot ada-sb-dot--${machine.online ? 'working' : 'exited'}`}
          aria-hidden="true"
        />
        <span className="ada-sb-ws-name">{machineName(machine)}</span>
        {waiting > 0 ? (
          <span className="ada-sb-count" title="waiting for you">
            {waiting}
          </span>
        ) : (
          <span className="ada-sb-count">{allPanes.length}</span>
        )}
        <Button
          variant="icon"
          size="sm"
          icon={<Ellipsis size={ICON} />}
          aria-label="Machine menu"
          title="Machine menu"
          onClick={(event) => {
            event.stopPropagation()
            onMachineMenu(event)
          }}
        />
      </div>

      {!folded && (
        <div className="ada-sb-children">
          {(machine.feed?.workspaces ?? []).map((workspace) => (
            <WorkspaceNode
              key={workspace.id}
              hostId={machine.hostId}
              workspace={workspace}
              onMenu={(event) => onWorkspaceMenu(workspace.id, event)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* === workspace ============================================================== */

interface WorkspaceNodeProps {
  hostId: string
  workspace: FeedWorkspace
  onMenu: (event: ReactMouseEvent) => void
}

function WorkspaceNode({ hostId, workspace, onMenu }: WorkspaceNodeProps): JSX.Element {
  const foldKey = `${hostId}/${workspace.id}`
  const folded = useRemote((state) => state.folded[foldKey] === true)
  const toggleFold = useRemote((state) => state.toggleFold)
  const selected = useRemote((state) => state.selected)
  const select = useRemote((state) => state.select)
  const selectWorkspace = useRemote((state) => state.selectWorkspace)
  const waiting = waitingCount(workspace.panes)
  const showWaiting = folded && waiting > 0
  const active = selected?.hostId === hostId && selected.workspaceId === workspace.id

  // Picking a workspace shows its canvas and unfolds its panes, as it does locally.
  const open = (): void => {
    selectWorkspace(hostId, workspace.id)
    if (folded) toggleFold(foldKey)
  }

  return (
    <div className="ada-sb-node">
      <div
        className={`ada-sb-row ada-sb-ws${active ? ' ada-sb-ws--active' : ''}`}
        title={workspace.rootDir}
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            open()
          }
        }}
      >
        <FoldChevron folded={folded} noun="workspace" onToggle={() => toggleFold(foldKey)} />
        <span className="ada-sb-ws-name">{workspace.name}</span>
        {showWaiting ? (
          <span className="ada-sb-count" title="waiting for you">
            {waiting}
          </span>
        ) : (
          <span className="ada-sb-count">{workspace.panes.length}</span>
        )}
        <Button
          variant="icon"
          size="sm"
          icon={<Plus size={ICON} />}
          aria-label="New agent or terminal"
          title="New agent or terminal"
          onClick={(event) => {
            event.stopPropagation()
            onMenu(event)
          }}
        />
      </div>

      {!folded && (
        <div className="ada-sb-children">
          {workspace.panes.map((pane) => (
            <PaneRow
              key={pane.id}
              pane={pane}
              active={selected?.hostId === hostId && selected.paneId === pane.id}
              onSelect={() => select({ hostId, workspaceId: workspace.id, paneId: pane.id })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* === pane =================================================================== */

interface PaneRowProps {
  pane: FeedPane
  active: boolean
  onSelect: () => void
}

function PaneRow({ pane, active, onSelect }: PaneRowProps): JSX.Element {
  // A file viewer has no terminal to stream; it is listed, but not openable.
  const selectable = pane.kind !== 'viewer'
  const classes = ['ada-sb-row', 'ada-sb-pane']
  if (active) classes.push('ada-sb-pane--active')
  if (!selectable) classes.push('ada-remote-pane--inert')

  return (
    <div
      className={classes.join(' ')}
      title={pane.name}
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-disabled={selectable ? undefined : true}
      onClick={selectable ? onSelect : undefined}
      onKeyDown={(event) => {
        if (!selectable) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <span className={`ada-sb-dot ada-sb-dot--${dotStatus(pane.status)}`} aria-hidden="true" />
      <span className="ada-sb-label">
        <span className="ada-sb-pane-name">{pane.name}</span>
        <span className="ada-sb-sub">
          {kindLabel(pane.kind)} · {pane.status === 'attention' ? 'waiting' : pane.status}
        </span>
      </span>
    </div>
  )
}

/* === shared bits ============================================================ */

interface FoldChevronProps {
  folded: boolean
  noun: string
  onToggle: () => void
}

function FoldChevron({ folded, noun, onToggle }: FoldChevronProps): JSX.Element {
  return (
    <button
      type="button"
      className="ada-sb-chevron"
      aria-label={folded ? `Expand ${noun}` : `Collapse ${noun}`}
      aria-expanded={!folded}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      {folded ? <ChevronRight size={ICON} /> : <ChevronDown size={ICON} />}
    </button>
  )
}

interface ForgetMachineDialogProps {
  machine: RemoteMachine
  onClose: () => void
}

function ForgetMachineDialog({ machine, onClose }: ForgetMachineDialogProps): JSX.Element {
  const name = machineName(machine)
  return (
    <Modal
      open
      title="Forget machine"
      width={400}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            danger
            onClick={() => {
              window.api.forgetRemoteMachine(machine.hostId)
              onClose()
            }}
          >
            Forget
          </Button>
        </>
      }
    >
      <p className="ada-remote-dialog-text">
        Forget {name}? Its panes disappear from this desktop; the machine keeps running. Pair again
        any time.
      </p>
    </Modal>
  )
}
