/**
 * The two grid menus, as pure builders: the quick-spawn menu an empty zone
 * raises (design 1c) and the menu a live pane raises from its ⋯ or a right-click.
 *
 * They return `MenuItem[]` and nothing else — every store write, every modal and
 * every piece of state arrives as a callback on the context. That keeps the menu
 * shapes readable in one place and lets the grid stay the only component that
 * knows how to spawn, move or close a pane.
 *
 * House rule throughout: an action that cannot run right now is DISABLED with a
 * `title` saying why, never dropped. A vanished row reads as a missing feature.
 */
import type { JSX } from 'react'
import { Copy, Plus, Server, SquareTerminal, UserRound } from 'lucide-react'
import type { ClaudeAccount, Pane } from '../../../shared/types'
import { DEFAULT_ACCOUNT_ID } from '../../../shared/types'
import type { PaneInit } from '../store/app'
import { neighborZoneInDirection, zoneOfPane, type Dir, type ZoneLayout } from '../lib/zones'
import type { MenuItem } from './ui'
import './paneMenu.css'

/** Every lucide glyph in a menu is drawn at this size, in the muted grey. */
const ICON = 13

/**
 * Claude Code's own mark. The one glyph in the app that is NOT a lucide icon —
 * it is the CLI's identity, and a generic sparkle would read as a different
 * product.
 */
function ClaudeGlyph({ muted }: { muted?: boolean }): JSX.Element {
  return (
    <span className={`ada-menu-claude${muted ? ' ada-menu-claude--muted' : ''}`} aria-hidden>
      ✻
    </span>
  )
}

/** The eight pane hues, as the swatch row draws them. */
const PANE_HUES: readonly { hue: number; label: string }[] = [
  { hue: 16, label: 'Ember' },
  { hue: 40, label: 'Amber' },
  { hue: 80, label: 'Moss' },
  { hue: 150, label: 'Jade' },
  { hue: 190, label: 'Teal' },
  { hue: 220, label: 'Steel' },
  { hue: 265, label: 'Iris' },
  { hue: 320, label: 'Plum' }
]

/** A pane colour is stored as the CSS the header paints with, hue and all. */
export function paneColor(hue: number): string {
  return `hsl(${hue} 70% 60%)`
}

/* === quick spawn (design 1c) ================================================ */

export interface QuickSpawnContext {
  /** ~/.ssh/config hosts; null while the caller is still reading them. */
  sshHosts: string[] | null
  accounts: ClaudeAccount[]
  /** False when the workspace has no focused pane to duplicate. */
  canDuplicate: boolean
  /** Spawn into the zone this menu was opened on. */
  onSpawn: (init: PaneInit) => void
  /** Copy the workspace's focused pane into this zone. */
  onDuplicate: () => void
  /** Open the "name your agent" dialog; spawning is its business. */
  onNewAgent: () => void
}

/** The ssh host rows, re-read from ~/.ssh/config each time the menu opens. */
function sshHostItems(hosts: string[] | null, pick: (host: string) => void): MenuItem[] {
  if (hosts === null) return [{ label: 'Loading…', disabled: true }]
  if (hosts.length === 0) return [{ label: 'No hosts in ~/.ssh/config', disabled: true }]
  return hosts.map((host) => ({ label: host, onClick: () => pick(host) }))
}

export function buildQuickSpawnMenu(ctx: QuickSpawnContext): MenuItem[] {
  const items: MenuItem[] = [
    {
      sectionLabel: 'SPAWN HERE',
      label: 'Claude Code',
      icon: <ClaudeGlyph />,
      hint: '↵',
      onClick: () => ctx.onSpawn({ kind: 'claude' })
    },
    {
      label: 'Terminal',
      icon: <SquareTerminal size={ICON} />,
      onClick: () => ctx.onSpawn({ kind: 'terminal' })
    },
    {
      label: 'Claude Code · plan mode',
      icon: <ClaudeGlyph muted />,
      onClick: () => ctx.onSpawn({ kind: 'claude', planMode: true })
    },
    {
      label: 'Connect to server',
      icon: <Server size={ICON} />,
      divider: true,
      submenu: sshHostItems(ctx.sshHosts, (host) =>
        ctx.onSpawn({ kind: 'ssh', sshHost: host, name: host })
      )
    }
  ]

  // A single-account household has nothing to choose between, so the row would
  // only ever restate the one answer.
  if (ctx.accounts.length > 1) {
    items.push({
      label: 'Claude Code as',
      icon: <UserRound size={ICON} />,
      submenu: ctx.accounts.map((account) => ({
        label: account.label,
        onClick: () => ctx.onSpawn({ kind: 'claude', accountId: account.id })
      }))
    })
  }

  items.push(
    {
      label: 'Duplicate pane',
      icon: <Copy size={ICON} />,
      divider: true,
      disabled: !ctx.canDuplicate,
      ...(ctx.canDuplicate ? {} : { title: 'Focus a pane first — there is nothing to copy yet' }),
      onClick: ctx.onDuplicate
    },
    { label: 'New agent…', icon: <Plus size={ICON} />, onClick: ctx.onNewAgent }
  )
  return items
}

