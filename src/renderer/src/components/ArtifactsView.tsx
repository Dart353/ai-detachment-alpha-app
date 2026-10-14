import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Copy, ExternalLink, FolderOpen, RefreshCw } from 'lucide-react'
import type { ArtifactRecord } from '../../../shared/types'
import { Button, TextInput } from './ui'
import { useApp } from '../store/app'
import { baseName } from '../lib/ids'
import { relativeTime } from '../lib/relativeTime'
import { revealLabel } from './paneMenu'
import './ArtifactsView.css'

/** Icon size (design: 12–14px, muted grey). */
const ICON = 13

/** Does an artifact match every word of the filter, across what the row shows? */
function matches(artifact: ArtifactRecord, query: string): boolean {
  const haystack = [artifact.title, artifact.description, artifact.cwd, artifact.url]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

/**
 * Every claude.ai page Claude Code published from this machine, newest first —
 * read out of the session transcripts in main (src/main/artifacts.ts). Clicking a
 * row opens it in the browser. Escape or Done goes back to the grid, as Settings does.
 */
export default function ArtifactsView(): JSX.Element {
  const setView = useApp((state) => state.setView)
  const pushToast = useApp((state) => state.pushToast)

  const [artifacts, setArtifacts] = useState<ArtifactRecord[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setArtifacts(await window.api.listArtifacts())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"]')) return
      setView('grid')
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [setView])

  const shown = useMemo(
    () => (artifacts ?? []).filter((artifact) => matches(artifact, query)),
    [artifacts, query]
  )
  const now = Date.now()

  return (
    <div className="ada-artifacts">
      <div className="ada-artifacts-column">
        <div className="ada-artifacts-head">
          <div>
            <div className="ada-artifacts-title">Artifacts</div>
            <div className="ada-artifacts-sub">
              Pages Claude published to claude.ai from this machine&apos;s Claude Code sessions,
              newest first.
            </div>
          </div>
          <span className="ada-artifacts-spacer" />
          <Button variant="outline" onClick={() => setView('grid')}>
            Done
          </Button>
        </div>

        <div className="ada-artifacts-tools">
          <TextInput
            value={query}
            placeholder="Filter by title, project or description"
            aria-label="Filter artifacts"
            autoFocus
            onChange={setQuery}
            onEscape={() => setQuery('')}
          />
          <Button
            variant="icon"
            aria-label="Refresh"
            title="Refresh"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={ICON} className={loading ? 'ada-artifacts-spin' : undefined} />
          </Button>
        </div>

        {artifacts === null ? (
          <div className="ada-artifacts-empty">Reading transcripts…</div>
        ) : artifacts.length === 0 ? (
          <div className="ada-artifacts-empty">
            No artifacts yet. When Claude publishes a page from a session on this machine, it
            shows up here.
          </div>
        ) : shown.length === 0 ? (
          <div className="ada-artifacts-empty">Nothing matches “{query}”.</div>
        ) : (
          <div className="ada-artifacts-list">
            {shown.map((artifact) => (
              <div
                key={artifact.url}
                className="ada-artifact"
                role="button"
                tabIndex={0}
                title={artifact.url}
                onClick={() => window.api.openExternal(artifact.url)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') window.api.openExternal(artifact.url)
                }}
              >
                <div className="ada-artifact-text">
                  <div className="ada-artifact-title">{artifact.title}</div>
                  {artifact.description && (
                    <div className="ada-artifact-desc">{artifact.description}</div>
                  )}
                  <div className="ada-artifact-meta">
                    {artifact.cwd && (
                      <span className="ada-artifact-project" title={artifact.cwd}>
                        {baseName(artifact.cwd)}
                      </span>
                    )}
                    {artifact.version !== null && <span>v{artifact.version}</span>}
                    <span title={new Date(artifact.lastPublishedAt).toLocaleString()}>
                      {relativeTime(artifact.lastPublishedAt, now)}
                    </span>
                  </div>
                </div>
                <div className="ada-artifact-actions" onClick={(event) => event.stopPropagation()}>
                  <Button
                    variant="icon"
                    aria-label="Open in browser"
                    title="Open in browser"
                    onClick={() => window.api.openExternal(artifact.url)}
                  >
                    <ExternalLink size={ICON} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label="Copy link"
                    title="Copy link"
                    onClick={() => {
                      window.api.copyText(artifact.url)
                      pushToast('Link copied.')
                    }}
                  >
                    <Copy size={ICON} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={revealLabel(window.api.platform)}
                    title={
                      artifact.fileExists
                        ? `${revealLabel(window.api.platform)}: ${artifact.filePath}`
                        : 'The source file is no longer on this machine'
                    }
                    disabled={!artifact.fileExists || !artifact.filePath}
                    onClick={() => {
                      if (artifact.filePath) void window.api.revealPath(artifact.filePath)
                    }}
                  >
                    <FolderOpen size={ICON} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
