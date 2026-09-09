import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getBaseKeys, isKeyAvailableOn } from '../shared/keys'
import { ActionBar } from './components/ActionBar'
import { Keyboard } from './components/Keyboard'
import {
  plateOuterWidthPx,
  unitForSpace,
  UNIT_FULL,
  withPlatformLabels,
} from './components/keyboard-layout'
import { ModeControls } from './components/ModeControls'
import { MousePad } from './components/MousePad'
import { PermissionGate } from './components/PermissionGate'
import { SettingsSheet } from './components/SettingsSheet'
import { TargetStrip } from './components/TargetStrip'
import { TitleBar } from './components/TitleBar'
import { UpdateBanner } from './components/UpdateBanner'
import { useActions, useAppStore } from './state/store'
import styles from './App.module.css'

/**
 * The shell.
 *
 * Horizontal bands, top to bottom: title, notices, targets, keyboard, mouse
 * and mode, action bar. No sidebar. A 260px rail leaves 786px of band at the
 * 1100px minimum window, which solves to a 34px key unit, and a dual-legend
 * cap at 34px is not readable.
 *
 * The chrome bands run full bleed; the instrument does not. The keyboard band
 * grows into whatever height is left over and the plate is solved to fill it,
 * then the mouse and mode band is capped to the plate's own width and centred
 * under it. That is what stops the board floating in a wide empty margin with
 * two stubs of content stranded below it.
 *
 * The one piece of state that lives here rather than in the store is the key
 * unit, because it is a function of the window rather than of the session.
 */
export function App(): JSX.Element {
  const phase = useAppStore((state) => state.session.phase)
  const platform = useAppStore((state) => state.platform)
  const theme = useAppStore((state) => state.settings.theme)
  const selectedIds = useAppStore((state) => state.keyIds)
  const firingIds = useAppStore((state) => state.session.firingKeyIds)
  const mode = useAppStore((state) => state.mode)
  const actions = useActions()

  const boardRef = useRef<HTMLDivElement>(null)
  const unit = useKeyUnit(boardRef)

  useTheme(theme)

  /**
   * The legends are per platform, and this is where that happens: the board
   * prints "⌘ Command" on macOS and "Win" on Windows off one shared key table.
   * Without this the caps either side of the space bar both read "Meta".
   */
  const keys = useMemo(() => withPlatformLabels(getBaseKeys(), platform), [platform])

  /**
   * Lock keys have no held state, so Hold cannot express them. They stay on the
   * board, drawn as disabled with the reason in their accessible name, rather
   * than vanishing and leaving a hole where the user expects Caps Lock.
   */
  const disabledIds = useAppStore(
    useShallow((state) =>
      state.mode === 'hold' ? keys.filter((key) => !key.holdable).map((key) => key.id) : [],
    ),
  )

  const unavailableIds = useMemo(
    () => keys.filter((key) => !isKeyAvailableOn(key, platform)).map((key) => key.id),
    [keys, platform],
  )

  const onToggle = useCallback(
    (keyIds: string[], selected: boolean) => actions.setKeysSelected(keyIds, selected),
    [actions],
  )

  /** The instrument's own width, so the lower band lines up with the plate. */
  const shellStyle = { '--plate-w': `${plateOuterWidthPx(unit)}px` } as CSSProperties

  return (
    <div className={styles.shell} data-phase={phase} data-mode={mode} style={shellStyle}>
      <a className="skip-link" href="#board">
        Skip to the keyboard
      </a>

      <TitleBar />
      <UpdateBanner />
      <PermissionGate />

      <main className={styles.main} data-scroll>
        <TargetStrip />

        <section className={styles.board} aria-labelledby="board-heading" id="board">
          <h2 className={styles.bandLabel} id="board-heading">
            Keyboard
          </h2>
          <div className={styles.boardArea} ref={boardRef}>
            <Keyboard
              keys={keys}
              selectedIds={selectedIds}
              firingIds={firingIds}
              disabledIds={disabledIds}
              unavailableIds={unavailableIds}
              onToggle={onToggle}
              unit={unit}
            />
          </div>
        </section>

        <div className={styles.split}>
          <MousePad />
          <ModeControls />
        </div>
      </main>

      <ActionBar />
      <SettingsSheet />
    </div>
  )
}

/**
 * The key unit, measured from the band rather than the window, so the value
 * stays right whatever padding the band ends up with.
 *
 * Both axes are measured. The band is a flex item with a definite height, so
 * its box never depends on the plate it contains and the observer cannot chase
 * its own tail.
 */
function useKeyUnit(ref: React.RefObject<HTMLDivElement | null>): number {
  const [unit, setUnit] = useState(UNIT_FULL)

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box !== undefined) setUnit(unitForSpace(box.width, box.height))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return unit
}

/**
 * `system` leaves the attribute off, so the stylesheet's
 * `prefers-color-scheme` rules decide. Any explicit choice stamps the root and
 * wins in both directions.
 */
function useTheme(theme: 'system' | 'dark' | 'light'): void {
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }, [theme])
}
