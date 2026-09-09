import type { JSX } from 'react'
import { useActions, useAppStore } from '../state/store'
import styles from './PermissionGate.module.css'

/**
 * Shown only on macOS, and only while Accessibility is still ungranted.
 *
 * There is no progress bar and no spinner here. Granting the permission is
 * something the user does in another app, at their own pace, and pretending to
 * track it would be a lie in a band whose whole job is to be believed.
 *
 * The prompt only ever appears once per app identity. Once it has been used, a
 * button offering to ask again cannot work, so this leads with the manual
 * steps instead and demotes the deep link to what it really is: a shortcut to
 * the right settings pane.
 */
export function PermissionGate(): JSX.Element | null {
  const platform = useAppStore((state) => state.platform)
  const permissions = useAppStore((state) => state.permissions)
  const actions = useActions()

  if (platform !== 'darwin') return null
  if (!permissions.needsPermission || permissions.hasPermission) return null

  const alreadyPrompted = permissions.promptWasAlreadyUsed

  return (
    <section className={styles.gate} aria-labelledby="permission-gate-heading">
      <div className={styles.text}>
        <h2 className={styles.heading} id="permission-gate-heading">
          macOS has not allowed KeyPress Ultimate to send input yet
        </h2>

        {alreadyPrompted ? (
          <>
            <p className={styles.body}>
              macOS shows its Accessibility prompt once per app, and that has already happened, so
              nothing here can ask again. Add the app by hand:
            </p>
            <ol className={styles.steps}>
              <li>Open System Settings, then Privacy &amp; Security, then Accessibility.</li>
              <li>
                Click <span className={styles.literal}>+</span> under the list.
              </li>
              <li>Pick KeyPress Ultimate from Applications, then switch it on.</li>
            </ol>
          </>
        ) : (
          <p className={styles.body}>
            Accessibility is the one permission this app needs, and macOS will not deliver a single
            keystroke without it. Grant it, come back, and nothing else changes.
          </p>
        )}
      </div>

      <button
        type="button"
        className={styles.action}
        onClick={() => void actions.openPermissionSettings()}
      >
        {alreadyPrompted ? 'Open that settings pane' : 'Open Accessibility settings'}
      </button>
    </section>
  )
}
