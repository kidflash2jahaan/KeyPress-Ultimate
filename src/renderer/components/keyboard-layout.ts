/**
 * Physical geometry for a full-size ANSI 104 keyboard, in key units.
 *
 * Everything here is a pure function over `KeyDef[]`. No React, no DOM, no
 * store, so `keyboard-layout.test.ts` can assert the real board dimensions
 * rather than a snapshot of whatever the renderer happened to draw.
 *
 * The numbers come from `data/layout-notes.md`, which in turn comes from the
 * ANSI/ISO 19.05mm switch pitch. Nothing is invented here:
 *
 *   alphanumeric 15u | 0.25u | navigation 3u | 0.25u | numpad 4u  = 22.5u
 *   function row 1u  | 0.5u vertical gap     | 5 main rows        =  6.5u
 */
import { platformLabel } from '@shared/keys'
import type { KeyDef, KeySection, Platform } from '@shared/types'

// ---------------------------------------------------------------------------
// Board constants, in key units (u)
// ---------------------------------------------------------------------------

export const ALPHANUM_WIDTH_U = 15
export const NAVIGATION_WIDTH_U = 3
export const NUMPAD_WIDTH_U = 4
export const BLOCK_GAP_U = 0.25

/** x offset of each block's left edge from the left edge of the board. */
export const ALPHANUM_X_U = 0
export const NAVIGATION_X_U = ALPHANUM_WIDTH_U + BLOCK_GAP_U // 15.25
export const NUMPAD_X_U = NAVIGATION_X_U + NAVIGATION_WIDTH_U + BLOCK_GAP_U // 18.5

export const BOARD_WIDTH_U = NUMPAD_X_U + NUMPAD_WIDTH_U // 22.5
export const BOARD_HEIGHT_U = 6.5

/** Vertical gap between the function row and the five main rows. */
export const FUNCTION_GAP_U = 0.5
/** y of the first main row: function row (1u) + the gap under it. */
export const MAIN_ROWS_Y_U = 1 + FUNCTION_GAP_U // 1.5

// ---------------------------------------------------------------------------
// Render scale
// ---------------------------------------------------------------------------

/** `--u` at the default desktop size. 22.5u x 6.5u -> 1080 x 312 px. */
export const UNIT_FULL = 48
/** `--u` in the compact band, where dual legends are still readable. */
export const UNIT_COMPACT = 34
/** The floor. Below this the plate scrolls horizontally instead of shrinking. */
export const UNIT_MIN = 30

/** Horizontal padding the plate adds around the board, as a multiple of `--u`. */
export const PLATE_PAD_U = 0.25

/**
 * The largest of the three sanctioned unit sizes whose plate fits in
 * `availablePx`. Never returns less than `UNIT_MIN`: at that point the plate
 * scrolls inside its own container rather than shrinking the legends further.
 */
export function unitForWidth(availablePx: number): number {
  for (const unit of [UNIT_FULL, UNIT_COMPACT] as const) {
    if (plateWidthPx(unit) <= availablePx) return unit
  }
  return UNIT_MIN
}

/** Total plate width in CSS pixels at a given unit, padding included. */
export function plateWidthPx(unit: number): number {
  return (BOARD_WIDTH_U + PLATE_PAD_U * 2) * unit
}

/** Total plate height in CSS pixels at a given unit, padding included. */
export function plateHeightPx(unit: number): number {
  return (BOARD_HEIGHT_U + PLATE_PAD_U * 2) * unit
}

// ---------------------------------------------------------------------------
// Structural gaps that live in the layout, not in the data
// ---------------------------------------------------------------------------

/**
 * Extra space inserted *before* a key, beyond the running cumulative width.
 * The function row is the only place a row is not simply keys butted together:
 * Esc sits alone, then F1-F4, F5-F8 and F9-F12 in groups of four.
 */
const LEADING_GAP_U: Readonly<Record<string, number>> = {
  'key-f1': 1,
  'key-f5': 0.5,
  'key-f9': 0.5,
}

/**
 * Where a row starts inside its own block, when it is not flush left.
 * Only the navigation cluster's Up-arrow row is indented, which is what makes
 * the inverted-T.
 */
const ROW_START_U: Readonly<Record<string, number>> = {
  'navigation:3': 1,
}

