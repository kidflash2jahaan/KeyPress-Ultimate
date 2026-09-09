/**
 * The keyboard.
 *
 * Pure presentation: every piece of state arrives as a prop, so the board can
 * be rendered in a test, in Storybook, or against the mock bridge with no store
 * behind it.
 *
 * Interaction contract:
 *  - click toggles one key
 *  - shift-click selects the range between the last-touched key and this one,
 *    when both sit on the same row
 *  - arrow keys move focus geometrically (a roving tabindex, one tab stop for
 *    the whole board), Home/End jump to the ends of the row, space and enter
 *    toggle, shift+space and shift+enter extend the range
 *  - keys that cannot be held stay focusable and are announced with the reason,
 *    rather than being removed from the tab order and silently ignored
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX, KeyboardEvent } from 'react'
import type { KeyDef } from '@shared/types'
import { Key } from './Key'
import {
  BOARD_HEIGHT_U,
  BOARD_WIDTH_U,
  PLATE_PAD_U,
  UNIT_MIN,
  computeLayout,
  neighborOf,
  rangeBetween,
  rowEnds,
} from './keyboard-layout'
import type { ArrowDirection, KeyState } from './keyboard-layout'
import styles from './Keyboard.module.css'

export interface KeyboardProps {
  /** The keys to draw. Entries flagged `extra` are ignored: the board is the
   *  104-key ANSI layout, and the extended keys have their own strip. */
  keys: readonly KeyDef[]
  selectedIds: readonly string[]
  firingIds: readonly string[]
  /** Keys that exist but cannot be held, e.g. the lock keys. */
  disabledIds: readonly string[]
  /** Keys with no code on this platform, e.g. Print Screen on macOS. */
  unavailableIds: readonly string[]
  /** Called with every key whose selection should change, and the state they
   *  should all end up in. A plain click passes one id; a shift-click passes
   *  the whole range. */
  onToggle: (keyIds: string[], selected: boolean) => void
  /** `--u`, the key unit in CSS pixels. Clamped up to `UNIT_MIN`; past that the
   *  plate scrolls rather than shrinking the legends further. */
  unit: number
}

const ARROW_DIRECTIONS: Readonly<Record<string, ArrowDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

export function Keyboard({
  keys,
  selectedIds,
  firingIds,
  disabledIds,
  unavailableIds,
  onToggle,
  unit,
}: KeyboardProps): JSX.Element {
  const hintId = useId()
  const layout = useMemo(() => computeLayout(keys), [keys])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const firing = useMemo(() => new Set(firingIds), [firingIds])
  const disabled = useMemo(() => new Set(disabledIds), [disabledIds])
  const unavailable = useMemo(() => new Set(unavailableIds), [unavailableIds])

  const nodes = useRef<Map<string, HTMLButtonElement>>(new Map())
  const anchor = useRef<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const stateOf = useCallback(
    (id: string): KeyState => {
      if (unavailable.has(id)) return 'unavailable'
      if (disabled.has(id)) return 'disabled'
      if (firing.has(id)) return 'firing'
      if (selected.has(id)) return 'selected'
      return 'idle'
    },
    [disabled, firing, selected, unavailable],
  )

  const selectable = useCallback(
    (id: string) => !unavailable.has(id) && !disabled.has(id),
    [disabled, unavailable],
  )

  const moveFocus = useCallback((id: string | null) => {
    if (id === null) return
    setFocusedId(id)
    nodes.current.get(id)?.focus()
  }, [])

  const onActivate = useCallback(
    (id: string, extendRange: boolean) => {
      if (!selectable(id)) return
      const next = !selected.has(id)
      const from = anchor.current

      if (extendRange && from !== null && from !== id) {
        const ids = rangeBetween(layout, from, id).filter(selectable)
        if (ids.length > 0) {
          onToggle(ids, next)
          return
        }
      }

      anchor.current = id
      onToggle([id], next)
    },
    [layout, onToggle, selectable, selected],
  )

  const onFocusKey = useCallback((id: string) => {
    setFocusedId(id)
  }, [])

  const onKeyDownKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
      const direction = ARROW_DIRECTIONS[event.key]
      if (direction !== undefined) {
        event.preventDefault()
        moveFocus(neighborOf(layout, id, direction))
        return
      }

      if (event.key === 'Home' || event.key === 'End') {
        const ends = rowEnds(layout, id)
        if (ends === null) return
        event.preventDefault()
        moveFocus(event.key === 'Home' ? ends.first : ends.last)
        return
      }

      if (event.key === ' ' || event.key === 'Enter') {
        // The button would fire click() on keyup for both of these. Taking the
        // event here keeps space and enter from toggling twice.
        event.preventDefault()
        onActivate(id, event.shiftKey)
      }
    },
    [layout, moveFocus, onActivate],
  )

  // One tab stop for the whole board. Before anything has been focused it is
  // the first key, so Tab always lands somewhere sensible.
  const tabbableId = focusedId ?? layout.keys[0]?.key.id ?? null

  const plateStyle = {
    '--u': `${Math.max(UNIT_MIN, unit)}px`,
    '--plate-pad': PLATE_PAD_U,
    '--board-w': BOARD_WIDTH_U,
    '--board-h': BOARD_HEIGHT_U,
  } as CSSProperties

  return (
    <div className={styles.scroller}>
      <div className={styles.plate} style={plateStyle}>
        <p id={hintId} className={styles.hint}>
          Click a key to hold it. Shift-click selects a range along a row. Arrow keys move
          between keys, space toggles one.
        </p>
        <div className={styles.board} role="group" aria-label="Keyboard" aria-describedby={hintId}>
          {layout.keys.map((placed) => (
            <Key
              key={placed.key.id}
              placed={placed}
              state={stateOf(placed.key.id)}
              selected={selected.has(placed.key.id)}
              tabbable={placed.key.id === tabbableId}
              nodes={nodes}
              onActivate={onActivate}
              onFocusKey={onFocusKey}
              onKeyDownKey={onKeyDownKey}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
