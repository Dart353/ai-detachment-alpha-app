/**
 * Small display helpers shared by the Remote view's components, kept apart so
 * the sidebar and the dialogs it mounts do not import each other.
 */
import type { RemoteMachine } from '../../../../shared/types'
import type { PaneStatus } from '../../../../shared/relayProtocol'

/** What the user calls a machine: their pairing label, else its own name. */
export function machineName(machine: RemoteMachine): string {
  return machine.label || machine.name || 'machine'
}

/** The sidebar's dot classes have no `starting`; a fresh agent reads as working. */
export function dotStatus(status: PaneStatus): Exclude<PaneStatus, 'starting'> {
  return status === 'starting' ? 'working' : status
}
