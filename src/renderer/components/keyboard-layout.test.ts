import { describe, expect, it } from 'vitest'
import { getBaseKeys, getKeys } from '@shared/keys'
import type { KeyDef } from '@shared/types'
import {
  BOARD_HEIGHT_U,
  BOARD_WIDTH_U,
  NAVIGATION_X_U,
  NUMPAD_X_U,
  UNIT_COMPACT,
  UNIT_FULL,
  UNIT_MIN,
  accessibleName,
  boundingBox,
  capLegend,
  computeLayout,
  findOverlaps,
  neighborOf,
  plateWidthPx,
  rangeBetween,
  rowEnds,
  rowIdOf,
  unitForWidth,
  withPlatformLabels,
} from './keyboard-layout'

const layout = computeLayout(getBaseKeys())

function placed(id: string) {
  const p = layout.byId.get(id)
  if (p === undefined) throw new Error(`no such key in layout: ${id}`)
  return p
}

describe('board constants', () => {
  it('matches the ANSI full-size arithmetic', () => {
    // 15u alphanum + 0.25u + 3u navigation + 0.25u + 4u numpad
    expect(NAVIGATION_X_U).toBe(15.25)
    expect(NUMPAD_X_U).toBe(18.5)
    expect(BOARD_WIDTH_U).toBe(22.5)
    expect(BOARD_HEIGHT_U).toBe(6.5)
  })
})

