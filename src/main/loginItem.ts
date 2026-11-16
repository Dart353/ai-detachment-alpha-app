import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LoginItemStatus } from '../shared/types'
import {
  AUTOSTART_FILE,
  autostartBlocker,
  autostartDesktopEntry,
  linuxLaunchPath
} from './autostart'
import { log } from './log'

/**
 * "Open at login". The OS is the source of truth — Windows' Run key, macOS'
 * login items, the XDG autostart folder on Linux — rather than a field in
 * settings.json, so the toggle can never claim something the next boot will not
 * do (the user can remove the entry from the OS's own startup list behind our
 * back, and an uninstall leaves settings.json but takes the registration).
 */

function blocker(): string | null {
  return autostartBlocker({
    packaged: app.isPackaged,
    platform: process.platform
  })
}

/** `$XDG_CONFIG_HOME/autostart`, falling back to `~/.config/autostart`. */
function autostartDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'), 'autostart')
}

function linuxEntryPath(): string {
  return path.join(autostartDir(), AUTOSTART_FILE)
}

export function getLoginItem(): LoginItemStatus {
  const reason = blocker()
  if (reason) return { supported: false, enabled: false, reason }
  if (process.platform === 'linux') {
    return { supported: true, enabled: fs.existsSync(linuxEntryPath()) }
  }
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin }
}

export function setLoginItem(enabled: boolean): LoginItemStatus {
  if (blocker()) return getLoginItem()
  try {
    if (process.platform === 'linux') {
      const file = linuxEntryPath()
      if (enabled) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const launch = linuxLaunchPath(process.execPath, process.env['APPIMAGE'])
        fs.writeFileSync(file, autostartDesktopEntry(launch), { mode: 0o644 })
      } else {
        fs.rmSync(file, { force: true })
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled })
    }
    log.info(`open at login ${enabled ? 'enabled' : 'disabled'}`)
  } catch (err) {
    log.warn(`open at login: could not ${enabled ? 'enable' : 'disable'}: ${String(err)}`)
    return { ...getLoginItem(), reason: 'The system refused the change.' }
  }
  return getLoginItem()
}
