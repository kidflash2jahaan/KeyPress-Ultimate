/**
 * Renderer entry.
 *
 * Two things happen before the first paint, and only two: the bridge is
 * resolved (real preload, or the browser mock), and the store is built around
 * it. `init()` is deliberately not awaited. It is a handful of IPC round trips,
 * and every component already renders a correct empty state, so blocking the
 * first frame on it would buy a blank window and nothing else.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { isMockBridge, resolveBridge } from './state/bridge'
import { initAppStore } from './state/store'
import './styles/global.css'

const container = document.getElementById('root')
if (container === null) throw new Error('renderer: #root is missing from index.html')

const root = createRoot(container)

void resolveBridge().then((bridge) => {
  const store = initAppStore(bridge)
  void store.getState().actions.init()

  if (isMockBridge()) {
    // Loud on purpose. Anyone driving the UI in a browser should know the app
    // list, the focus changes and the session are all fake.
    console.info(
      'KeyPress Ultimate: no Electron bridge found, running against the mock in src/renderer/mock/bridge.ts.',
    )
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