describe('computeLayout', () => {
  it('places all 104 base keys and nothing else', () => {
    expect(layout.keys).toHaveLength(104)
    expect(layout.byId.size).toBe(104)
  })

  it('drops the 10 extended keys when they are passed in', () => {
    const withExtras = computeLayout(getKeys())
    expect(getKeys()).toHaveLength(114)
    expect(withExtras.keys).toHaveLength(104)
    expect(withExtras.byId.has('key-f13')).toBe(false)
    expect(withExtras.byId.has('key-fn')).toBe(false)
    expect(withExtras.byId.has('numpad-equals')).toBe(false)
  })

  it('gives every row the unit sum the ANSI layout requires', () => {
    const expected: Record<string, number> = {
      // 13 x 1u; the remaining 2u of the 15u row are the structural gaps.
      'function:0': 13,
      'alphanum:0': 15,
      'alphanum:1': 15,
      'alphanum:2': 15,
      'alphanum:3': 15,
      'alphanum:4': 15,
      'navigation:0': 3,
      'navigation:1': 3,
      'navigation:2': 3,
      // Only the Up arrow; the two empty cells are what make the inverted-T.
      'navigation:3': 1,
      'navigation:4': 3,
      'numpad:0': 4,
      // Rows 2 and 4 are short by 1u because '+' and Enter overhang from above.
      'numpad:1': 4,
      'numpad:2': 3,
      'numpad:3': 4,
      'numpad:4': 3,
    }

    const actual: Record<string, number> = {}
    for (const [rowId, keys] of layout.rows) {
      actual[rowId] = keys.reduce((sum, p) => sum + p.w, 0)
    }

    expect(actual).toEqual(expected)
  })

  it('spans exactly 15u across the function row once the gaps are counted', () => {
    const row = layout.rows.get(rowIdOf('function', 0)) ?? []
    const first = row[0]
    const last = row[row.length - 1]
    expect(first?.key.id).toBe('key-escape')
    expect(last?.key.id).toBe('key-f12')
    expect((last?.x ?? 0) + (last?.w ?? 0) - (first?.x ?? 0)).toBe(15)
  })

  it('puts the function row at the documented x offsets', () => {
    expect(placed('key-escape').x).toBe(0)
    expect(placed('key-f1').x).toBe(2)
    expect(placed('key-f4').x).toBe(5)
    expect(placed('key-f5').x).toBe(6.5)
    expect(placed('key-f8').x).toBe(9.5)
    expect(placed('key-f9').x).toBe(11)
    expect(placed('key-f12').x).toBe(14)
  })

  it('drops the main rows below the 0.5u band gap', () => {
    expect(placed('key-escape').y).toBe(0)
    expect(placed('key-backquote').y).toBe(1.5)
    expect(placed('key-q').y).toBe(2.5)
    expect(placed('key-a').y).toBe(3.5)
    expect(placed('key-z').y).toBe(4.5)
    expect(placed('key-left-ctrl').y).toBe(5.5)
  })

  it('runs the alphanum rows left to right by cumulative width', () => {
    expect(placed('key-tab').x).toBe(0)
    expect(placed('key-q').x).toBe(1.5)
    expect(placed('key-backslash').x).toBe(13.5)
    expect(placed('key-caps-lock').x).toBe(0)
    expect(placed('key-a').x).toBe(1.75)
    expect(placed('key-enter').x).toBe(12.75)
    expect(placed('key-space').x).toBe(3.75)
  })

  it('indents the Up arrow to the middle column of the navigation cluster', () => {
    expect(placed('arrow-up').x).toBe(NAVIGATION_X_U + 1)
    expect(placed('arrow-left').x).toBe(NAVIGATION_X_U)
    expect(placed('arrow-down').x).toBe(NAVIGATION_X_U + 1)
    expect(placed('arrow-right').x).toBe(NAVIGATION_X_U + 2)
    expect(placed('key-print-screen').x).toBe(NAVIGATION_X_U)
  })

  it('makes numpad + and Enter 2u tall and overhangs them into the row below', () => {
    const add = placed('numpad-add')
    const enter = placed('numpad-enter')
    expect(add.h).toBe(2)
    expect(enter.h).toBe(2)
    expect(add.x).toBe(NUMPAD_X_U + 3)
    expect(add.y).toBe(2.5)
    expect(add.y + add.h).toBe(4.5)
    expect(enter.x).toBe(NUMPAD_X_U + 3)
    expect(enter.y).toBe(4.5)
    expect(enter.y + enter.h).toBe(6.5)
    // Every other key on the board is 1u tall.
    const tall = layout.keys.filter((p) => p.h !== 1).map((p) => p.key.id)
    expect(tall.sort()).toEqual(['numpad-add', 'numpad-enter'])
  })

  it('gives the numpad zero 2u of width and butts the decimal against it', () => {
    expect(placed('numpad-0').x).toBe(NUMPAD_X_U)
    expect(placed('numpad-0').w).toBe(2)
    expect(placed('numpad-decimal').x).toBe(NUMPAD_X_U + 2)
  })

  it('never overlaps two keys', () => {
    expect(findOverlaps(layout)).toEqual([])
  })

  it('fills the 22.5u x 6.5u bounding box exactly', () => {
    expect(boundingBox(layout)).toEqual({ minX: 0, minY: 0, maxX: 22.5, maxY: 6.5 })
  })

  it('keeps every key inside its own block', () => {
    const blocks: Record<string, [number, number]> = {
      function: [0, 15],
      alphanum: [0, 15],
      navigation: [15.25, 18.25],
      numpad: [18.5, 22.5],
    }
    for (const p of layout.keys) {
      const bounds = blocks[p.key.section]
      if (bounds === undefined) throw new Error(`unknown section ${p.key.section}`)
      expect(p.x).toBeGreaterThanOrEqual(bounds[0])
      expect(p.x + p.w).toBeLessThanOrEqual(bounds[1])
    }
  })
})

describe('unitForWidth', () => {
  it('uses the full unit only when the whole plate fits', () => {
    expect(unitForWidth(plateWidthPx(UNIT_FULL))).toBe(UNIT_FULL)
    expect(unitForWidth(plateWidthPx(UNIT_FULL) + 400)).toBe(UNIT_FULL)
  })

  it('steps down to compact rather than shrinking the full size', () => {
    expect(unitForWidth(plateWidthPx(UNIT_FULL) - 1)).toBe(UNIT_COMPACT)
    expect(unitForWidth(plateWidthPx(UNIT_COMPACT))).toBe(UNIT_COMPACT)
  })

  it('floors at the minimum unit instead of shrinking further', () => {
    expect(unitForWidth(plateWidthPx(UNIT_COMPACT) - 1)).toBe(UNIT_MIN)
    expect(unitForWidth(200)).toBe(UNIT_MIN)
    expect(unitForWidth(0)).toBe(UNIT_MIN)
  })
})

