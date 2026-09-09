/**
 * The boundary tests.
 *
 * Everything here treats the renderer as hostile, because that is the only
 * useful assumption main can make about a web page. The cases are not "what
 * does the UI send", they are "what could arrive on this channel": a mode that
 * is not a mode, a tap interval of zero, a key id that is not on the keyboard,
 * a preset id shaped like a path, a settings patch with a field nobody
 * declared, a disarm reason main reserves for its own failsafes, and a sender
 * that is not our window.
 *
 * Electron is faked down to the two methods this module actually uses, so the
 * whole boundary runs under plain vitest with no BrowserWindow anywhere.
 */
import { describe, expect, it, vi } from 'vitest'
import { IPC_INVOKE, type DisarmReason } from '@shared/ipc'
import type { AppInfo, Preset, SessionConfig, SessionState, Settings } from '@shared/types'
import {
  INTERVAL_MS,
  LIMITS,
  MAX_SESSION_MINUTES,
  REPEAT_INITIAL_MS,
  clampMs,
  isSafeText,
  parseDisarmReason,
  parsePreset,
  parsePresetId,
  parseSessionConfig,
  parseSettingsPatch,
  registerIpcHandlers,
  type ArmResult,
  type IpcHandlerDeps,
  type IpcInvokeEventLike,
  type IpcInvokeListener,
  type IpcMainLike,
} from './ipc-handlers'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOD_CONFIG: SessionConfig = {
  keyIds: ['key-w'],
  buttonIds: ['left'],
  targets: ['com.mojang.minecraft'],
  mode: 'hold',
  repeatInitialMs: 400,
  repeatIntervalMs: 33,
  tapIntervalMs: 100,
}

const SETTINGS: Settings = {
  theme: 'system',
  panicHotkey: 'CommandOrControl+Alt+Shift+K',
  maxSessionMinutes: 30,
  autoCheckUpdates: true,
  windowsUseVirtualKeys: false,
}

const IDLE_STATE: SessionState = {
  phase: 'idle',
  startedAt: null,
  firingKeyIds: [],
  firingButtonIds: [],
  focusedApp: null,
  onTarget: false,
  message: null,
}

const PRESET: Preset = {
  id: 'preset-1',
  name: 'AFK farm',
  config: GOOD_CONFIG,
  updatedAt: 1_700_000_000_000,
}

const APP: AppInfo = {
  identity: 'com.mojang.minecraft',
  name: 'Minecraft',
  pid: 4412,
  path: '/Applications/Minecraft.app',
}

/**
 * A NUL and a unit separator, built rather than typed so this test file itself
 * stays printable in a diff, a terminal and a code review.
 */
const NUL = String.fromCharCode(0)
const UNIT_SEPARATOR = String.fromCharCode(31)

// ---------------------------------------------------------------------------
// A fake ipcMain, and a harness that speaks to it the way Electron would.
// ---------------------------------------------------------------------------

interface Harness {
  deps: IpcHandlerDeps
  spies: {
    arm: ReturnType<typeof vi.fn>
    disarm: ReturnType<typeof vi.fn>
    presetsSave: ReturnType<typeof vi.fn>
    presetsRemove: ReturnType<typeof vi.fn>
    settingsSet: ReturnType<typeof vi.fn>
    minimize: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    openSettings: ReturnType<typeof vi.fn>
    download: ReturnType<typeof vi.fn>
  }
  errors: Array<{ message: string; error: unknown }>
  channels(): string[]
  /** Calls a registered handler as if the trusted window had invoked it. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /** Same, from a webContents that is not ours. */
  invokeAs(sender: unknown, channel: string, ...args: unknown[]): Promise<unknown>
  dispose(): void
}

const WINDOW_SENDER = { id: 'the-one-window' }