/* === the pane menu ========================================================== */

export interface PaneMenuContext {
  pane: Pane
  layout: ZoneLayout
  accounts: ClaudeAccount[]
  maximized: boolean
  /** Decides the wording of the reveal row: Finder, Explorer, file manager. */
  platform: NodeJS.Platform
  /** The terminal's current selection, when the pane can report one. */
  getSelection?: () => string
  onCopyText: (text: string) => void
  onRename: () => void
  onSetColor: (color: string | undefined) => void
  onCopyPath: () => void
  onRevealPath: () => void
  onSplit: (dir: 'right' | 'down') => void
  onMove: (dir: Dir) => void
  onToggleMaximize: () => void
  onSetAccount: (accountId: string) => void
  onStartFresh: () => void
  onClose: () => void
}

/** What "show me this folder" is called on this host. */
export function revealLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Show in file manager'
}

/** The swatch row plus the reset, as one submenu. */
function colorSubmenu(ctx: PaneMenuContext): MenuItem[] {
  const chosen = ctx.pane.color
  return [
    {
      label: 'Swatches',
      content: (
        <div className="ada-pane-swatches">
          {PANE_HUES.map(({ hue, label }) => {
            const color = paneColor(hue)
            return (
              <button
                key={hue}
                type="button"
                className={`ada-pane-swatch${chosen === color ? ' is-on' : ''}`}
                style={{ background: color }}
                title={label}
                aria-label={label}
                aria-pressed={chosen === color}
                onClick={() => ctx.onSetColor(color)}
              />
            )
          })}
        </div>
      )
    },
    {
      label: 'Default',
      divider: true,
      disabled: !chosen,
      ...(chosen ? {} : { title: 'This pane already uses the default colour' }),
      onClick: () => ctx.onSetColor(undefined)
    }
  ]
}

/** Move rows: one per direction, disabled where the canvas has no neighbour. */
function moveSubmenu(ctx: PaneMenuContext): MenuItem[] {
  const zoneId = zoneOfPane(ctx.layout, ctx.pane.id)
  const row = (dir: Dir, label: string): MenuItem => {
    const neighbor = zoneId ? neighborZoneInDirection(ctx.layout, zoneId, dir) : null
    if (neighbor) return { label, onClick: () => ctx.onMove(dir) }
    return { label, disabled: true, title: `There is no zone ${dir} of this pane` }
  }
  return [
    row('left', 'Left'),
    row('right', 'Right'),
    row('up', 'Up'),
    row('down', 'Down')
  ]
}

export function buildPaneMenu(ctx: PaneMenuContext): MenuItem[] {
  const selection = ctx.getSelection?.() ?? ''
  const isClaude = ctx.pane.kind === 'claude'
  const multiAccount = ctx.accounts.length > 1
  const items: MenuItem[] = []

  // Copy is the one row that is absent rather than disabled: with nothing
  // selected it is not an action the operator can even mean.
  if (selection) items.push({ label: 'Copy', onClick: () => ctx.onCopyText(selection) })

  items.push(
    { label: 'Rename…', divider: !!selection, onClick: ctx.onRename },
    { label: 'Colour', submenu: colorSubmenu(ctx) },
    { label: 'Copy path', divider: true, onClick: ctx.onCopyPath },
    { label: revealLabel(ctx.platform), onClick: ctx.onRevealPath },
    {
      label: 'Split',
      divider: true,
      submenu: [
        { label: 'Right', onClick: () => ctx.onSplit('right') },
        { label: 'Down', onClick: () => ctx.onSplit('down') }
      ]
    },
    { label: 'Move', submenu: moveSubmenu(ctx) },
    { label: ctx.maximized ? 'Restore' : 'Maximize', onClick: ctx.onToggleMaximize }
  )

  if (isClaude && multiAccount) {
    items.push({
      label: 'Run as account',
      divider: true,
      submenu: ctx.accounts.map((account) => {
        const current = (ctx.pane.accountId ?? DEFAULT_ACCOUNT_ID) === account.id
        return {
          label: account.label,
          disabled: current,
          title: current
            ? 'This pane already runs as this account'
            : 'Starts a fresh session signed in as this account',
          onClick: () => ctx.onSetAccount(account.id)
        }
      })
    })
  }

  if (isClaude) {
    items.push({
      label: 'Start fresh session',
      divider: !multiAccount,
      danger: true,
      title: 'Drops the saved session and starts a new one',
      onClick: ctx.onStartFresh
    })
  }

  items.push({ label: 'Close pane', divider: !isClaude, onClick: ctx.onClose })
  return items
}
