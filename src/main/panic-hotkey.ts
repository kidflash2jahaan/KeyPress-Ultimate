/**
 * The panic hotkey.
 *
 * A global shortcut that releases everything, registered only while a session
 * is armed. Three rules make it worth having, and all three are enforced here
 * rather than left to the caller:
 *
 *   1. Registration is checked. `globalShortcut.register` returns false when
 *      another app already owns the combination, and Electron's docs are
 *      explicit that it then "silently fails". A panic button that does nothing
 *      is worse than no panic button, so a failed registration must refuse the
 *      Start it was requested for.
 *
 *   2. Never a media key. On macOS 10.14 and later the media accelerators are
 *      the one class of shortcut that needs the app to be a trusted
 *      accessibility client. The app holds that permission anyway for posting
 *      input, but the panic path must never depend on a permission the user can
 *      revoke mid-session, since revocation is itself one of the things the
 *      panic hotkey exists to survive.
 *
 *   3. Registered only while armed. Global shortcuts are exclusive: while ours
 *      is registered no other app can use that combination. Squatting on it for
 *      the app's whole lifetime is rude and unnecessary.
 */
import type { GlobalShortcut } from 'electron'
import { requireOrThrow } from './cjs-require'
import { getKeyById, platformLabel } from '@shared/keys'
import type { Platform } from '@shared/types'

/**
 * The slice of Electron's `globalShortcut` this module uses. Injected so the
 * whole module is testable without Electron.
 */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  isRegistered(accelerator: string): boolean
  unregister(accelerator: string): void
}

/**
 * Three modifiers and a letter. Out of the way of single- and double-modifier
 * app shortcuts on both platforms, not a system shortcut on either, not an
 * F-key (they collide with game bindings and need Fn on Mac laptops), and not
 * punctuation (which moves between keyboard layouts). K for kill.
 */
export const DEFAULT_PANIC_HOTKEY = 'CommandOrControl+Alt+Shift+K'

/**
 * Accelerators this module refuses outright. The first four are the ones
 * Electron documents as requiring a trusted accessibility client on macOS; the
 * volume keys are owned by the system and are a bad panic key regardless.
 */
const FORBIDDEN_KEY_TOKENS = new Set([
  'mediaplaypause',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'volumeup',
  'volumedown',
  'volumemute',
])

const MODIFIER_TOKENS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
])

export type PanicHotkeyProblem =
  | { kind: 'empty' }
  | { kind: 'forbidden-key'; token: string }
  | { kind: 'no-modifier' }
  | { kind: 'no-key' }
  | { kind: 'multiple-keys'; tokens: string[] }

export type PanicHotkeyFailure =
  | { reason: 'invalid'; problem: PanicHotkeyProblem; message: string }
  | { reason: 'taken'; message: string }
  | { reason: 'threw'; error: unknown; message: string }

export type PanicHotkeyRegistration =
  | { ok: true; accelerator: string }
  | ({ ok: false } & PanicHotkeyFailure)

/**
 * Structural check on an accelerator, before Electron ever sees it. Returns
 * null when the accelerator is acceptable.
 */
export function validatePanicHotkey(accelerator: string): PanicHotkeyProblem | null {
  const tokens = accelerator
    .split('+')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  if (tokens.length === 0) return { kind: 'empty' }

  const forbidden = tokens.find((token) => FORBIDDEN_KEY_TOKENS.has(token.toLowerCase()))
  if (forbidden !== undefined) return { kind: 'forbidden-key', token: forbidden }

  const modifiers = tokens.filter((token) => MODIFIER_TOKENS.has(token.toLowerCase()))
  const keys = tokens.filter((token) => !MODIFIER_TOKENS.has(token.toLowerCase()))

  if (modifiers.length === 0) return { kind: 'no-modifier' }
  if (keys.length === 0) return { kind: 'no-key' }
  if (keys.length > 1) return { kind: 'multiple-keys', tokens: keys }
  return null
}

export function describePanicHotkeyProblem(
  problem: PanicHotkeyProblem,
  accelerator: string,
): string {
  switch (problem.kind) {
    case 'empty':
      return 'No panic hotkey is set. Pick one in Settings, then press Start again.'
    case 'forbidden-key':
      return `The panic hotkey cannot use ${problem.token}. Media and volume keys are owned by the system and need a permission you can revoke, which is exactly what the panic hotkey has to survive. Pick a different combination in Settings.`
    case 'no-modifier':
      return `The panic hotkey ${accelerator} has no modifier, so it would fire during normal typing. Add Ctrl, Alt, Shift or Command in Settings.`
    case 'no-key':
      return `The panic hotkey ${accelerator} is modifiers only. Add a letter or number in Settings.`
    case 'multiple-keys':
      return `The panic hotkey ${accelerator} names more than one key (${problem.tokens.join(', ')}). Use one key plus modifiers.`
  }
}

