/**
 * The restore prompt: reopening a folder whose panes were archived asks what
 * this workspace should become before anything is created.
 *
 * It shows the archive rather than describing it — the zone layout as the same
 * wireframe the layout picker draws, with each zone labelled by the pane that
 * sat in it — because "4 panes" is not enough to recognize a workspace by.
 *
 * Three ways out, and all of them go through `confirmRestore` exactly once:
 * Restore brings the panes back (Claude panes keep their session ids, so they
 * resume), Start empty opens a fresh workspace and leaves the archive standing
 * for next time, and Cancel — including Escape and a backdrop click — creates
 * nothing and consumes nothing.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { FileText, Server, SquareTerminal } from 'lucide-react'
import type { Pane, Zone } from '../../../shared/types'
import { useApp } from '../store/app'
import { relativeTime } from '../lib/relativeTime'
import { Button, Modal } from './ui'
import './RestorePreview.css'

/** Dialog width, and the wireframe's gap between zones (as the layout picker). */
const WIDTH = 460
const ZONE_GAP = 3

/** Longest path the mono line shows before it is middle-ellipsized. */
const PATH_CHARS = 52

/** `/home/me/dev/api` → `~/dev/api`, so the line reads as a place, not a path. */
function shortenHome(path: string, home: string): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  if (rest && rest[0] !== '/' && rest[0] !== '\\') return path
  return `~${rest}`
}

/** Drop the middle, not the tail: the last folders are what identify a path. */
function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** One wireframe rectangle, inset by the gap the way the layout tiles are. */
function zoneStyle(zone: Zone): { left: string; top: string; width: string; height: string } {
  return {
    left: `calc(${zone.x}% + ${ZONE_GAP / 2}px)`,
    top: `calc(${zone.y}% + ${ZONE_GAP / 2}px)`,
    width: `calc(${zone.w}% - ${ZONE_GAP}px)`,
    height: `calc(${zone.h}% - ${ZONE_GAP}px)`
  }
}

/** What the pane list says a pane is, under its name. */
function kindLabel(pane: Pane): string {
  switch (pane.kind) {
    case 'claude':
      return pane.sessionId ? 'Claude Code · resumes session' : 'Claude Code'
    case 'terminal':
      return 'Terminal'
    case 'ssh':
      return pane.sshHost ? `ssh · ${pane.sshHost}` : 'ssh'
    case 'viewer':
      return 'File'
  }
}

/** The kind's mark: lucide everywhere, except Claude Code's own ✻. */
function PaneGlyph({ pane }: { pane: Pane }): JSX.Element {
  if (pane.kind === 'claude') {
    return (
      <span className="ada-restore-claude" aria-hidden>
        ✻
      </span>
    )
  }
  const size = 13
  if (pane.kind === 'terminal') return <SquareTerminal size={size} aria-hidden />
  if (pane.kind === 'ssh') return <Server size={size} aria-hidden />
  return <FileText size={size} aria-hidden />
}

export default function RestorePreview(): JSX.Element | null {
  const pendingRestore = useApp((state) => state.pendingRestore)
  const confirmRestore = useApp((state) => state.confirmRestore)
  const [home, setHome] = useState('')
  const restoreRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    void window.api?.homeDir().then((dir) => {
      if (live) setHome(dir)
    })
    return () => {
      live = false
    }
  }, [])

  // The dialog opens on the safe-but-useful default, so Enter restores. Runs
  // after Modal's own "focus the first control" effect, which would land on
  // Cancel.
  useEffect(() => {
    if (pendingRestore) restoreRef.current?.focus()
  }, [pendingRestore])

  if (!pendingRestore) return null

  const { entry } = pendingRestore
  const panes = entry.panes
  const zoneOf = entry.layout.assign
  const paneInZone = new Map<string, Pane>()
  for (const pane of panes) {
    const zoneId = zoneOf[pane.id]
    if (zoneId && !paneInZone.has(zoneId)) paneInZone.set(zoneId, pane)
  }

  const fullPath = entry.rootDir
  const displayPath = middleEllipsis(shortenHome(fullPath, home), PATH_CHARS)
  const closed = relativeTime(entry.archivedAt, Date.now())
  const paneCount = `${panes.length} ${panes.length === 1 ? 'pane' : 'panes'}`
  const resumes = panes.some((pane) => pane.sessionId)

  return (
    <Modal
      open
      title={`Restore ${entry.name}?`}
      width={WIDTH}
      onClose={() => confirmRestore('cancel')}
      className="ada-restore"
      footer={
        <>
          <Button variant="ghost" onClick={() => confirmRestore('cancel')}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => confirmRestore('empty')}>
            Start empty
          </Button>
          <Button ref={restoreRef} variant="primary" onClick={() => confirmRestore('restore')}>
            Restore
          </Button>
        </>
      }
    >
      <div className="ada-restore-path" title={fullPath}>
        {displayPath}
      </div>
      <div className="ada-restore-meta">
        Closed {closed} · {paneCount}
      </div>

      <div className="ada-restore-wire" aria-hidden>
        {entry.layout.zones.map((zone) => (
          <span key={zone.id} className="ada-restore-zone" style={zoneStyle(zone)}>
            <span className="ada-restore-zone-name">{paneInZone.get(zone.id)?.name ?? ''}</span>
          </span>
        ))}
      </div>

      <ul className="ada-restore-panes">
        {panes.map((pane) => (
          <li key={pane.id} className="ada-restore-pane">
            <span className="ada-restore-glyph">
              <PaneGlyph pane={pane} />
            </span>
            <span className="ada-restore-name">{pane.name}</span>
            <span className="ada-restore-kind">{kindLabel(pane)}</span>
          </li>
        ))}
      </ul>

      {resumes && (
        <div className="ada-restore-note">Claude panes resume their previous sessions.</div>
      )}
    </Modal>
  )
}
