import { useId, type JSX } from 'react'
import { useActions, useAppStore } from '../state/store'
import styles from './TargetStrip.module.css'

/**
 * The target picker, and the app's cheapest teaching moment.
 *
 * The frontmost app is shown live from the first paint, long before Start is
 * pressed, and the chip for it is marked "front". So by the time a user presses
 * Start with our own window focused and sees nothing fire, they have already
 * watched that readout follow their attention around the desktop, and
 * "Armed, waiting" reads as the rule working rather than the app failing.
 */

function RefreshIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M11.6 5.6A4.8 4.8 0 1 0 11.9 8.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M11.9 2.3v3.4H8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function TargetStrip(): JSX.Element {
  const apps = useAppStore((state) => state.apps)
  const targets = useAppStore((state) => state.targets)
  const focusedApp = useAppStore((state) => state.session.focusedApp)
  const actions = useActions()

  const headingId = useId()
  const focusedIdentity = focusedApp?.identity ?? null

  return (
    <section className={styles.strip} aria-labelledby={headingId}>
      <div className={styles.head}>
        <h2 className={styles.heading} id={headingId}>
          Targets
        </h2>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void actions.refreshApps()}
        >
          <RefreshIcon />
          Refresh list
        </button>
      </div>

      {apps.length === 0 ? (
        <p className={styles.empty}>
          Nothing else is running with a window right now. Open the game or app you want to target,
          then press Refresh list.
        </p>
      ) : (
        <div className={styles.scroller} role="group" aria-label="Applications you can target">
          {apps.map((app) => {
            const picked = targets.includes(app.identity)
            const isFront = app.identity === focusedIdentity
            return (
              <button
                key={app.identity}
                type="button"
                className={styles.chip}
                aria-pressed={picked}
                data-front={isFront ? 'true' : undefined}
                onClick={() => actions.toggleTarget(app.identity)}
              >
                {app.iconDataUrl === undefined ? (
                  <span className={styles.iconFallback} aria-hidden="true">
                    {app.name.slice(0, 1)}
                  </span>
                ) : (
                  <img className={styles.icon} src={app.iconDataUrl} alt="" width={16} height={16} />
                )}
                <span className={styles.chipName}>{app.name}</span>
                {isFront ? <span className={styles.front}>front</span> : null}
              </button>
            )
          })}
        </div>
      )}

      <p className={styles.focus}>
        <span className={styles.focusLabel}>Frontmost now</span>
        <span className={styles.focusValue}>{focusedApp?.name ?? 'Unknown'}</span>
        {targets.length === 0 ? (
          <span className={styles.focusHint}>
            Keys fire only while one of your targets is the frontmost window.
          </span>
        ) : null}
      </p>
    </section>
  )
}
