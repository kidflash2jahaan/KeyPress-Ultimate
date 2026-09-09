/**
 * The last-resort release.
 *
 * Both callers act irreversibly on what this function reports: the crash
 * journal is deleted on a normal return, and the session controller stops
 * warning that keys may still be held. So the two properties under test are
 * "every id was attempted" and "the number reported is the number posted".
 */
import { describe, expect, it } from 'vitest'
import type { KeyDef, MouseDef } from '@shared/types'
import { getKeyById, getMouseButtonById } from '@shared/keys'
import { DirectReleaseError, releaseInputDirectly } from './release-directly'

/** Records what was actually posted, and can be told to refuse specific ids. */
function fakeNative(refuse: ReadonlySet<string> = new Set()) {
  const posted: string[] = []
  return {
    posted,
    keyUp(key: KeyDef): void {
      if (refuse.has(key.id)) throw new Error(`SendInput inserted 0 of 1 for ${key.id}`)
      posted.push(key.id)
    },
    mouseUp(btn: MouseDef): void {
      if (refuse.has(btn.id)) throw new Error(`SendInput inserted 0 of 1 for ${btn.id}`)
      posted.push(btn.id)
    },
  }
}

const W = 'key-w'
const A = 'key-a'
const SHIFT = 'key-left-shift'
const LEFT = 'left'

describe('releaseInputDirectly', () => {
  it('posts an up for every id, buttons before keys', () => {
    const native = fakeNative()

    const released = releaseInputDirectly({
      native,
      keyIds: [A, W, SHIFT],
      buttonIds: [LEFT],
    })

    expect(native.posted).toEqual([LEFT, A, W, SHIFT])
    expect(released).toBe(4)
  })

  it('attempts every remaining id after one of them fails', () => {
    // The R-03(d) case: force-killed while holding Shift+W+Space, and at replay
    // time one up is refused because input is momentarily blocked. Aborting
    // there would strand every key after it.
    const native = fakeNative(new Set([A]))

    expect(() =>
      releaseInputDirectly({ native, keyIds: [A, W, SHIFT], buttonIds: [LEFT] }),
    ).toThrow(DirectReleaseError)

    expect(native.posted).toEqual([LEFT, W, SHIFT])
  })

  it('reports how many were posted and which ids failed', () => {
    const native = fakeNative(new Set([W, LEFT]))

    let thrown: unknown
    try {
      releaseInputDirectly({ native, keyIds: [A, W], buttonIds: [LEFT] })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(DirectReleaseError)
    const error = thrown as DirectReleaseError
    expect(error.releasedCount).toBe(1)
    expect(error.releasedCount).toBe(native.posted.length)
    expect([...error.failedIds]).toEqual([LEFT, W])
    expect(error.message).toContain(W)
  })

  it('never returns a count larger than the number of ups actually posted', () => {
    // The count is a promise that keys were released: `recoverStaleJournal`
    // deletes the journal on it and tells the user that many keys came up. It
    // must never count a resolvable id whose event never left the process.
    for (const refuse of [new Set<string>(), new Set([W]), new Set([W, A, LEFT])]) {
      const native = fakeNative(refuse)
      let released: number
      try {
        released = releaseInputDirectly({ native, keyIds: [A, W], buttonIds: [LEFT] })
      } catch (error) {
        expect(error).toBeInstanceOf(DirectReleaseError)
        released = (error as DirectReleaseError).releasedCount
      }
      expect(released).toBe(native.posted.length)
    }
  })

  it('throws rather than reporting a partial success, so the journal is kept', () => {
    // A normal return is proof: the caller clears the journal on it. Anything
    // that failed has to reach the caller as a throw, even when most of the
    // plan went out fine.
    const native = fakeNative(new Set([SHIFT]))

    expect(() => releaseInputDirectly({ native, keyIds: [W, SHIFT], buttonIds: [] })).toThrow(
      /could not be released/i,
    )
  })

  it('refuses to pretend anything happened when the native layer never bound', () => {
    expect(() => releaseInputDirectly({ native: null, keyIds: [W], buttonIds: [] })).toThrow(
      /not bound/i,
    )
  })

  it('skips an id this build does not know without failing the whole replay', () => {
    // A journal written by an older build can name a key this one dropped.
    // Nothing can post it, so failing forever would nag on every launch.
    const native = fakeNative()
    const notes: string[] = []

    const released = releaseInputDirectly({
      native,
      keyIds: ['key-from-the-future', W],
      buttonIds: ['button-from-the-future'],
      onError: (message) => notes.push(message),
    })

    expect(released).toBe(1)
    expect(native.posted).toEqual([W])
    expect(notes.join(' ')).toMatch(/unknown/i)
  })

  it('reports each failure as it happens', () => {
    const native = fakeNative(new Set([W]))
    const notes: string[] = []

    expect(() =>
      releaseInputDirectly({
        native,
        keyIds: [W],
        buttonIds: [],
        onError: (message) => notes.push(message),
      }),
    ).toThrow(DirectReleaseError)

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(W)
  })

  it('releases nothing and reports nothing for an empty plan', () => {
    const native = fakeNative()
    expect(releaseInputDirectly({ native, keyIds: [], buttonIds: [] })).toBe(0)
    expect(native.posted).toEqual([])
  })

  it('uses the real key and button tables, not the ids it was handed', () => {
    // Ids come off disk, so they are looked up rather than trusted.
    const seen: (KeyDef | MouseDef)[] = []
    const native = {
      keyUp: (key: KeyDef) => seen.push(key),
      mouseUp: (btn: MouseDef) => seen.push(btn),
    }

    releaseInputDirectly({ native, keyIds: [W], buttonIds: [LEFT] })

    expect(seen).toEqual([getMouseButtonById(LEFT), getKeyById(W)])
  })
})
