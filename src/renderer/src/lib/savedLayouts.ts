/**
 * Saved layouts: zone arrangements the user named in the editor so they can be
 * applied again later.
 *
 * Everything that DECIDES anything is a pure function over `SavedLayout[]` —
 * the list is small, fully in memory, and every mutation is a whole-list
 * rewrite, so there is nothing to gain from hiding the rules behind a store and
 * a great deal to gain from being able to test them directly. The two thin
 * wrappers at the bottom are the only places that know the list is persisted at
 * all, and both degrade quietly when there is no bridge (unit tests, a browser
 * preview) rather than taking the editor down with them.
 */
import type { SavedLayout, Zone } from '../../../shared/types'
import { uid } from './ids'

/** The name a blank one falls back to, so a saved layout is never nameless. */
const FALLBACK_NAME = 'Layout'

/** Trim float noise, and renumber ids so a saved shape is JSON-stable. */
function normalizeZones(zones: readonly Zone[]): Zone[] {
  const round = (value: number): number => Math.round(value * 10000) / 10000
  return zones.map((zone, index) => ({
    id: `z${index + 1}`,
    x: round(zone.x),
    y: round(zone.y),
    w: round(zone.w),
    h: round(zone.h)
  }))
}

/**
 * A trimmed name that no OTHER entry already carries, suffixed " 2", " 3", …
 * until it is free. Case-insensitive, because two layouts called "Wide" and
 * "wide" are indistinguishable in the picker they both appear in.
 */
export function uniqueLayoutName(
  list: readonly SavedLayout[],
  name: string,
  exceptId?: string
): string {
  const base = name.trim() || FALLBACK_NAME
  const taken = new Set(
    list.filter((entry) => entry.id !== exceptId).map((entry) => entry.name.toLowerCase())
  )
  if (!taken.has(base.toLowerCase())) return base
  let suffix = 2
  while (taken.has(`${base} ${suffix}`.toLowerCase())) suffix += 1
  return `${base} ${suffix}`
}

/** Append a layout under `name` (de-duplicated), keeping the zones as-is. */
export function addSavedLayout(
  list: readonly SavedLayout[],
  name: string,
  zones: readonly Zone[]
): SavedLayout[] {
  if (zones.length === 0) return list.slice()
  return [
    ...list,
    { id: uid('sl'), name: uniqueLayoutName(list, name), zones: normalizeZones(zones) }
  ]
}

/** Rename one layout in place. A blank name is refused — the list stays as it was. */
export function renameSavedLayout(
  list: readonly SavedLayout[],
  id: string,
  name: string
): SavedLayout[] {
  if (!name.trim()) return list.slice()
  const next = uniqueLayoutName(list, name, id)
  return list.map((entry) => (entry.id === id ? { ...entry, name: next } : entry))
}

/** Move the layout at `from` to index `to` (clamped). Order drives the pickers. */
export function reorderSavedLayout(
  list: readonly SavedLayout[],
  from: number,
  to: number
): SavedLayout[] {
  const next = list.slice()
  if (from < 0 || from >= next.length) return next
  const target = Math.max(0, Math.min(to, next.length - 1))
  if (target === from) return next
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

export function deleteSavedLayout(list: readonly SavedLayout[], id: string): SavedLayout[] {
  return list.filter((entry) => entry.id !== id)
}

/* === persistence ============================================================ */

/** The preload bridge, or undefined outside the app (unit tests, SSR). */
function bridge(): Window['api'] | undefined {
  return typeof window !== 'undefined' ? window.api : undefined
}

/** Whatever is on disk, or an empty list — a read failure is not an error here. */
export async function loadSavedLayouts(): Promise<SavedLayout[]> {
  try {
    const list = await bridge()?.loadLayouts()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** Fire-and-forget write; a failed save must not interrupt an editing session. */
export function persistSavedLayouts(list: readonly SavedLayout[]): void {
  void bridge()
    ?.saveLayouts(list.slice())
    .catch(() => {
      /* the list is still correct in memory; the next save will try again */
    })
}
