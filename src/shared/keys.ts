/**
 * The single reader for `data/keys.json` and `data/mouse.json`.
 *
 * Both files are imported statically so the bundler inlines them into all three
 * processes (main, injector, renderer). Nothing else in the app is allowed to
 * read those files, and no other module re-derives key geometry or platform
 * codes.
 *
 * The JSON carries two fields that are deliberately not part of `KeyDef`:
 * `domCode` (provenance, the Chromium DomCode the codes were derived from) and
 * `platformExclusive` (needed by the UI to draw a key disabled rather than
 * leaving a hole in the layout). They are exposed through `getKeyMeta`, so
 * `KeyDef` stays exactly as the interface contract specifies.
 */
import keysJson from '../../data/keys.json'
import mouseJson from '../../data/mouse.json'
import type { KeyDef, KeySection, MouseButtonId, MouseDef, Platform } from './types'

// ---------------------------------------------------------------------------
// The on-disk shape. JSON has no `undefined`, so absent optionals are `null`
// here and are converted once, below.
// ---------------------------------------------------------------------------

interface RawKey {
  id: string
  label: string
  subLabel: string | null
  macLabel: string | null
  winLabel: string | null
  section: string
  row: number
  unitWidth: number
  unitHeight: number
  macKeyCode: number | null
  winVirtualKey: number | null
  winScanCode: number | null
  winExtended: boolean
  isModifier: boolean
  holdable: boolean
  domCode: string | null
  extra: boolean
  platformExclusive: string | null
  notes: string | null
}

interface RawMouse {
  id: string
  label: string
  description: string
  macButton: number | null
  macDownType: number | null
  macUpType: number | null
  winFlagDown: number | null
  winFlagUp: number | null
  winMouseData: number
  holdable: boolean
  repeatIntervalMsDefault?: number
  notes: string | null
}

const rawKeys: readonly RawKey[] = keysJson
const rawMouse: readonly RawMouse[] = mouseJson

// ---------------------------------------------------------------------------
// Narrowing. The JSON widens string literals to `string`, so the two union
// types in the contract are re-checked here and throw loudly at import time if
// the data ever drifts. `data/validate.mjs` catches the same drift in CI.
// ---------------------------------------------------------------------------

const KEY_SECTIONS: readonly KeySection[] = ['function', 'alphanum', 'navigation', 'numpad']

const MOUSE_BUTTON_IDS: readonly MouseButtonId[] = [
  'left',
  'right',
  'middle',
  'back',
  'forward',
  'wheel-up',
  'wheel-down',
]

function toKeySection(value: string, id: string): KeySection {
  const found = KEY_SECTIONS.find((section) => section === value)
  if (found === undefined) {
    throw new Error(`keys.json: "${id}" has an unknown section ${JSON.stringify(value)}`)
  }
  return found
}

function toMouseButtonId(value: string): MouseButtonId {
  const found = MOUSE_BUTTON_IDS.find((id) => id === value)
  if (found === undefined) {
    throw new Error(`mouse.json: unknown button id ${JSON.stringify(value)}`)
  }
  return found
}

function toPlatform(value: string | null, id: string): Platform | null {
  if (value === null) return null
  if (value === 'mac') return 'darwin'
  if (value === 'win') return 'win32'
  throw new Error(`keys.json: "${id}" has an unknown platformExclusive ${JSON.stringify(value)}`)
}

function orUndefined(value: string | null): string | undefined {
  return value === null ? undefined : value
}

// ---------------------------------------------------------------------------
// Built once at module load, then deep-frozen.
//
// Every getter below returns the same frozen array on every call. That is
// deliberate: the references are stable, so they are safe as React hook
// dependencies and cost nothing to call in a render. The price is that the
// returned arrays cannot be mutated in place, so copy before sorting:
// `[...getKeys()].sort(...)`, never `getKeys().sort(...)`.
// ---------------------------------------------------------------------------

const ALL_KEYS: KeyDef[] = rawKeys.map((raw) =>
  Object.freeze({
    id: raw.id,
    label: raw.label,
    subLabel: orUndefined(raw.subLabel),
    macLabel: orUndefined(raw.macLabel),
    winLabel: orUndefined(raw.winLabel),
    section: toKeySection(raw.section, raw.id),
    row: raw.row,
    unitWidth: raw.unitWidth,
    unitHeight: raw.unitHeight,
    macKeyCode: raw.macKeyCode,
    winVirtualKey: raw.winVirtualKey,
    winScanCode: raw.winScanCode,
    winExtended: raw.winExtended,
    isModifier: raw.isModifier,
    holdable: raw.holdable,
    extra: raw.extra,
    notes: orUndefined(raw.notes),
  }),
)
Object.freeze(ALL_KEYS)

