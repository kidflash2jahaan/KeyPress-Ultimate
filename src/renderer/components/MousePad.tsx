import { useId, type JSX } from 'react'
import type { MouseButtonId } from '../../shared/types'
import { getMouseButtons } from '../../shared/keys'
import { useActions, useAppStore } from '../state/store'
import styles from './MousePad.module.css'

/**
 * A mouse drawn at roughly life size, with the five real buttons as hit
 * regions on the body and the two wheel detents kept deliberately outside it.
 *
 * The wheel is not a button. It emits detents, so there is no down/up pair to
 * hold, and drawing it as a third cap on the body would promise a held state
 * that cannot exist. It sits beside the mouse instead, dashed and flat, with
 * one line saying what it does instead.
 */

const BODY_BUTTONS: readonly MouseButtonId[] = ['left', 'right', 'middle', 'back', 'forward']
const WHEEL_BUTTONS: readonly MouseButtonId[] = ['wheel-up', 'wheel-down']

const SHORT_LABEL: Record<MouseButtonId, string> = {
  left: 'Left',
  right: 'Right',
  middle: 'Mid',
  back: 'Back',
  forward: 'Fwd',
  'wheel-up': 'Scroll up',
  'wheel-down': 'Scroll down',
}

export function MousePad(): JSX.Element {
  const selected = useAppStore((state) => state.buttonIds)
  const firing = useAppStore((state) => state.session.firingButtonIds)
  const mode = useAppStore((state) => state.mode)
  const actions = useActions()

  const headingId = useId()
  const wheelNoteId = useId()
  const buttons = getMouseButtons()

  function stateFor(id: MouseButtonId, holdable: boolean): {
    pressed: boolean
    firing: boolean
    disabled: boolean
  } {
    return {
      pressed: selected.includes(id),
      firing: firing.includes(id),
      disabled: mode === 'hold' && !holdable,
    }
  }

  return (
    <section className={styles.pad} aria-labelledby={headingId}>
      <h2 className={styles.heading} id={headingId}>
        Mouse
      </h2>

      <div className={styles.body}>
        <div className={styles.mouse}>
          {/* The shell is decoration; every hit region below is a real button. */}
          <span className={styles.seam} aria-hidden="true" />
          {BODY_BUTTONS.map((id) => {
            const def = buttons.find((button) => button.id === id)
            if (def === undefined) return null
            const state = stateFor(id, def.holdable)
            return (
              <button
                key={id}
                type="button"
                className={`${styles.region ?? ''} ${styles[id] ?? ''}`}
                aria-pressed={state.pressed}
                aria-label={`${def.label}. ${def.description}`}
                data-firing={state.firing ? 'true' : undefined}
                onClick={() => actions.toggleButton(id)}
              >
                <span className={styles.regionLabel}>{SHORT_LABEL[id]}</span>
              </button>
            )
          })}
        </div>

        <div className={styles.wheelColumn}>
          <h3 className={styles.subheading}>Wheel</h3>
          <div className={styles.wheelButtons}>
            {WHEEL_BUTTONS.map((id) => {
              const def = buttons.find((button) => button.id === id)
              if (def === undefined) return null
              const state = stateFor(id, def.holdable)
              return (
                <button
                  key={id}
                  type="button"
                  className={styles.detent}
                  aria-pressed={state.pressed}
                  aria-describedby={wheelNoteId}
                  disabled={state.disabled}
                  data-firing={state.firing ? 'true' : undefined}
                  onClick={() => actions.toggleButton(id)}
                >
                  <span className={styles.detentArrow} aria-hidden="true">
                    {id === 'wheel-up' ? <ArrowUpIcon /> : <ArrowDownIcon />}
                  </span>
                  {SHORT_LABEL[id]}
                </button>
              )
            })}
          </div>
          <p className={styles.wheelNote} id={wheelNoteId}>
            A wheel has no held state, so these repeat instead of holding. Pick Tap or Hold + repeat
            to use them.
          </p>
        </div>
      </div>
    </section>
  )
}

function ArrowUpIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
      <path d="M5 8V2M2.4 4.6L5 2l2.6 2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ArrowDownIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
      <path d="M5 2v6M2.4 5.4L5 8l2.6-2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
