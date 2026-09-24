import { useEffect, useRef, useState, type JSX } from 'react'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import ExplorerPanel from './components/ExplorerPanel'
import Grid from './components/Grid'
import ZoneEditor from './components/ZoneEditor'
import FirstRun from './components/FirstRun'
import AddWorkspace from './components/AddWorkspace'
import SettingsView from './components/SettingsView'
import RestorePreview from './components/RestorePreview'
import { Toasts } from './components/ui'
import { useStatusEngine } from './hooks/useStatusEngine'
import { useHostPublisher } from './hooks/useHostPublisher'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { selectActiveWorkspace, useApp } from './store/app'
import { hydrate, startPersistence } from './store/persist'
import './App.css'

/**
 * The app shell: the window frame, the title bar, and the one rule everything
 * else is arranged around — a grid, once mounted, is never unmounted. Visiting
 * Settings or the zone editor hides the grids, it does not tear them down,
 * because unmounting an xterm instance throws away its scrollback and orphans
 * the pty feeding it.
 */
export default function App(): JSX.Element {
  const hydrated = useApp((state) => state.hydrated)
  const view = useApp((state) => state.view)
  const zoneEditorOpen = useApp((state) => state.zoneEditorOpen)
  const workspaces = useApp((state) => state.workspaces)
  const activeWorkspaceId = useApp((state) => state.activeWorkspaceId)
  const activeWorkspace = useApp(selectActiveWorkspace)
  const toasts = useApp((state) => state.toasts)
  const dismissToast = useApp((state) => state.dismissToast)
  const setZoneEditorOpen = useApp((state) => state.setZoneEditorOpen)

  const [maximized, setMaximized] = useState(false)
  // StrictMode mounts, unmounts and remounts in development; hydrating twice
  // would race two reads of the same file against one another.
  const booted = useRef(false)

  useStatusEngine()
  useHostPublisher()
  useGlobalShortcuts()

  useEffect(() => {
    if (booted.current) return undefined
    booted.current = true
    let stop: (() => void) | null = null
    void hydrate().then(() => {
      stop = startPersistence()
    })
    return () => {
      stop?.()
    }
  }, [])

  useEffect(() => window.api?.onWinMaximized(setMaximized), [])

  const isMac = typeof window !== 'undefined' && window.api?.platform === 'darwin'
  const classes = ['ada-app']
  // The frame is ours to draw only where the window is actually detached from
  // the screen edges: macOS rounds its own, and a maximized window has no edge.
  if (!isMac && !maximized) classes.push('ada-app--framed')

  if (!hydrated) return <div className={classes.join(' ')} />

  const titlebarVariant =
    view === 'settings'
      ? 'settings'
      : view === 'addWorkspace'
        ? 'addWorkspace'
        : view === 'firstRun' || zoneEditorOpen
          ? 'minimal'
          : 'full'

  return (
    <div className={classes.join(' ')}>
      <Titlebar variant={titlebarVariant} />

      <main className="ada-app-main">
        <div className={`ada-app-body${view === 'grid' ? '' : ' ada-app-body--hidden'}`}>
          <Sidebar />
          {activeWorkspace?.explorer.open && <ExplorerPanel workspaceId={activeWorkspace.id} />}
          <div className="ada-app-grids">
            {/* Every workspace's grid is mounted at once and the inactive ones are
                merely hidden: this is what keeps terminal scrollback (and the
                xterm instances themselves) alive across a workspace switch. */}
            {workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspaceId
              return (
                <div
                  key={workspace.id}
                  className={`ada-app-grid${active ? '' : ' ada-app-grid--hidden'}`}
                >
                  <Grid workspaceId={workspace.id} active={active} />
                </div>
              )
            })}
          </div>
        </div>

        {view === 'firstRun' && (
          <div className="ada-app-layer">
            <FirstRun />
          </div>
        )}

        {view === 'addWorkspace' && (
          <div className="ada-app-layer">
            <AddWorkspace />
          </div>
        )}

        {view === 'settings' && (
          <div className="ada-app-layer">
            <SettingsView />
          </div>
        )}

        {view === 'grid' && zoneEditorOpen && activeWorkspace && (
          <div className="ada-app-layer">
            <ZoneEditor
              workspaceId={activeWorkspace.id}
              onClose={() => setZoneEditorOpen(false)}
            />
          </div>
        )}
      </main>

      <RestorePreview />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
