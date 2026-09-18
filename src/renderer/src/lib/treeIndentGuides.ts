/**
 * Tree indent guides.
 *
 * The flat headless-tree list the explorer renders shows nesting purely as
 * paddingLeft on sibling rows, so a guide line can never be one wrapper border:
 * each row at depth N paints one 1px stripe per ancestor level, and the per-row
 * segments stack into continuous verticals. The stripes are background gradients —
 * backgrounds never capture pointer events, and these inline longhands survive the
 * class-level `background:` shorthands that hover / selected / drop-target set.
 * Colour comes from `--ada-tree-guide`, set on the panel in ExplorerPanel.css.
 */
import type { CSSProperties } from 'react'

/** Per-tree spacing: rows sit at `paddingLeft = gutter + level * indent`. */
export interface TreeIndentMetrics {
  indent: number
  gutter: number
}

/**
 * Inline style for a tree row at `level`: the paddingLeft the tree already used,
 * plus one vertical guide per ancestor level, centred under that ancestor's
 * chevron column (half an indent step past the ancestor's own padding).
 */
export function treeRowIndentStyle(
  level: number,
  { indent, gutter }: TreeIndentMetrics
): CSSProperties {
  const style: CSSProperties = { paddingLeft: gutter + level * indent }
  if (level > 0) {
    const stops = Array.from(
      { length: level },
      (_, ancestor) => gutter + ancestor * indent + indent / 2
    )
    style.backgroundImage = stops
      .map(() => 'linear-gradient(var(--ada-tree-guide), var(--ada-tree-guide))')
      .join(', ')
    style.backgroundPosition = stops.map((offset) => `${offset}px 0`).join(', ')
    style.backgroundRepeat = 'no-repeat'
    style.backgroundSize = '1px 100%'
  }
  return style
}
