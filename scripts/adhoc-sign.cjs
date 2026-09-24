/**
 * electron-builder `afterSign` hook: give the macOS app an ad-hoc signature
 * when there is no Apple identity to sign it with.
 *
 * Without ANY signature an arm64 app does not launch at all — macOS reports it
 * as "damaged" — so a build with no certificate is worse than useless. An
 * ad-hoc signature (`codesign -s -`) makes it a valid app that Gatekeeper
 * merely holds at first open, which the user clears once (see README →
 * Installing on a Mac). With a real identity configured (CSC_LINK / the
 * keychain) electron-builder signs itself and this hook does nothing.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const config = context.packager.config
  // electron-builder only reaches this hook without signing when discovery is
  // off or the identity is explicitly null; either way, nothing signed the app.
  const signed = process.env.CSC_LINK || (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false' && config.mac?.identity !== null)
  if (signed) return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const app = path.join(context.appOutDir, appName)
  const entitlements = path.resolve(config.mac?.entitlements ?? 'build/entitlements.mac.plist')
  console.log(`  • ad-hoc signing ${appName} (no Apple identity)`)
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, '--timestamp=none', app],
    { stdio: 'inherit' }
  )
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
