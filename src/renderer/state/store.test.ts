import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBridge } from '../mock/bridge'
import {
  createAppStore,
  describeStartRefusal,
  LIMITS,
  type AppStore,
} from './store'

const MINECRAFT = 'com.mojang.minecraft'
const CHROME = 'com.google.Chrome'

function makeStore(): AppStore {
  // rotateFocus off so no interval outlives the test.
  return createAppStore(createMockBridge({ rotateFocus: false }))
}

/** Every user-facing string in this app is checked for the same two things. */
function expectReadableSentence(text: string): void {
  expect(text).not.toMatch(/—/)
  expect(text).not.toMatch(/error occurred/i)
  expect(text.trim().length).toBeGreaterThan(20)
  expect(text.trim().endsWith('.')).toBe(true)
}

describe('selection', () => {
  let store: AppStore

  beforeEach(() => {
    store = makeStore()
  })

  it('adds and removes keys, keeping click order', () => {
    const { toggleKey } = store.getState().actions
    toggleKey('key-w')
    toggleKey('key-a')
    expect(store.getState().keyIds).toEqual(['key-w', 'key-a'])

    toggleKey('key-w')
    expect(store.getState().keyIds).toEqual(['key-a'])
  })

  it('adds and removes mouse buttons independently of keys', () => {
    const { toggleKey, toggleButton } = store.getState().actions
    toggleKey('key-w')
    toggleButton('left')
    toggleButton('right')
    expect(store.getState().keyIds).toEqual(['key-w'])
    expect(store.getState().buttonIds).toEqual(['left', 'right'])

    toggleButton('right')
    expect(store.getState().buttonIds).toEqual(['left'])
  })

  it('refuses a lock key in Hold mode and says what to do instead', () => {
    store.getState().actions.toggleKey('key-caps-lock')

    expect(store.getState().keyIds).toEqual([])
    const notice = store.getState().notice
    expect(notice?.kind).toBe('problem')
    expect(notice?.text).toContain('Caps Lock')
    expectReadableSentence(notice?.text ?? '')
  })

  it('refuses a wheel detent in Hold mode, because a wheel has no held state', () => {
    store.getState().actions.toggleButton('wheel-up')

    expect(store.getState().buttonIds).toEqual([])
    expect(store.getState().notice?.text).toContain('wheel')
    expectReadableSentence(store.getState().notice?.text ?? '')
  })

  it('clears keys and buttons together', () => {
    const { toggleKey, toggleButton, clearSelection } = store.getState().actions
    toggleKey('key-w')
    toggleButton('left')
    clearSelection()
    expect(store.getState().keyIds).toEqual([])
    expect(store.getState().buttonIds).toEqual([])
  })
})

describe('targets', () => {
  it('toggles a target on and back off', () => {
    const store = makeStore()
    const { toggleTarget } = store.getState().actions

    toggleTarget(MINECRAFT)
    expect(store.getState().targets).toEqual([MINECRAFT])

    toggleTarget(CHROME)
    expect(store.getState().targets).toEqual([MINECRAFT, CHROME])

    toggleTarget(MINECRAFT)
    expect(store.getState().targets).toEqual([CHROME])
  })

  it('lists real apps and never offers KeyPress Ultimate as a target', async () => {
    const store = makeStore()
    await store.getState().actions.init()

    const identities = store.getState().apps.map((app) => app.identity)
    expect(identities).toContain(MINECRAFT)
    expect(identities).not.toContain('com.keypressultimate.app')
  })
})

describe('mode switching', () => {
  it('moves between the three modes', () => {
    const store = makeStore()
    const { setMode } = store.getState().actions

    expect(store.getState().mode).toBe('hold')
    setMode('hold-repeat')
    expect(store.getState().mode).toBe('hold-repeat')
    setMode('tap')
    expect(store.getState().mode).toBe('tap')
  })

  it('lets a wheel detent be selected once the mode can express it', () => {
    const store = makeStore()
    const { setMode, toggleButton } = store.getState().actions

    setMode('tap')
    toggleButton('wheel-down')
    expect(store.getState().buttonIds).toEqual(['wheel-down'])
    expect(store.getState().notice).toBeNull()
  })

  it('drops what Hold cannot express when switching back, and explains why', () => {
    const store = makeStore()
    const { setMode, toggleKey, toggleButton } = store.getState().actions

    setMode('tap')
    toggleKey('key-w')
    toggleKey('key-caps-lock')
    toggleButton('wheel-up')
    expect(store.getState().keyIds).toEqual(['key-w', 'key-caps-lock'])

    setMode('hold')
    expect(store.getState().keyIds).toEqual(['key-w'])
    expect(store.getState().buttonIds).toEqual([])
    const notice = store.getState().notice
    expect(notice?.kind).toBe('info')
    expect(notice?.text).toContain('Caps Lock')
    expect(notice?.text).toContain('Wheel Up')
    expectReadableSentence(notice?.text ?? '')
  })

  it('clamps interval fields to the range the injector accepts', () => {
    const store = makeStore()
    const { setTapIntervalMs, setRepeatIntervalMs } = store.getState().actions

    setTapIntervalMs(5)
    expect(store.getState().tapIntervalMs).toBe(LIMITS.tapIntervalMs.min)

    setTapIntervalMs(99999)
    expect(store.getState().tapIntervalMs).toBe(LIMITS.tapIntervalMs.max)

    setRepeatIntervalMs(Number.NaN)
    expect(store.getState().repeatIntervalMs).toBe(LIMITS.repeatIntervalMs.min)
  })
})