describe('rangeBetween', () => {
  it('selects inclusively along a row, in either direction', () => {
    expect(rangeBetween(layout, 'key-1', 'key-4')).toEqual([
      'key-1',
      'key-2',
      'key-3',
      'key-4',
    ])
    expect(rangeBetween(layout, 'key-4', 'key-1')).toEqual([
      'key-1',
      'key-2',
      'key-3',
      'key-4',
    ])
  })

  it('returns the single key when the anchor sits on another row', () => {
    expect(rangeBetween(layout, 'key-q', 'key-4')).toEqual(['key-4'])
  })

  it('returns the one key when anchor and target are the same', () => {
    expect(rangeBetween(layout, 'key-w', 'key-w')).toEqual(['key-w'])
  })

  it('returns nothing for an unknown id', () => {
    expect(rangeBetween(layout, 'key-w', 'key-nope')).toEqual([])
  })
})

describe('neighborOf', () => {
  it('walks along a row', () => {
    expect(neighborOf(layout, 'key-a', 'right')).toBe('key-s')
    expect(neighborOf(layout, 'key-s', 'left')).toBe('key-a')
  })

  it('walks between rows', () => {
    expect(neighborOf(layout, 'key-a', 'up')).toBe('key-q')
    expect(neighborOf(layout, 'key-a', 'down')).toBe('key-z')
    expect(neighborOf(layout, 'key-escape', 'down')).toBe('key-backquote')
    expect(neighborOf(layout, 'key-backquote', 'up')).toBe('key-escape')
  })

  it('crosses the block gaps', () => {
    expect(neighborOf(layout, 'key-backslash', 'right')).toBe('key-insert')
    expect(neighborOf(layout, 'key-page-up', 'right')).toBe('numpad-7')
    expect(neighborOf(layout, 'key-insert', 'left')).toBe('key-backslash')
  })

  it('returns null at the edges of the board', () => {
    expect(neighborOf(layout, 'key-escape', 'left')).toBeNull()
    expect(neighborOf(layout, 'key-escape', 'up')).toBeNull()
    expect(neighborOf(layout, 'numpad-subtract', 'right')).toBeNull()
  })

  it('returns null for an unknown id', () => {
    expect(neighborOf(layout, 'key-nope', 'left')).toBeNull()
  })

  it('reaches the inverted-T from the row above', () => {
    expect(neighborOf(layout, 'arrow-up', 'down')).toBe('arrow-down')
    expect(neighborOf(layout, 'arrow-down', 'up')).toBe('arrow-up')
    expect(neighborOf(layout, 'arrow-left', 'right')).toBe('arrow-down')
  })
})

describe('rowEnds', () => {
  it('finds the first and last key on a row', () => {
    expect(rowEnds(layout, 'key-g')).toEqual({ first: 'key-caps-lock', last: 'key-enter' })
    expect(rowEnds(layout, 'key-f7')).toEqual({ first: 'key-escape', last: 'key-f12' })
  })

  it('returns null for an unknown id', () => {
    expect(rowEnds(layout, 'key-nope')).toBeNull()
  })
})

