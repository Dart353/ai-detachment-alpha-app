/**
 * The pure half of "Open at login": whether this build can register itself, and
 * the XDG autostart entry Linux needs. Kept free of Electron so it unit-tests;
 * `loginItem.ts` is the half that touches the OS.
 */

/** The file name under `~/.config/autostart`; matches the Linux executableName. */
export const AUTOSTART_FILE = 'ai-detachment-alpha.desktop'

export interface AutostartEnv {
  packaged: boolean
  platform: NodeJS.Platform
}

/**
 * Why this build cannot open at login, or null when it can.
 *
 * A run from source would register the bare Electron binary, which boots to
 * Electron's default page rather than the app — so only packaged builds offer it.
 */
export function autostartBlocker(env: AutostartEnv): string | null {
  if (!env.packaged) return 'Only an installed build can open at login.'
  if (env.platform === 'win32' || env.platform === 'darwin' || env.platform === 'linux') return null
  return 'Opening at login is not supported on this system.'
}

/**
 * What a login launch should run on Linux. An AppImage's `execPath` points inside
 * its temporary mount, which is gone by the next boot — the AppImage file itself
 * is the stable thing to start.
 */
export function linuxLaunchPath(execPath: string, appImage?: string): string {
  return appImage || execPath
}

/**
 * Quote one argument for a desktop entry's `Exec=` key (Desktop Entry spec,
 * "The Exec key"): wrap in double quotes, backslash-escape `"`, `` ` ``, `$` and
 * `\`, and double any `%` so it is not read as a field code.
 */
export function quoteExecArg(arg: string): string {
  return `"${arg.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`
}

/** The whole `.desktop` file that makes a desktop session start the app. */
export function autostartDesktopEntry(launchPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=AI Detachment Alpha',
    'Comment=A minimal terminal multiplexer for Claude Code',
    `Exec=${quoteExecArg(launchPath)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}