describe('presets', () => {
  it('saves the current configuration under a name and marks it active', async () => {
    const store = makeStore()
    const { init, toggleKey, toggleButton, toggleTarget, setMode, savePreset } =
      store.getState().actions
    await init()

    toggleKey('key-w')
    toggleButton('left')
    toggleTarget(MINECRAFT)
    setMode('hold-repeat')
    await savePreset('  Farm run  ')

    const saved = store.getState().presets.find((preset) => preset.name === 'Farm run')
    expect(saved).toBeDefined()
    expect(saved?.config.keyIds).toEqual(['key-w'])
    expect(saved?.config.buttonIds).toEqual(['left'])
    expect(saved?.config.targets).toEqual([MINECRAFT])
    expect(saved?.config.mode).toBe('hold-repeat')
    expect(store.getState().activePresetId).toBe(saved?.id)
  })

  it('loads a preset over whatever was selected', async () => {
    const store = makeStore()
    const { init, toggleKey, toggleTarget, applyPreset } = store.getState().actions
    await init()

    toggleKey('key-space')
    toggleTarget(CHROME)

    const seeded = store.getState().presets.find((preset) => preset.id === 'preset-afk-farm')
    expect(seeded).toBeDefined()
    applyPreset('preset-afk-farm')

    expect(store.getState().keyIds).toEqual(['key-w'])
    expect(store.getState().buttonIds).toEqual(['left'])
    expect(store.getState().targets).toEqual([MINECRAFT])
    expect(store.getState().mode).toBe('hold')
    expect(store.getState().activePresetId).toBe('preset-afk-farm')
  })

  it('detaches from the active preset as soon as the config is edited', async () => {
    const store = makeStore()
    const { init, applyPreset, toggleKey } = store.getState().actions
    await init()

    applyPreset('preset-afk-farm')
    expect(store.getState().activePresetId).toBe('preset-afk-farm')

    toggleKey('key-a')
    expect(store.getState().activePresetId).toBeNull()
  })

  it('renames and deletes', async () => {
    const store = makeStore()
    const { init, renamePreset, deletePreset } = store.getState().actions
    await init()

    await renamePreset('preset-afk-farm', 'Kelp farm')
    expect(
      store.getState().presets.find((preset) => preset.id === 'preset-afk-farm')?.name,
    ).toBe('Kelp farm')

    await deletePreset('preset-afk-farm')
    expect(store.getState().presets.map((preset) => preset.id)).not.toContain('preset-afk-farm')
  })

  it('refuses to save a preset with no name', async () => {
    const store = makeStore()
    await store.getState().actions.init()
    const before = store.getState().presets.length

    await store.getState().actions.savePreset('   ')

    expect(store.getState().presets).toHaveLength(before)
    expectReadableSentence(store.getState().notice?.text ?? '')
  })
})

describe('start refusals', () => {
  it('refuses with a clear message when nothing is selected', async () => {
    const store = makeStore()
    await store.getState().actions.init()
    store.getState().actions.toggleTarget(MINECRAFT)

    const outcome = await store.getState().actions.start()

    expect(outcome.started).toBe(false)
    const message = outcome.started ? '' : outcome.message
    expect(message).toContain('Nothing is selected')
    expectReadableSentence(message)
    expect(store.getState().notice).toEqual({ kind: 'problem', text: message })
    expect(store.getState().session.phase).toBe('idle')
  })

  it('refuses with a clear message when no target app is picked', async () => {
    const store = makeStore()
    await store.getState().actions.init()
    store.getState().actions.toggleKey('key-w')

    const outcome = await store.getState().actions.start()

    expect(outcome.started).toBe(false)
    const message = outcome.started ? '' : outcome.message
    expect(message).toContain('No target app')
    expect(message).toContain('frontmost')
    expectReadableSentence(message)
    expect(store.getState().session.phase).toBe('idle')
  })

  it('refuses while macOS Accessibility is still ungranted', async () => {
    const store = createAppStore(
      createMockBridge({ rotateFocus: false, hasPermission: false, promptWasAlreadyUsed: true }),
    )
    await store.getState().actions.init()
    store.getState().actions.toggleKey('key-w')
    store.getState().actions.toggleTarget(MINECRAFT)

    const outcome = await store.getState().actions.start()

    expect(outcome.started).toBe(false)
    const message = outcome.started ? '' : outcome.message
    expect(message).toContain('Accessibility')
    expectReadableSentence(message)
  })

  it('names the refusal purely from state, with no bridge round trip', () => {
    const store = makeStore()
    expect(describeStartRefusal(store.getState())).toContain('Nothing is selected')

    store.getState().actions.toggleKey('key-w')
    expect(describeStartRefusal(store.getState())).toContain('No target app')

    store.getState().actions.toggleTarget(MINECRAFT)
    expect(describeStartRefusal(store.getState())).toBeNull()
  })

  it('arms and then disarms once keys and a target are both present', async () => {
    const store = makeStore()
    await store.getState().actions.init()
    store.getState().actions.toggleKey('key-w')
    store.getState().actions.toggleTarget(MINECRAFT)

    const outcome = await store.getState().actions.start()
    expect(outcome.started).toBe(true)
    expect(store.getState().notice).toBeNull()
    expect(['armed-waiting', 'firing']).toContain(store.getState().session.phase)

    await store.getState().actions.stop()
    expect(store.getState().session.phase).toBe('idle')
    expect(store.getState().session.firingKeyIds).toEqual([])
  })
})
