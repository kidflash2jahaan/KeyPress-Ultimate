import type { JSX } from 'react'
import { useActions, useAppStore } from '../state/store'
import styles from './UpdateBanner.module.css'

/**
 * Silent until there is something to say. When there is, it says the version,
 * what changed, how far the download got, and offers exactly one action.
 *
 * The progress bar is always determinate. A custom updater knows the asset's
 * size before it starts, so an indeterminate bar here would be decoration, and
 * it would also be the app's second looping animation.
 */
export function UpdateBanner(): JSX.Element | null {
  const update = useAppStore((state) => state.update)
  const stage = useAppStore((state) => state.updateStage)
  const progress = useAppStore((state) => state.updateProgress)
  const actions = useActions()

  if (update === null || stage === 'none') return null

  const fraction = progress?.fraction ?? 0
  const notes = update.notes.split('\n').filter((line) => line.trim() !== '')

  return (
    <section className={styles.banner} aria-labelledby="update-banner-heading">
      <div className={styles.main}>
        <h2 className={styles.heading} id="update-banner-heading">
          Version {update.version} is ready to download
        </h2>

        {stage === 'downloading' || stage === 'ready' ? (
          <div className={styles.progressRow}>
            <div
              className={styles.track}
              role="progressbar"
              aria-label={`Downloading version ${update.version}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
            >
              <div className={styles.fill} style={{ transform: `scaleX(${fraction})` }} />
            </div>
            <p className={styles.progressText}>
              {stage === 'ready'
                ? 'Downloaded and verified.'
                : `${formatBytes(progress?.receivedBytes ?? 0)} of ${formatBytes(update.sizeBytes)}`}
            </p>
          </div>
        ) : (
          <details className={styles.notes}>
            <summary className={styles.notesSummary}>
              What changed ({formatBytes(update.sizeBytes)} download)
            </summary>
            <ul className={styles.notesList}>
              {notes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void actions.openReleasesPage()}
        >
          Open the release page
        </button>
        {stage === 'ready' ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => void actions.installUpdate()}
          >
            Install and relaunch
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            disabled={stage === 'downloading'}
            onClick={() => void actions.downloadUpdate()}
          >
            {stage === 'downloading' ? 'Downloading…' : 'Download'}
          </button>
        )}
      </div>
    </section>
  )
}

/** Non-breaking space between the number and its unit, so it never wraps. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u00a0B`
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${Math.round(bytes / 1024)}\u00a0KB`
  return `${mb.toFixed(mb < 10 ? 1 : 0)}\u00a0MB`
}
