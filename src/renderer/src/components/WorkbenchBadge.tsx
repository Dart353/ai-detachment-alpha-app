import type { JSX } from 'react'
import { useRuntime } from '../store/runtime'
import { wantingSections } from '../lib/workbench'
import './WorkbenchBadge.css'

export interface WorkbenchBadgeProps {
  rootDir: string
  /** Just the number, for the tight title-bar tabs. */
  compact?: boolean
}

/**
 * How many tasks on a workspace's workbench are waiting on the user. Nothing
 * at all when none are: a quiet workspace shows no chip.
 */
export function WorkbenchBadge({ rootDir, compact }: WorkbenchBadgeProps): JSX.Element | null {
  // A number, so a page rewrite that leaves the count alone re-renders nothing.
  const count = useRuntime((state) => wantingSections(state.workbench[rootDir]).length)
  return <NeedsYouChip count={count} compact={compact} />
}

/** The chip itself, for a count from anywhere — a local page or a remote feed. */
export function NeedsYouChip({ count, compact }: { count: number; compact?: boolean }): JSX.Element | null {
  if (count === 0) return null
  const label = `${count} ${count === 1 ? 'task needs' : 'tasks need'} you on the workbench`
  return (
    <span className="ada-wb-badge" title={label} aria-label={label}>
      {compact ? count : `${count} needs you`}
    </span>
  )
}

export default WorkbenchBadge
