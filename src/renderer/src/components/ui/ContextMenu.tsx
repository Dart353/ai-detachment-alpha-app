import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import './ContextMenu.css'

export interface MenuItem {
  /** The row's text. Also what the filter box and the keyboard match against. */
  label: string
  /** Leading glyph, drawn in a fixed 16px slot so labels line up with and without one. */
  icon?: ReactNode
  /** Trailing hint, mono and muted — a shortcut, or the `↵` on the default action. */
  hint?: string
  /** fired when the item is chosen; omit for pure submenu parents */
  onClick?: () => void
  /** render a hairline separator above this item */
  divider?: boolean
  /** a non-interactive caps heading above this item ("SPAWN HERE") */
  sectionLabel?: string
  /** styled as a caution action (e.g. "Start fresh") */
  danger?: boolean
  disabled?: boolean
  /**
   * Native tooltip on the row. The house rule for an action that can't run right
   * now is to DISABLE it and say why here, rather than drop it from the menu —
   * a vanished row reads as a missing feature.
   */
  title?: string
  /** nested items — renders a drill-down flyout instead of a leaf action */
  submenu?: MenuItem[]
  /**
   * Arbitrary markup rendered in place of the usual button row (the colour
   * swatches and `<input type="color">`). The row owns its own clicks — the menu
   * does NOT close for it — so whatever goes in here must either be
   * self-contained (a live-applying picker) or close the menu itself. `label`
   * is still required: it is what the filter box matches on.
   */
  content?: ReactNode
}

export interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /** Overrides the 230px default for a level that needs more room. */
  width?: number
  className?: string
}

/** Menu width from the mockups (1c). */
const DEFAULT_WIDTH = 230

/** The margin the menu and its flyouts keep off the window edge. */
const VIEWPORT_PAD = 8

/**
 * A small right-click context menu, positioned at the cursor and clamped to the
 * viewport. Closes on outside-click, Escape, or after an item fires. Items carrying
 * a `submenu` open a drill-down flyout on hover rather than flattening every choice
 * into one tall list.
 *
 * Portalled to <body> so it escapes any clipping or transformed ancestor the pane
 * that opened it happens to sit in.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  width = DEFAULT_WIDTH,
  className
}: ContextMenuProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // clamp inside the window once we know the menu's measured size
  useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) return
    const { width: menuWidth, height } = element.getBoundingClientRect()
    const left = Math.min(x, window.innerWidth - menuWidth - VIEWPORT_PAD)
    const top = Math.min(y, window.innerHeight - height - VIEWPORT_PAD)
    setPos({ left: Math.max(VIEWPORT_PAD, left), top: Math.max(VIEWPORT_PAD, top) })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      // the root menu owns the whole flyout tree; only outside clicks close it
      if (!rootRef.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    // capture so we beat xterm / pane handlers to the event
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  // hidden until measured so the clamp doesn't flash at the wrong spot
  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, width }
    : { left: 0, top: 0, width, visibility: 'hidden' }

  return createPortal(
    <div
      className={`ada-menu${className ? ` ${className}` : ''}`}
      ref={rootRef}
      style={style}
      role="menu"
    >
      <MenuList items={items} onClose={onClose} />
    </div>,
    document.body
  )
}

/** Above this many rows a menu level grows a filter box (e.g. 50+ ssh hosts). */
const SEARCH_THRESHOLD = 12

/** Rows the keyboard can land on: not a divider-only spacer, not a custom row, not disabled. */
function isSelectable(item: MenuItem): boolean {
  return !item.content && !item.disabled
}

/**
 * Renders one level of menu rows. A row with a `submenu` opens a Flyout to its side
 * on hover; hovering any sibling closes an open flyout. Recursive, so deeper nesting
 * works. Long levels get a filter input, and every level scrolls inside
 * `.ada-menu-list` instead of running off-screen.
 */