const BLOCK_X_U: Readonly<Record<KeySection, number>> = {
  function: 0,
  alphanum: ALPHANUM_X_U,
  navigation: NAVIGATION_X_U,
  numpad: NUMPAD_X_U,
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface PlacedKey {
  readonly key: KeyDef
  /** Left edge in key units, from the left edge of the board. */
  readonly x: number
  /** Top edge in key units, from the top edge of the board. */
  readonly y: number
  readonly w: number
  readonly h: number
  /** `section:row`. Two keys share a row iff they share this string. */
  readonly rowId: string
}

export interface KeyboardLayout {
  readonly keys: readonly PlacedKey[]
  readonly widthU: number
  readonly heightU: number
  /** Row id -> the keys on that row, left to right. */
  readonly rows: ReadonlyMap<string, readonly PlacedKey[]>
  readonly byId: ReadonlyMap<string, PlacedKey>
}

export function rowIdOf(section: KeySection, row: number): string {
  return `${section}:${row}`
}

/** y of a row's top edge. The function row sits above the 0.5u band gap. */
export function rowY(section: KeySection, row: number): number {
  return section === 'function' ? row : MAIN_ROWS_Y_U + row
}

/**
 * Place every key on the board.
 *
 * Keys are laid out in the order given, grouped by `section:row`, each row
 * running left to right from its block's x offset. Keys flagged `extra` are
 * dropped: F13-F20, fn and the Apple numpad `=` are not part of the 104-key
 * board and belong in their own opt-in strip.
 */
export function computeLayout(keys: readonly KeyDef[]): KeyboardLayout {
  const rows = new Map<string, PlacedKey[]>()
  const byId = new Map<string, PlacedKey>()
  const cursors = new Map<string, number>()

  for (const key of keys) {
    if (key.extra === true) continue

    const rowId = rowIdOf(key.section, key.row)
    const blockX = BLOCK_X_U[key.section]
    const start = ROW_START_U[rowId] ?? 0
    const cursor = cursors.get(rowId) ?? start
    const x = cursor + (LEADING_GAP_U[key.id] ?? 0)

    const placed: PlacedKey = {
      key,
      x: blockX + x,
      y: rowY(key.section, key.row),
      w: key.unitWidth,
      h: key.unitHeight,
      rowId,
    }

    cursors.set(rowId, x + key.unitWidth)

    const bucket = rows.get(rowId)
    if (bucket === undefined) rows.set(rowId, [placed])
    else bucket.push(placed)
    byId.set(key.id, placed)
  }

  const all: PlacedKey[] = []
  for (const bucket of rows.values()) all.push(...bucket)

  return { keys: all, widthU: BOARD_WIDTH_U, heightU: BOARD_HEIGHT_U, rows, byId }
}

/** Bounding box of a laid-out board, for tests and for sizing the plate. */
export function boundingBox(layout: KeyboardLayout): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of layout.keys) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + p.w)
    maxY = Math.max(maxY, p.y + p.h)
  }
  return { minX, minY, maxX, maxY }
}

