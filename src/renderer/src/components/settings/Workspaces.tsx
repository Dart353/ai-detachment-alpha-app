import { useEffect, useState, type JSX } from 'react'
import { Button, Toggle } from '../ui'
import { useApp } from '../../store/app'
import { SettingRow } from './SettingRow'
import './settings.css'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** `"2h ago"` — how long ago a workspace was closed, never blank. */
function ago(at: number, now: number): string {
  const age = Math.max(0, now - at)
  if (age < MINUTE_MS) return 'just now'
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`
  return `${Math.floor(age / DAY_MS)}d ago`
}

/** `/home/me/dev/api` → `~/dev/api`, so the path reads as a place. */
function shorten(path: string, home: string): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  if (rest && rest[0] !== '/' && rest[0] !== '\\') return path
  return `~${rest}`
}

export default function Workspaces(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const updateSettings = useApp((state) => state.updateSettings)
  const archive = useApp((state) => state.archive)
  const deleteArchiveEntry = useApp((state) => state.deleteArchiveEntry)
  const recents = useApp((state) => state.recents)
  const clearRecents = useApp((state) => state.clearRecents)

  const [home, setHome] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const now = Date.now()

  useEffect(() => {
    let live = true
    void window.api?.homeDir().then((dir) => {
      if (live) setHome(dir)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <>
      <div className="ada-set-title">Workspaces</div>
      <div className="ada-set-sub">
        What happens when you reopen a folder, and what is still waiting to be reopened.
      </div>

      <div className="ada-set-cards">
        <div className="ada-set-card">
          <SettingRow
            label="Restore archived workspaces automatically"
            description="Skip the preview and bring back panes when you reopen a folder."
          >
            <Toggle
              checked={settings.restoreArchivesAutomatically}
              ariaLabel="Restore archived workspaces automatically"
              onChange={(checked) => updateSettings({ restoreArchivesAutomatically: checked })}
            />
          </SettingRow>
        </div>

        <div className="ada-set-card">
          <div className="ada-set-card-head">
            <span className="ada-set-card-title">Archived</span>
          </div>
          {archive.length === 0 ? (
            <div className="ada-set-list-empty">Nothing archived</div>
          ) : (
            <div className="ada-set-list">
              {archive.map((entry) => (
                <div key={entry.key} className="ada-set-item ada-set-item--active">
                  <div>
                    <div className="ada-set-item-name">{entry.name}</div>
                    <div className="ada-set-mono">{shorten(entry.rootDir, home)}</div>
                  </div>
                  <span className="ada-set-card-spacer" />
                  <span className="ada-set-item-meta">
                    closed {ago(entry.archivedAt, now)} · {entry.panes.length}{' '}
                    {entry.panes.length === 1 ? 'pane' : 'panes'}
                  </span>
                  {confirmDelete === entry.key ? (
                    <span className="ada-set-confirm">
                      Delete?
                      <Button
                        size="sm"
                        variant="ghost"
                        danger
                        onClick={() => {
                          setConfirmDelete(null)
                          deleteArchiveEntry(entry.key)
                        }}
                      >
                        Yes
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        No
                      </Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(entry.key)}>
                      Delete
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ada-set-card">
          <div className="ada-set-card-head">
            <span className="ada-set-card-title">Recent folders</span>
            <span className="ada-set-card-spacer" />
            <Button size="sm" disabled={recents.length === 0} onClick={clearRecents}>
              Clear
            </Button>
          </div>
          {recents.length === 0 ? (
            <div className="ada-set-list-empty">No recent folders</div>
          ) : (
            <div className="ada-set-list">
              {recents.map((recent) => (
                <div key={recent.rootDir} className="ada-set-item">
                  <span className="ada-set-item-name">{recent.name}</span>
                  <span className="ada-set-card-spacer" />
                  <span className="ada-set-mono">{shorten(recent.rootDir, home)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