function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }): JSX.Element {
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')

  const searchable = items.length > SEARCH_THRESHOLD

  // Without a filter box the list itself takes the keyboard, so ↑/↓/Enter work the
  // moment the menu appears rather than after a first click somewhere inside it.
  useEffect(() => {
    if (!searchable) listRef.current?.focus()
  }, [searchable])

  const needle = query.trim().toLowerCase()
  const shown =
    searchable && needle
      ? items.filter((item) => item.label.toLowerCase().includes(needle))
      : items

  /** Fire a leaf row: the menu closes first, so the handler can open its own UI. */
  const activate = (item: MenuItem): void => {
    if (item.disabled || item.content) return
    onClose()
    item.onClick?.()
  }

  /** Move the highlight to the next selectable row, walking `direction`. */
  const moveActive = (direction: 1 | -1): void => {
    if (shown.length === 0) return
    let next = activeIndex
    for (let step = 0; step < shown.length; step += 1) {
      next = (next + direction + shown.length) % shown.length
      if (isSelectable(shown[next])) {
        setActiveIndex(next)
        return
      }
    }
  }

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveActive(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveActive(-1)
        break
      case 'ArrowRight': {
        const item = shown[activeIndex]
        if (item?.submenu?.length && !item.disabled) {
          event.preventDefault()
          anchorRef.current = listRef.current?.querySelector<HTMLButtonElement>(
            `[data-idx="${activeIndex}"]`
          ) ?? null
          setOpenSub(activeIndex)
        }
        break
      }
      case 'ArrowLeft':
        // closing a level is the root's Escape handling one rung down
        if (openSub !== null) {
          event.preventDefault()
          setOpenSub(null)
        }
        break
      case 'Enter': {
        const item = shown[activeIndex]
        if (item) {
          event.preventDefault()
          activate(item)
        }
        break
      }
      default:
        break
    }
  }

  return (
    <>
      {searchable && (
        <input
          className="ada-menu-search"
          type="text"
          placeholder="Search…"
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value)
            setOpenSub(null)
            setActiveIndex(-1)
          }}
          onKeyDown={(event) => {
            // Enter picks the first visible match so a type-then-Enter flow works
            if (event.key === 'Enter') {
              const first = shown.find(
                (item) => !item.disabled && !item.submenu?.length && !item.content
              )
              if (first) {
                onClose()
                first.onClick?.()
              }
            }
          }}
        />
      )}
      <div className="ada-menu-list" ref={listRef} tabIndex={-1} onKeyDown={onListKeyDown}>
        {shown.length === 0 && <div className="ada-menu-empty">No matches</div>}
        {shown.map((item, index) => {
          const hasSub = !!item.submenu?.length
          const enter = (event: ReactMouseEvent<HTMLButtonElement>): void => {
            // entering a submenu parent opens it; entering any leaf collapses the flyout.
            // A DISABLED parent stays shut — its tooltip is the whole answer, and a
            // flyout of rows that can't be used would say the opposite.
            if (hasSub && !item.disabled) {
              anchorRef.current = event.currentTarget
              setOpenSub(index)
            } else {
              setOpenSub(null)
            }
            if (isSelectable(item)) setActiveIndex(index)
          }
          // a custom row renders its own markup and keeps the menu open
          if (item.content)
            return (
              <div key={`${item.label}-${index}`}>
                {item.divider && <div className="ada-menu-divider" />}
                {item.sectionLabel && <div className="ada-menu-section">{item.sectionLabel}</div>}
                <div className="ada-menu-custom" onMouseEnter={() => setOpenSub(null)}>
                  {item.content}
                </div>
              </div>
            )
          return (
            // The tooltip lives on the WRAPPER as well as the row: Chromium sends
            // no pointer events to a disabled <button>, so a title on the button
            // alone would never show — and "disabled, with a reason" is exactly
            // the state an unavailable action is meant to be in.
            <div key={`${item.label}-${index}`} title={item.title}>
              {item.divider && <div className="ada-menu-divider" />}
              {item.sectionLabel && <div className="ada-menu-section">{item.sectionLabel}</div>}
              <button
                data-idx={index}
                className={`ada-menu-item${item.danger ? ' ada-menu-item-danger' : ''}${
                  hasSub ? ' ada-menu-item-parent' : ''
                }${openSub === index || activeIndex === index ? ' ada-menu-item-active' : ''}`}
                type="button"
                role="menuitem"
                title={item.title}
                aria-haspopup={hasSub || undefined}
                aria-expanded={hasSub ? openSub === index : undefined}
                disabled={item.disabled}
                onMouseEnter={enter}
                onClick={() => {
                  if (item.disabled) return
                  if (hasSub) {
                    anchorRef.current = document.activeElement as HTMLButtonElement
                    setOpenSub((current) => (current === index ? null : index))
                    return
                  }
                  activate(item)
                }}
              >
                <span className="ada-menu-icon" aria-hidden={!item.icon || undefined}>
                  {item.icon}
                </span>
                <span className="ada-menu-label">{item.label}</span>
                {hasSub ? (
                  <span className="ada-menu-chevron" aria-hidden="true">
                    ›
                  </span>
                ) : (
                  item.hint && <span className="ada-menu-hint">{item.hint}</span>
                )}
              </button>
              {hasSub && openSub === index && anchorRef.current && (
                <Flyout anchor={anchorRef.current} items={item.submenu ?? []} onClose={onClose} />
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * A submenu popover anchored to its parent row. Opens to the right, flips left when
 * it would overflow, and clamps vertically. It sits inside the root menu's DOM so the
 * root's outside-click handler still treats it as "inside".
 */
function Flyout({
  anchor,
  items,
  onClose
}: {
  anchor: HTMLElement
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const anchorRect = anchor.getBoundingClientRect()
    const { width, height } = element.getBoundingClientRect()
    const overlap = 4 // slight overlap so the mouse can cross without a dead gap
    let left = anchorRect.right - overlap
    if (left + width > window.innerWidth - VIEWPORT_PAD) left = anchorRect.left - width + overlap
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - width - VIEWPORT_PAD))
    let top = anchorRect.top - 4 // line the first row up with the parent row
    top = Math.max(VIEWPORT_PAD, Math.min(top, window.innerHeight - height - VIEWPORT_PAD))
    setPos({ left, top })
  }, [anchor])

  // hidden until measured so the clamp doesn't flash at the wrong spot
  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top }
    : { left: 0, top: 0, visibility: 'hidden' }

  return (
    <div className="ada-menu ada-menu-sub" ref={ref} style={style} role="menu">
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}

export default ContextMenu