/**
 * Owns at most one registration at a time. `register` is the only thing that
 * can arm it and `unregister` is the only thing that can disarm it, so the
 * "registered only while a session is armed" rule reduces to two call sites in
 * the session controller.
 */
export class PanicHotkey {
  #globalShortcut: GlobalShortcutLike | null
  #registered: string | null = null

  constructor(options: { globalShortcut?: GlobalShortcutLike } = {}) {
    this.#globalShortcut = options.globalShortcut ?? null
  }

  /** The currently registered accelerator, or null. */
  get accelerator(): string | null {
    return this.#registered
  }

  get isRegistered(): boolean {
    return this.#registered !== null
  }

  /**
   * Take the accelerator. Any failure here must block Start: the caller gets a
   * message that names the combination so the user knows what to change.
   */
  register(accelerator: string, onPanic: () => void): PanicHotkeyRegistration {
    const trimmed = accelerator.trim()

    if (this.#registered === trimmed && trimmed.length > 0) {
      return { ok: true, accelerator: trimmed }
    }
    this.unregister()

    const problem = validatePanicHotkey(trimmed)
    if (problem !== null) {
      return {
        ok: false,
        reason: 'invalid',
        problem,
        message: describePanicHotkeyProblem(problem, trimmed),
      }
    }

    let shortcuts: GlobalShortcutLike
    try {
      shortcuts = this.#shortcuts()
    } catch (error) {
      return {
        ok: false,
        reason: 'threw',
        error,
        message:
          'KeyPress Ultimate could not reach the system shortcut service, so it cannot register a panic hotkey. Restart the app and try again.',
      }
    }

    let accepted: boolean
    try {
      // Electron throws on a malformed accelerator rather than returning false.
      accepted = shortcuts.register(trimmed, onPanic)
    } catch (error) {
      return {
        ok: false,
        reason: 'threw',
        error,
        message: `The panic hotkey ${trimmed} is not a valid shortcut. Pick a different combination in Settings, then press Start again.`,
      }
    }

    // Both checks matter. `register` reports the attempt, `isRegistered`
    // reports the outcome, and the documented failure mode is that the
    // combination is "already taken by other applications".
    if (!accepted || !shortcuts.isRegistered(trimmed)) {
      try {
        shortcuts.unregister(trimmed)
      } catch {
        // Nothing was registered, so there is nothing to clean up.
      }
      return { ok: false, reason: 'taken', message: takenMessage(trimmed) }
    }

    this.#registered = trimmed
    return { ok: true, accelerator: trimmed }
  }

  /** Idempotent. Safe to call when nothing is registered. */
  unregister(): void {
    const current = this.#registered
    this.#registered = null
    if (current === null) return
    try {
      this.#shortcuts().unregister(current)
    } catch {
      // The app may already be tearing down. A shortcut we cannot unregister is
      // released by the process exiting anyway.
    }
  }

  #shortcuts(): GlobalShortcutLike {
    this.#globalShortcut ??= loadElectronGlobalShortcut()
    return this.#globalShortcut
  }
}

export function takenMessage(accelerator: string): string {
  return `The panic hotkey ${accelerator} is already taken by another app, so KeyPress Ultimate cannot register it. Without a working panic hotkey the session will not start. Pick a different combination in Settings, then press Start again.`
}

// ---------------------------------------------------------------------------
// Overlap with the keys the user asked to hold
// ---------------------------------------------------------------------------

const META_KEYS = ['key-left-meta', 'key-right-meta']
const CTRL_KEYS = ['key-left-ctrl', 'key-right-ctrl']

/**
 * Modifier tokens to the physical keys they occupy. `CommandOrControl` resolves
 * against the running platform, exactly the way Electron resolves it: Command
 * on macOS, Control on Windows, never both. Unioning the two used to make the
 * Windows key permanently unholdable on Windows and Control unholdable on
 * macOS, for a combination that does not contain them there.
 */
function modifierTokenToKeyIds(token: string, platform: Platform): string[] | undefined {
  switch (token) {
    case 'command':
    case 'cmd':
    case 'super':
    case 'meta':
      return META_KEYS
    case 'control':
    case 'ctrl':
      return CTRL_KEYS
    case 'commandorcontrol':
    case 'cmdorctrl':
      return platform === 'darwin' ? META_KEYS : CTRL_KEYS
    case 'alt':
    case 'option':
      return ['key-left-alt', 'key-right-alt']
    case 'altgr':
      return ['key-right-alt']
    case 'shift':
      return ['key-left-shift', 'key-right-shift']
    default:
      return undefined
  }
}

