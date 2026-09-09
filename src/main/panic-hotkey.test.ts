/**
 * The panic hotkey's overlap rules.
 *
 * Two bugs live here historically, and both are the same shape: the conflict
 * check took keys away from the user that the hotkey never actually needed.
 * `CommandOrControl` was expanded to Command *and* Control on both platforms,
 * which made the Windows key unholdable on Windows and Control unholdable on
 * macOS, and every modifier in the accelerator was treated as a conflict, which
 * made Shift+W refuse to start under stock settings.
 */
import { describe, expect, it } from 'vitest'
import { getKeys } from '@shared/keys'
import {
  DEFAULT_PANIC_HOTKEY,
  describePanicHotkeyConflict,
  formatAcceleratorForPlatform,
  panicHotkeyConflicts,
  panicHotkeyKeyIds,
  panicHotkeyTriggerKeyIds,
  validatePanicHotkey,
} from './panic-hotkey'

const MODIFIER_IDS = getKeys()
  .filter((key) => key.isModifier)
  .map((key) => key.id)

describe('panicHotkeyKeyIds', () => {
  it('resolves CommandOrControl the way the platform does, never as both', () => {
    const onWindows = panicHotkeyKeyIds(DEFAULT_PANIC_HOTKEY, 'win32')
    expect(onWindows).toContain('key-left-ctrl')
    expect(onWindows).not.toContain('key-left-meta')
    expect(onWindows).not.toContain('key-right-meta')

    const onMac = panicHotkeyKeyIds(DEFAULT_PANIC_HOTKEY, 'darwin')
    expect(onMac).toContain('key-left-meta')
    expect(onMac).not.toContain('key-left-ctrl')
    expect(onMac).not.toContain('key-right-ctrl')
  })

  it('maps the explicit modifier tokens and the trigger key', () => {
    expect(panicHotkeyKeyIds('Control+Shift+P', 'win32').sort()).toEqual([
      'key-left-ctrl',
      'key-left-shift',
      'key-p',
      'key-right-ctrl',
      'key-right-shift',
    ])
    expect(panicHotkeyKeyIds('AltGr+J', 'win32').sort()).toEqual(['key-j', 'key-right-alt'])
  })

  it('ignores tokens that name no key on the board', () => {
    expect(panicHotkeyKeyIds('Ctrl+Alt+Nonsense', 'win32')).not.toContain('key-nonsense')
  })
})

describe('panicHotkeyTriggerKeyIds', () => {
  it('is the accelerator minus its modifiers', () => {
    expect(panicHotkeyTriggerKeyIds(DEFAULT_PANIC_HOTKEY)).toEqual(['key-k'])
    expect(panicHotkeyTriggerKeyIds('Ctrl+Shift+Alt')).toEqual([])
  })
})

describe('panicHotkeyConflicts', () => {
  it('costs the user no holdable modifier under the default hotkey', () => {
    // Shift+W is sneak-walk in half the games this app exists for. Every one of
    // the eight modifiers used to be refused at Start with stock settings.
    expect(panicHotkeyConflicts(DEFAULT_PANIC_HOTKEY, ['key-left-shift', 'key-w'])).toEqual([])
    expect(panicHotkeyConflicts(DEFAULT_PANIC_HOTKEY, MODIFIER_IDS)).toEqual([])
    // The eight real modifiers plus Fn, so the sweep above is not vacuous.
    expect(MODIFIER_IDS.length).toBeGreaterThanOrEqual(8)
  })

  it('leaves the Windows key holdable on Windows and Control holdable on macOS', () => {
    expect(panicHotkeyConflicts(DEFAULT_PANIC_HOTKEY, ['key-left-meta'])).toEqual([])
    expect(panicHotkeyConflicts(DEFAULT_PANIC_HOTKEY, ['key-left-ctrl'])).toEqual([])
  })

  it('still refuses the trigger key, which the app would be pressing itself', () => {
    expect(panicHotkeyConflicts(DEFAULT_PANIC_HOTKEY, ['key-w', 'key-k'])).toEqual(['key-k'])
    expect(panicHotkeyConflicts('Ctrl+Alt+F8', ['key-f8'])).toEqual(['key-f8'])
  })
})

describe('describePanicHotkeyConflict', () => {
  it('names the key on the keyboard and the one action that fixes it', () => {
    const message = describePanicHotkeyConflict(DEFAULT_PANIC_HOTKEY, ['key-k'], 'win32')

    expect(message).toContain('K')
    expect(message).toContain('Deselect')
    // Settings renders the panic hotkey as text and has no editor, so the
    // message must never send the user there to "change one of them".
    expect(message).not.toContain('Settings')
  })

  it('spells the combination the way the platform does', () => {
    expect(describePanicHotkeyConflict(DEFAULT_PANIC_HOTKEY, ['key-k'], 'win32')).toContain(
      'Ctrl+Alt+Shift+K',
    )
    expect(describePanicHotkeyConflict(DEFAULT_PANIC_HOTKEY, ['key-k'], 'darwin')).toContain(
      'Command+Option+Shift+K',
    )
  })
})

describe('formatAcceleratorForPlatform', () => {
  it('resolves CommandOrControl per platform and leaves plain keys alone', () => {
    expect(formatAcceleratorForPlatform('CommandOrControl+Alt+Shift+K', 'win32')).toBe(
      'Ctrl+Alt+Shift+K',
    )
    expect(formatAcceleratorForPlatform('CommandOrControl+Alt+Shift+K', 'darwin')).toBe(
      'Command+Option+Shift+K',
    )
    expect(formatAcceleratorForPlatform('Control+F9', 'darwin')).toBe('Control+F9')
  })
})

describe('validatePanicHotkey', () => {
  it('accepts the default and rejects the shapes that cannot work', () => {
    expect(validatePanicHotkey(DEFAULT_PANIC_HOTKEY)).toBeNull()
    expect(validatePanicHotkey('K')).toEqual({ kind: 'no-modifier' })
    expect(validatePanicHotkey('Ctrl+Alt')).toEqual({ kind: 'no-key' })
    expect(validatePanicHotkey('')).toEqual({ kind: 'empty' })
    expect(validatePanicHotkey('MediaPlayPause')).toMatchObject({ kind: 'forbidden-key' })
  })
})
