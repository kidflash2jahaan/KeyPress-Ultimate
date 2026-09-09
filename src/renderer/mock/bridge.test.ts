/**
 * The mock is not a stub: it is the rig the whole interface is flow-tested in,
 * so a gate it gets wrong is a gate that looks broken in a browser and fine in
 * the app. These tests pin the focus gate it mirrors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockBridge } from './bridge'
import { FOCUS_SETTLE_MS } from '../../shared/ipc'
import type { SessionConfig, SessionState } from '../../shared/types'

const MINECRAFT = 'com.mojang.minecraft'
const FOCUS_PERIOD_MS = 3200

const CONFIG: SessionConfig = {
  keyIds: ['key-w'],
  buttonIds: [],
  targets: [MINECRAFT],
  mode: 'hold',
  repeatInitialMs: 400,
  repeatIntervalMs: 33,
  tapIntervalMs: 100,
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('arming while the target is already frontmost', () => {
  it('fires once the focus has settled, not at the next focus change', async () => {
    const bridge = createMockBridge({ rotateFocus: true })
    const states: SessionState[] = []
    const stop = bridge.on('sessionState', (state) => states.push(state))

    // Rotate onto Minecraft and let it sit there, so the target is frontmost
    // and long settled before Start is pressed.
    await vi.advanceTimersByTimeAsync(FOCUS_PERIOD_MS)
    await vi.advanceTimersByTimeAsync(1000)
    expect(states[states.length - 1]?.focusedApp?.identity).toBe(MINECRAFT)

    const result = await bridge.session.arm(CONFIG)
    expect(result.ok).toBe(true)

    // Arming restarts the settle clock, so the first frame is armed-waiting.
    expect(states[states.length - 1]?.phase).toBe('armed-waiting')

    // The gate opens FOCUS_SETTLE_MS later. It used to stay shut until the
    // next 3.2s focus rotation, because nothing re-evaluated after the settle.
    await vi.advanceTimersByTimeAsync(FOCUS_SETTLE_MS + 40)
    expect(states[states.length - 1]?.phase).toBe('firing')
    expect(states[states.length - 1]?.firingKeyIds).toEqual(['key-w'])

    stop()
  })

  it('shows armed-waiting on the way in, so the gate stays visible', async () => {
    const bridge = createMockBridge({ rotateFocus: true })
    const phases: string[] = []
    const stop = bridge.on('sessionState', (state) => phases.push(state.phase))

    await vi.advanceTimersByTimeAsync(FOCUS_PERIOD_MS + 1000)
    await bridge.session.arm(CONFIG)
    await vi.advanceTimersByTimeAsync(FOCUS_SETTLE_MS + 40)

    const firstFiring = phases.indexOf('firing')
    expect(firstFiring).toBeGreaterThan(0)
    expect(phases[firstFiring - 1]).toBe('armed-waiting')

    stop()
  })

  it('drops the pending settle when the session is disarmed', async () => {
    const bridge = createMockBridge({ rotateFocus: true })
    const phases: string[] = []
    const stop = bridge.on('sessionState', (state) => phases.push(state.phase))

    await vi.advanceTimersByTimeAsync(FOCUS_PERIOD_MS + 1000)
    await bridge.session.arm(CONFIG)
    await bridge.session.disarm('user-stop')
    await vi.advanceTimersByTimeAsync(FOCUS_SETTLE_MS + 40)

    expect(phases).not.toContain('firing')
    expect(phases[phases.length - 1]).toBe('idle')

    stop()
  })
})

describe('downloading an update', () => {
  it('resolves only once every byte has been reported', async () => {
    const bridge = createMockBridge({ rotateFocus: false, offerUpdate: true })
    const fractions: number[] = []
    const stop = bridge.on('updateProgress', (progress) => fractions.push(progress.fraction))

    let settled = false
    const download = bridge.updates.download().then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(180 * 3)
    // Resolving early would tell the renderer the call was over while progress
    // was still arriving, and the renderer reads a call that came back before
    // 100% as an abandoned download.
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(180 * 30)
    await download
    expect(settled).toBe(true)
    expect(fractions[fractions.length - 1]).toBe(1)

    stop()
  })
})
