import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type JSX } from 'react'
import { Check, ChevronDown, ChevronUp, GripVertical, Pencil, Trash2, X } from 'lucide-react'
import type { SavedLayout, Zone } from '../../../shared/types'
import { Button, TextInput } from './ui'
import './SavedLayouts.css'

export interface SavedLayoutsProps {
  layouts: readonly SavedLayout[]
  /** Save the zones currently on the canvas under this name. */
  onSave: (name: string) => void
  /** Re-seed the canvas from a saved shape. */
  onApply: (layout: SavedLayout) => void
  onRename: (id: string, name: string) => void
  onReorder: (from: number, to: number) => void
  onDelete: (id: string) => void
  onClose: () => void
}

const ICON = 13

/** A zone's rectangle as absolute-positioning percentages. */
const pct = (zone: Zone): CSSProperties => ({
  left: `${zone.x}%`,
  top: `${zone.y}%`,
  width: `${zone.w}%`,
  height: `${zone.h}%`
})

/**
 * A saved shape drawn small: outlined rectangles on a fixed-ratio card, the same
 * wireframe language the layout picker's tiles use, so a layout is recognised by
 * its shape rather than read off its name.
 */
function LayoutThumb({ zones }: { zones: readonly Zone[] }): JSX.Element {
  return (
    <span className="ada-saved-thumb" aria-hidden>
      {zones.map((zone) => (
        <span key={zone.id} className="ada-saved-thumb-cell" style={pct(zone)} />
      ))}
    </span>
  )
}

/**
 * The saved-layouts panel: it opens BESIDE the canvas, never over it. Every
 * gesture keeps working while layouts are named, renamed, reordered or removed,
 * which is the whole point — you save a shape by looking at it.
 */
