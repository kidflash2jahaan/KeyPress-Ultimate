import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { getAppStore, useActions, useAppStore } from '../state/store'
import styles from './PresetMenu.module.css'

/**
 * Presets as a compact header menu, not a rail. A rail would cost horizontal
 * space the keyboard cannot spare, and presets are a switch-and-forget
 * control: the user opens this once, picks, and never looks at it again.
 */

function PencilIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M9.2 2.4l2.4 2.4-6.3 6.3-3 .6.6-3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M2.8 3.8h8.4M5.6 3.8V2.6h2.8v1.2M4 3.8l.5 7.2h5l.5-7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      <path
        d="M2.5 6.3l2.4 2.4 4.6-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true" focusable="false">
      <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function PresetMenu(): JSX.Element {
  const presets = useAppStore((state) => state.presets)
  const activePresetId = useAppStore((state) => state.activePresetId)
  const actions = useActions()

  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [newName, setNewName] = useState('')

  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const newNameId = useId()

  const active = presets.find((preset) => preset.id === activePresetId) ?? null

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false)
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false)
        setRenamingId(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function beginRename(id: string, current: string): void {
    setRenamingId(id)
    setDraftName(current)
  }

  async function commitRename(): Promise<void> {
    if (renamingId === null) return
    await actions.renamePreset(renamingId, draftName)
    setRenamingId(null)
  }

  async function saveNew(): Promise<void> {
    const before = presets.length
    await actions.savePreset(newName)
    // Only clear and close if something was actually saved. A refusal leaves
    // the field, the typed name and the menu exactly where the user left them.
    if (getAppStore().getState().presets.length > before) {
      setNewName('')
      setOpen(false)
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.triggerLabel}>{active?.name ?? 'Presets'}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className={styles.menu} id={menuId} role="menu" aria-label="Presets">
          {presets.length === 0 ? (
            <p className={styles.empty}>
              No presets yet. Set up your keys and target, then save the combination here.
            </p>
          ) : (
            <ul className={styles.list}>
              {presets.map((preset) => (
                <li key={preset.id} className={styles.row}>
                  {renamingId === preset.id ? (
                    <form
                      className={styles.renameForm}
                      onSubmit={(event) => {
                        event.preventDefault()
                        void commitRename()
                      }}
                    >
                      <label className={styles.visuallyHidden} htmlFor={`${menuId}-rename`}>
                        Preset name
                      </label>
                      <input
                        id={`${menuId}-rename`}
                        className={styles.input}
                        value={draftName}
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setDraftName(event.target.value)}
                        onBlur={() => void commitRename()}
                      />
                      <button type="submit" className={styles.textButton}>
                        Rename
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={preset.id === activePresetId}
                        className={styles.pick}
                        onClick={() => {
                          actions.applyPreset(preset.id)
                          setOpen(false)
                        }}
                      >
                        <span className={styles.tick}>
                          {preset.id === activePresetId ? <CheckIcon /> : null}
                        </span>
                        <span className={styles.name}>{preset.name}</span>
                        <span className={styles.summary}>{describe(preset.config)}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.rowAction}
                        aria-label={`Rename ${preset.name}`}
                        onClick={() => beginRename(preset.id, preset.name)}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className={styles.rowAction}
                        aria-label={`Delete ${preset.name}`}
                        onClick={() => void actions.deletePreset(preset.id)}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form
            className={styles.saveForm}
            onSubmit={(event) => {
              event.preventDefault()
              void saveNew()
            }}
          >
            <label className={styles.saveLabel} htmlFor={newNameId}>
              Save what is selected now
            </label>
            <div className={styles.saveRow}>
              <input
                id={newNameId}
                className={styles.input}
                value={newName}
                placeholder="Name this preset…"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setNewName(event.target.value)}
              />
              <button type="submit" className={styles.textButton} disabled={newName.trim() === ''}>
                Save
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}

function describe(config: { keyIds: string[]; buttonIds: string[]; targets: string[] }): string {
  const parts: string[] = []
  const inputs = config.keyIds.length + config.buttonIds.length
  parts.push(inputs === 1 ? '1 input' : `${inputs} inputs`)
  parts.push(config.targets.length === 1 ? '1 target' : `${config.targets.length} targets`)
  return parts.join(', ')
}