describe('capLegend', () => {
  function legendFor(id: string) {
    return capLegend(placed(id).key)
  }

  it('prints the shifted legend above the primary on the number row', () => {
    const one = legendFor('key-1')
    expect(one.lines).toEqual(['1'])
    expect(one.sub).toBe('!')
    expect(one.subOnTop).toBe(true)
  })

  it('prints the navigation legend below the digit on the numpad', () => {
    const seven = legendFor('numpad-7')
    expect(seven.lines).toEqual(['7'])
    expect(seven.sub).toBe('Home')
    expect(seven.subOnTop).toBe(false)
    expect(seven.subLength).toBe(4)
  })

  it('keeps a genuine second legend on the navigation cluster', () => {
    const pause = legendFor('key-pause')
    expect(pause.lines).toEqual(['Pause'])
    expect(pause.sub).toBe('Break')
    expect(pause.subOnTop).toBe(false)
  })

  it('collapses an abbreviation sub-legend into the only legend', () => {
    const pgUp = legendFor('key-page-up')
    expect(pgUp.lines).toEqual(['PgUp'])
    expect(pgUp.sub).toBeNull()
  })

  it('wraps a two-word legend rather than shrinking it off the cap', () => {
    expect(legendFor('key-caps-lock').lines).toEqual(['Caps', 'Lock'])
    expect(legendFor('numpad-num-lock').lines).toEqual(['Num', 'Lock'])
    expect(legendFor('key-caps-lock').longest).toBe(4)
  })

  it('keeps a wide key on one line', () => {
    expect(legendFor('key-backspace').lines).toEqual(['Backspace'])
    expect(legendFor('key-space').lines).toEqual(['Space'])
  })

  it('abbreviates a long name that cannot wrap on a 1u cap', () => {
    expect(legendFor('key-insert').lines).toEqual(['Ins'])
    expect(legendFor('key-delete').lines).toEqual(['Del'])
  })

  it('leaves a platform legend alone when the abbreviation does not fit it', () => {
    // macOS calls Insert "Help". "Ins" is not a subsequence of it, so the
    // abbreviation must not be applied.
    const macInsert: KeyDef = { ...placed('key-insert').key, label: 'Help' }
    expect(capLegend(macInsert).lines).toEqual(['Help'])
  })

  it('wraps a glyph-plus-word modifier legend onto two lines', () => {
    const macCommand: KeyDef = { ...placed('key-left-meta').key, label: '⌘ Command' }
    expect(capLegend(macCommand).lines).toEqual(['⌘', 'Command'])
    expect(capLegend(macCommand).longest).toBe(7)
  })

  it('never leaves a legend line long enough to overflow a compact cap badly', () => {
    for (const p of layout.keys) {
      const legend = capLegend(p.key)
      // Roughly 5.4 characters fit per unit of width at the compact size.
      expect(legend.longest).toBeLessThanOrEqual(Math.max(5, p.w * 5.4))
    }
  })
})

describe('accessibleName', () => {
  it('uses the unabbreviated name, not the printed legend', () => {
    expect(accessibleName(placed('key-insert').key, 'idle')).toBe('Insert')
  })

  it('reads both legends on a dual-legend numpad key', () => {
    expect(accessibleName(placed('numpad-7').key, 'idle')).toBe('7, Home')
  })

  it('does not read the shifted legend on the number row', () => {
    expect(accessibleName(placed('key-1').key, 'idle')).toBe('1')
  })

  it('carries the states that aria-pressed cannot express', () => {
    const w = placed('key-w').key
    expect(accessibleName(w, 'firing')).toBe('W, firing')
    expect(accessibleName(placed('key-caps-lock').key, 'disabled')).toBe(
      'Caps Lock, cannot be held',
    )
    expect(accessibleName(placed('key-pause').key, 'unavailable')).toBe(
      'Pause, Break, not on this keyboard',
    )
  })

  it('leaves the name bare when selected, because aria-pressed says it', () => {
    expect(accessibleName(placed('key-w').key, 'selected')).toBe('W')
  })
})

describe('withPlatformLabels', () => {
  it('swaps in the macOS legends', () => {
    const mac = withPlatformLabels(getBaseKeys(), 'darwin')
    const meta = mac.find((k) => k.id === 'key-left-meta')
    expect(meta?.label).toBe('⌘ Command')
    expect(mac.find((k) => k.id === 'key-enter')?.label).toBe('Return')
  })

  it('swaps in the Windows legends', () => {
    const win = withPlatformLabels(getBaseKeys(), 'win32')
    expect(win.find((k) => k.id === 'key-left-meta')?.label).toBe('Win')
    expect(win.find((k) => k.id === 'key-backspace')?.label).toBe('Backspace')
  })

  it('returns the identical object for keys with no override', () => {
    const base = getBaseKeys()
    const mac = withPlatformLabels(base, 'darwin')
    const i = base.findIndex((k) => k.id === 'key-w')
    expect(mac[i]).toBe(base[i])
  })

  it('does not disturb the layout', () => {
    const relabelled = computeLayout(withPlatformLabels(getBaseKeys(), 'darwin'))
    expect(boundingBox(relabelled)).toEqual(boundingBox(layout))
    expect(findOverlaps(relabelled)).toEqual([])
  })
})
