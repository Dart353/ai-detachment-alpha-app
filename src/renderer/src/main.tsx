import ReactDOM from 'react-dom/client'
import App from './App'
import { useApp } from './store/app'
import { useRuntime } from './store/runtime'
// The mono face is bundled, not fetched: a cold offline launch must not fall
// back to a system stack and leave xterm measuring the wrong cell.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles/tokens.css'
import './styles/base.css'

// Mark the host platform so chrome can adapt per-OS — the title bar reserving
// room for the macOS traffic lights is the case that needs it today.
document.body.classList.add(`platform-${window.api.platform}`)

// The e2e smoke test drives the app the way the UI does — through the stores —
// rather than by synthesizing clicks at coordinates that every layout change
// would invalidate. Exposed in development and when main asked for it with
// `?e2e=1` (which it only does for a throwaway userData profile); a packaged
// launch has neither, so nothing is reachable from a real window.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('e2e')) {
  window.__ada = { useApp, useRuntime }
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
