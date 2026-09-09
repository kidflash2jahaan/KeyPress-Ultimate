/**
 * Everything the app persists: presets, settings, and one bit of app state.
 *
 * Two rules govern this module.
 *
 * **Writes are atomic.** Content goes to a temp file in the same directory, is
 * fsynced, and is then renamed over the real file. A crash or a power cut can
 * therefore lose the newest write, but can never leave a half-written file that
 * makes the app unable to start.
 *
 * **Reads never throw.** A corrupt, truncated, hand-edited or wrong-version file
 * yields defaults, not an exception. Refusing to launch because presets.json is
 * damaged would be a worse failure than losing the presets, and this app already
 * has one genuinely serious failure mode (a stuck key) to spend attention on.
 *
 * `app.getPath('userData')` is passed in rather than imported, so this module
 * carries no Electron and runs under plain vitest.
 */
import * as nodeFsModule from 'node:fs'
import { join } from 'node:path'
import type { HoldMode, Preset, SessionConfig, Settings } from '../shared/types'
import type { PromptState } from './permissions'

export const SETTINGS_SCHEMA_VERSION = 1
export const PRESETS_SCHEMA_VERSION = 1
export const STATE_SCHEMA_VERSION = 1

export const SETTINGS_FILE = 'settings.json'
export const PRESETS_FILE = 'presets.json'
export const STATE_FILE = 'state.json'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  panicHotkey: 'CommandOrControl+Alt+Shift+K',
  maxSessionMinutes: 30,
  autoCheckUpdates: true,
  windowsUseVirtualKeys: false,
}

/** Timing bounds. Tap is 10-1000ms per the spec; the rest just stay sane. */
const REPEAT_INITIAL_BOUNDS = { min: 1, max: 10_000, fallback: 400 } as const
const REPEAT_INTERVAL_BOUNDS = { min: 1, max: 1_000, fallback: 33 } as const
const TAP_INTERVAL_BOUNDS = { min: 10, max: 1_000, fallback: 100 } as const

/** The slice of `node:fs` this module uses, injectable for tests. */
export interface StoreFs {
  mkdirSync(path: string): void
  readFileSync(path: string): string
  openSync(path: string, flags: string): number
  writeSync(fd: number, data: string): void
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
}

const defaultFs: StoreFs = {
  mkdirSync: (path) => {
    nodeFsModule.mkdirSync(path, { recursive: true })
  },
  readFileSync: (path) => nodeFsModule.readFileSync(path, 'utf8'),
  openSync: (path, flags) => nodeFsModule.openSync(path, flags),
  writeSync: (fd, data) => {
    nodeFsModule.writeSync(fd, data)
  },
  fsyncSync: (fd) => {
    nodeFsModule.fsyncSync(fd)
  },
  closeSync: (fd) => {
    nodeFsModule.closeSync(fd)
  },
  renameSync: (from, to) => {
    nodeFsModule.renameSync(from, to)
  },
  unlinkSync: (path) => {
    nodeFsModule.unlinkSync(path)
  },
}

/**
 * A migration hook. It receives the raw `data` payload and the version it was
 * written at, and returns something the sanitizer can read. Throwing is allowed
 * and means "give up, use defaults".
 */
export type Migration = (data: unknown, fromVersion: number) => unknown

export interface StoreDeps {
  /** `app.getPath('userData')`. */
  userDataDir: string
  fs?: StoreFs
  now?: () => number
  migrateSettings?: Migration
  migratePresets?: Migration
}

export interface Store {
  readonly paths: { settings: string; presets: string; state: string }
  loadSettings(): Settings
  /** Returns what was actually written, after sanitising. */
  saveSettings(settings: Settings): Settings
  loadPresets(): Preset[]
  savePresets(presets: readonly Preset[]): Preset[]
  upsertPreset(preset: Preset): Preset[]
  deletePreset(id: string): Preset[]
  /** Persisted "the macOS Accessibility prompt has been spent" bit. */
  readonly promptState: PromptState
}

// ---------------------------------------------------------------------------
// sanitising
// ---------------------------------------------------------------------------

const THEMES: readonly Settings['theme'][] = ['system', 'dark', 'light']
const MODES: readonly HoldMode[] = ['hold', 'hold-repeat', 'tap']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const id = nonEmptyString(item)
    if (id !== null && !out.includes(id)) out.push(id)
  }
  return out
}

