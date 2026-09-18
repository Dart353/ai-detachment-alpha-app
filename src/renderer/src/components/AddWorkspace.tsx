import { useEffect, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { FolderOpen } from 'lucide-react'
import Logo from './Logo'
import { LayoutWire } from './LayoutPicker'
import { Button, ContextMenu, TextInput, type MenuItem } from './ui'
import { useApp, type PaneInit } from '../store/app'
import { archiveKey, entryMatchesRoot } from '../lib/archive'
import { baseName } from '../lib/ids'
import { ZONE_PRESETS, type Rect } from '../lib/zones'
import './AddWorkspace.css'

/**
 * The Add workspace screen: a folder, a name, a starting layout and what runs
 * in each of its zones. Nothing exists until "Create workspace" — the store's
 * createWorkspace turns the whole form into one workspace in one step, so a
 * half-filled form abandoned with Cancel leaves no trace.
 */

/** The starting layouts on offer, in the order the mockup shows them. */
const STARTING_PRESETS = ['single', 'cols-2', 'main-side', 'grid-2x2', 'main-2'] as const

/** What a zone may start with. `null` is an empty slot. */
const PANE_CHOICES: { label: string; init: PaneInit | null; glyph?: string }[] = [
  { label: 'Empty', init: null },
  { label: 'Claude Code', init: { kind: 'claude' }, glyph: '✻' },
  { label: 'Claude Code · plan mode', init: { kind: 'claude', planMode: true }, glyph: '✻' },
  { label: 'Terminal', init: { kind: 'terminal' } }
]

function choiceLabel(init: PaneInit | null): string {
  if (!init) return 'Empty'
  if (init.kind === 'claude') return init.planMode ? 'Claude Code · plan' : 'Claude Code'
  return 'Terminal'
}

/** The gap between zone tiles on the panes canvas, in canvas pixels. */
const ZONE_GAP = 6

function zoneStyle(rect: Rect): { left: string; top: string; width: string; height: string } {
  return {
    left: `calc(${rect.x}% + ${ZONE_GAP / 2}px)`,
    top: `calc(${rect.y}% + ${ZONE_GAP / 2}px)`,
    width: `calc(${rect.w}% - ${ZONE_GAP}px)`,
    height: `calc(${rect.h}% - ${ZONE_GAP}px)`
  }
}

export default function AddWorkspace(): JSX.Element {
  const initialRoot = useApp((state) => state.addWorkspaceRoot)
  const workspaces = useApp((state) => state.workspaces)
  const archive = useApp((state) => state.archive)
  const createWorkspace = useApp((state) => state.createWorkspace)
  const cancelAddWorkspace = useApp((state) => state.cancelAddWorkspace)
  const openWorkspace = useApp((state) => state.openWorkspace)

  const [rootDir, setRootDir] = useState(initialRoot ?? '')
  const [name, setName] = useState('')
  const [presetId, setPresetId] = useState<string>(STARTING_PRESETS[0])
  const [panes, setPanes] = useState<(PaneInit | null)[]>([])
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)

  const preset = ZONE_PRESETS.find((candidate) => candidate.id === presetId) ?? ZONE_PRESETS[0]

  // Escape is Cancel — never a keystroke the hidden grid's terminal should hear.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (menu) setMenu(null)
      else cancelAddWorkspace()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cancelAddWorkspace, menu])

  const chooseFolder = async (): Promise<void> => {
    const dir = await window.api?.pickDir()
    if (dir) setRootDir(dir)
  }

  const alreadyOpen = rootDir
    ? workspaces.find((workspace) => archiveKey(workspace.rootDir) === archiveKey(rootDir))
    : undefined
  const archived = rootDir && !alreadyOpen
    ? archive.find((entry) => entryMatchesRoot(entry, rootDir))
    : undefined

  const canCreate = rootDir.length > 0
  const create = (): void => {
    if (!canCreate) return
    createWorkspace({ rootDir, name, presetId, panes })
  }

  const status = !rootDir
    ? 'Choose a folder to create a new workspace'
    : alreadyOpen
      ? `${alreadyOpen.name} is already open for this folder — Create switches to it`
      : archived
        ? 'An earlier workspace for this folder is archived; Create starts fresh'
        : `Creates “${name.trim() || baseName(rootDir)}” with ${preset.label.toLowerCase()} zones`

  const pickPane = (index: number, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ index, x: rect.left + rect.width / 2 - 100, y: rect.top + rect.height / 2 })
  }

  const menuItems = (index: number): MenuItem[] =>
    PANE_CHOICES.map((choice) => ({
      label: choice.label,
      icon: choice.glyph ? <span className="ada-addws-glyph">{choice.glyph}</span> : undefined,
      onClick: () =>
        setPanes((current) => {
          const next = [...current]
          next[index] = choice.init
          return next
        })
    }))

  return (
    <div className="ada-addws">
      <div className="ada-addws-scroll">
        <div className="ada-addws-column">
          <div className="ada-addws-mark">
            <Logo width={40} height={24} strokeWidth={2.4} />
          </div>
          <h1 className="ada-addws-title">Add workspace</h1>

          <div className="ada-addws-label">FOLDER</div>
          <div className="ada-addws-folder">
            <TextInput
              className="ada-addws-folder-field"
              mono
              value={rootDir}
              placeholder="No folder chosen"
              onChange={setRootDir}
              onEnter={create}
              aria-label="Workspace folder"
            />
            <Button
              variant="primary"
              icon={<FolderOpen size={13} />}
              onClick={() => void chooseFolder()}
            >
              Choose…
            </Button>
          </div>
          <div className="ada-addws-hint">
            A workspace is a project folder; terminal panes and agents run inside it.
            {archived && (
              <>
                {' '}
                <button
                  type="button"
                  className="ada-addws-link"
                  onClick={() => openWorkspace(rootDir)}
                >
                  Restore the archived one instead
                </button>
              </>
            )}
          </div>

          <div className="ada-addws-label">NAME</div>
          <TextInput
            value={name}
            placeholder={rootDir ? baseName(rootDir) : 'Workspace name'}
            onChange={setName}
            onEnter={create}
            aria-label="Workspace name"
          />

          <div className="ada-addws-rule" />

          <div className="ada-addws-label">STARTING LAYOUT</div>
          <div className="ada-addws-presets">
            {STARTING_PRESETS.map((id) => {
              const candidate = ZONE_PRESETS.find((entry) => entry.id === id)
              if (!candidate) return null
              const selected = candidate.id === presetId
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className={`ada-layout-tile${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setPresetId(candidate.id)
                    // choices are per zone index; a smaller shape drops the extras
                    setPanes((current) => current.slice(0, candidate.rects.length))
                  }}
                >
                  <LayoutWire rects={candidate.rects} />
                  <span className="ada-layout-label">{candidate.label}</span>
                </button>
              )
            })}
          </div>

          <div className="ada-addws-panes">
            <div className="ada-addws-label ada-addws-label--tight">PANES</div>
            <div className="ada-addws-hint ada-addws-hint--tight">
              Click a pane to choose which agent starts in it. Empty panes stay open slots.
            </div>
            <div className="ada-addws-canvas">
              {preset.rects.map((rect, index) => {
                const init = panes[index] ?? null
                return (
                  <button
                    key={`${rect.x}:${rect.y}:${rect.w}:${rect.h}`}
                    type="button"
                    className={`ada-addws-zone${init ? ' is-filled' : ''}`}
                    style={zoneStyle(rect)}
                    title="Choose what starts in this pane"
                    onClick={(event) => pickPane(index, event)}
                  >
                    {init?.kind === 'claude' && (
                      <span className="ada-addws-glyph" aria-hidden>
                        ✻
                      </span>
                    )}
                    {choiceLabel(init)}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="ada-addws-footer">
        <span className="ada-addws-status">{status}</span>
        <Button variant="ghost" onClick={cancelAddWorkspace}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canCreate} onClick={create}>
          Create workspace
        </Button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={230}
          items={menuItems(menu.index)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
