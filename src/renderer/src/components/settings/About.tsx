import { useEffect, useState, type JSX } from 'react'
import { Button } from '../ui'
import Logo from '../Logo'
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
          <Button size="sm" onClick={() => void window.api?.revealLogs()}>
            Reveal logs
          </Button>
        </div>
      </div>
    </>
  )
}
