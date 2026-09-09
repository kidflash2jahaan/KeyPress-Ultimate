import type { JSX } from 'react'
import type { AppInfo, HoldMode, SessionState } from '../../shared/types'
import { getKeyById, getMouseButtonById } from '../../shared/keys'
import { useShallow } from 'zustand/react/shallow'
import { describeStartRefusal, useAppStore, type AppState } from '../state/store'
import styles from './StatusLine.module.css'

/**
 * The sentence that says what the app is doing and why.
 *
 * This is the other half of making 'armed-waiting' read as intentional. The
 * plate border changes shape, and this says the words out loud: "Armed,
 * waiting for Minecraft", followed by which app is actually frontmost. Between
 * them there is nothing left to misread.
 */

export function StatusLine(): JSX.Element {
  // Shallow-compared, so the sentence only re-renders when the words change,
  // not on every session frame the injector pushes.
  const lines = useAppStore(useShallow(selectLines))

  return (
    <p className={styles.line} role="status" aria-live="polite" aria-atomic="true">
      <span className={styles.primary}>{lines.primary}</span>
      {lines.secondary === null ? null : (
        <span className={styles.secondary}>{lines.secondary}</span>
      )}
    </p>
  )
}

interface StatusLines {
  primary: string
  secondary: string | null
}

/**
 * Exported for the same reason `describeStartRefusal` is: the wording is part
 * of the product, so it is written once and read from one place.
 */
export function selectLines(state: AppState): StatusLines {
  const { session } = state
  const targetLabel = describeTargets(state.targets, state.apps)
  const selection = describeSelection(state.keyIds, state.buttonIds)
  const focused = session.focusedApp

  switch (session.phase) {
    case 'firing':
      return {
        primary: `Firing in ${focused?.name ?? targetLabel}.`,
        secondary: `${selection} ${verbFor(state.mode, state.keyIds.length + state.buttonIds.length)}.`,
      }

    case 'armed-waiting':
      return {
        primary: `Armed, waiting for ${targetLabel}.`,
        secondary:
          focused === null
            ? 'Nothing is being sent until a target app is frontmost.'
            : `${focused.name} is frontmost right now, so nothing is being sent.`,
      }

    case 'blocked':
      return {
        primary: session.message ?? `${targetLabel} is refusing the injected input.`,
        secondary: 'Nothing is being sent. Stop, then see the notes in Settings.',
      }

    case 'error':
      return {
        primary: session.message ?? 'The session stopped and every key was released.',
        secondary: null,
      }

    case 'idle':
    default: {
      const refusal = describeStartRefusal(state)
      if (refusal !== null) return { primary: refusal, secondary: null }
      return {
        primary: `Ready. ${selection} will be held while ${targetLabel} is frontmost.`,
        secondary: 'Press Start, then switch to it.',
      }
    }
  }
}

function verbFor(mode: HoldMode, count: number): string {
  const plural = count !== 1
  if (mode === 'tap') return plural ? 'are being tapped' : 'is being tapped'
  if (mode === 'hold-repeat') return plural ? 'are held and repeating' : 'is held and repeating'
  return plural ? 'are held down' : 'is held down'
}

export function describeSelection(keyIds: readonly string[], buttonIds: readonly string[]): string {
  const names = [
    ...keyIds.map((id) => getKeyById(id)?.label ?? id),
    ...buttonIds.map((id) => getMouseButtonById(id)?.label ?? id),
  ]
  if (names.length === 0) return 'Nothing'
  if (names.length <= 3) return joinWithAnd(names)
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

export function describeTargets(targets: readonly string[], apps: readonly AppInfo[]): string {
  const names = targets.map(
    (identity) => apps.find((app) => app.identity === identity)?.name ?? identity,
  )
  if (names.length === 0) return 'a target app'
  if (names.length === 1) return names[0] ?? 'a target app'
  if (names.length === 2) return `${names[0]} or ${names[1]}`
  return `${names[0]} or ${names.length - 1} others`
}

function joinWithAnd(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`
}

/** The compact form the action bar shows next to the timer. */
export function summarise(
  keyIds: readonly string[],
  buttonIds: readonly string[],
  targets: readonly string[],
  session: SessionState,
): string {
  if (session.phase === 'firing') {
    const live = session.firingKeyIds.length + session.firingButtonIds.length
    return live === 1 ? '1 input live' : `${live} inputs live`
  }
  const total = keyIds.length + buttonIds.length
  const inputs = total === 1 ? '1 input' : `${total} inputs`
  const targetCount = targets.length === 1 ? '1 target' : `${targets.length} targets`
  return `${inputs}, ${targetCount}`
}
