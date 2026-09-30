/**
 * Small display helpers shared by the Remote view's components, kept apart so
 * the sidebar and the dialogs it mounts do not import each other.
 */
import type { RemoteMachine } from '../../../../shared/types'
import type { FeedLayout, FeedPane, FeedWorkspace, FeedZone, PaneKind, PaneStatus } from '../../../../shared/relayProtocol'

/** What the user calls a machine: their pairing label, else its own name. */
export function machineName(machine: RemoteMachine): string {
  return machine.label || machine.name || 'machine'
}

/** The sidebar's dot classes have no `starting`; a fresh agent reads as working. */
export function dotStatus(status: PaneStatus): Exclude<PaneStatus, 'starting'> {
  return status === 'starting' ? 'working' : status
}

/** A pane kind as the sidebar and the headers spell it. */
export function kindLabel(kind: PaneKind): string {
  if (kind === 'claude') return 'Claude Code'
  if (kind === 'terminal') return 'Terminal'
  if (kind === 'ssh') return 'ssh'
  return 'File'
}

/** One pane and the tile it is drawn in. */
export interface RemoteSlot {
  pane: FeedPane
  zone: FeedZone
}

/**
 * An even grid for `count` panes, as wide as it is tall or one wider: what a
 * workspace gets when its desktop sent no layout (it predates the field) or
 * a pane has no tile of its own.
 */
export function evenZones(count: number): FeedZone[] {
  if (count <= 0) return []
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const zones: FeedZone[] = []
  for (let index = 0; index < count; index++) {
    const row = Math.floor(index / cols)
    // The last row stretches to fill the width when it is short.
    const inRow = row === rows - 1 ? count - row * cols : cols
    const col = index - row * cols
    zones.push({ id: `even-${index}`, x: (col * 100) / inRow, y: (row * 100) / rows, w: 100 / inRow, h: 100 / rows })
  }
  return zones
}

function usable(layout: FeedLayout | undefined): layout is FeedLayout {
  return !!layout && Array.isArray(layout.zones) && layout.zones.length > 0 && !!layout.assign
}

/**
 * Where each pane of a workspace is drawn: in its own desktop's tile when the
 * feed says which, otherwise in an even grid. Two panes never share a tile —
 * the first one the feed lists keeps it.
 */
export function slotsOf(workspace: FeedWorkspace): RemoteSlot[] {
  const layout = workspace.layout
  if (!usable(layout)) {
    const zones = evenZones(workspace.panes.length)
    return workspace.panes.map((pane, index) => ({ pane, zone: zones[index] }))
  }
  const byId = new Map(layout.zones.map((zone) => [zone.id, zone]))
  const taken = new Set<string>()
  const slots: RemoteSlot[] = []
  for (const pane of workspace.panes) {
    const zone = byId.get(layout.assign[pane.id] ?? '')
    if (!zone || taken.has(zone.id)) continue
    taken.add(zone.id)
    slots.push({ pane, zone })
  }
  // A layout that places nothing is no layout: fall back rather than show a blank canvas.
  if (slots.length === 0 && workspace.panes.length > 0) {
    const zones = evenZones(workspace.panes.length)
    return workspace.panes.map((pane, index) => ({ pane, zone: zones[index] }))
  }
  return slots
}

/** A pasted pairing key as main expects it: whitespace dropped, lowercased. */
export function normalizePairingKey(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

/** A pairing key is 32 bytes of hex. */
export function isPairingKey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}
