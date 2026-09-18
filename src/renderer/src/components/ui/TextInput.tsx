import { forwardRef, type InputHTMLAttributes } from 'react'
import './TextInput.css'

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value' | 'size'
>

export interface TextInputProps extends NativeInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Draw in the mono face — paths, commands, anything meant to line up. */
  mono?: boolean
  /** Enter, with the current value. */
  onEnter?: (value: string) => void
  /** Escape — usually "abandon this rename". */
  onEscape?: () => void
  size?: 'sm' | 'md'
}

/**
 * The house text field. Beyond the styling it does one load-bearing thing:
 * it stops `keydown` from leaving the input. The app binds global shortcuts on
 * the window and keeps focused terminals fed with raw keys, so without this a
 * rename box would spawn panes and echo what you typed into a shell.
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { value, onChange, placeholder, mono, onEnter, onEscape, size = 'md', className, ...rest },
  ref
) {
  const classes = ['ada-input']
  if (mono) classes.push('ada-input-mono')
  if (size === 'sm') classes.push('ada-input-sm')
  if (className) classes.push(className)

  return (
    <input
      ref={ref}
      type="text"
      className={classes.join(' ')}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') onEnter?.(event.currentTarget.value)
        else if (event.key === 'Escape') onEscape?.()
      }}
      {...rest}
    />
  )
})

export default TextInput
