import { useEffect, useRef, type JSX } from 'react'
import { useTodos, startTodoSync } from '../../store/todos'
import { TodoBoard } from './TodoBoard'

/**
 * The popped-out board's whole renderer. It shares the bundle with the main
 * window but none of its world: no workspaces, no panes, no persistence of
 * app state — only the todo store, kept in step through main.
 */
export function TodoWindow(): JSX.Element | null {
  const hydrated = useTodos((state) => state.hydrated)
  const started = useRef(false)

  useEffect(() => {
    // StrictMode mounts twice in development; one subscription is enough.
    if (started.current) return undefined
    started.current = true
    return startTodoSync()
  }, [])

  if (!hydrated) return null
  return <TodoBoard mode="window" />
}

export default TodoWindow
