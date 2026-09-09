import { describe, expect, it } from 'vitest'
import {
  getBaseKeys,
  getExtraKeys,
  getKeyById,
  getKeyMeta,
  getKeys,
  getMouseButtonById,
  getMouseButtons,
  isKeyAvailableOn,
  keysBySection,
  platformLabel,
} from './keys'
import type { KeySection, MouseButtonId } from './types'

describe('key data', () => {
  it('holds 114 definitions: 104 base plus 10 extras', () => {
    expect(getKeys()).toHaveLength(114)
    expect(getBaseKeys()).toHaveLength(104)
    expect(getExtraKeys()).toHaveLength(10)
  })

  it('defines the base set as exactly the keys with extra !== true', () => {
    expect(getBaseKeys().every((key) => key.extra !== true)).toBe(true)
    expect(getExtraKeys().every((key) => key.extra === true)).toBe(true)
    expect(getBaseKeys().length + getExtraKeys().length).toBe(getKeys().length)
  })

  it('has no duplicate ids', () => {
    const ids = getKeys().map((key) => key.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every non-null macKeyCode to exactly one key', () => {
    const seen = new Map<number, string>()
    const collisions: string[] = []
    for (const key of getKeys()) {
      if (key.macKeyCode === null) continue
      const previous = seen.get(key.macKeyCode)
      if (previous !== undefined) {
        collisions.push(`0x${key.macKeyCode.toString(16)}: ${previous} and ${key.id}`)
      } else {
        seen.set(key.macKeyCode, key.id)
      }
    }
    expect(collisions).toEqual([])
    // 3 Windows-only keys have no macOS keycode at all.
    expect(seen.size).toBe(114 - 3)
  })

  it('gives every non-null winVirtualKey to exactly one key, bar the documented VK_RETURN alias', () => {
    const seen = new Map<number, string>()
    const collisions: Array<{ vk: number; a: string; b: string }> = []
    for (const key of getKeys()) {
      if (key.winVirtualKey === null) continue
      const previous = seen.get(key.winVirtualKey)
      if (previous !== undefined) {
        collisions.push({ vk: key.winVirtualKey, a: previous, b: key.id })
      } else {
        seen.set(key.winVirtualKey, key.id)
      }
    }
    // Enter and numpad Enter genuinely share VK_RETURN (0x0D) on Windows. That
    // is the API, not a data error: the pair is disambiguated by
    // KEYEVENTF_EXTENDEDKEY plus scancode 0x1C. Exactly one such pair is
    // allowed, and nothing else.
    expect(collisions).toEqual([{ vk: 0x0d, a: 'key-enter', b: 'numpad-enter' }])
  })

  it('keeps the (winVirtualKey, winExtended, winScanCode) triple unique so injection is unambiguous', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const key of getKeys()) {
      if (key.winVirtualKey === null) continue
      const triple = `${key.winVirtualKey}|${key.winExtended}|${key.winScanCode}`
      if (seen.has(triple)) duplicates.push(`${key.id} (${triple})`)
      seen.add(triple)
    }
    expect(duplicates).toEqual([])
  })

  it('marks only the three lock keys as non-holdable', () => {
    const notHoldable = getKeys()
      .filter((key) => !key.holdable)
      .map((key) => key.id)
      .sort()
    expect(notHoldable).toEqual(['key-caps-lock', 'key-scroll-lock', 'numpad-num-lock'])
  })

  it('looks a key up by id, and returns undefined for one that does not exist', () => {
    const w = getKeyById('key-w')
    expect(w?.label).toBe('W')
    expect(w?.section).toBe('alphanum')
    expect(getKeyById('key-does-not-exist')).toBeUndefined()
  })

  it('groups every key into its section, with the ANSI counts', () => {
    const bySection = keysBySection()
    const sections: KeySection[] = ['function', 'alphanum', 'navigation', 'numpad']
    const total = sections.reduce((sum, section) => sum + bySection[section].length, 0)
    expect(total).toBe(114)
    for (const section of sections) {
      expect(bySection[section].every((key) => key.section === section)).toBe(true)
    }
    // Esc + F1-F12, then F13-F20 as extras.
    expect(bySection.function).toHaveLength(21)
  })

  it('sums each alphanumeric row of the base board to exactly 15u', () => {
    const base = getBaseKeys().filter((key) => key.section === 'alphanum')
    for (const row of [0, 1, 2, 3, 4]) {
      const width = base
        .filter((key) => key.row === row)
        .reduce((sum, key) => sum + key.unitWidth, 0)
      expect(width).toBeCloseTo(15, 9)
    }
  })
})

