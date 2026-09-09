/**
 * The last-resort release: the only place the main process posts input itself.
 *
 * It runs in exactly two situations, and both of them are the app's final
 * chance to keep a promise it made to the user:
 *
 *   - at startup, replaying a crash journal left by a run that was killed with
 *     keys still down, and
 *   - when the injector dies, or never confirms, and the session controller
 *     needs the keys up anyway.
 *
 * Two rules follow from that, and this module exists so both are stated in one
 * testable place rather than assumed inside `index.ts`:
 *
 *   1. **Attempt every id.** One key the OS refuses must not strand the rest.
 *      The injector's own release path isolates each item for the same reason
 *      (`postUp` in `src/injector/hold-loop.ts`), and `MacNativeInput.releaseAll`
 *      says it outright: the only thing worse than a failed release is a failed
 *      release that aborts the rest of them.
 *   2. **Never overstate what happened.** The return value is a count of ups
 *      that were actually posted, and both callers treat a normal return as
 *      proof: `recoverStaleJournal` deletes the journal on it, and
 *      `SessionController.#finishTeardown` marks the release confirmed and
 *      suppresses its warning. A count that counted resolvable ids rather than
 *      posted events would erase the only record that a key is still down.
 *      So anything that failed is re-thrown once every id has been tried, which
 *      is what keeps the journal on disk for the next launch.
 */
import { getKeyById, getMouseButtonById } from '@shared/keys'
import type { KeyDef, MouseDef } from '@shared/types'

/** The slice of `NativeInput` this needs. Keeps the module free of the adapter. */
export interface DirectReleaseTarget {
  keyUp(key: KeyDef): void
  mouseUp(btn: MouseDef): void
}

export interface DirectReleaseOptions {
  /** Null when the native layer never bound. Releasing is then impossible. */
  native: DirectReleaseTarget | null
  keyIds: readonly string[]
  buttonIds: readonly string[]
  /** Every individual failure is reported here as it happens, then summarised. */
  onError?: (message: string, error: unknown) => void
}

export class DirectReleaseError extends Error {
  /** Ups that were posted before, between and after the failures. */
  readonly releasedCount: number
  /** The ids whose up the OS refused. */
  readonly failedIds: readonly string[]

  constructor(releasedCount: number, failedIds: readonly string[]) {
    super(
      `released ${releasedCount} input${releasedCount === 1 ? '' : 's'}, but ` +
        `${failedIds.length} could not be released: ${failedIds.join(', ')}`,
    )
    this.name = 'DirectReleaseError'
    this.releasedCount = releasedCount
    this.failedIds = failedIds
  }
}

/**
 * Post ups for every id given, and return how many were actually posted.
 *
 * Throws when the native layer is unbound, or when any single up failed after
 * all of them were tried. A throw is how the caller learns not to treat the
 * release as proof; it is deliberately not a partial success, because both
 * callers read a normal return as "the keys are up" and act irreversibly on it.
 */
export function releaseInputDirectly(options: DirectReleaseOptions): number {
  const { native, keyIds, buttonIds, onError } = options
  if (native === null) {
    throw new Error('the native input layer is not bound, so nothing can be released')
  }

  let released = 0
  const failedIds: string[] = []

  /** One attempt, isolated. A throw here must never skip the ids after it. */
  const attempt = (id: string, post: () => void): void => {
    try {
      post()
      released += 1
    } catch (error) {
      failedIds.push(id)
      onError?.(`could not release "${id}" directly`, error)
    }
  }

  // Buttons first, then keys, then modifiers last within the keys, which is the
  // order `buildReplayPlan` already sorted them into.
  for (const buttonId of buttonIds) {
    const button = getMouseButtonById(buttonId)
    if (button === undefined) {
      // An id this build does not know cannot be posted by any means, so it is
      // not a failure to retry on the next launch: it would nag forever.
      onError?.(`ignoring an unknown mouse button id "${buttonId}"`, new Error('no such button'))
      continue
    }
    attempt(buttonId, () => {
      native.mouseUp(button)
    })
  }
  for (const keyId of keyIds) {
    const key = getKeyById(keyId)
    if (key === undefined) {
      onError?.(`ignoring an unknown key id "${keyId}"`, new Error('no such key'))
      continue
    }
    attempt(keyId, () => {
      native.keyUp(key)
    })
  }

  if (failedIds.length > 0) throw new DirectReleaseError(released, failedIds)
  return released
}
