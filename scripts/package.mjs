/**
 * `pnpm package:<platform>` — electron-builder with the output directory pinned
 * to `release/<platform>/version_<x_y_z>/`, so builds of different platforms
 * and versions sit side by side instead of overwriting one another in the flat
 * `release/` folder electron-builder defaults to.
 *
 *   node scripts/package.mjs win            → release/win/version_0_1_0/
 *   node scripts/package.mjs linux dir      → release/linux/version_0_1_0/linux-unpacked
 *   node scripts/package.mjs mac
 *
 * The version comes from package.json, dots replaced with underscores. Anything
 * after the platform is handed to electron-builder unchanged.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [platform, ...rest] = process.argv.slice(2)

const PLATFORMS = new Set(['win', 'linux', 'mac'])
if (!PLATFORMS.has(platform)) {
  console.error(`usage: node scripts/package.mjs <win|linux|mac> [electron-builder args]`)
  process.exit(2)
}

const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const output = path.posix.join('release', platform, `version_${version.replace(/\./g, '_')}`)

const command = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
const bin = path.join(repoRoot, 'node_modules', '.bin', command)
const args = [`--${platform}`, ...rest, `--config.directories.output=${output}`]

console.log(`packaging ${platform} ${version} → ${output}/`)
const result = spawnSync(bin, args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(result.status ?? 1)