describe('platformLabel', () => {
  it('prints Mac legends on darwin', () => {
    const meta = getKeyById('key-left-meta')
    const alt = getKeyById('key-left-alt')
    const enter = getKeyById('key-enter')
    const backspace = getKeyById('key-backspace')
    expect(meta && platformLabel(meta, 'darwin')).toBe('⌘ Command')
    expect(alt && platformLabel(alt, 'darwin')).toBe('⌥ Option')
    expect(enter && platformLabel(enter, 'darwin')).toBe('Return')
    expect(backspace && platformLabel(backspace, 'darwin')).toBe('⌫ Delete')
  })

  it('prints Windows legends on win32', () => {
    const meta = getKeyById('key-left-meta')
    const alt = getKeyById('key-left-alt')
    const enter = getKeyById('key-enter')
    const backspace = getKeyById('key-backspace')
    expect(meta && platformLabel(meta, 'win32')).toBe('Win')
    expect(alt && platformLabel(alt, 'win32')).toBe('Alt')
    expect(enter && platformLabel(enter, 'win32')).toBe('Enter')
    expect(backspace && platformLabel(backspace, 'win32')).toBe('Backspace')
  })

  it('falls back to the shared label when a key is named the same on both', () => {
    const w = getKeyById('key-w')
    expect(w && platformLabel(w, 'darwin')).toBe('W')
    expect(w && platformLabel(w, 'win32')).toBe('W')
  })

  it('never returns an empty legend for any key on either platform', () => {
    for (const key of getKeys()) {
      expect(platformLabel(key, 'darwin').length).toBeGreaterThan(0)
      expect(platformLabel(key, 'win32').length).toBeGreaterThan(0)
    }
  })
})

describe('platform availability', () => {
  it('reports the three Windows-only keys as unavailable on macOS', () => {
    for (const id of ['key-print-screen', 'key-scroll-lock', 'key-pause']) {
      const key = getKeyById(id)
      expect(key).toBeDefined()
      if (!key) continue
      expect(isKeyAvailableOn(key, 'darwin')).toBe(false)
      expect(isKeyAvailableOn(key, 'win32')).toBe(true)
      expect(getKeyMeta(id)?.platformExclusive).toBe('win32')
    }
  })

  it('reports the Mac-only keys as unavailable on Windows', () => {
    for (const id of ['key-fn', 'numpad-equals']) {
      const key = getKeyById(id)
      expect(key).toBeDefined()
      if (!key) continue
      expect(isKeyAvailableOn(key, 'win32')).toBe(false)
      expect(isKeyAvailableOn(key, 'darwin')).toBe(true)
      expect(getKeyMeta(id)?.platformExclusive).toBe('darwin')
    }
  })

  it('carries the DomCode a key was derived from', () => {
    expect(getKeyMeta('key-w')?.domCode).toBe('KeyW')
    expect(getKeyMeta('key-w')?.platformExclusive).toBeNull()
    expect(getKeyMeta('nope')).toBeUndefined()
  })
})

describe('mouse data', () => {
  it('holds the 7 buttons of the MouseButtonId union, in order', () => {
    const expected: MouseButtonId[] = [
      'left',
      'right',
      'middle',
      'back',
      'forward',
      'wheel-up',
      'wheel-down',
    ]
    expect(getMouseButtons().map((button) => button.id)).toEqual(expected)
  })

  it('marks the two wheel entries as not holdable, and everything else as holdable', () => {
    const notHoldable = getMouseButtons()
      .filter((button) => !button.holdable)
      .map((button) => button.id)
    expect(notHoldable).toEqual(['wheel-up', 'wheel-down'])
  })

  it('gives every holdable button a real release path on both platforms', () => {
    for (const button of getMouseButtons().filter((b) => b.holdable)) {
      expect(button.macUpType).not.toBeNull()
      expect(button.winFlagUp).not.toBeNull()
      expect(button.macButton).not.toBeNull()
    }
  })

  it('looks a button up by id', () => {
    expect(getMouseButtonById('left')?.macButton).toBe(0)
    expect(getMouseButtonById('mouse-left')).toBeUndefined()
  })
})
