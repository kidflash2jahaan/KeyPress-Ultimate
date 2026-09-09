import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Platform } from '../../shared/types'
import { isSessionArmed, useActions, useAppStore } from '../state/store'
import { StatusLine, summarise } from './StatusLine'
import styles from './ActionBar.module.css'

/**
 * The sticky bottom band: one primary action, what is happening, how long it
 * has been happening, and the way out.
 *
 * Start is never disabled. A greyed-out button makes the user hunt for the
 * reason; a button that answers "no target app is picked, choose one above"
 * teaches the rule in one click.
 */

export function ActionBar(): JSX.Element {
  const phase = useAppStore((state) => state.session.phase)
  const startedAt = useAppStore((state) => state.session.startedAt)
  const platform = useAppStore((state) => state.platform)
  const panicHotkey = useAppStore((state) => state.settings.panicHotkey)
  const notice = useAppStore((state) => state.notice)
  const summary = useAppStore(
    useShallow((state) =>
      summarise(state.keyIds, state.buttonIds, state.targets, state.session),
    ),
  )
  const actions = useActions()

  const armed = isSessionArmed(phase)

  return (
    <footer className={styles.bar} data-phase={phase}>
      {notice === null ? null : (
        <div
          className={styles.notice}
          data-kind={notice.kind}
          role={notice.kind === 'problem' ? 'alert' : 'status'}
        >
          <p className={styles.noticeText}>{notice.text}</p>
          <button
            type="button"
            className={styles.noticeDismiss}
            onClick={() => actions.dismissNotice()}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className={styles.row}>
        <button
          type="button"
          className={styles.primary}
          data-armed={armed ? 'true' : undefined}
          onClick={() => void (armed ? actions.stop() : actions.start())}
        >
          {armed ? <StopIcon /> : <StartIcon />}
          {armed ? 'Stop' : 'Start'}
        </button>

        <StatusLine />

        <dl className={styles.readouts}>
          <div className={styles.readout}>
            <dt className={styles.readoutLabel}>Selected</dt>
            <dd className={styles.readoutValue}>{summary}</dd>
          </div>
          <div className={styles.readout}>
            <dt className={styles.readoutLabel}>Elapsed</dt>
            <dd className={styles.readoutValue}>
              <Elapsed startedAt={armed ? startedAt : null} />
            </dd>
          </div>
          <div className={styles.readout}>
            <dt className={styles.readoutLabel}>Panic</dt>
            <dd className={styles.readoutValue}>{formatAccelerator(panicHotkey, platform)}</dd>
          </div>
        </dl>
      </div>
    </footer>
  )
}

/**
 * Its own component so the once-a-second tick re-renders eight characters
 * rather than the whole bar.
 */
function Elapsed({ startedAt }: { startedAt: number | null }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return
    // No synchronous setState here: the initialiser already read the clock, and
    // the first tick lands 1s later, which is exactly when the display changes.
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  if (startedAt === null) return <span className={styles.readoutIdle}>Not running</span>

  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  const text = hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`

  return <time dateTime={`PT${seconds}S`}>{text}</time>
}

/** Electron accelerators are not what a user reads on their own keyboard. */
export function formatAccelerator(accelerator: string, platform: Platform): string {
  const mac = platform === 'darwin'
  return accelerator
    .split('+')
    .map((part) => {
      switch (part) {
        case 'CommandOrControl':
        case 'CmdOrCtrl':
          return mac ? '⌘' : 'Ctrl'
        case 'Command':
        case 'Cmd':
          return '⌘'
        case 'Control':
        case 'Ctrl':
          return mac ? '⌃' : 'Ctrl'
        case 'Alt':
          return mac ? '⌥' : 'Alt'
        case 'Option':
          return '⌥'
        case 'Shift':
          return mac ? '⇧' : 'Shift'
        default:
          return part
      }
    })
    .join(mac ? '' : '+')
}

function StartIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M3.4 2.2l6 3.8-6 3.8z" fill="currentColor" />
    </svg>
  )
}

function StopIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  )
}
