import { useId, type JSX } from 'react'
import type { HoldMode } from '../../shared/types'
import { LIMITS, useActions, useAppStore } from '../state/store'
import styles from './ModeControls.module.css'

/**
 * How the selected keys are sent. Three modes, and only the fields that belong
 * to the chosen one are on screen.
 *
 * The labels avoid the words the internals use. "Hold + repeat" is not called
 * typematic or autorepeat, and the field is "first repeat after" rather than
 * "initial delay", because that is what the number actually does.
 */

interface ModeOption {
  id: HoldMode
  label: string
  blurb: string
}

const MODES: readonly ModeOption[] = [
  {
    id: 'hold',
    label: 'Hold',
    blurb: 'Presses once and keeps it down. Nothing else is sent until you stop or leave the target.',
  },
  {
    id: 'hold-repeat',
    label: 'Hold + repeat',
    blurb: 'Keeps it down and re-sends the press, the way a keyboard repeats a held key.',
  },
  {
    id: 'tap',
    label: 'Tap',
    blurb: 'Presses and releases over and over, at the interval you set.',
  },
]

export function ModeControls(): JSX.Element {
  const mode = useAppStore((state) => state.mode)
  const repeatInitialMs = useAppStore((state) => state.repeatInitialMs)
  const repeatIntervalMs = useAppStore((state) => state.repeatIntervalMs)
  const tapIntervalMs = useAppStore((state) => state.tapIntervalMs)
  const actions = useActions()

  const headingId = useId()
  const groupName = useId()
  const active = MODES.find((option) => option.id === mode) ?? MODES[0]

  return (
    <section className={styles.controls} aria-labelledby={headingId}>
      <h2 className={styles.heading} id={headingId}>
        Mode
      </h2>

      <fieldset className={styles.fieldset}>
        <legend className={styles.visuallyHidden}>How the selection is sent</legend>
        <div className={styles.segments}>
          {MODES.map((option) => (
            <label key={option.id} className={styles.segment}>
              <input
                className={styles.segmentInput}
                type="radio"
                name={groupName}
                value={option.id}
                checked={mode === option.id}
                onChange={() => actions.setMode(option.id)}
              />
              <span className={styles.segmentLabel}>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className={styles.blurb}>{active?.blurb}</p>

      {mode === 'hold-repeat' ? (
        <div className={styles.fields}>
          <NumberField
            label="First repeat after"
            value={repeatInitialMs}
            limits={LIMITS.repeatInitialMs}
            onCommit={actions.setRepeatInitialMs}
          />
          <NumberField
            label="Then every"
            value={repeatIntervalMs}
            limits={LIMITS.repeatIntervalMs}
            onCommit={actions.setRepeatIntervalMs}
            hint={`${perSecond(repeatIntervalMs)} a second`}
          />
        </div>
      ) : null}

      {mode === 'tap' ? (
        <div className={styles.fields}>
          <NumberField
            label="Tap every"
            value={tapIntervalMs}
            limits={LIMITS.tapIntervalMs}
            onCommit={actions.setTapIntervalMs}
            hint={`${perSecond(tapIntervalMs)} a second`}
          />
        </div>
      ) : null}
    </section>
  )
}

function perSecond(intervalMs: number): string {
  if (intervalMs <= 0) return 'many'
  const rate = 1000 / intervalMs
  return rate >= 10 ? `about ${Math.round(rate)} times` : `about ${rate.toFixed(1)} times`
}

interface NumberFieldProps {
  label: string
  value: number
  limits: { min: number; max: number; step: number }
  onCommit: (value: number) => void
  hint?: string
}

function NumberField({ label, value, limits, onCommit, hint }: NumberFieldProps): JSX.Element {
  const id = useId()
  const hintId = useId()
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputWrap}>
        <input
          id={id}
          className={styles.number}
          type="number"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          min={limits.min}
          max={limits.max}
          step={limits.step}
          value={value}
          aria-label={`${label}, in milliseconds`}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event) => onCommit(Number(event.target.value))}
        />
        <span className={styles.unit} aria-hidden="true">
          ms
        </span>
      </div>
      {hint === undefined ? null : (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}
