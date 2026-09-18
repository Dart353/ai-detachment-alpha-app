import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import './Select.css'

export interface SelectOption {
  value: string
  label: string
  /** Non-selectable, shown greyed out. */
  disabled?: boolean
}

export interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** Shown when `value` matches no option. */
  placeholder?: string
  /** `sm` tightens padding and type for dense toolbars. Defaults to `md`. */
  size?: 'sm' | 'md'
  /** Fixed trigger width in pixels. Omit to fill the container. */
  width?: number
  disabled?: boolean
  className?: string
  ariaLabel?: string
}

/**
 * Above this many options the popover grows a filter box — the same threshold the
 * context menu uses, because forty ssh hosts and forty saved layouts are the same
 * problem.
 */
const SEARCH_THRESHOLD = 12

/** Distance from the trigger, and the margin the menu keeps off the window edge. */
const GAP = 4
const VIEWPORT_PAD = 8

/** A shown option paired with its index in the FULL options array. */
interface VisibleOption {
  option: SelectOption
  index: number
}

/**
 * The rows the popover shows. Every piece of state here speaks ORIGINAL indices, so
 * filtering can never slide a commit onto the option that merely sits at the same
 * position in the narrowed list.
 */
function filterOptions(options: SelectOption[], query: string): VisibleOption[] {
  const rows = options.map((option, index) => ({ option, index }))
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  // `includes`, not `startsWith`: a row is as likely to be recognised by a word in
  // the middle of its label as by its first letter
  return rows.filter(({ option }) => option.label.toLowerCase().includes(needle))
}

/**
 * First selectable row at or after position `from` in the SHOWN list, walking
 * `direction`. Returns that row's original index, or -1 if there is none.
 */
function seekEnabled(rows: VisibleOption[], from: number, direction: 1 | -1): number {
  for (let cursor = from; cursor >= 0 && cursor < rows.length; cursor += direction) {
    if (!rows[cursor].option.disabled) return rows[cursor].index
  }
  return -1
}