/** The platform this main process is running on. */
export function currentPlatform(): Platform {
  return process.platform === 'win32' ? 'win32' : 'darwin'
}

/** Key ids an accelerator would occupy on a given platform, best effort. */
export function panicHotkeyKeyIds(
  accelerator: string,
  platform: Platform = currentPlatform(),
): string[] {
  const ids = new Set<string>()
  for (const raw of accelerator.split('+')) {
    const token = raw.trim().toLowerCase()
    if (token.length === 0) continue
    const mapped = modifierTokenToKeyIds(token, platform)
    if (mapped !== undefined) {
      for (const id of mapped) ids.add(id)
      continue
    }
    const candidate = `key-${token}`
    if (getKeyById(candidate) !== undefined) ids.add(candidate)
  }
  return [...ids]
}

/**
 * The non-modifier key ids of an accelerator: the "K" of Ctrl+Alt+Shift+K.
 * Usually one, and never a modifier.
 */
export function panicHotkeyTriggerKeyIds(accelerator: string): string[] {
  const ids: string[] = []
  for (const raw of accelerator.split('+')) {
    const token = raw.trim().toLowerCase()
    if (token.length === 0) continue
    if (MODIFIER_TOKENS.has(token)) continue
    const candidate = `key-${token}`
    if (getKeyById(candidate) !== undefined && !ids.includes(candidate)) ids.push(candidate)
  }
  return ids
}

/**
 * Keys the user selected that genuinely fight with the panic hotkey.
 *
 * Only the accelerator's trigger key counts. Holding it is incoherent: the app
 * would be pressing part of its own escape hatch, and in tap or hold-repeat
 * mode it could fire the hotkey itself. Holding a *modifier* the hotkey also
 * uses is fine, and refusing it was a real cost: with the default hotkey
 * (CommandOrControl+Alt+Shift+K) every one of the eight modifiers became
 * unholdable, so Shift+W, the most ordinary hold in any game, was refused at
 * Start under stock settings. A modifier we hold down only makes the panic
 * combination easier for the user to complete, never harder, and the user's own
 * physical press of that key still reaches the shortcut system regardless.
 */
export function panicHotkeyConflicts(
  accelerator: string,
  selectedKeyIds: readonly string[],
): string[] {
  const triggerIds = new Set(panicHotkeyTriggerKeyIds(accelerator))
  return selectedKeyIds.filter((id) => triggerIds.has(id))
}

/**
 * The refusal the user reads when a selected key is the panic hotkey's trigger.
 * It names the key on their own keyboard and the one action that fixes it,
 * because the panic hotkey is not editable in Settings.
 */
export function describePanicHotkeyConflict(
  accelerator: string,
  conflicts: readonly string[],
  platform: Platform = currentPlatform(),
): string {
  const names = conflicts.map((id) => {
    const key = getKeyById(id)
    return key === undefined ? id : platformLabel(key, platform)
  })
  const listed = names.length === 0 ? 'a key you picked' : names.join(' and ')
  const combination = formatAcceleratorForPlatform(accelerator, platform)
  const deselect = names.length > 1 ? 'those keys' : listed
  return `The panic hotkey ${combination} needs ${listed}, which you also picked to hold. Deselect ${deselect} on the keyboard, then press Start again.`
}

/**
 * An accelerator as a user reads it. Main-process copy of what the keyboard
 * shows, in words rather than glyphs, because this text lands in a plain
 * status line.
 */
export function formatAcceleratorForPlatform(accelerator: string, platform: Platform): string {
  const mac = platform === 'darwin'
  return accelerator
    .split('+')
    .map((raw) => {
      const token = raw.trim()
      switch (token.toLowerCase()) {
        case 'commandorcontrol':
        case 'cmdorctrl':
          return mac ? 'Command' : 'Ctrl'
        case 'command':
        case 'cmd':
          return 'Command'
        case 'control':
        case 'ctrl':
          return mac ? 'Control' : 'Ctrl'
        case 'alt':
        case 'option':
          return mac ? 'Option' : 'Alt'
        case 'shift':
          return 'Shift'
        default:
          return token
      }
    })
    .filter((token) => token.length > 0)
    .join('+')
}

function loadElectronGlobalShortcut(): GlobalShortcutLike {
  const electron = requireOrThrow('electron', 'PanicHotkey') as { globalShortcut?: GlobalShortcut }
  const shortcuts = electron.globalShortcut
  if (shortcuts === undefined) {
    throw new Error('electron.globalShortcut is unavailable')
  }
  return shortcuts
}