/** Every pair of keys whose rectangles intersect. Empty on a correct board. */
export function findOverlaps(layout: KeyboardLayout): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const all = layout.keys
  for (let i = 0; i < all.length; i += 1) {
    const a = all[i]
    if (a === undefined) continue
    for (let j = i + 1; j < all.length; j += 1) {
      const b = all[j]
      if (b === undefined) continue
      const overlapX = a.x < b.x + b.w && b.x < a.x + a.w
      const overlapY = a.y < b.y + b.h && b.y < a.y + a.h
      if (overlapX && overlapY) out.push([a.key.id, b.key.id])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Selection and navigation
// ---------------------------------------------------------------------------

/**
 * The ids from `anchorId` to `targetId` inclusive, when both sit on the same
 * row. Shift-clicking across rows would sweep up a rectangle of unrelated keys,
 * so that case selects only the target.
 */
export function rangeBetween(
  layout: KeyboardLayout,
  anchorId: string,
  targetId: string,
): string[] {
  const anchor = layout.byId.get(anchorId)
  const target = layout.byId.get(targetId)
  if (anchor === undefined || target === undefined) return []
  if (anchor.rowId !== target.rowId) return [targetId]

  const row = layout.rows.get(anchor.rowId) ?? []
  const lo = Math.min(anchor.x, target.x)
  const hi = Math.max(anchor.x, target.x)
  return row.filter((p) => p.x >= lo && p.x <= hi).map((p) => p.key.id)
}

export type ArrowDirection = 'left' | 'right' | 'up' | 'down'

/**
 * The key a focus arrow should land on: the nearest key in that direction,
 * measured centre to centre, with movement across the primary axis weighted
 * three times more heavily so the focus ring stays on its row or column
 * instead of cutting diagonally between blocks.
 */
export function neighborOf(
  layout: KeyboardLayout,
  fromId: string,
  direction: ArrowDirection,
): string | null {
  const from = layout.byId.get(fromId)
  if (from === undefined) return null

  const fx = from.x + from.w / 2
  const fy = from.y + from.h / 2
  const horizontal = direction === 'left' || direction === 'right'
  const sign = direction === 'left' || direction === 'up' ? -1 : 1

  let best: PlacedKey | null = null
  let bestScore = Infinity

  for (const p of layout.keys) {
    if (p.key.id === fromId) continue
    const px = p.x + p.w / 2
    const py = p.y + p.h / 2
    const along = horizontal ? (px - fx) * sign : (py - fy) * sign
    if (along <= 0.001) continue
    const across = horizontal ? Math.abs(py - fy) : Math.abs(px - fx)
    const score = along + across * 3
    if (score < bestScore) {
      bestScore = score
      best = p
    }
  }

  return best === null ? null : best.key.id
}

/** First and last key on a row, for Home and End. */
export function rowEnds(layout: KeyboardLayout, id: string): { first: string; last: string } | null {
  const placed = layout.byId.get(id)
  if (placed === undefined) return null
  const row = layout.rows.get(placed.rowId)
  const first = row?.[0]
  const last = row?.[row.length - 1]
  if (first === undefined || last === undefined) return null
  return { first: first.key.id, last: last.key.id }
}

// ---------------------------------------------------------------------------
// Legends
// ---------------------------------------------------------------------------

/**
 * Short forms for keys whose full name cannot fit a 1u cap at `UNIT_COMPACT`.
 * Applied only when the short form is a subsequence of the resolved label, so a
 * platform override is never mislabelled: Insert becomes "Ins", but the macOS
 * legend for the same key ("Help") is left alone.
 */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  'key-insert': 'Ins',
  'key-delete': 'Del',
  'key-print-screen': 'PrtSc',
  'key-scroll-lock': 'ScrLk',
  'key-page-up': 'PgUp',
  'key-page-down': 'PgDn',
}

function isSubsequence(needle: string, haystack: string): boolean {
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  let i = 0
  for (const ch of h) {
    if (ch === n[i]) i += 1
    if (i === n.length) return true
  }
  return n.length === 0
}

export interface CapLegend {
  /** The main legend, one entry per printed line. */
  readonly lines: readonly string[]
  /** The second legend, or null when the cap carries only one. */
  readonly sub: string | null
  /** True when `sub` prints above `lines` (the shifted legend, "!" over "1"). */
  readonly subOnTop: boolean
  /** Longest printed line in characters, used to fit the type to the cap. */
  readonly longest: number
  /** Characters in `sub`. */
  readonly subLength: number
}

/**
 * What actually gets printed on the keycap.
 *
 * Three sub-legend shapes exist in the data and they are not the same thing:
 *
 *  - alphanum: the shifted legend, which prints *above* the primary ("!" / "1")
 *  - numpad: the navigation legend, which prints *below* ("7" / "Home")
 *  - navigation: usually an abbreviation of the same name ("Page Up" / "PgUp"),
 *    in which case only the short form is printed, but sometimes a genuine
 *    second legend (Pause / Break), which prints below.
 */
export function capLegend(key: KeyDef): CapLegend {
  let label = key.label
  let sub: string | null = key.subLabel ?? null
  let subOnTop = false

  if (sub !== null) {
    if (key.section === 'alphanum') {
      subOnTop = true
    } else if (key.section === 'navigation' && sub.length < label.length) {
      // An abbreviation of the primary, not a second legend. Print it alone.
      label = sub
      sub = null
    }
  }

  let lines = label.includes(' ') && key.unitWidth < 2.5 ? label.split(' ') : [label]
  let longest = lines.reduce((max, line) => Math.max(max, line.length), 0)

  const abbreviation = ABBREVIATIONS[key.id]
  if (
    abbreviation !== undefined &&
    key.unitWidth <= 1 &&
    longest > 4 &&
    isSubsequence(abbreviation, label)
  ) {
    lines = [abbreviation]
    longest = abbreviation.length
  }

  return { lines, sub, subOnTop, longest, subLength: sub === null ? 0 : sub.length }
}

export type KeyState = 'idle' | 'selected' | 'firing' | 'disabled' | 'unavailable'

/**
 * The name a screen reader announces. The visual cap is abbreviated for space;
 * this never is. `selected` is deliberately absent: it is carried by
 * `aria-pressed`, and announcing it twice is noise.
 */
export function accessibleName(key: KeyDef, state: KeyState): string {
  const parts = [key.label]
  if (key.subLabel !== undefined && (key.section === 'numpad' || key.section === 'navigation')) {
    parts.push(key.subLabel)
  }
  const name = parts.join(', ')

  switch (state) {
    case 'firing':
      return `${name}, firing`
    case 'disabled':
      return `${name}, cannot be held`
    case 'unavailable':
      return `${name}, not on this keyboard`
    case 'idle':
    case 'selected':
      return name
  }
}

/**
 * `keys` with each `label` replaced by the legend for `platform`, so the board
 * prints "⌘ Command" on macOS and "Win" on Windows without the component
 * needing to know which platform it is running on.
 */
export function withPlatformLabels(keys: readonly KeyDef[], platform: Platform): KeyDef[] {
  return keys.map((key) => {
    const label = platformLabel(key, platform)
    return label === key.label ? key : { ...key, label }
  })
}