/**
 * The house dropdown, replacing the native `<select>` (which ignores the theme and
 * renders as a bright OS control). A trigger shaped like an outline button opens a
 * listbox on the standard popover surface.
 *
 * The menu's height is BUDGETED from the room actually around the trigger and the
 * list scrolls inside it. A fixed cap ignores how much space exists; once the menu
 * is taller than the window, its tail hangs off the bottom of the screen where it
 * cannot be reached.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder,
  size = 'md',
  width,
  disabled = false,
  className,
  ariaLabel
}: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: 'hidden' })

  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const typeahead = useRef<{ buffer: string; timer: number | null }>({ buffer: '', timer: null })

  const baseId = useId()
  const listboxId = `${baseId}-listbox`
  const optionId = (index: number): string => `${baseId}-opt-${index}`

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null

  const searchable = options.length > SEARCH_THRESHOLD
  const rows = useMemo(
    () => filterOptions(options, searchable ? query : ''),
    [options, query, searchable]
  )

  const close = useCallback((refocus = true): void => {
    setOpen(false)
    setQuery('')
    setMenuStyle({ visibility: 'hidden' })
    if (refocus) triggerRef.current?.focus()
  }, [])

  const openMenu = useCallback((): void => {
    if (disabled) return
    // land on the current value, or the first selectable entry
    const start = selectedIndex >= 0 ? selectedIndex : seekEnabled(filterOptions(options, ''), 0, 1)
    setQuery('')
    setActiveIndex(start)
    setOpen(true)
  }, [disabled, options, selectedIndex])

  const commit = useCallback(
    (index: number): void => {
      const option = options[index]
      if (!option || option.disabled) return
      onChange(option.value)
      close()
    },
    [options, onChange, close]
  )

  /**
   * Anchor the (fixed-position) menu under its trigger, opening upward when the space
   * below is tight, and budget its height from the room actually around the trigger.
   * Re-run on resize, so a window change re-budgets rather than leaving a menu that
   * no longer fits.
   */
  const place = useCallback((): void => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    const list = listRef.current
    if (!trigger || !menu) return
    const rect = trigger.getBoundingClientRect()

    // Natural height with the current cap ignored: `scrollHeight` on the rows is the
    // full content either way, and `chrome` is whatever the shell holds beyond them
    // (padding, border, the filter box).
    const chrome = menu.offsetHeight - (list?.offsetHeight ?? 0)
    const natural = chrome + (list?.scrollHeight ?? menu.offsetHeight)

    const below = window.innerHeight - rect.bottom - GAP - VIEWPORT_PAD
    const above = rect.top - GAP - VIEWPORT_PAD
    // prefer opening downward while the whole list fits; otherwise take the roomier side
    const openUp = natural > below && above > below
    const room = openUp ? above : below

    // A floor of about three rows, so a cramped trigger still yields a scrollable list
    // rather than a sliver. Measured off a real row so it tracks the type size.
    const firstRow = list?.firstElementChild
    const rowHeight = firstRow instanceof HTMLElement ? firstRow.offsetHeight : 30
    const floor = Math.min(natural, chrome + rowHeight * 3)
    // …but never taller than the viewport, or the clamp below would have no position
    // that keeps both edges on screen
    const cap = Math.max(0, window.innerHeight - VIEWPORT_PAD * 2)
    const maxHeight = Math.min(Math.max(floor, Math.min(natural, room)), cap)

    let top = openUp ? rect.top - maxHeight - GAP : rect.bottom + GAP
    top = Math.max(VIEWPORT_PAD, Math.min(top, window.innerHeight - maxHeight - VIEWPORT_PAD))
    const left = Math.max(
      VIEWPORT_PAD,
      Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_PAD)
    )
    setMenuStyle({ position: 'fixed', top, left, minWidth: rect.width, maxHeight })
  }, [])

  // position once rendered, and again whenever filtering changes how many rows
  // there are to budget for
  useLayoutEffect(() => {
    if (!open) return
    place()
  }, [open, place, rows.length])

  // The filter box owns the keyboard while it is up, so focus follows it in — but
  // only once place() has run. A menu still carrying the pre-placement
  // `visibility: hidden` cannot take focus, and focus() on it is a silent no-op.
  const placed = menuStyle.visibility !== 'hidden'
  useLayoutEffect(() => {
    if (open && searchable && placed) searchRef.current?.focus()
  }, [open, searchable, placed])

  // outside-press dismisses; resize repositions. Capture phase, so we hear a press
  // that lands in a terminal (xterm stops propagation on its own events).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      // the menu is portalled out of the trigger's subtree, so it has to be named
      // here or this very listener would dismiss it before an option's press ran
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', place)
    }
  }, [open, close, place])

  // keep the highlighted row in view as the arrows move it
  useEffect(() => {
    if (!open || activeIndex < 0) return
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const runTypeahead = useCallback(
    (character: string): void => {
      const state = typeahead.current
      if (state.timer) window.clearTimeout(state.timer)
      state.buffer += character.toLowerCase()
      const buffer = state.buffer
      const match = options.findIndex(
        (option) => !option.disabled && option.label.toLowerCase().startsWith(buffer)
      )
      if (match >= 0) setActiveIndex(match)
      state.timer = window.setTimeout(() => {
        state.buffer = ''
        state.timer = null
      }, 600)
    },
    [options]
  )

  /** Where the highlighted option sits in the SHOWN list (-1 once filtered away). */
  const activePos = rows.findIndex((row) => row.index === activeIndex)

  /** Narrow the list and re-arm the highlight on the first match, so Enter picks it. */
  const applyQuery = (next: string): void => {
    setQuery(next)
    setActiveIndex(seekEnabled(filterOptions(options, next), 0, 1))
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (disabled) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openMenu()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        // a highlight the filter has hidden re-enters at the top of what is shown
        const next = seekEnabled(rows, activePos < 0 ? 0 : activePos + 1, 1)
        if (next >= 0) setActiveIndex(next)
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        const previous = seekEnabled(rows, activePos < 0 ? rows.length - 1 : activePos - 1, -1)
        if (previous >= 0) setActiveIndex(previous)
        break
      }
      case 'Home':
        event.preventDefault()
        setActiveIndex(seekEnabled(rows, 0, 1))
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(seekEnabled(rows, rows.length - 1, -1))
        break
      case 'Enter': {
        event.preventDefault()
        // the highlighted row, or the first match when the filter has cleared it
        const target = activePos >= 0 ? activeIndex : seekEnabled(rows, 0, 1)
        if (target >= 0) commit(target)
        break
      }
      case ' ':
        // inside the filter box a space is a character, not a commit
        if (searchable) break
        event.preventDefault()
        if (activeIndex >= 0) commit(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        close()
        break
      case 'Tab':
        close(false)
        break
      default:
        // the filter box supersedes the character-by-character type-ahead
        if (
          !searchable &&
          event.key.length === 1 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        )
          runTypeahead(event.key)
    }
  }

  return (
    <div
      className={`ada-select${size === 'sm' ? ' ada-select-sm' : ''}${
        className ? ` ${className}` : ''
      }`}
      style={width === undefined ? undefined : { width }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ada-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={`ada-select-value${selected ? '' : ' ada-select-placeholder'}`}>
          {selected ? selected.label : placeholder ?? ''}
        </span>
        <span className="ada-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {/* Portalled to <body>: `position: fixed` resolves against the nearest
          ancestor carrying a transform or filter, not the viewport, so inside a
          blurred overlay the menu lands offset by that overlay's origin instead of
          under its trigger. At body level there is nothing to trap it. */}
      {open &&
        createPortal(
          <div ref={menuRef} className="ada-select-menu" style={menuStyle}>
            {/* pinned above the rows, so narrowing a forty-entry list never scrolls
                the box you are typing into out of reach */}
            {searchable && (
              <input
                ref={searchRef}
                type="text"
                className="ada-select-search"
                placeholder="Search…"
                value={query}
                aria-label={ariaLabel}
                onChange={(event) => applyQuery(event.target.value)}
                // the app binds global shortcuts on the window; typed keys stop here
                onKeyDown={(event) => {
                  event.stopPropagation()
                  onKeyDown(event)
                }}
              />
            )}
            <div
              ref={listRef}
              id={listboxId}
              className="ada-select-list"
              role="listbox"
              aria-label={ariaLabel}
              // The list scrolls itself; letting the wheel through would scroll the
              // page behind and drag the menu off its trigger.
              onWheel={(event) => event.stopPropagation()}
            >
              {rows.length === 0 && <div className="ada-select-empty">No matches</div>}
              {rows.map(({ option, index }) => {
                const isSelected = option.value === value
                return (
                  <button
                    key={option.value}
                    id={optionId(index)}
                    data-idx={index}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    className={`ada-select-option${
                      index === activeIndex ? ' ada-select-option-active' : ''
                    }`}
                    // pointerdown, not click, so we commit before the outside-press
                    // listener sees the same gesture
                    onPointerDown={(event) => {
                      event.preventDefault()
                      commit(index)
                    }}
                    onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                  >
                    <span className="ada-select-check">{isSelected && <Check size={12} />}</span>
                    <span className="ada-select-label">{option.label}</span>
                  </button>
                )
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

export default Select
