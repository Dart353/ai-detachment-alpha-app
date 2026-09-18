/**
 * Identity helpers shared by the store.
 *
 * Ids are minted in the renderer and travel everywhere — into the layout's
 * `assign` map, into the PTY manager, into the archive on disk — so they must be
 * collision-free across a whole install history, not just the current session.
 * `crypto.randomUUID` gives that; the prefix keeps a stray id readable in logs
 * ("p_1f3c…" is a pane, "w_…" a workspace) without anything ever parsing it.
 */

/** The random half of an id: a UUID with its dashes dropped, truncated. */
function randomChunk(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.replace(/-/g, '').slice(0, 12)
  // No WebCrypto (an ancient runtime, or a stripped test harness): a timestamp
  // plus randomness is still unique enough for ids that never leave one install.
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** A fresh unique id, optionally tagged: `uid('p')` → `p_9a3f…`. */
export function uid(prefix?: string): string {
  const chunk = randomChunk()
  return prefix ? `${prefix}_${chunk}` : chunk
}

/**
 * The last segment of a path, with either separator and any number of trailing
 * ones. Falls back to the input when there is no segment at all (the filesystem
 * root), so a workspace name is never empty.
 */
export function baseName(path: string): string {
  const segments = path.split(/[/\\]+/).filter(Boolean)
  return segments[segments.length - 1] ?? path
}
