/**
 * A remote client's `addPane`, turned into what the store's `addPane` takes.
 * Pure, so the one judgement in it — is the asked-for cwd really inside the
 * workspace — is tested without a store.
 */
import type { AddPaneOpts, PaneInit } from '../store/app'
import type { RelayCommand } from '../../../shared/types'

type AddPaneCommand = Extract<RelayCommand, { type: 'addPane' }>

export interface RemotePane {
  init: PaneInit
  opts: AddPaneOpts
  /** The first message to send once Claude is ready, if any. */
  prompt?: string
}

/**
 * `path` is `root` itself or a folder below it. Both are absolute paths as the
 * workspace stores them (POSIX, or Windows off WSL mode); a `..` segment is
 * refused outright rather than resolved, so nothing can climb back out.
 */
export function isInsideFolder(root: string, path: string): boolean {
  const separators = /[\\/]+/
  const rootParts = root.split(separators).filter(Boolean)
  const pathParts = path.split(separators).filter(Boolean)
  if (pathParts.some((part) => part === '.' || part === '..')) return false
  if (pathParts.length < rootParts.length) return false
  // Same leading kind of path: `/a` is not inside `C:\a`, nor `\\server\a`.
  const leading = (value: string): string => (value.match(/^[\\/]+/)?.[0] ?? '').replace(/\\/g, '/')
  if (leading(root) !== leading(path)) return false
  const caseless = /^[A-Za-z]:$/.test(rootParts[0] ?? '') || leading(root) === '//'
  const same = (a: string, b: string): boolean => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b)
  return rootParts.every((part, index) => same(part, pathParts[index]))
}

export function remotePaneFor(command: AddPaneCommand, rootDir: string): RemotePane {
  const init: PaneInit = { kind: command.kind }
  if (command.name) init.name = command.name
  if (command.model) init.model = command.model
  if (command.effort) init.effort = command.effort
  if (command.planMode) init.planMode = true
  if (command.tag) init.tag = command.tag
  // A cwd outside the workspace is dropped, not refused: the pane still opens,
  // at the workspace root, as it would have before cwd existed.
  if (command.cwd && isInsideFolder(rootDir, command.cwd)) init.cwd = command.cwd
  const pane: RemotePane = { init, opts: command.background ? { background: true } : {} }
  if (command.kind === 'claude' && command.prompt) pane.prompt = command.prompt
  return pane
}