export default function SavedLayouts({
  layouts,
  onSave,
  onApply,
  onRename,
  onReorder,
  onDelete,
  onClose
}: SavedLayoutsProps): JSX.Element {
  const saveInputRef = useRef<HTMLInputElement>(null)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  // the panel is mounted by the "Save layout…" button, so the field it exists to
  // offer takes the caret straight away
  useEffect(() => {
    saveInputRef.current?.focus()
  }, [])

  const commitSave = (): void => {
    const name = newName.trim()
    if (!name) {
      saveInputRef.current?.focus()
      return
    }
    onSave(name)
    setNewName('')
  }

  const beginRename = (layout: SavedLayout): void => {
    setConfirmId(null)
    setRenamingId(layout.id)
    setRenameDraft(layout.name)
  }

  const commitRename = (): void => {
    if (renamingId && renameDraft.trim()) onRename(renamingId, renameDraft)
    setRenamingId(null)
  }

  const endDrag = (): void => {
    setDragIndex(null)
    setDropIndex(null)
  }

  const onRowDrop = (index: number) => (event: DragEvent<HTMLLIElement>): void => {
    event.preventDefault()
    if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index)
    endDrag()
  }

  return (
    <aside
      className="ada-saved"
      aria-label="Saved layouts"
      // the canvas is right next door and listens on the window for Escape and
      // Delete; a press in here must never read as the start of a gesture
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="ada-saved-head">
        <h2 className="ada-saved-title">Saved layouts</h2>
        <Button
          variant="icon"
          size="sm"
          aria-label="Close the saved layouts panel"
          title="Close this panel"
          onClick={onClose}
        >
          <X size={ICON} />
        </Button>
      </header>

      <div className="ada-saved-new">
        <TextInput
          ref={saveInputRef}
          size="sm"
          value={newName}
          placeholder="Name this layout…"
          aria-label="Name for the current layout"
          onChange={setNewName}
          onEnter={commitSave}
          // Escape steps out of the field rather than closing the editor; a
          // second Escape (now on the canvas) leaves as it always did
          onEscape={() => {
            setNewName('')
            saveInputRef.current?.blur()
          }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={!newName.trim()}
          title="Save the zones currently on the canvas under this name"
          onClick={commitSave}
        >
          Save
        </Button>
      </div>

      {layouts.length === 0 ? (
        <p className="ada-saved-empty">
          No saved layouts yet. Arrange the canvas, then name it above to keep it.
        </p>
      ) : (
        <ul className="ada-saved-list" onDragEnd={endDrag}>
          {layouts.map((layout, index) => {
            const renaming = renamingId === layout.id
            const confirming = confirmId === layout.id
            const classes = ['ada-saved-row']
            if (dragIndex === index) classes.push('ada-saved-row--dragging')
            if (dropIndex === index && dragIndex !== null && dragIndex !== index) {
              classes.push('ada-saved-row--drop')
            }
            return (
              <li
                key={layout.id}
                className={classes.join(' ')}
                draggable={!renaming}
                onDragStart={(event) => {
                  setDragIndex(index)
                  event.dataTransfer.effectAllowed = 'move'
                  // Chromium refuses to start a drag with an empty payload
                  event.dataTransfer.setData('text/plain', layout.id)
                }}
                onDragOver={(event) => {
                  if (dragIndex === null) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropIndex(index)
                }}
                onDrop={onRowDrop(index)}
              >
                <span className="ada-saved-grip" title="Drag to reorder" aria-hidden>
                  <GripVertical size={ICON} />
                </span>
                <LayoutThumb zones={layout.zones} />

                {renaming ? (
                  <TextInput
                    className="ada-saved-rename"
                    size="sm"
                    autoFocus
                    value={renameDraft}
                    aria-label={`Rename ${layout.name}`}
                    onChange={setRenameDraft}
                    onEnter={commitRename}
                    onEscape={() => setRenamingId(null)}
                    onBlur={commitRename}
                  />
                ) : (
                  <button
                    type="button"
                    className="ada-saved-name"
                    title={`Apply “${layout.name}” to the canvas`}
                    onClick={() => onApply(layout)}
                  >
                    <span className="ada-saved-name-text">{layout.name}</span>
                    <span className="ada-saved-count">
                      {layout.zones.length} zone{layout.zones.length === 1 ? '' : 's'}
                    </span>
                  </button>
                )}

                {confirming ? (
                  <div className="ada-saved-confirm">
                    <span className="ada-saved-confirm-text">Delete?</span>
                    <Button
                      variant="primary"
                      size="sm"
                      danger
                      onClick={() => {
                        setConfirmId(null)
                        onDelete(layout.id)
                      }}
                    >
                      Delete
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="ada-saved-actions">
                    <Button
                      variant="icon"
                      size="sm"
                      disabled={index === 0}
                      title="Move up"
                      aria-label={`Move ${layout.name} up`}
                      onClick={() => onReorder(index, index - 1)}
                    >
                      <ChevronUp size={ICON} />
                    </Button>
                    <Button
                      variant="icon"
                      size="sm"
                      disabled={index === layouts.length - 1}
                      title="Move down"
                      aria-label={`Move ${layout.name} down`}
                      onClick={() => onReorder(index, index + 1)}
                    >
                      <ChevronDown size={ICON} />
                    </Button>
                    <Button
                      variant="icon"
                      size="sm"
                      title={renaming ? 'Keep this name' : 'Rename'}
                      aria-label={renaming ? `Keep the name for ${layout.name}` : `Rename ${layout.name}`}
                      // hold the focus in the field: without this the press blurs
                      // it first, the blur commits, and the click then lands on a
                      // button that has already flipped back to "Rename" —
                      // reopening the editor the user just closed
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => (renaming ? commitRename() : beginRename(layout))}
                    >
                      {renaming ? <Check size={ICON} /> : <Pencil size={ICON} />}
                    </Button>
                    <Button
                      variant="icon"
                      size="sm"
                      danger
                      title="Delete this layout"
                      aria-label={`Delete ${layout.name}`}
                      onClick={() => setConfirmId(layout.id)}
                    >
                      <Trash2 size={ICON} />
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <p className="ada-saved-note">Saved layouts also appear under “Apply a layout…”.</p>
    </aside>
  )
}
