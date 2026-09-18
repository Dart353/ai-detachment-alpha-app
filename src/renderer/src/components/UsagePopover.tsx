import { Fragment, useMemo, type JSX, type RefObject } from 'react'
import { Meter, Popover, Toggle } from './ui'
import { useNow } from '../hooks/useUsage'
import { selectActiveWorkspace, useApp } from '../store/app'
import { useRuntime } from '../store/runtime'
import {
  SESSION_WINDOW_KEY,
  capProjectionLabel,
  resetLabel,
  rowsBySession,
  sortWindows,
  timeLeft,
  toneFor,
  updatedAgo,
  type SessionUsageRow,
  type UsagePaneRef,
  type UsageTone
} from '../lib/usageMath'
import type { UsageSnapshot, UsageWindow } from '../../../shared/types'
import './UsagePopover.css'

export interface UsagePopoverProps {
  open: boolean
  anchorRef: RefObject<HTMLButtonElement>
  onClose: () => void
}

/** Width the design gives the surface. */
const WIDTH = 352

/** The countdowns are live while the surface is up, and paused while it is not. */
const TICK_MS = 1000

/** A window that has nothing left to give reads as its reset, not its rate. */
const FULL_PCT = 100

/**
 * The usage popover (design README 4a): every limit window the plan reports,
 * then who in this app spent the current one.
 */
export default function UsagePopover({ open, anchorRef, onClose }: UsagePopoverProps): JSX.Element {
  const usage = useRuntime((state) => state.usage)
  const now = useNow(open ? TICK_MS : 0)
  const warnEnabled = useApp((state) => state.settings.warnEnabled)
  const warnAtPct = useApp((state) => state.settings.warnAtPct)
  const updateSettings = useApp((state) => state.updateSettings)
  const rows = useSessionRows(usage)

  const windows = usage ? sortWindows(usage.windows) : []

  return (
    <Popover
      open={open}
      anchorRef={anchorRef}
      placement="bottom-end"
      width={WIDTH}
      onClose={onClose}
      className="ada-usage-pop"
      ariaLabel="Usage"
    >
      <div className="ada-usage-head">
        <span className="ada-usage-title">Usage</span>
        <span className="ada-usage-meta">
          {[usage?.plan, usage ? updatedAgo(usage.updatedAt, now) : null]
            .filter((part): part is string => Boolean(part))
            .join(' · ')}
        </span>
      </div>

      {windows.map((usageWindow, index) => (
        <Fragment key={usageWindow.key}>
          {index === 1 && <div className="ada-usage-divider" />}
          <WindowBlock usageWindow={usageWindow} first={index === 0} now={now} />
        </Fragment>
      ))}

      <div className="ada-usage-divider" />

      <div className="ada-usage-caption">THIS WINDOW, BY SESSION</div>
      {rows.length === 0 ? (
        <div className="ada-usage-empty">No Claude sessions in this window</div>
      ) : (
        <div className="ada-usage-rows">
          {rows.map((row) => (
            <SessionRow key={row.paneId} row={row} />
          ))}
        </div>
      )}

      <div className="ada-usage-foot">
        <Toggle
          checked={warnEnabled}
          onChange={(checked) => updateSettings({ warnEnabled: checked })}
          label={`Warn me at ${warnAtPct}%`}
        />
        {/* The history screen is not built yet; the affordance is here so the
            popover's shape is final, but it says so rather than pretending. */}
        <button type="button" className="ada-usage-history" disabled title="Coming later">
          Full history →
        </button>
      </div>
    </Popover>
  )
}

/* === one limit window ======================================================= */

interface WindowBlockProps {
  usageWindow: UsageWindow
  /** The block right under the header, which sets its own rhythm. */
  first: boolean
  now: number
}