const BASE_KEYS: KeyDef[] = ALL_KEYS.filter((key) => key.extra !== true)
const EXTRA_KEYS: KeyDef[] = ALL_KEYS.filter((key) => key.extra === true)
Object.freeze(BASE_KEYS)
Object.freeze(EXTRA_KEYS)

const KEYS_BY_ID: ReadonlyMap<string, KeyDef> = new Map(ALL_KEYS.map((key) => [key.id, key]))

/** Provenance and platform availability that `KeyDef` deliberately does not carry. */
export interface KeyMeta {
  /** The Chromium DomCode the platform codes were derived from, e.g. `"KeyW"`. */
  domCode: string | null
  /** Set when the key physically exists on only one platform. */
  platformExclusive: Platform | null
}

const KEY_META_BY_ID: ReadonlyMap<string, KeyMeta> = new Map(
  rawKeys.map((raw) => [
    raw.id,
    Object.freeze({
      domCode: raw.domCode,
      platformExclusive: toPlatform(raw.platformExclusive, raw.id),
    }),
  ]),
)

const SECTION_INDEX: Record<KeySection, KeyDef[]> = {
  function: ALL_KEYS.filter((key) => key.section === 'function'),
  alphanum: ALL_KEYS.filter((key) => key.section === 'alphanum'),
  navigation: ALL_KEYS.filter((key) => key.section === 'navigation'),
  numpad: ALL_KEYS.filter((key) => key.section === 'numpad'),
}
for (const section of KEY_SECTIONS) Object.freeze(SECTION_INDEX[section])
Object.freeze(SECTION_INDEX)

const MOUSE_BUTTONS: MouseDef[] = rawMouse.map((raw) =>
  Object.freeze({
    id: toMouseButtonId(raw.id),
    label: raw.label,
    description: raw.description,
    holdable: raw.holdable,
    macButton: raw.macButton,
    macDownType: raw.macDownType,
    macUpType: raw.macUpType,
    winFlagDown: raw.winFlagDown,
    winFlagUp: raw.winFlagUp,
    winMouseData: raw.winMouseData,
  }),
)
Object.freeze(MOUSE_BUTTONS)

const MOUSE_BY_ID: ReadonlyMap<string, MouseDef> = new Map(
  MOUSE_BUTTONS.map((button) => [button.id, button]),
)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All 114 definitions: the 104-key ANSI board plus the 10 extended keys.
 * Frozen and referentially stable. Copy before sorting.
 */
export function getKeys(): KeyDef[] {
  return ALL_KEYS
}

/**
 * The 104 keys of a standard full-size ANSI board, i.e. `extra !== true`.
 * Frozen and referentially stable. Copy before sorting.
 */
export function getBaseKeys(): KeyDef[] {
  return BASE_KEYS
}

/** The 10 keys outside the ANSI 104: F13-F20, fn, and the Apple numpad `=`. */
export function getExtraKeys(): KeyDef[] {
  return EXTRA_KEYS
}

export function getKeyById(id: string): KeyDef | undefined {
  return KEYS_BY_ID.get(id)
}

/** Provenance and platform-exclusivity for a key id, if that id exists. */
export function getKeyMeta(id: string): KeyMeta | undefined {
  return KEY_META_BY_ID.get(id)
}

/**
 * False when the key has no code at all on this platform, so the UI can render
 * it present-but-disabled instead of leaving a hole in the physical layout.
 */
export function isKeyAvailableOn(key: KeyDef, platform: Platform): boolean {
  const exclusive = KEY_META_BY_ID.get(key.id)?.platformExclusive ?? null
  if (exclusive !== null && exclusive !== platform) return false
  return platform === 'darwin' ? key.macKeyCode !== null : key.winVirtualKey !== null
}

/** All 7 buttons, in MouseButtonId order. Frozen and referentially stable. */
export function getMouseButtons(): MouseDef[] {
  return MOUSE_BUTTONS
}

export function getMouseButtonById(id: string): MouseDef | undefined {
  return MOUSE_BY_ID.get(id)
}

/**
 * The legend to print on a keycap for a given platform. Falls back to the
 * shared `label` when the key is named the same on both, so macOS gets
 * "⌘ Command" where Windows gets "Win".
 */
export function platformLabel(key: KeyDef, platform: Platform): string {
  const override = platform === 'darwin' ? key.macLabel : key.winLabel
  return override ?? key.label
}

/**
 * All keys grouped by section, in data order. Includes the 10 extras, so filter
 * on `extra !== true` when drawing the physical 104-key board.
 * Frozen and referentially stable. Copy before sorting.
 */
export function keysBySection(): Record<KeySection, KeyDef[]> {
  return SECTION_INDEX
}
