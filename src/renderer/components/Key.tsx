/**
 * A single keycap: an absolutely positioned toggle button.
 *
 * Presentational and memoised. During a session `firingIds` changes on every
 * focus transition, so the 104 keys that did not change state must not re-render
 * with it. Every callback this takes is stable for the life of the board, and
 * every prop is a primitive, so `memo` actually holds.
 */
import { memo } from 'react'
import type { CSSProperties, JSX, KeyboardEvent, MouseEvent, RefObject } from 'react'
import { accessibleName, capLegend } from './keyboard-layout'
import type { KeyState, PlacedKey } from './keyboard-layout'
import styles from './Key.module.css'

/** Advance width of one character as a fraction of the font size, for fitting
 *  a legend to a cap. Geist Sans sits a little under this; the value is
 *  deliberately generous so a legend clears the cap edge rather than kissing it. */
const CHAR_ADVANCE = 0.58

export interface KeyProps {
  placed: PlacedKey
  state: KeyState
  /** Selection, independent of `state`: a key can be selected and firing. */
  selected: boolean
  tabbable: boolean
  nodes: RefObject<Map<string, HTMLButtonElement>>
  onActivate: (id: string, extendRange: boolean) => void
  onFocusKey: (id: string) => void
  onKeyDownKey: (event: KeyboardEvent<HTMLButtonElement>, id: string) => void
}

function KeyImpl({
  placed,
  state,
  selected,
  tabbable,
  nodes,
  onActivate,
  onFocusKey,
  onKeyDownKey,
}: KeyProps): JSX.Element {
  const { key, x, y, w, h } = placed
  const legend = capLegend(key)
  const interactive = state !== 'disabled' && state !== 'unavailable'

  const style = {
    '--kx': x,
    '--ky': y,
    '--kw': w,
    '--kh': h,
    '--legend-div': Math.max(legend.longest, 1) * CHAR_ADVANCE,
    '--sub-div': Math.max(legend.subLength, 1) * CHAR_ADVANCE,
  } as CSSProperties

  const sub =
    legend.sub === null ? null : (
      <span className={styles.sub} aria-hidden="true">
        {legend.sub}
      </span>
    )

  return (
    <button
      type="button"
      ref={(node) => {
        if (node === null) nodes.current.delete(key.id)
        else nodes.current.set(key.id, node)
      }}
      className={styles.key}
      style={style}
      data-key-id={key.id}
      data-state={state}
      data-interactive={interactive}
      aria-pressed={selected}
      aria-disabled={interactive ? undefined : true}
      aria-label={accessibleName(key, state)}
      tabIndex={tabbable ? 0 : -1}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onActivate(key.id, event.shiftKey)
      }}
      onFocus={() => {
        onFocusKey(key.id)
      }}
      onKeyDown={(event) => {
        onKeyDownKey(event, key.id)
      }}
    >
      <span className={styles.cap}>
        <span className={styles.legend}>
          {legend.subOnTop ? sub : null}
          {/* A cap prints at most two legend lines, and they never reorder. */}
          {legend.lines.map((line, index) => (
            <span className={styles.primary} key={`${key.id}-${String(index)}`} aria-hidden="true">
              {line}
            </span>
          ))}
          {legend.subOnTop ? null : sub}
        </span>
      </span>
      <span className={styles.glow} aria-hidden="true" />
    </button>
  )
}

export const Key = memo(KeyImpl)
Key.displayName = 'Key'