function WindowBlock({ usageWindow, first, now }: WindowBlockProps): JSX.Element {
  const isSession = usageWindow.key === SESSION_WINDOW_KEY
  const tone = toneFor(usageWindow.pct, isSession ? 'session' : 'background')
  const left = timeLeft(usageWindow.resetsAt, now)
  const note = windowNote(usageWindow, now)

  const classes = ['ada-usage-block']
  if (first) classes.push('ada-usage-block--first')

  return (
    <div className={classes.join(' ')}>
      <div className="ada-usage-block-head">
        <span className="ada-usage-block-label">{usageWindow.label}</span>
        <span className={`ada-usage-pct ada-usage-pct--${pctTone(tone, isSession)}`}>
          {usageWindow.pct}% used
        </span>
      </div>
      <Meter
        pct={usageWindow.pct}
        tone={isSession ? 'accent' : 'neutral'}
        height={6}
        label={usageWindow.label}
      />
      <div className="ada-usage-block-foot">
        <span className={note.warn ? 'ada-usage-note--warn' : undefined}>{note.text}</span>
        {left && <span className="ada-usage-left">{left} left</span>}
      </div>
    </div>
  )
}

/** The left-hand line under a meter: what the window is, or what it is about to do. */
function windowNote(usageWindow: UsageWindow, now: number): { text: string; warn: boolean } {
  const reset = resetLabel(usageWindow.resetsAt, now)
  // Spent out: the rate no longer matters, only when it comes back.
  if (usageWindow.pct >= FULL_PCT) return { text: reset, warn: true }
  const projection = capProjectionLabel(usageWindow.projectedCapAt, now)
  if (projection) return { text: projection, warn: true }
  if (usageWindow.key === SESSION_WINDOW_KEY) {
    return { text: reset ? `5-hour window · ${reset}` : '5-hour window', warn: false }
  }
  return { text: reset, warn: false }
}

/**
 * The percent readout follows the meter, except that an under-threshold session
 * window reads in the accent's tinted text rather than the accent itself — the
 * full-strength orange is for the bar.
 */
function pctTone(tone: UsageTone, isSession: boolean): UsageTone {
  if (tone === 'warn') return 'warn'
  return isSession ? 'accent' : 'neutral'
}

/* === this window, by session ================================================ */

function SessionRow({ row }: { row: SessionUsageRow }): JSX.Element {
  const focusedPaneId = useApp((state) => selectActiveWorkspace(state)?.focusedPaneId ?? null)
  const focused = row.paneId === focusedPaneId

  return (
    <div className="ada-usage-row">
      <span className={`ada-usage-dot ada-usage-dot--${row.status}`} aria-hidden="true" />
      <span className="ada-usage-row-name" title={row.name}>
        {row.name}
      </span>
      <span className="ada-usage-row-track" aria-hidden="true">
        <span
          className={`ada-usage-row-fill ada-usage-row-fill--${focused ? 'accent' : 'neutral'}`}
          style={{ width: `${row.barPct}%` }}
        />
      </span>
      <span className="ada-usage-row-pct">{row.pctOfWindow}%</span>
    </div>
  )
}

/**
 * The by-session rows for every Claude pane the app has open — spend belongs to
 * the session that made it, which is not always in the workspace on screen.
 */
function useSessionRows(usage: UsageSnapshot | null): SessionUsageRow[] {
  const workspaces = useApp((state) => state.workspaces)
  const sessions = useRuntime((state) => state.sessions)
  const status = useRuntime((state) => state.status)

  const panes = useMemo<UsagePaneRef[]>(
    () =>
      workspaces.flatMap((workspace) =>
        workspace.panes
          .filter((pane) => pane.kind === 'claude')
          .map((pane) => ({
            paneId: pane.id,
            name: pane.name,
            status: status[pane.id] ?? 'idle',
            sessionId: pane.sessionId ?? sessions[pane.id]?.sessionId ?? undefined
          }))
      ),
    [workspaces, sessions, status]
  )

  return useMemo(() => rowsBySession(usage, panes), [usage, panes])
}
