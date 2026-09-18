import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import './Popover.css'

export type PopoverPlacement = 'bottom-end' | 'bottom-start' | 'right-start'

export interface PopoverProps {
  open: boolean
  /** The element the popover hangs off. Ignored when `anchorRect` is given. */
  anchorRef?: RefObject<HTMLElement>
  /** A rect in viewport coordinates, for anchors that are not elements (a grid zone). */
  anchorRect?: DOMRect
  placement?: PopoverPlacement
  onClose: () => void
  /** Fixed width in pixels. Omit to let the content size itself. */
  width?: number
  className?: string
  /** Accessible name; the surface carries role="dialog" for screen readers. */
  ariaLabel?: string
  children: ReactNode
}

/** Distance from the anchor, and the margin the popover keeps off the window edge. */
const GAP = 6
const VIEWPORT_PAD = 8

/** The anchor's viewport rect, from whichever of the two anchor props was given. */
function readAnchorRect(
  anchorRef: RefObject<HTMLElement> | undefined,
  anchorRect: DOMRect | undefined
): DOMRect | null {
  if (anchorRect) return anchorRect
  return anchorRef?.current?.getBoundingClientRect() ?? null
}

/**
 * Where the surface sits given the anchor and its own measured size. Placement is
 * a preference, not a promise: the clamp below always wins, because a menu that
 * honours `bottom-end` by hanging half off the screen is worse than one that moved.
 */
function place(
  anchor: DOMRect,
  size: { width: number; height: number },
  placement: PopoverPlacement
): { left: number; top: number } {
  let left: number
  let top: number
  if (placement === 'right-start') {
    left = anchor.right + GAP
    top = anchor.top
  } else {
    top = anchor.bottom + GAP
    left = placement === 'bottom-end' ? anchor.right - size.width : anchor.left
  }
  const maxLeft = window.innerWidth - size.width - VIEWPORT_PAD
  const maxTop = window.innerHeight - size.height - VIEWPORT_PAD
  return {
    left: Math.max(VIEWPORT_PAD, Math.min(left, maxLeft)),
    top: Math.max(VIEWPORT_PAD, Math.min(top, maxTop))
  }
}

/**
 * The floating surface every menu, picker and dropdown in the app is drawn on:
 * popover background, hairline border, 10px radius and the one elevation shadow.
 *
 * Portalled to <body> so it escapes any `overflow: hidden` or transformed ancestor
 * (a `position: fixed` child of a filtered element resolves against that element,
 * not the viewport, which lands the surface nowhere near its anchor).
 */
export function Popover({
  open,
  anchorRef,
  anchorRect,
  placement = 'bottom-end',
  onClose,
  width,
  className,
  ariaLabel,
  children
}: PopoverProps): JSX.Element | null {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Measure, then position — and re-measure on resize, since the clamp depends on
  // the window. Kept in a layout effect so the surface never paints at 0,0 first.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return undefined
    }
    const reposition = (): void => {
      const surface = surfaceRef.current
      const anchor = readAnchorRect(anchorRef, anchorRect)
      if (!surface || !anchor) return
      const rect = surface.getBoundingClientRect()
      setPos(place(anchor, { width: rect.width, height: rect.height }, placement))
    }
    reposition()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [open, anchorRef, anchorRect, placement, width])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (surfaceRef.current?.contains(target)) return
      // a press on the anchor is the toggle's business, not a dismissal
      if (anchorRef?.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    // Capture phase: xterm.js stops propagation on its own pointer and key events,
    // so a bubble-phase listener never hears a click that lands in a terminal.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  // hidden until measured, so the clamp does not flash at the unclamped spot
  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, width }
    : { left: 0, top: 0, width, visibility: 'hidden' }

  return createPortal(
    <div
      ref={surfaceRef}
      className={`ada-popover${className ? ` ${className}` : ''}`}
      style={style}
      role="dialog"
      aria-label={ariaLabel}
    >
      {children}
    </div>,
    document.body
  )
}

export default Popover
