import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './Modal.css'

export interface ModalProps {
  open: boolean
  /** Visible heading; also names the dialog for screen readers. */
  title?: string
  onClose: () => void
  children: ReactNode
  /** Right-aligned action row pinned under the body (the buttons). */
  footer?: ReactNode
  /** Max width of the card in pixels. */
  width?: number
  className?: string
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/** Visible, focusable descendants in DOM order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  )
}

/**
 * The house dialog: scrim, popover-surfaced card, and the three things a
 * hand-rolled backdrop always forgets — Tab stays inside the card, Escape
 * dismisses, and focus goes back to whatever opened it on close.
 *
 * Portalled to <body>, so it escapes any `overflow: hidden` or stacking context
 * its caller happens to sit in.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
  className
}: ModalProps): JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null)
  // read inside effects only, so changing the handler never re-runs the trap
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // a press that STARTED inside the card (a drag that selected past the edge and
  // released on the scrim) is not a backdrop click and must not dismiss
  const pressStartedInside = useRef(false)
  const titleId = useId()

  // move focus in on open, hand it back on close
  useEffect(() => {
    if (!open) return
    const restoreTo = document.activeElement as HTMLElement | null
    const card = cardRef.current
    const target = card ? focusables(card)[0] ?? card : null
    target?.focus()
    return () => {
      // the opener may have unmounted with the dialog; focus() is a no-op then
      restoreTo?.focus?.()
    }
  }, [open])

  // Escape to dismiss + Tab cycling inside the card
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // a descendant that consumed Escape itself (an open Select inside the
        // card) preventDefaults — leave the dialog standing
        if (event.defaultPrevented) return
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      // re-queried per keystroke so controls added mid-dialog are picked up
      const items = focusables(card)
      if (items.length === 0) {
        event.preventDefault()
        card.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === card || !card.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !card.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    // bubble phase, so a child's own Escape handling runs first and can mark the
    // event handled before it reaches us
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="ada-modal-scrim"
      onPointerDown={(event) => {
        pressStartedInside.current = event.target !== event.currentTarget
      }}
      onPointerUp={(event) => {
        if (event.target === event.currentTarget && !pressStartedInside.current) onClose()
        pressStartedInside.current = false
      }}
    >
      <div
        ref={cardRef}
        className={`ada-modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        style={width === undefined ? undefined : { maxWidth: width }}
      >
        {title && (
          <h2 className="ada-modal-title" id={titleId}>
            {title}
          </h2>
        )}
        <div className="ada-modal-body">{children}</div>
        {footer && <div className="ada-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export default Modal
