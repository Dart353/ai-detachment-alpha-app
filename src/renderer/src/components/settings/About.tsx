import { useCallback, useEffect, useState, type JSX } from 'react'
import { Button, Meter } from '../ui'
import Logo from '../Logo'
import type { UpdateStatus } from '../../../../shared/types'
import './settings.css'

export default function About(): JSX.Element {
  // The packaged version main reports; the build-time constant covers the
  // moment before that answer arrives (and a renderer with no bridge).
  const [version, setVersion] = useState(__APP_VERSION__)

  useEffect(() => {
    let live = true
    void window.api?.appVersion().then((value) => {
      if (live && value) setVersion(value)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <>
      <div className="ada-set-title">About</div>

      <div className="ada-set-cards">
        <div className="ada-set-card ada-about-card">
          <Logo width={66} height={40} strokeWidth={2.6} />
          <div className="ada-about-brand">AI DETACHMENT ALPHA</div>
          <div className="ada-about-version">Version {version}</div>
          <Updates />
          <Button size="sm" onClick={() => void window.api?.revealLogs()}>
            Reveal logs
          </Button>
        </div>
      </div>
    </>
  )
}

/* === updates ================================================================ */

/**
 * The update block: one line saying where the app stands, and the one button
 * that stage allows. Main owns the whole cycle and pushes every change here, so
 * this only ever reads a status — including the check it runs on its own at
 * launch, which lands here without anyone pressing anything.
 */
function Updates(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    let live = true
    void window.api?.getUpdateStatus().then((value) => {
      if (live) setStatus(value)
    })
    const off = window.api?.onUpdateStatus((value) => setStatus(value))
    return () => {
      live = false
      off?.()
    }
  }, [])

  const check = useCallback(() => {
    void window.api?.checkForUpdate().then(setStatus)
  }, [])

  if (!status) return null

  const checking = status.stage === 'checking'

  return (
    <div className="ada-about-update">
      <div className="ada-about-update-line">{updateLine(status)}</div>

      {status.stage === 'downloading' && (
        <Meter pct={status.percent} tone="accent" height={4} label="Downloading the update" />
      )}

      {status.stage === 'ready' ? (
        <Button size="sm" variant="primary" onClick={() => window.api?.installUpdate()}>
          Restart and install
        </Button>
      ) : (
        // A build that cannot update itself says so and offers no button: there
        // is nothing the click could do.
        status.stage !== 'unsupported' &&
        status.stage !== 'downloading' && (
          <Button size="sm" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
        )
      )}
    </div>
  )
}

/** What the status reads as, in one sentence. */
function updateLine(status: UpdateStatus): string {
  switch (status.stage) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${status.version} is available.`
    case 'downloading':
      return `Downloading ${status.version ?? 'the update'}…`
    case 'ready':
      return `Version ${status.version} is ready to install.`
    case 'current':
      return 'This is the newest version.'
    case 'error':
      return status.error ?? 'The update check failed.'
    case 'unsupported':
      return status.error ?? 'This build does not update itself.'
    default:
      return 'Updates install when you quit the app.'
  }
}