function clampInt(
  value: unknown,
  bounds: { min: number; max: number; fallback: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

export function sanitizeSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return { ...DEFAULT_SETTINGS }

  const theme = raw['theme']
  const panicHotkey = nonEmptyString(raw['panicHotkey'])
  const maxSessionMinutes = raw['maxSessionMinutes']
  const autoCheckUpdates = raw['autoCheckUpdates']
  const windowsUseVirtualKeys = raw['windowsUseVirtualKeys']

  return {
    theme: THEMES.includes(theme as Settings['theme'])
      ? (theme as Settings['theme'])
      : DEFAULT_SETTINGS.theme,
    panicHotkey: panicHotkey ?? DEFAULT_SETTINGS.panicHotkey,
    maxSessionMinutes:
      typeof maxSessionMinutes === 'number' &&
      Number.isFinite(maxSessionMinutes) &&
      maxSessionMinutes >= 0
        ? Math.floor(maxSessionMinutes)
        : DEFAULT_SETTINGS.maxSessionMinutes,
    autoCheckUpdates:
      typeof autoCheckUpdates === 'boolean' ? autoCheckUpdates : DEFAULT_SETTINGS.autoCheckUpdates,
    windowsUseVirtualKeys:
      typeof windowsUseVirtualKeys === 'boolean'
        ? windowsUseVirtualKeys
        : DEFAULT_SETTINGS.windowsUseVirtualKeys,
  }
}

function sanitizeConfig(raw: unknown): SessionConfig | null {
  if (!isRecord(raw)) return null
  const mode = raw['mode']
  if (!MODES.includes(mode as HoldMode)) return null

  return {
    keyIds: stringList(raw['keyIds']),
    buttonIds: stringList(raw['buttonIds']),
    targets: stringList(raw['targets']),
    mode: mode as HoldMode,
    repeatInitialMs: clampInt(raw['repeatInitialMs'], REPEAT_INITIAL_BOUNDS),
    repeatIntervalMs: clampInt(raw['repeatIntervalMs'], REPEAT_INTERVAL_BOUNDS),
    tapIntervalMs: clampInt(raw['tapIntervalMs'], TAP_INTERVAL_BOUNDS),
  }
}

export function sanitizePreset(raw: unknown, now: number): Preset | null {
  if (!isRecord(raw)) return null
  const id = nonEmptyString(raw['id'])
  const name = nonEmptyString(raw['name'])
  if (id === null || name === null) return null

  const config = sanitizeConfig(raw['config'])
  if (config === null) return null

  const updatedAt = raw['updatedAt']
  return {
    id,
    name,
    config,
    updatedAt:
      typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0
        ? updatedAt
        : now,
  }
}

function sanitizePresets(raw: unknown, now: number): Preset[] {
  if (!Array.isArray(raw)) return []
  const out: Preset[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const preset = sanitizePreset(item, now)
    if (preset === null || seen.has(preset.id)) continue
    seen.add(preset.id)
    out.push(preset)
  }
  return out
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export function createStore(deps: StoreDeps): Store {
  const fs = deps.fs ?? defaultFs
  const now = deps.now ?? (() => Date.now())

  const paths = {
    settings: join(deps.userDataDir, SETTINGS_FILE),
    presets: join(deps.userDataDir, PRESETS_FILE),
    state: join(deps.userDataDir, STATE_FILE),
  }

  /** Write temp, fsync, rename. Never leaves the real file half-written. */
  function writeAtomic(path: string, payload: unknown): void {
    const text = JSON.stringify(payload, null, 2)
    const tmp = `${path}.${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`

    fs.mkdirSync(deps.userDataDir)

    let fd: number | null = null
    try {
      fd = fs.openSync(tmp, 'w')
      fs.writeSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          // Already closed or never really opened. Nothing to salvage.
        }
      }
    }

    try {
      fs.renameSync(tmp, path)
    } catch (error) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // Best effort. A stray .tmp is harmless, an unhandled throw is not.
      }
      throw error
    }
  }

  /**
   * Reads one envelope. Returns the payload, or null for missing, unreadable,
   * unparseable, wrong-shaped, or un-migratable content.
   */
  function readEnvelope(path: string, currentVersion: number, migrate?: Migration): unknown {
    let text: string
    try {
      text = fs.readFileSync(path)
    } catch {
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }

    if (!isRecord(parsed)) return null
    const version = parsed['schemaVersion']
    if (typeof version !== 'number' || !Number.isFinite(version)) return null
    const data = parsed['data']

    if (version === currentVersion) return data
    if (migrate === undefined) return null
    try {
      return migrate(data, version)
    } catch {
      return null
    }
  }

  function loadPresets(): Preset[] {
    return sanitizePresets(
      readEnvelope(paths.presets, PRESETS_SCHEMA_VERSION, deps.migratePresets),
      now(),
    )
  }

  function savePresets(presets: readonly Preset[]): Preset[] {
    const clean = sanitizePresets(presets, now())
    writeAtomic(paths.presets, { schemaVersion: PRESETS_SCHEMA_VERSION, data: clean })
    return clean
  }

  // The Accessibility prompt bit is read once and cached: it only ever goes
  // false -> true, and it is consulted on every permission status render.
  let promptUsed: boolean | null = null

  function readPromptUsed(): boolean {
    if (promptUsed !== null) return promptUsed
    const data = readEnvelope(paths.state, STATE_SCHEMA_VERSION)
    promptUsed = isRecord(data) && data['accessibilityPromptUsed'] === true
    return promptUsed
  }

  return {
    paths,

    loadSettings(): Settings {
      return sanitizeSettings(
        readEnvelope(paths.settings, SETTINGS_SCHEMA_VERSION, deps.migrateSettings),
      )
    },

    saveSettings(settings: Settings): Settings {
      const clean = sanitizeSettings(settings)
      writeAtomic(paths.settings, { schemaVersion: SETTINGS_SCHEMA_VERSION, data: clean })
      return clean
    },

    loadPresets,
    savePresets,

    upsertPreset(preset: Preset): Preset[] {
      const clean = sanitizePreset(preset, now())
      if (clean === null) return loadPresets()
      const next = loadPresets().filter((p) => p.id !== clean.id)
      next.push(clean)
      return savePresets(next)
    },

    deletePreset(id: string): Preset[] {
      const next = loadPresets().filter((p) => p.id !== id)
      return savePresets(next)
    },

    promptState: {
      wasUsed: readPromptUsed,
      markUsed(): void {
        if (readPromptUsed()) return
        promptUsed = true
        writeAtomic(paths.state, {
          schemaVersion: STATE_SCHEMA_VERSION,
          data: { accessibilityPromptUsed: true },
        })
      },
    },
  }
}
