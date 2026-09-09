import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Preset, Settings } from '../shared/types'
import {
  DEFAULT_SETTINGS,
  PRESETS_SCHEMA_VERSION,
  SESSION_MINUTES_BOUNDS,
  SETTINGS_SCHEMA_VERSION,
  createStore,
} from './store'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kpu-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function validPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'p1',
    name: 'Minecraft AFK',
    config: {
      keyIds: ['w'],
      buttonIds: ['left'],
      targets: ['com.mojang.minecraft'],
      mode: 'hold',
      repeatInitialMs: 400,
      repeatIntervalMs: 33,
      tapIntervalMs: 100,
    },
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('settings', () => {
  it('has the defaults the spec names', () => {
    expect(DEFAULT_SETTINGS).toEqual<Settings>({
      theme: 'system',
      panicHotkey: 'CommandOrControl+Alt+Shift+K',
      maxSessionMinutes: 30,
      autoCheckUpdates: true,
      windowsUseVirtualKeys: false,
    })
  })

  it('returns defaults when nothing has ever been written', () => {
    const store = createStore({ userDataDir: join(dir, 'never-created') })

    expect(store.loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults instead of throwing when the file is corrupt', () => {
    writeFileSync(join(dir, 'settings.json'), '{ this is not: json ')
    const store = createStore({ userDataDir: dir })

    expect(() => store.loadSettings()).not.toThrow()
    expect(store.loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults when the file holds valid JSON of the wrong shape', () => {
    writeFileSync(join(dir, 'settings.json'), '[1,2,3]')
    const store = createStore({ userDataDir: dir })

    expect(store.loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips through a fresh store instance', () => {
    const writer = createStore({ userDataDir: dir })
    writer.saveSettings({ ...DEFAULT_SETTINGS, theme: 'dark', maxSessionMinutes: 0 })

    const reader = createStore({ userDataDir: dir })
    expect(reader.loadSettings().theme).toBe('dark')
    expect(reader.loadSettings().maxSessionMinutes).toBe(0)
  })

  it('writes a schema version alongside the data', () => {
    const store = createStore({ userDataDir: dir })
    store.saveSettings(DEFAULT_SETTINGS)

    const raw: unknown = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect((raw as { schemaVersion: number }).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('replaces individually bad fields with defaults rather than failing the load', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        data: {
          theme: 'purple',
          panicHotkey: '',
          maxSessionMinutes: -5,
          autoCheckUpdates: 'yes',
          windowsUseVirtualKeys: true,
        },
      }),
    )
    const store = createStore({ userDataDir: dir })

    const settings = store.loadSettings()
    expect(settings.theme).toBe('system')
    expect(settings.panicHotkey).toBe(DEFAULT_SETTINGS.panicHotkey)
    expect(settings.maxSessionMinutes).toBe(DEFAULT_SETTINGS.maxSessionMinutes)
    expect(settings.autoCheckUpdates).toBe(true)
    // The one field that was actually valid survives.
    expect(settings.windowsUseVirtualKeys).toBe(true)
  })

  it('clamps a hand-edited session cap to a day, so the timer cannot overflow', () => {
    // 100000 minutes is 6e9 ms, past the signed 32-bit ceiling setTimeout
    // stores. Left unclamped it is silently rounded down to 1ms and every
    // session ends the instant it starts.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        data: { ...DEFAULT_SETTINGS, maxSessionMinutes: 100_000 },
      }),
    )
    const store = createStore({ userDataDir: dir })

    const minutes = store.loadSettings().maxSessionMinutes
    expect(minutes).toBe(SESSION_MINUTES_BOUNDS.max)
    expect(minutes * 60_000).toBeLessThan(2_147_483_647)
  })

  it('clamps on save as well as on load, so a bad value cannot be persisted', () => {
    const store = createStore({ userDataDir: dir })

    const written = store.saveSettings({ ...DEFAULT_SETTINGS, maxSessionMinutes: 10 ** 12 })

    expect(written.maxSessionMinutes).toBe(SESSION_MINUTES_BOUNDS.max)
    expect(createStore({ userDataDir: dir }).loadSettings().maxSessionMinutes).toBe(
      SESSION_MINUTES_BOUNDS.max,
    )
  })

  it('keeps every in-range session cap, including the unlimited 0 and the bound itself', () => {
    const store = createStore({ userDataDir: dir })

    expect(store.saveSettings({ ...DEFAULT_SETTINGS, maxSessionMinutes: 0 }).maxSessionMinutes).toBe(
      0,
    )
    expect(
      store.saveSettings({ ...DEFAULT_SETTINGS, maxSessionMinutes: SESSION_MINUTES_BOUNDS.max })
        .maxSessionMinutes,
    ).toBe(SESSION_MINUTES_BOUNDS.max)
    expect(
      store.saveSettings({ ...DEFAULT_SETTINGS, maxSessionMinutes: 45.9 }).maxSessionMinutes,
    ).toBe(45)
  })

  it('falls back to the default for a negative cap rather than clamping it to unlimited', () => {
    const store = createStore({ userDataDir: dir })

    expect(
      store.saveSettings({ ...DEFAULT_SETTINGS, maxSessionMinutes: -5 }).maxSessionMinutes,
    ).toBe(DEFAULT_SETTINGS.maxSessionMinutes)
  })

  it('leaves no temp files behind, so a crash mid-write cannot half-write the real file', () => {
    const store = createStore({ userDataDir: dir })
    store.saveSettings(DEFAULT_SETTINGS)
    store.saveSettings({ ...DEFAULT_SETTINGS, theme: 'light' })

    expect(readdirSync(dir).sort()).toEqual(['settings.json'])
  })

  it('runs the migration hook when the on-disk version is older', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ schemaVersion: 0, data: { theme: 'dark', legacyPanic: 'F13' } }),
    )
    const migrateSettings = vi.fn((raw: unknown, from: number) => {
      expect(from).toBe(0)
      const old = raw as { theme: string; legacyPanic: string }
      return { ...DEFAULT_SETTINGS, theme: old.theme, panicHotkey: old.legacyPanic }
    })
    const store = createStore({ userDataDir: dir, migrateSettings })

    const settings = store.loadSettings()

    expect(migrateSettings).toHaveBeenCalledTimes(1)
    expect(settings.theme).toBe('dark')
    expect(settings.panicHotkey).toBe('F13')
  })

  it('falls back to defaults when a migration throws', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 0, data: {} }))
    const store = createStore({
      userDataDir: dir,
      migrateSettings: () => {
        throw new Error('cannot migrate')
      },
    })

    expect(store.loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to defaults for an old version with no migration hook', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ schemaVersion: 0, data: { theme: 'dark' } }),
    )
    const store = createStore({ userDataDir: dir })

    expect(store.loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('creates the userData directory on first write', () => {
    const nested = join(dir, 'a', 'b')
    const store = createStore({ userDataDir: nested })

    store.saveSettings(DEFAULT_SETTINGS)

    expect(readFileSync(join(nested, 'settings.json'), 'utf8')).toContain('schemaVersion')
  })
})

