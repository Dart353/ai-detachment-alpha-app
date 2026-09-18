import { type JSX } from 'react'
import { X } from 'lucide-react'
import './Toasts.css'

export interface Toast {
  id: string
  msg: string
  kind: 'info' | 'error'
  /** An offer attached to the message — "Reopen", "Undo". Running it dismisses. */
  action?: { label: string; run: () => void }
}

export interface ToastsProps {
  toasts: Toast[]
  onDismiss: (id: string) => void
  className?: string
}

/**
 * How long a toast should stand. A toast carrying an action has to outlive the
 * moment it takes to notice and reach for it; one that is only telling you
 * something can go as soon as it has been read.
 *
 * Exported rather than applied here because the timers belong to whoever owns the
 * toast list — this component is presentational and holds no state of its own.
 */
export function toastTtl(toast: Toast): number {
  return toast.action ? 10000 : 4200
}

/**
 * The bottom-right toast stack. Errors get a warn-coloured bar down their left
 * edge rather than a red card: the palette has no red, and a failed spawn is
 * information, not an alarm.
 */
export function Toasts({ toasts, onDismiss, className }: ToastsProps): JSX.Element | null {
  if (toasts.length === 0) return null
  return (
    <div
      className={`ada-toasts${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div key={toast.id} className={`ada-toast ada-toast-${toast.kind}`}>
          <span className="ada-toast-msg">{toast.msg}</span>
          {toast.action && (
            <button
              type="button"
              className="ada-toast-action"
              onClick={() => {
                // run first, then clear: the handler may want the toast's context
                toast.action?.run()
                onDismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="ada-toast-close"
            aria-label="Dismiss"
            onClick={() => onDismiss(toast.id)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

export default Toasts
