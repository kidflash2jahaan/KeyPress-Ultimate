import { useEffect, useId, useRef, type JSX } from 'react'
import type { Settings } from '../../shared/types'
import { useActions, useAppStore } from '../state/store'
import { formatAccelerator } from './ActionBar'
import styles from './SettingsSheet.module.css'

/**
 * Settings as a sheet over the plate, not a separate screen. There are six of
 * them; a routed page would be ceremony.
 *
 * The two limitations at the bottom are here rather than buried in a readme
 * because they are the two things most likely to make someone think the app is
 * broken when it is working exactly as designed.
 */

const THEMES: readonly { value: Settings['theme']; label: string }[] = [
  { value: 'system', label: 'Follow the system' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

export function SettingsSheet(): JSX.Element | null {
  const open = useAppStore((state) => state.settingsOpen)
  const settings = useAppStore((state) => state.settings)
  const platform = useAppStore((state) => state.platform)
  const appVersion = useAppStore((state) => state.appVersion)
  const actions = useActions()

  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusTo = useRef<Element | null>(null)

  const titleId = useId()
  const themeName = useId()
  const capId = useId()
  const autoUpdateId = useId()
  const virtualKeysId = useId()

  useEffect(() => {
    if (!open) return
    returnFocusTo.current = document.activeElement
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus()

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') actions.setSettingsOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const previous = returnFocusTo.current
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [open, actions])

  if (!open) return null

  return (
    <div className={styles.scrim} onPointerDown={() => actions.setSettingsOpen(false)}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <h2 className={styles.title} id={titleId}>
            Settings
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={() => actions.setSettingsOpen(false)}
          >
            Done
          </button>
        </header>

        <div className={styles.body}>
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Appearance</legend>
            <div className={styles.radios}>
              {THEMES.map((theme) => (
                <label key={theme.value} className={styles.radio}>
                  <input
                    type="radio"
                    name={themeName}
                    value={theme.value}
                    checked={settings.theme === theme.value}
                    onChange={() => void actions.updateSettings({ theme: theme.value })}
                  />
                  <span>{theme.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.group}>
            <legend className={styles.legend}>Safety</legend>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={capId}>
                Stop on its own after
              </label>
              <div className={styles.inline}>
                <input
                  id={capId}
                  className={styles.number}
                  type="number"
                  inputMode="numeric"
                  autoComplete="off"
                  min={0}
                  max={480}
                  step={5}
                  value={settings.maxSessionMinutes}
                  aria-describedby={`${capId}-hint`}
                  onChange={(event) =>
                    void actions.updateSettings({
                      maxSessionMinutes: Math.max(0, Math.round(Number(event.target.value) || 0)),
                    })
                  }
                />
                <span className={styles.unit}>minutes</span>
              </div>
              <p className={styles.hint} id={`${capId}-hint`}>
                {settings.maxSessionMinutes === 0
                  ? 'Set to 0, so a session runs until you stop it.'
                  : 'Set to 0 if you would rather it run until you stop it.'}
              </p>
            </div>

            <div className={styles.field}>
              <p className={styles.fieldLabel}>Panic hotkey</p>
              <p className={styles.keycombo}>{formatAccelerator(settings.panicHotkey, platform)}</p>
              <p className={styles.hint}>
                Registered only while a session is armed, and it releases everything instantly. If
                the system refuses to register it, Start is refused too, because a panic button that
                quietly does nothing is worse than none.
              </p>
            </div>
          </fieldset>

          <fieldset className={styles.group}>
            <legend className={styles.legend}>Updates</legend>
            <label className={styles.check} htmlFor={autoUpdateId}>
              <input
                id={autoUpdateId}
                type="checkbox"
                checked={settings.autoCheckUpdates}
                onChange={(event) =>
                  void actions.updateSettings({ autoCheckUpdates: event.target.checked })
                }
              />
              <span>Check for updates at launch</span>
            </label>
            <div className={styles.inline}>
              <button
                type="button"
                className={styles.button}
                onClick={() => void actions.checkForUpdates()}
              >
                Check now
              </button>
              <span className={styles.version}>You are on {appVersion}</span>
            </div>
          </fieldset>

          {platform === 'win32' ? (
            <fieldset className={styles.group}>
              <legend className={styles.legend}>Windows input</legend>
              <label className={styles.check} htmlFor={virtualKeysId}>
                <input
                  id={virtualKeysId}
                  type="checkbox"
                  checked={settings.windowsUseVirtualKeys}
                  onChange={(event) =>
                    void actions.updateSettings({ windowsUseVirtualKeys: event.target.checked })
                  }
                />
                <span>Send virtual keys instead of scancodes</span>
              </label>
              <p className={styles.hint}>
                Scancodes are what a real keyboard sends, so they work in more games. A few titles
                read virtual keys instead. Turn this on only if a game ignores the app entirely.
              </p>
            </fieldset>
          ) : null}

          <section className={styles.group}>
            <h3 className={styles.legend}>Two things that are not bugs</h3>
            <p className={styles.hint}>
              Games with kernel anti-cheat, like Vanguard, EAC and BattlEye, can detect synthetic
              input however it is made. Some ignore it, some ban for it. This app will never try to
              hide from them.
            </p>
            <p className={styles.hint}>
              Games that read the keyboard as raw HID may not see injected input at all. That is a
              driver-level problem, and it is out of scope here.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
