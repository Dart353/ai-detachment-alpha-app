/**
 * The layout picker (design 1b): two sections of mini wireframes, one per house
 * preset, hanging off the title bar's layout icon.
 *
 * Applying a preset is an ASSIGNMENT change over new rectangles — panes keep
 * their reading order and their processes, so the canvas re-arranges live and
 * nothing respawns. The picker stays open afterwards: trying two shapes in a row
 * is the whole point of it.
 */
import type { JSX, RefObject } from 'react'
import { selectActiveWorkspace, useApp } from '../store/app'
import { matchPreset, ZONE_PRESETS, type Rect, type ZonePreset } from '../lib/zones'
import { Popover } from './ui'
import './LayoutPicker.css'

export interface LayoutPickerProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  onEditZones: () => void
}

/** Popover width from the mockup, and the wireframe's gap between cells. */
const WIDTH = 392
const CELL_GAP = 3

/** One cell of a tile's wireframe, derived from the preset's own rectangle. */
function cellStyle(rect: Rect): { left: string; top: string; width: string; height: string } {
  return {
    left: `calc(${rect.x}% + ${CELL_GAP / 2}px)`,
    top: `calc(${rect.y}% + ${CELL_GAP / 2}px)`,
    width: `calc(${rect.w}% - ${CELL_GAP}px)`,
    height: `calc(${rect.h}% - ${CELL_GAP}px)`
  }
}

function LayoutTile({
  preset,
  selected,
  disabled,
  onPick
}: {
  preset: ZonePreset
  selected: boolean
  disabled: boolean
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`ada-layout-tile${selected ? ' is-selected' : ''}`}
      disabled={disabled}
      title={disabled ? 'Open a workspace first' : `Arrange the panes as ${preset.label}`}
      aria-pressed={selected}
      onClick={onPick}
    >
      <span className="ada-layout-wire" aria-hidden>
        {/* The first rectangle is the preset's main region — the one the mockup
            fills when the tile is the layout in use. */}
        {preset.rects.map((rect, index) => (
          <span
            key={`${rect.x}:${rect.y}:${rect.w}:${rect.h}`}
            className={`ada-layout-cell${index === 0 ? ' ada-layout-cell--main' : ''}`}
            style={cellStyle(rect)}
          />
        ))}
      </span>
      <span className="ada-layout-label">{preset.label}</span>
      {selected && (
        <span className="ada-layout-check" aria-hidden>
          ✓
        </span>
      )}
    </button>
  )
}

export default function LayoutPicker({
  open,
  anchorRef,
  onClose,
  onEditZones
}: LayoutPickerProps): JSX.Element | null {
  const workspace = useApp(selectActiveWorkspace)
  const applyPreset = useApp((state) => state.applyPreset)

  const selectedId = workspace ? matchPreset(workspace.layout) : null
  const disabled = !workspace

  const section = (group: ZonePreset['group']): JSX.Element => (
    <div className="ada-layout-grid">
      {ZONE_PRESETS.filter((preset) => preset.group === group).map((preset) => (
        <LayoutTile
          key={preset.id}
          preset={preset}
          selected={preset.id === selectedId}
          disabled={disabled}
          onPick={() => {
            if (workspace) applyPreset(workspace.id, preset.id)
          }}
        />
      ))}
    </div>
  )

  const edit = (): void => {
    onEditZones()
    onClose()
  }

  return (
    <Popover
      open={open}
      // identical at runtime — a RefObject's `current` is nullable either way,
      // but React's variance annotations refuse the two spellings as one type
      anchorRef={anchorRef as RefObject<HTMLElement>}
      placement="bottom-end"
      width={WIDTH}
      onClose={onClose}
      className="ada-layouts"
      ariaLabel="Workspace layout"
    >
      <div className="ada-layout-section">GRIDS</div>
      {section('grid')}
      <div className="ada-layout-section ada-layout-section--next">ARRANGEMENTS</div>
      {section('arrangement')}
      <div className="ada-layout-footer">
        <button type="button" className="ada-layout-custom" disabled={disabled} onClick={edit}>
          Custom zones…
        </button>
        <button type="button" className="ada-layout-edit" disabled={disabled} onClick={edit}>
          Edit layout →
        </button>
      </div>
    </Popover>
  )
}