function makeHarness(over: Partial<IpcHandlerDeps> = {}): Harness {
  const handlers = new Map<string, IpcInvokeListener>()
  const errors: Array<{ message: string; error: unknown }> = []

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      // Electron throws on a second handler for one channel, and so does this.
      if (handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`)
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
  }

  const spies = {
    arm: vi.fn((_config: SessionConfig): ArmResult => ({ ok: true })),
    disarm: vi.fn((_reason: DisarmReason): void => undefined),
    presetsSave: vi.fn((preset: Preset): Preset[] => [preset]),
    presetsRemove: vi.fn((_id: string): Preset[] => []),
    settingsSet: vi.fn((patch: Partial<Settings>): Settings => ({ ...SETTINGS, ...patch })),
    minimize: vi.fn((): void => undefined),
    close: vi.fn((): void => undefined),
    openSettings: vi.fn((): void => undefined),
    download: vi.fn(async (): Promise<void> => undefined),
  }

  const deps: IpcHandlerDeps = {
    ipcMain,
    systemInfo: () => ({ platform: 'darwin', appVersion: '0.1.0', isPackaged: false }),
    apps: {
      list: async () => [APP],
      refresh: async () => [APP],
    },
    session: {
      arm: spies.arm,
      disarm: spies.disarm,
      getState: () => IDLE_STATE,
    },
    permissions: {
      get: () => ({ needsPermission: true, hasPermission: true, promptWasAlreadyUsed: false }),
      openSettings: spies.openSettings,
    },
    presets: {
      list: () => [PRESET],
      save: spies.presetsSave,
      remove: spies.presetsRemove,
    },
    settings: {
      get: () => SETTINGS,
      set: spies.settingsSet,
    },
    updates: {
      check: async () => null,
      download: spies.download,
      install: async () => undefined,
      openReleasesPage: async () => undefined,
    },
    window: {
      minimize: spies.minimize,
      close: spies.close,
    },
    isTrustedSender: (event: IpcInvokeEventLike) => event.sender === WINDOW_SENDER,
    now: () => 1_800_000_000_000,
    onError: (message, error) => {
      errors.push({ message, error })
    },
    ...over,
  }

  const dispose = registerIpcHandlers(deps)

  async function call(sender: unknown, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler is registered for ${channel}`)
    return handler({ sender }, ...args)
  }

  return {
    deps,
    spies,
    errors,
    channels: () => [...handlers.keys()],
    invoke: (channel, ...args) => call(WINDOW_SENDER, channel, ...args),
    invokeAs: (sender, channel, ...args) => call(sender, channel, ...args),
    dispose,
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('isSafeText', () => {
  it('accepts ordinary text within the limit', () => {
    expect(isSafeText('com.mojang.minecraft', 512)).toBe(true)
  })

  it('rejects an empty string, an over-long string and a non-string', () => {
    expect(isSafeText('', 512)).toBe(false)
    expect(isSafeText('x'.repeat(513), 512)).toBe(false)
    expect(isSafeText(42, 512)).toBe(false)
    expect(isSafeText(null, 512)).toBe(false)
  })

  it('rejects control characters, which are how a string sneaks past a log', () => {
    expect(isSafeText(`com.evil${NUL}.app`, 512)).toBe(false)
    expect(isSafeText('two\nlines', 512)).toBe(false)
    expect(isSafeText(`separated${UNIT_SEPARATOR}`, 512)).toBe(false)
  })
})

describe('clampMs', () => {
  it('clamps to both ends of the range', () => {
    expect(clampMs(0, INTERVAL_MS, 100)).toBe(INTERVAL_MS.min)
    expect(clampMs(999_999, INTERVAL_MS, 100)).toBe(INTERVAL_MS.max)
    expect(clampMs(250, INTERVAL_MS, 100)).toBe(250)
  })

  it('falls back rather than letting a non-number reach a timer', () => {
    expect(clampMs('50', INTERVAL_MS, 100)).toBe(100)
    expect(clampMs(Number.NaN, INTERVAL_MS, 100)).toBe(100)
    expect(clampMs(Number.POSITIVE_INFINITY, INTERVAL_MS, 100)).toBe(100)
    expect(clampMs(undefined, INTERVAL_MS, 100)).toBe(100)
    expect(clampMs({ valueOf: () => 5 }, INTERVAL_MS, 100)).toBe(100)
  })

  it('rounds, so a fractional millisecond never reaches setInterval', () => {
    expect(clampMs(33.6, INTERVAL_MS, 100)).toBe(34)
  })
})

// ---------------------------------------------------------------------------
// parseSessionConfig
// ---------------------------------------------------------------------------

describe('parseSessionConfig', () => {
  it('accepts a well-formed config unchanged', () => {
    const parsed = parseSessionConfig({ ...GOOD_CONFIG })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(GOOD_CONFIG)
  })

  it('refuses anything that is not an object', () => {
    for (const raw of [null, undefined, 'hold', 7, [GOOD_CONFIG]]) {
      expect(parseSessionConfig(raw).ok).toBe(false)
    }
  })

  it('refuses a mode outside the closed set', () => {
    expect(parseSessionConfig({ ...GOOD_CONFIG, mode: 'turbo' }).ok).toBe(false)
    expect(parseSessionConfig({ ...GOOD_CONFIG, mode: 3 }).ok).toBe(false)
  })

  it('clamps every interval into range', () => {
    const parsed = parseSessionConfig({
      ...GOOD_CONFIG,
      mode: 'tap',
      repeatIntervalMs: 0,
      tapIntervalMs: 5_000_000,
      repeatInitialMs: -1,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.repeatIntervalMs).toBe(INTERVAL_MS.min)
    expect(parsed.value.tapIntervalMs).toBe(INTERVAL_MS.max)
    expect(parsed.value.repeatInitialMs).toBe(REPEAT_INITIAL_MS.min)
  })

  it('replaces a missing or unusable interval with the default', () => {
    const parsed = parseSessionConfig({
      keyIds: ['key-w'],
      buttonIds: [],
      targets: ['com.mojang.minecraft'],
      mode: 'hold',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.tapIntervalMs).toBe(100)
    expect(parsed.value.repeatIntervalMs).toBe(33)
    expect(parsed.value.repeatInitialMs).toBe(400)
  })

  it('drops key and button ids that are not on the keyboard', () => {
    const parsed = parseSessionConfig({
      ...GOOD_CONFIG,
      keyIds: ['key-w', 'key-nope', '../../etc/passwd', 42],
      buttonIds: ['left', 'telekinesis'],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.keyIds).toEqual(['key-w'])
    expect(parsed.value.buttonIds).toEqual(['left'])
  })

  it('refuses a config whose ids were all dropped', () => {
    const parsed = parseSessionConfig({ ...GOOD_CONFIG, keyIds: ['key-nope'], buttonIds: [] })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toMatch(/at least one key or mouse button/i)
  })

  it('refuses a config with no targets, since that would fire everywhere', () => {
    const parsed = parseSessionConfig({ ...GOOD_CONFIG, targets: [] })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toMatch(/target app/i)
  })

  it('de-duplicates and caps the target list', () => {
    const many = Array.from({ length: LIMITS.targets + 20 }, (_, index) => `app.${String(index)}`)
    const parsed = parseSessionConfig({
      ...GOOD_CONFIG,
      targets: ['com.a', 'com.a', ...many],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.targets.length).toBe(LIMITS.targets)
    expect(new Set(parsed.value.targets).size).toBe(parsed.value.targets.length)
  })

  it('drops a target carrying a control character or an over-long identity', () => {
    const parsed = parseSessionConfig({
      ...GOOD_CONFIG,
      targets: ['com.ok.app', `com.bad${NUL}.app`, 'x'.repeat(LIMITS.identityChars + 1)],
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.targets).toEqual(['com.ok.app'])
  })

  it('ignores extra properties instead of passing them through', () => {
    const parsed = parseSessionConfig({ ...GOOD_CONFIG, injectorPath: '/tmp/evil.js' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(Object.keys(parsed.value).sort()).toEqual(Object.keys(GOOD_CONFIG).sort())
  })
})

// ---------------------------------------------------------------------------
// parseDisarmReason
// ---------------------------------------------------------------------------

describe('parseDisarmReason', () => {
  it('honours the one reason the renderer owns', () => {
    expect(parseDisarmReason('user-stop')).toBe('user-stop')
  })

  it('reads main-only failsafe reasons as a user stop, so the UI cannot lie', () => {
    for (const reason of ['permission-revoked', 'heartbeat-timeout', 'panic-hotkey', 'signal']) {
      expect(parseDisarmReason(reason)).toBe('user-stop')
    }
  })

  it('reads an unknown or non-string reason as a user stop', () => {
    expect(parseDisarmReason('whatever')).toBe('user-stop')
    expect(parseDisarmReason(undefined)).toBe('user-stop')
    expect(parseDisarmReason({ toString: () => 'panic-hotkey' })).toBe('user-stop')
  })
})

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

describe('parsePresetId', () => {
  it('accepts an ordinary id', () => {
    expect(parsePresetId('preset-afk-farm')).toBe('preset-afk-farm')
  })

  it('refuses anything that could be read as a path', () => {
    expect(parsePresetId('../../settings')).toBeNull()
    expect(parsePresetId('a/b')).toBeNull()
    expect(parsePresetId('a\\b')).toBeNull()
    expect(parsePresetId('..')).toBeNull()
  })

  it('refuses an empty, over-long or non-string id', () => {
    expect(parsePresetId('')).toBeNull()
    expect(parsePresetId('   ')).toBeNull()
    expect(parsePresetId('x'.repeat(LIMITS.presetIdChars + 1))).toBeNull()
    expect(parsePresetId(12)).toBeNull()
  })
})

describe('parsePreset', () => {
  it('accepts a preset and keeps its timestamp', () => {
    const parsed = parsePreset(PRESET, 999)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.updatedAt).toBe(PRESET.updatedAt)
  })

  it('stamps the current time when the timestamp is missing or absurd', () => {
    for (const updatedAt of [undefined, -1, Number.NaN, 'yesterday']) {
      const parsed = parsePreset({ ...PRESET, updatedAt }, 999)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value.updatedAt).toBe(999)
    }
  })

  it('refuses a nameless preset, an over-long name and a name with a control character', () => {
    expect(parsePreset({ ...PRESET, name: '' }, 1).ok).toBe(false)
    expect(parsePreset({ ...PRESET, name: 'x'.repeat(LIMITS.presetNameChars + 1) }, 1).ok).toBe(
      false,
    )
    expect(parsePreset({ ...PRESET, name: `bad${NUL}name` }, 1).ok).toBe(false)
  })

  it('refuses a preset with a path-shaped id or a missing config', () => {
    expect(parsePreset({ ...PRESET, id: '../escape' }, 1).ok).toBe(false)
    expect(parsePreset({ ...PRESET, config: undefined }, 1).ok).toBe(false)
    expect(parsePreset({ ...PRESET, config: { ...GOOD_CONFIG, mode: 'turbo' } }, 1).ok).toBe(false)
  })

  it('allows an empty saved config, but still clamps its intervals', () => {
    const parsed = parsePreset(
      {
        ...PRESET,
        config: { ...GOOD_CONFIG, keyIds: [], buttonIds: [], targets: [], tapIntervalMs: 1 },
      },
      1,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.config.keyIds).toEqual([])
    expect(parsed.value.config.tapIntervalMs).toBe(INTERVAL_MS.min)
  })
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('parseSettingsPatch', () => {
  it('passes through a patch of known fields', () => {
    const parsed = parseSettingsPatch({ theme: 'dark', autoCheckUpdates: false })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual({ theme: 'dark', autoCheckUpdates: false })
  })

  it('drops fields nobody declared rather than merging them into the file', () => {
    const parsed = parseSettingsPatch({ theme: 'light', injectorPath: '/tmp/evil.js' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(Object.keys(parsed.value)).toEqual(['theme'])
  })

  it('refuses a theme outside the closed set', () => {
    expect(parseSettingsPatch({ theme: 'midnight' }).ok).toBe(false)
    expect(parseSettingsPatch({ theme: null }).ok).toBe(false)
  })

  it('clamps maxSessionMinutes and refuses a non-number', () => {
    const low = parseSettingsPatch({ maxSessionMinutes: -30 })
    const high = parseSettingsPatch({ maxSessionMinutes: 10_000 })
    expect(low.ok && low.value.maxSessionMinutes).toBe(MAX_SESSION_MINUTES.min)
    expect(high.ok && high.value.maxSessionMinutes).toBe(MAX_SESSION_MINUTES.max)
    expect(parseSettingsPatch({ maxSessionMinutes: '30' }).ok).toBe(false)
    expect(parseSettingsPatch({ maxSessionMinutes: Number.NaN }).ok).toBe(false)
  })

  it('refuses a non-boolean where a boolean belongs', () => {
    expect(parseSettingsPatch({ autoCheckUpdates: 'yes' }).ok).toBe(false)
    expect(parseSettingsPatch({ windowsUseVirtualKeys: 1 }).ok).toBe(false)
  })

  it('refuses a hotkey that is empty, over-long or carries a control character', () => {
    expect(parseSettingsPatch({ panicHotkey: '' }).ok).toBe(false)
    expect(parseSettingsPatch({ panicHotkey: 'x'.repeat(65) }).ok).toBe(false)
    expect(parseSettingsPatch({ panicHotkey: `Ctrl+${NUL}K` }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Registration and dispatch
// ---------------------------------------------------------------------------

describe('registerIpcHandlers', () => {
  it('registers exactly the invoke channels in the contract, and no others', () => {
    const harness = makeHarness()
    const expected = Object.values(IPC_INVOKE)
    expect(harness.channels().sort()).toEqual([...expected].sort())
  })

  it('removes every handler when disposed, so a rebuilt window can re-register', () => {
    const harness = makeHarness()
    harness.dispose()
    expect(harness.channels()).toEqual([])
  })

  it('refuses a message from a webContents that is not our window', async () => {
    const harness = makeHarness()
    await expect(
      harness.invokeAs({ id: 'someone-else' }, IPC_INVOKE.sessionArm, GOOD_CONFIG),
    ).rejects.toThrow(/unexpected sender/i)
    expect(harness.spies.arm).not.toHaveBeenCalled()
  })

  it('answers the trusted sender', async () => {
    const harness = makeHarness()
    await expect(harness.invoke(IPC_INVOKE.systemInfo)).resolves.toEqual({
      platform: 'darwin',
      appVersion: '0.1.0',
      isPackaged: false,
    })
  })
})

describe('session channels', () => {
  it('hands the controller a clamped config, never the renderer bytes', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.sessionArm, {
      ...GOOD_CONFIG,
      keyIds: ['key-w', 'key-not-real'],
      tapIntervalMs: 0,
      repeatIntervalMs: 99_999,
    })
    expect(harness.spies.arm).toHaveBeenCalledTimes(1)
    const config = harness.spies.arm.mock.calls[0]?.[0] as SessionConfig
    expect(config.keyIds).toEqual(['key-w'])
    expect(config.tapIntervalMs).toBe(INTERVAL_MS.min)
    expect(config.repeatIntervalMs).toBe(INTERVAL_MS.max)
  })

  it('refuses a malformed arm with a sentence and never reaches the controller', async () => {
    const harness = makeHarness()
    const result = (await harness.invoke(IPC_INVOKE.sessionArm, { mode: 'turbo' })) as ArmResult
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
    expect(harness.spies.arm).not.toHaveBeenCalled()
  })

  it('turns a throwing controller into a refusal rather than a rejected invoke', async () => {
    const harness = makeHarness()
    harness.spies.arm.mockImplementation(() => {
      throw new Error('the injector is on fire')
    })
    const result = (await harness.invoke(IPC_INVOKE.sessionArm, GOOD_CONFIG)) as ArmResult
    expect(result.ok).toBe(false)
    expect(harness.errors.some((entry) => entry.message === 'session:arm')).toBe(true)
  })

  it('rewrites a forged disarm reason as a user stop', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.sessionDisarm, 'permission-revoked')
    await harness.invoke(IPC_INVOKE.sessionDisarm, 12345)
    expect(harness.spies.disarm.mock.calls.map((call) => call[0])).toEqual([
      'user-stop',
      'user-stop',
    ])
  })

  it('returns the current state', async () => {
    const harness = makeHarness()
    await expect(harness.invoke(IPC_INVOKE.sessionGetState)).resolves.toEqual(IDLE_STATE)
  })
})

describe('preset channels', () => {
  it('saves a parsed preset, not the payload it was handed', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.presetsSave, {
      ...PRESET,
      name: '  AFK farm  ',
      config: { ...GOOD_CONFIG, keyIds: ['key-w', 'nope'], tapIntervalMs: 2 },
    })
    const saved = harness.spies.presetsSave.mock.calls[0]?.[0] as Preset
    expect(saved.name).toBe('AFK farm')
    expect(saved.config.keyIds).toEqual(['key-w'])
    expect(saved.config.tapIntervalMs).toBe(INTERVAL_MS.min)
  })

  it('answers a malformed save with the unchanged list and writes nothing', async () => {
    const harness = makeHarness()
    const result = await harness.invoke(IPC_INVOKE.presetsSave, { id: '../escape', name: 'x' })
    expect(result).toEqual([PRESET])
    expect(harness.spies.presetsSave).not.toHaveBeenCalled()
    expect(harness.errors.some((entry) => entry.message === 'presets:save')).toBe(true)
  })

  it('refuses to delete by a path-shaped id', async () => {
    const harness = makeHarness()
    const result = await harness.invoke(IPC_INVOKE.presetsDelete, '../../settings.json')
    expect(result).toEqual([PRESET])
    expect(harness.spies.presetsRemove).not.toHaveBeenCalled()
  })

  it('deletes by an ordinary id', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.presetsDelete, 'preset-1')
    expect(harness.spies.presetsRemove).toHaveBeenCalledWith('preset-1')
  })
})

describe('settings channels', () => {
  it('writes only the fields the patch legitimately carried', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.settingsSet, {
      theme: 'dark',
      maxSessionMinutes: 99_999,
      somethingElse: true,
    })
    expect(harness.spies.settingsSet).toHaveBeenCalledWith({
      theme: 'dark',
      maxSessionMinutes: MAX_SESSION_MINUTES.max,
    })
  })

  it('answers an invalid patch with the current settings and writes nothing', async () => {
    const harness = makeHarness()
    const result = await harness.invoke(IPC_INVOKE.settingsSet, { theme: 'midnight' })
    expect(result).toEqual(SETTINGS)
    expect(harness.spies.settingsSet).not.toHaveBeenCalled()
    expect(harness.errors.some((entry) => entry.message === 'settings:set')).toBe(true)
  })

  it('answers a non-object patch with the current settings', async () => {
    const harness = makeHarness()
    await expect(harness.invoke(IPC_INVOKE.settingsSet, 'dark')).resolves.toEqual(SETTINGS)
    expect(harness.spies.settingsSet).not.toHaveBeenCalled()
  })
})

describe('the remaining channels', () => {
  it('forwards the window controls', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.windowMinimize)
    await harness.invoke(IPC_INVOKE.windowClose)
    expect(harness.spies.minimize).toHaveBeenCalledTimes(1)
    expect(harness.spies.close).toHaveBeenCalledTimes(1)
  })

  it('ignores whatever arguments the renderer attaches to a no-argument channel', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.windowMinimize, { pretend: 'payload' }, 'and another')
    expect(harness.spies.minimize).toHaveBeenCalledWith()
  })

  it('lists apps, and falls back to an empty list when enumeration throws', async () => {
    const harness = makeHarness({
      apps: {
        list: async () => {
          throw new Error('enumeration failed')
        },
        refresh: async () => [APP],
      },
    })
    await expect(harness.invoke(IPC_INVOKE.appsList)).resolves.toEqual([])
    await expect(harness.invoke(IPC_INVOKE.appsRefresh)).resolves.toEqual([APP])
    expect(harness.errors.some((entry) => entry.message === 'apps:list')).toBe(true)
  })

  it('swallows a failing update download rather than rejecting the invoke', async () => {
    const harness = makeHarness()
    harness.spies.download.mockRejectedValue(new Error('offline'))
    await expect(harness.invoke(IPC_INVOKE.updatesDownload)).resolves.toBeUndefined()
    expect(harness.errors.some((entry) => entry.message === 'updates:download')).toBe(true)
  })

  it('opens the permission pane through the dependency, not a renderer string', async () => {
    const harness = makeHarness()
    await harness.invoke(IPC_INVOKE.permissionsOpenSettings, 'file:///etc/passwd')
    expect(harness.spies.openSettings).toHaveBeenCalledWith()
  })
})
