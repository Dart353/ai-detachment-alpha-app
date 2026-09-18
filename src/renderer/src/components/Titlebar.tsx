import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { Copy, FolderTree, LayoutGrid, Minus, PanelLeft, Settings, Square, X } from 'lucide-react'
import Logo from './Logo'
import WorkspaceTabs from './WorkspaceTabs'
import UsagePill from './UsagePill'
import LayoutPicker from './LayoutPicker'
import { Button } from './ui'
import { selectActiveWorkspace, useApp } from '../store/app'
import './Titlebar.css'

/**
 * Which chrome the bar carries.
 *   full     → the working screen: toggles, workspace tabs, usage, layout, settings
 *   minimal  → first run and the zone editor: the mark and the window controls
 *   settings → the mark, a centred "Settings" label, the window controls
 *   addWorkspace → the same shell, captioned "Add workspace"
 */
export type TitlebarVariant = 'full' | 'minimal' | 'settings' | 'addWorkspace'

export interface TitlebarProps {
  variant: TitlebarVariant
}

/** Icon size for every glyph in the bar (design: 12–14px, muted grey). */
const ICON = 13

/**
 * The frameless window's own title bar. The whole strip is a drag region and
 * every control inside it opts back out, which is the only way a custom bar can
 * both move the window and still be clickable.
 *
 * On macOS the native traffic lights own the left corner, so the custom controls
 * disappear and the bar reserves room for them instead.
 */
export default function Titlebar({ variant }: TitlebarProps): JSX.Element {
  const platform = typeof window !== 'undefined' ? window.api?.platform : undefined
  const isMac = platform === 'darwin'

  const sidebarCollapsed = useApp((state) => state.sidebarCollapsed)
  const toggleSidebar = useApp((state) => state.toggleSidebar)
  const setExplorer = useApp((state) => state.setExplorer)
  const setView = useApp((state) => state.setView)
  const setZoneEditorOpen = useApp((state) => state.setZoneEditorOpen)
  const workspace = useApp(selectActiveWorkspace)

  const [maximized, setMaximized] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  useEffect(() => window.api?.onWinMaximized(setMaximized), [])

  /** A double-click on the bar itself — never on a control — zooms the window. */
  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (isMac) return
    if ((event.target as HTMLElement).closest('.ada-nodrag')) return
    window.api?.winToggleMaximize()
  }

  const classes = ['ada-titlebar']
  if (isMac) classes.push('ada-titlebar--mac')

  const explorerOpen = workspace?.explorer.open === true

  return (
    <div className={classes.join(' ')} onDoubleClick={onDoubleClick}>
      <Logo width={24} height={16} />

      {variant === 'full' && (
        <>
          <Button
            className="ada-nodrag ada-titlebar-toggle"
            variant="icon"
            active={!sidebarCollapsed}
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            onClick={toggleSidebar}
          >
            <PanelLeft size={ICON} />
          </Button>
          <Button
            className="ada-nodrag ada-titlebar-toggle"
            variant="icon"
            active={explorerOpen}
            disabled={!workspace}
            aria-label="Toggle file explorer"
            title={workspace ? 'Toggle file explorer' : 'Open a workspace first'}
            onClick={() => {
              if (!workspace) return
              setExplorer(workspace.id, { open: !workspace.explorer.open })
            }}
          >
            <FolderTree size={ICON} />
          </Button>
          <WorkspaceTabs />
          <UsagePill />
          <Button
            ref={pickerAnchor}
            className="ada-nodrag ada-titlebar-wide"
            variant="icon"
            active={pickerOpen}
            aria-label="Layouts"
            title="Layouts"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <LayoutGrid size={ICON} />
          </Button>
          <LayoutPicker
            open={pickerOpen}
            anchorRef={pickerAnchor}
            onClose={() => setPickerOpen(false)}
            onEditZones={() => {
              setPickerOpen(false)
              setZoneEditorOpen(true)
            }}
          />
          <Button
            className="ada-nodrag ada-titlebar-wide"
            variant="icon"
            aria-label="Settings"
            title="Settings"
            onClick={() => setView('settings')}
          >
            <Settings size={ICON} />
          </Button>
        </>
      )}

      {variant === 'settings' && <div className="ada-titlebar-label">Settings</div>}
      {variant === 'addWorkspace' && <div className="ada-titlebar-label">Add workspace</div>}

      {variant === 'minimal' && <div className="ada-titlebar-spacer" />}

      {!isMac && (
        <>
          <div className="ada-titlebar-gap" />
          <div className="ada-titlebar-controls">
            <Button
              className="ada-nodrag ada-titlebar-winbtn"
              variant="icon"
              aria-label="Minimize"
              onClick={() => window.api?.winMinimize()}
            >
              <Minus size={ICON} />
            </Button>
            <Button
              className="ada-nodrag ada-titlebar-winbtn"
              variant="icon"
              aria-label={maximized ? 'Restore' : 'Maximize'}
              onClick={() => window.api?.winToggleMaximize()}
            >
              {maximized ? <Copy size={ICON} /> : <Square size={ICON} />}
            </Button>
            <Button
              className="ada-nodrag ada-titlebar-winbtn ada-titlebar-close"
              variant="icon"
              aria-label="Close"
              onClick={() => window.api?.winClose()}
            >
              <X size={ICON} />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
