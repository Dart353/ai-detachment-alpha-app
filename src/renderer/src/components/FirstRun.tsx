import { useEffect, useState, type JSX } from 'react'
import Logo from './Logo'
import { Button } from './ui'
import { useApp } from '../store/app'
import './FirstRun.css'

/** How many folders the first-run list offers before it stops being a shortcut. */
const MAX_ROWS = 6

/** `/home/me/dev/api` → `~/dev/api`, so the column reads as a place, not a path. */
function shorten(path: string, home: string): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  if (rest && rest[0] !== '/' && rest[0] !== '\\') return path
  return `~${rest}`
}

/**
 * The empty state (design README 1e): what the app is, what a workspace is, and
 * the two ways in — pick a folder, or drop straight into a shell at home.
 */
export default function FirstRun(): JSX.Element {
  const recents = useApp((state) => state.recents)
  const openWorkspace = useApp((state) => state.openWorkspace)
  const addPane = useApp((state) => state.addPane)
  const [home, setHome] = useState('')

  useEffect(() => {
    let live = true
    void window.api?.homeDir().then((dir) => {
      if (live) setHome(dir)
    })
    return () => {
      live = false
    }
  }, [])

  const openFolder = async (): Promise<void> => {
    const dir = await window.api?.pickDir()
    if (dir) openWorkspace(dir)
  }

  const quickTerminal = async (): Promise<void> => {
    const dir = await window.api?.homeDir()
    if (!dir) return
    openWorkspace(dir)
    // openWorkspace decides which workspace this folder became (fresh, restored,
    // or a prompt that has not resolved yet); the store is the only honest source.
    const { activeWorkspaceId } = useApp.getState()
    if (activeWorkspaceId) addPane(activeWorkspaceId, { kind: 'terminal' })
  }

  const rows = recents.slice(0, MAX_ROWS)

  return (
    <div className="ada-firstrun">
      <Logo width={66} height={40} strokeWidth={2.6} />
      <div className="ada-firstrun-brand">AI DETACHMENT ALPHA</div>
      <div className="ada-firstrun-headline">Open a folder to start</div>
      <div className="ada-firstrun-explainer">
        A workspace is a folder. Sessions you spawn inside it share its directory and survive tab
        switches.
      </div>
      <div className="ada-firstrun-actions">
        <Button variant="primary" size="lg" onClick={() => void openFolder()}>
          Open folder…
        </Button>
        <Button variant="outline" size="lg" onClick={() => void quickTerminal()}>
          Quick terminal
        </Button>
      </div>

      {rows.length > 0 && (
        <div className="ada-firstrun-recent">
          <div className="ada-firstrun-recent-label">RECENT</div>
          <div className="ada-firstrun-recent-list">
            {rows.map((recent) => (
              <button
                key={recent.rootDir}
                type="button"
                className="ada-firstrun-recent-row"
                onClick={() => openWorkspace(recent.rootDir)}
              >
                <span className="ada-firstrun-recent-caret">▸</span>
                <span className="ada-firstrun-recent-name">{recent.name}</span>
                <span className="ada-firstrun-recent-path">{shorten(recent.rootDir, home)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
