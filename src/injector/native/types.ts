/**
 * The one real seam in the app.
 *
 * `NativeInput` below is the Interface Contract from the plan, verbatim. It is
 * locked: nothing may rename, widen or re-declare it. Two adapters implement
 * it, `MacNativeInput` and `WindowsNativeInput`, and `./index.ts` picks one
 * once at injector startup.
 *
 * Anything an adapter can do beyond the contract lives in `NativeInputExtras`,
 * a separate optional interface, so the locked shape stays exactly as
 * specified while platform-specific capabilities are still reachable and
 * type-safe. Callers ask for them with `hasNativeInputExtras()`.
 */
import type { AppInfo, KeyDef, MouseDef } from '@shared/types'

export interface NativeInput {
  init(): Promise<void> // binds FFI, asserts struct layout, throws on mismatch
  listApplications(): AppInfo[]
  getFrontmostPid(): number | null // null = unknown; caller MUST treat as "not on target"
  keyDown(key: KeyDef): void
  keyUp(key: KeyDef): void
  mouseDown(btn: MouseDef): void
  mouseUp(btn: MouseDef): void
  releaseAll(): void // idempotent, batched where the OS allows
  hasPermission(): boolean
  openPermissionSettings(): void
  dispose(): void
}

/**
 * Optional capabilities. An adapter either implements all of these or none of
 * them, so one `hasNativeInputExtras()` check covers the lot.
 *
 * These exist because `src/injector/native/{macos,windows}.ts` are the only
 * two files in the app allowed to call koffi. The hold loop needs answers that
 * only the native layer can give, and they must not be smuggled into
 * `NativeInput` itself.
 */
export interface NativeInputExtras {
  /**
   * Re-send a key-down for an already-held key with the OS autorepeat flag set,
   * so it mimics real typematic behaviour. This is the only assert Hold+Repeat
   * mode is allowed to make: never an intermediate key-up, which would produce
   * duplicated input in a text field.
   */
  keyDownRepeat(key: KeyDef): void

  /**
   * Post one key-up directly to a single process, without touching held state.
   *
   * The focus-loss path posts every release twice: first here, at the app that
   * was holding the key, so it definitely observes the release even though it
   * is no longer frontmost, then again globally through `keyUp()` to clear
   * system state. A no-op for a key this adapter is not holding.
   */
  keyUpToPid(key: KeyDef, pid: number): void

  /**
   * True when the user is not physically holding any modifier right now.
   *
   * The focus-gain gate gates the first press on this. A user who Cmd-Tabs into
   * the target is usually still holding Cmd at the instant focus lands, and
   * pressing a held `W` into that turns into Cmd+W, which closes their window.
   */
  physicalModifiersClear(): boolean
}

export function hasNativeInputExtras(
  input: NativeInput,
): input is NativeInput & NativeInputExtras {
  const candidate = input as Partial<NativeInputExtras>
  return (
    typeof candidate.keyDownRepeat === 'function' &&
    typeof candidate.keyUpToPid === 'function' &&
    typeof candidate.physicalModifiersClear === 'function'
  )
}