describe('presets', () => {
  it('returns an empty list when the file is missing', () => {
    expect(createStore({ userDataDir: dir }).loadPresets()).toEqual([])
  })

  it('returns an empty list instead of throwing when the file is corrupt', () => {
    writeFileSync(join(dir, 'presets.json'), 'not json at all')
    const store = createStore({ userDataDir: dir })

    expect(() => store.loadPresets()).not.toThrow()
    expect(store.loadPresets()).toEqual([])
  })

  it('round-trips a preset', () => {
    createStore({ userDataDir: dir }).savePresets([validPreset()])

    const loaded = createStore({ userDataDir: dir }).loadPresets()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.name).toBe('Minecraft AFK')
    expect(loaded[0]?.config.mode).toBe('hold')
  })

  it('writes presets with a schema version', () => {
    const store = createStore({ userDataDir: dir })
    store.savePresets([validPreset()])

    const raw: unknown = JSON.parse(readFileSync(join(dir, 'presets.json'), 'utf8'))
    expect((raw as { schemaVersion: number }).schemaVersion).toBe(PRESETS_SCHEMA_VERSION)
  })

  it('drops entries that are not usable presets and keeps the rest', () => {
    writeFileSync(
      join(dir, 'presets.json'),
      JSON.stringify({
        schemaVersion: PRESETS_SCHEMA_VERSION,
        data: [
          validPreset(),
          null,
          { id: 'no-config', name: 'Broken' },
          { ...validPreset({ id: 'bad-mode' }), config: { ...validPreset().config, mode: 'spin' } },
        ],
      }),
    )
    const store = createStore({ userDataDir: dir })

    expect(store.loadPresets().map((p) => p.id)).toEqual(['p1'])
  })

  it('clamps out-of-range timings rather than dropping the preset', () => {
    writeFileSync(
      join(dir, 'presets.json'),
      JSON.stringify({
        schemaVersion: PRESETS_SCHEMA_VERSION,
        data: [
          {
            ...validPreset(),
            config: { ...validPreset().config, tapIntervalMs: 5, repeatIntervalMs: 0 },
          },
        ],
      }),
    )
    const store = createStore({ userDataDir: dir })

    const [preset] = store.loadPresets()
    expect(preset?.config.tapIntervalMs).toBe(10)
    expect(preset?.config.repeatIntervalMs).toBeGreaterThan(0)
  })

  it('upserts by id, replacing rather than duplicating', () => {
    const store = createStore({ userDataDir: dir })
    store.savePresets([validPreset()])

    const after = store.upsertPreset(validPreset({ name: 'Renamed' }))

    expect(after).toHaveLength(1)
    expect(after[0]?.name).toBe('Renamed')
    expect(createStore({ userDataDir: dir }).loadPresets()[0]?.name).toBe('Renamed')
  })

  it('deletes by id and is a no-op for an unknown id', () => {
    const store = createStore({ userDataDir: dir })
    store.savePresets([validPreset(), validPreset({ id: 'p2', name: 'Second' })])

    expect(store.deletePreset('p1').map((p) => p.id)).toEqual(['p2'])
    expect(store.deletePreset('nope').map((p) => p.id)).toEqual(['p2'])
  })
})

describe('persisted app state', () => {
  it('remembers that the Accessibility prompt has been spent', () => {
    const first = createStore({ userDataDir: dir })
    expect(first.promptState.wasUsed()).toBe(false)

    first.promptState.markUsed()

    expect(createStore({ userDataDir: dir }).promptState.wasUsed()).toBe(true)
  })

  it('reports the prompt as unused when the state file is corrupt', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), '{{{')

    expect(createStore({ userDataDir: dir }).promptState.wasUsed()).toBe(false)
  })
})
