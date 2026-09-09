import type { JSX } from 'react'
import type { SessionPhase } from '../../shared/types'
import { useActions, useAppStore } from '../state/store'
import { PresetMenu } from './PresetMenu'
import styles from './TitleBar.module.css'

/**
 * The frameless top band: wordmark, the one global state indicator, presets,
 * settings, and window controls where the OS does not draw them.
 *
 * The status pill carries the only looping animation in the app, and it loops
 * in exactly one phase. Everything else here is static.
 */

const PHASE_WORD: Record<SessionPhase, string> = {
  idle: 'Idle',
  'armed-waiting': 'Armed, waiting',
  firing: 'Firing',
  blocked: 'Blocked',
  error: 'Stopped',
}

function MinimizeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  )
}

function SettingsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4L3.3 3.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function TitleBar(): JSX.Element {
  const phase = useAppStore((state) => state.session.phase)
  const platform = useAppStore((state) => state.platform)
  const actions = useActions()

  return (
    <header className={`app-drag ${styles.bar ?? ''}`} data-phase={phase}>
      {/* macOS draws its own traffic lights into this inset. */}
      {platform === 'darwin' ? <div className={styles.trafficLightInset} aria-hidden="true" /> : null}

      <h1 className={styles.wordmark}>KeyPress Ultimate</h1>

      <p className={styles.pill} data-phase={phase}>
        <span className={styles.dot} aria-hidden="true" />
        {PHASE_WORD[phase]}
      </p>

      <div className={styles.right}>
        <PresetMenu />

        <button
          type="button"
          className={styles.iconButton}
          aria-label="Settings"
          onClick={() => actions.setSettingsOpen(true)}
        >
          <SettingsIcon />
        </button>

        {platform === 'win32' ? (
          <div className={styles.windowControls}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Minimize window"
              onClick={() => void actions.minimizeWindow()}
            >
              <MinimizeIcon />
            </button>
            <button
              type="button"
              className={`${styles.iconButton ?? ''} ${styles.closeButton ?? ''}`}
              aria-label="Close window"
              onClick={() => void actions.closeWindow()}
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
