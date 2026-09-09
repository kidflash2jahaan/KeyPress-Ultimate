import { beforeEach, describe, expect, it } from 'vitest'
import { FOCUS_SETTLE_MS, FOCUS_TICK_MS, MODIFIER_CLEAR_TIMEOUT_MS } from '@shared/ipc'
import type { AppInfo, KeyDef, MouseDef, SessionConfig, Settings } from '@shared/types'
import type { ForegroundBlockingReport } from './native/windows'
import type { BlockedTargetEvent, HoldLoopState, InjectorNative } from './hold-loop'
import {
  computeTickPeriodMs,
  createHoldLoop,
  REPEAT_INTERVAL_DEFAULT_MS,
  TAP_INTERVAL_MAX_MS,
  TARGET_IDENTITY_RECHECK_MS,
} from './hold-loop'
import type { Clock, TimerHandle } from './scheduler'

// ---------------------------------------------------------------------------
// Fakes. Nothing in this file touches a real timer, a real process or a real
// input API: every test runs with zero synthesized input.
// ---------------------------------------------------------------------------

interface FakeClock extends Clock {
  advance(ms: number): void
}

function createFakeClock(start = 1_000): FakeClock {
  let time = start
  let seq = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimeout(callback: () => void, delayMs: number): TimerHandle {
      const id = ++seq
      timers.set(id, { at: time + Math.max(0, delayMs), callback })
      return id
    },
    clearTimeout(handle: TimerHandle): void {
      timers.delete(handle as number)
    },
    advance(ms: number): void {
      const end = time + ms
      for (;;) {
        let nextId: number | null = null
        let nextAt = Number.POSITIVE_INFINITY
        for (const [id, timer] of timers) {
          if (timer.at < nextAt) {
            nextAt = timer.at
            nextId = id
          }
        }
        if (nextId === null || nextAt > end) break
        const timer = timers.get(nextId)
        timers.delete(nextId)
        time = nextAt
        timer?.callback()
      }
      time = end
    },
  }
}

type OpName =
  | 'keyDown'
  | 'keyDownRepeat'
  | 'keyUp'
  | 'keyUpToPid'
  | 'mouseDown'
  | 'mouseUp'
  | 'releaseAll'
  | 'getFrontmostPid'
  | 'listApplications'
  | 'beginHighResolutionTimers'
  | 'endHighResolutionTimers'
  | 'dispose'
  | 'applySettings'
  | 'describeForegroundBlocking'

interface Op {
  op: OpName
  id?: string
  pid?: number
  at: number
}

interface FakeNative {
  native: InjectorNative
  ops: Op[]
  /** Ops that actually post input, i.e. what the target would observe. */
  inputOps(): Op[]
  count(op: OpName): number
  setFrontmost(pid: number | null): void
  setApps(apps: AppInfo[]): void
  setModifiersClear(clear: boolean): void
  setBlockingReport(report: ForegroundBlockingReport): void
  throwOnListApplications(shouldThrow: boolean): void
  modifierGateCalls: { at: number }[]
  reset(): void
}

const MINECRAFT: AppInfo = {
  identity: 'com.mojang.minecraft',
  name: 'Minecraft',
  pid: 4242,
  path: null,
}
const TERMINAL: AppInfo = {
  identity: 'com.apple.Terminal',
  name: 'Terminal',
  pid: 777,
  path: null,
}
const OUR_APP: AppInfo = {
  identity: 'com.keypressultimate.app',
  name: 'KeyPress Ultimate',
  pid: 999,
  path: null,
}

const NOT_ELEVATED = {
  state: 'known-not-elevated',
  lastError: null,
  reason: 'the token reports not elevated',
} as const

/** What the Windows adapter answers when injection is expected to land. */
const REACHABLE_REPORT: ForegroundBlockingReport = {
  ok: true,
  severity: 'ok',
  app: MINECRAFT,
  self: NOT_ELEVATED,
  target: NOT_ELEVATED,
  message: 'Minecraft looks reachable.',
}

/** UIPI: the target runs elevated and we do not, so nothing we post arrives. */
const ELEVATED_REPORT: ForegroundBlockingReport = {
  ok: false,
  severity: 'blocked',
  app: MINECRAFT,
  self: NOT_ELEVATED,
  target: { state: 'known-elevated', lastError: null, reason: 'the token reports elevated' },
  message: 'Minecraft is running as administrator, restart KeyPress Ultimate as administrator.',
}

const INPUT_OPS: readonly OpName[] = [
  'keyDown',
  'keyDownRepeat',
  'keyUp',
  'keyUpToPid',
  'mouseDown',
  'mouseUp',
]

function createFakeNative(
  clock: Clock,
  options: { extensions?: boolean } = {},
): FakeNative {
  const withExtensions = options.extensions ?? true
  const ops: Op[] = []
  const modifierGateCalls: { at: number }[] = []
  let frontmost: number | null = MINECRAFT.pid
  let apps: AppInfo[] = [MINECRAFT, TERMINAL, OUR_APP]
  let modifiersClear = true
  let blockingReport: ForegroundBlockingReport = REACHABLE_REPORT
  let listApplicationsThrows = false

  const record = (op: OpName, id?: string, pid?: number): void => {
    ops.push({ op, id, pid, at: clock.now() })
  }

  const base = {
    async init(): Promise<void> {},
    listApplications(): AppInfo[] {
      record('listApplications')
      if (listApplicationsThrows) throw new Error('the window server is not answering')
      return apps
    },
    getFrontmostPid(): number | null {
      record('getFrontmostPid')
      return frontmost
    },
    keyDown(key: KeyDef): void {
      record('keyDown', key.id)
    },
    keyUp(key: KeyDef): void {
      record('keyUp', key.id)
    },
    mouseDown(button: MouseDef): void {
      record('mouseDown', button.id)
    },
    mouseUp(button: MouseDef): void {
      record('mouseUp', button.id)
    },
    releaseAll(): void {
      record('releaseAll')
    },
    hasPermission(): boolean {
      return true
    },
    openPermissionSettings(): void {},
    dispose(): void {
      record('dispose')
    },
  }

  const extensions = {
    keyDownRepeat(key: KeyDef): void {
      record('keyDownRepeat', key.id)
    },
    keyUpToPid(key: KeyDef, pid: number): void {
      record('keyUpToPid', key.id, pid)
    },
    physicalModifiersClear(): boolean {
      modifierGateCalls.push({ at: clock.now() })
      return modifiersClear
    },
    beginHighResolutionTimers(): void {
      record('beginHighResolutionTimers')
    },
    endHighResolutionTimers(): void {
      record('endHighResolutionTimers')
    },
    applySettings(): void {
      record('applySettings')
    },
    describeForegroundBlocking(): ForegroundBlockingReport {
      record('describeForegroundBlocking')
      return blockingReport
    },
  }

  const native = (withExtensions ? { ...base, ...extensions } : base) as InjectorNative

  return {
    native,
    ops,
    inputOps: () => ops.filter((op) => INPUT_OPS.includes(op.op)),
    count: (op) => ops.filter((entry) => entry.op === op).length,
    setFrontmost: (pid) => {
      frontmost = pid
    },
    setApps: (next) => {
      apps = next
    },
    setModifiersClear: (clear) => {
      modifiersClear = clear
    },
    setBlockingReport: (report) => {
      blockingReport = report
    },
    throwOnListApplications: (shouldThrow) => {
      listApplicationsThrows = shouldThrow
    },
    modifierGateCalls,
    reset: () => {
      ops.length = 0
    },
  }
}

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    keyIds: ['key-w'],
    buttonIds: [],
    targets: [MINECRAFT.identity],
    mode: 'hold',
    repeatInitialMs: 400,
    repeatIntervalMs: 33,
    tapIntervalMs: 100,
    ...overrides,
  }
}

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    panicHotkey: 'CommandOrControl+Alt+Shift+K',
    maxSessionMinutes: 30,
    autoCheckUpdates: true,
    windowsUseVirtualKeys: false,
    ...overrides,
  }
}

const SETTLE_AND_GATE_MS = FOCUS_SETTLE_MS + 60

interface Harness {
  clock: FakeClock
  fake: FakeNative
  loop: ReturnType<typeof createHoldLoop>
  states: HoldLoopState[]
  errors: { code: string; message: string }[]
  released: { count: number; reason: string }[]
  blocked: BlockedTargetEvent[]
  selfDisarms: string[]
}

function harness(
  options: {
    platform?: 'darwin' | 'win32'
    extensions?: boolean
    ourPids?: number[]
  } = {},
): Harness {
  const clock = createFakeClock()
  const fake = createFakeNative(clock, { extensions: options.extensions })
  const states: HoldLoopState[] = []
  const errors: { code: string; message: string }[] = []
  const released: { count: number; reason: string }[] = []
  const blocked: BlockedTargetEvent[] = []
  const selfDisarms: string[] = []
  const loop = createHoldLoop({
    native: fake.native,
    clock,
    spinMs: 0,
    platform: options.platform ?? 'darwin',
    ourPids: options.ourPids ?? [OUR_APP.pid],
    onState: (state) => states.push(state),
    onError: (code, message) => errors.push({ code, message }),
    onReleased: (count, reason) => released.push({ count, reason }),
    onBlocked: (event) => blocked.push(event),
    onSelfDisarm: (reason) => selfDisarms.push(reason),
  })
  return { clock, fake, loop, states, errors, released, blocked, selfDisarms }
}

// ---------------------------------------------------------------------------

describe('computeTickPeriodMs', () => {
  it('is 25ms for hold and never slower for any mode', () => {
    expect(computeTickPeriodMs('hold', 33, 100)).toBe(25)
    expect(computeTickPeriodMs('hold-repeat', 33, 100)).toBe(25)
    expect(computeTickPeriodMs('hold-repeat', 500, 100)).toBe(25)
    expect(computeTickPeriodMs('tap', 33, 1000)).toBe(25)
  })

  it('speeds the tick up when the assert interval is shorter than the focus tick', () => {
    expect(computeTickPeriodMs('hold-repeat', 10, 100)).toBe(10)
    expect(computeTickPeriodMs('tap', 33, 40)).toBe(10)
    // Floored, so a 10ms tap does not turn into a 2.5ms spin loop.
    expect(computeTickPeriodMs('tap', 33, 10)).toBe(5)
  })
})

describe('hold mode', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('waits the settle delay before the first press', () => {
    h.loop.arm(config())
    h.clock.advance(FOCUS_SETTLE_MS - 5)
    expect(h.fake.count('keyDown')).toBe(0)

    h.clock.advance(60)
    expect(h.fake.count('keyDown')).toBe(1)
    expect(h.fake.ops.find((op) => op.op === 'keyDown')?.id).toBe('key-w')
  })

  it('never re-asserts, no matter how long the hold lasts', () => {
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    // Six seconds is 240 ticks. A blind re-assert loop would produce 240 key
    // downs here, i.e. 240 characters in a text field.
    h.clock.advance(6_000)
    expect(h.fake.count('keyDown')).toBe(1)
    expect(h.fake.count('keyDownRepeat')).toBe(0)
    expect(h.fake.count('keyUp')).toBe(0)
  })

  it('presses modifiers first and releases them last, in reverse press order', () => {
    h.loop.arm(
      config({ keyIds: ['key-w', 'key-left-shift', 'key-a'], buttonIds: ['left'] }),
    )
    h.clock.advance(SETTLE_AND_GATE_MS)

    const down = h.fake.ops
      .filter((op) => op.op === 'keyDown' || op.op === 'mouseDown')
      .map((op) => op.id)
    expect(down).toEqual(['key-left-shift', 'key-w', 'key-a', 'left'])

    h.fake.reset()
    h.loop.disarm('user-stop')

    // Reverse press order with modifiers last, and each up posted to the pid
    // that was holding it before it is posted globally.
    const up = h.fake.ops
      .filter((op) => op.op === 'keyUp' || op.op === 'mouseUp')
      .map((op) => op.id)
    expect(up).toEqual(['left', 'key-a', 'key-w', 'key-left-shift'])
  })

  it('drops keys that cannot be held rather than pressing them', () => {
    h.loop.arm(config({ keyIds: ['key-caps-lock', 'key-w'] }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    const pressed = h.fake.ops.filter((op) => op.op === 'keyDown').map((op) => op.id)
    expect(pressed).toEqual(['key-w'])
  })

  it('refuses to arm when nothing in the configuration can be held', () => {
    h.loop.arm(config({ keyIds: ['key-caps-lock', 'not-a-key'], buttonIds: [] }))
    expect(h.loop.armed).toBe(false)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain('nothing to hold')
    h.clock.advance(1_000)
    expect(h.fake.inputOps()).toHaveLength(0)
  })
})

describe('focus', () => {
  it('re-reads the frontmost pid immediately before every assert', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)

    const index = h.fake.ops.findIndex((op) => op.op === 'keyDown')
    expect(index).toBeGreaterThan(0)
    // The op immediately before the press is a fresh focus read, not a cached
    // value from the top of the tick.
    expect(h.fake.ops[index - 1]?.op).toBe('getFrontmostPid')
  })

  it('releases immediately when focus leaves, pid-targeted up first then global', () => {
    const h = harness()
    h.loop.arm(config({ keyIds: ['key-w'], buttonIds: ['left'] }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    h.fake.reset()
    h.fake.setFrontmost(TERMINAL.pid)
    h.clock.advance(25)

    const posted = h.fake.ops.filter((op) => INPUT_OPS.includes(op.op))
    // Mouse first (reverse press order), then the key, and each key-up posted
    // to the app that was holding it before it is posted globally. There is no
    // pid-targeted path for mouse buttons in the adapter contract.
    expect(posted.map((op) => `${op.op}:${op.id}`)).toEqual([
      'mouseUp:left',
      'keyUpToPid:key-w',
      'keyUp:key-w',
    ])
    expect(posted[1]?.pid).toBe(MINECRAFT.pid)
    expect(h.fake.count('releaseAll')).toBe(1)
    expect(h.released).toEqual([{ count: 2, reason: 'focus-lost' }])
    expect(h.loop.state.phase).toBe('armed-waiting')
  })

  it('does not press again while focus stays away, and re-settles when it returns', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    h.fake.setFrontmost(TERMINAL.pid)
    h.clock.advance(2_000)
    h.fake.reset()

    h.fake.setFrontmost(MINECRAFT.pid)
    h.clock.advance(FOCUS_SETTLE_MS - 30)
    expect(h.fake.count('keyDown')).toBe(0)
    h.clock.advance(80)
    expect(h.fake.count('keyDown')).toBe(1)
  })

  it('treats an unknown frontmost pid as not on target', () => {
    const h = harness()
    h.fake.setFrontmost(null)
    h.loop.arm(config())
    h.clock.advance(2_000)
    expect(h.fake.inputOps()).toHaveLength(0)
    expect(h.loop.state.phase).toBe('armed-waiting')
  })

  it('follows a target that quits and relaunches under a new pid', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    // The game quits: its pid is gone from the app list and something else is
    // frontmost. That is an ordinary focus loss.
    h.fake.setApps([TERMINAL, OUR_APP])
    h.fake.setFrontmost(TERMINAL.pid)
    h.clock.advance(50)
    expect(h.fake.count('keyUp')).toBe(1)

    // It comes back with a different pid but the same identity.
    const relaunched: AppInfo = { ...MINECRAFT, pid: 5150 }
    h.fake.setApps([relaunched, TERMINAL, OUR_APP])
    h.fake.setFrontmost(relaunched.pid)
    h.fake.reset()
    h.clock.advance(2_000)
    expect(h.fake.count('keyDown')).toBe(1)
  })
})

describe('self-target guard', () => {
  it('releases and stays armed-waiting when our own window is frontmost', () => {
    const h = harness({ ourPids: [OUR_APP.pid] })
    h.loop.arm(config({ targets: [MINECRAFT.identity, OUR_APP.identity] }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    h.fake.reset()
    h.fake.setFrontmost(OUR_APP.pid)
    h.clock.advance(25)

    expect(h.fake.count('keyUp')).toBe(1)
    expect(h.released[0]?.reason).toBe('self-target')
    expect(h.loop.armed).toBe(true)
    expect(h.loop.state.phase).toBe('armed-waiting')

    // Even though our own identity is in the target list, it never presses.
    h.fake.reset()
    h.clock.advance(5_000)
    expect(h.fake.inputOps()).toHaveLength(0)
  })
})

describe('modifier-clear gate', () => {
  it('holds the first press until the physical modifiers clear', () => {
    const h = harness()
    h.fake.setModifiersClear(false)
    h.loop.arm(config())

    h.clock.advance(1_000)
    expect(h.fake.count('keyDown')).toBe(0)
    expect(h.loop.state.phase).toBe('modifier-gate')

    h.fake.setModifiersClear(true)
    h.clock.advance(30)
    expect(h.fake.count('keyDown')).toBe(1)
  })

  it('only starts asking after the settle delay, then asks every tick', () => {
    const h = harness()
    h.fake.setModifiersClear(false)
    h.loop.arm(config({ keyIds: ['key-left-shift', 'key-w'] }))
    h.clock.advance(FOCUS_SETTLE_MS - 5)
    expect(h.fake.modifierGateCalls).toHaveLength(0)
    h.clock.advance(500)
    expect(h.fake.modifierGateCalls.length).toBeGreaterThan(10)
  })

  it('gives up and presses anyway after the 2s timeout', () => {
    const h = harness()
    h.fake.setModifiersClear(false)
    h.loop.arm(config())

    h.clock.advance(FOCUS_SETTLE_MS + MODIFIER_CLEAR_TIMEOUT_MS - 60)
    expect(h.fake.count('keyDown')).toBe(0)
    h.clock.advance(120)
    expect(h.fake.count('keyDown')).toBe(1)
  })

  it('degrades to the settle delay alone when the adapter cannot check modifiers', () => {
    const h = harness({ extensions: false })
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)
    // No pid-targeted release available either, but the global up still happens.
    h.loop.disarm('user-stop')
    expect(h.fake.count('keyUp')).toBe(1)
    expect(h.fake.count('keyUpToPid')).toBe(0)
  })
})

describe('hold-repeat mode', () => {
  it('re-sends the down with the autorepeat flag and never an intermediate up', () => {
    const h = harness()
    h.loop.arm(config({ mode: 'hold-repeat', repeatInitialMs: 400, repeatIntervalMs: 33 }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)
    expect(h.fake.count('keyDownRepeat')).toBe(0)

    // Nothing before the 400ms initial delay.
    h.clock.advance(350)
    expect(h.fake.count('keyDownRepeat')).toBe(0)

    h.clock.advance(20)
    expect(h.fake.count('keyDownRepeat')).toBe(1)

    h.clock.advance(1_000)
    expect(h.fake.count('keyDownRepeat')).toBeGreaterThan(20)
    // The single original down, and not one up until the session ends.
    expect(h.fake.count('keyDown')).toBe(1)
    expect(h.fake.count('keyUp')).toBe(0)
  })

  it('does not re-assert modifiers or mouse buttons', () => {
    const h = harness()
    h.loop.arm(
      config({
        mode: 'hold-repeat',
        keyIds: ['key-left-shift', 'key-w'],
        buttonIds: ['left'],
        repeatInitialMs: 100,
        repeatIntervalMs: 50,
      }),
    )
    h.clock.advance(SETTLE_AND_GATE_MS + 600)

    const repeated = new Set(
      h.fake.ops.filter((op) => op.op === 'keyDownRepeat').map((op) => op.id),
    )
    expect([...repeated]).toEqual(['key-w'])
    expect(h.fake.count('mouseDown')).toBe(1)
  })

  it('falls back to a plain key-down when the adapter has no autorepeat path', () => {
    const h = harness({ extensions: false })
    h.loop.arm(config({ mode: 'hold-repeat', repeatInitialMs: 100, repeatIntervalMs: 50 }))
    h.clock.advance(SETTLE_AND_GATE_MS + 400)
    expect(h.fake.count('keyDown')).toBeGreaterThan(3)
    expect(h.fake.count('keyUp')).toBe(0)
  })

  it('uses the 33ms default for a missing interval, and honours a zero initial delay', () => {
    expect(REPEAT_INTERVAL_DEFAULT_MS).toBe(33)
    const h = harness()
    h.loop.arm(config({ mode: 'hold-repeat', repeatInitialMs: 0, repeatIntervalMs: 0 }))
    h.clock.advance(SETTLE_AND_GATE_MS + 1_000)
    expect(h.fake.count('keyDownRepeat')).toBeGreaterThan(20)
  })
})

describe('tap mode', () => {
  it('emits alternating down/up pairs at the tap interval', () => {
    const h = harness()
    h.loop.arm(config({ mode: 'tap', tapIntervalMs: 100 }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    h.fake.reset()
    h.clock.advance(1_000)

    const sequence = h.fake.ops
      .filter((op) => op.op === 'keyDown' || op.op === 'keyUp')
      .map((op) => op.op)
    expect(sequence.length).toBeGreaterThanOrEqual(18)
    // Strictly alternating: never two downs in a row.
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]).not.toBe(sequence[i - 1])
    }
    const downs = sequence.filter((op) => op === 'keyDown').length
    expect(downs).toBeGreaterThanOrEqual(9)
    expect(downs).toBeLessThanOrEqual(11)
  })

  it('clamps the interval to at most 1000ms', () => {
    expect(TAP_INTERVAL_MAX_MS).toBe(1_000)
    const h = harness()
    h.loop.arm(config({ mode: 'tap', tapIntervalMs: 60_000 }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    h.fake.reset()
    h.clock.advance(3_000)
    expect(h.fake.count('keyDown')).toBe(3)
  })

  it('clamps the interval to at least 10ms', () => {
    const h = harness()
    h.loop.arm(config({ mode: 'tap', tapIntervalMs: 1 }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    h.fake.reset()
    h.clock.advance(1_000)
    // 10ms clamp against a 5ms tick: about 100 taps a second, not 1000.
    expect(h.fake.count('keyDown')).toBeLessThanOrEqual(110)
    expect(h.fake.count('keyDown')).toBeGreaterThanOrEqual(80)
  })

  it('releases whatever is mid-tap when focus leaves', () => {
    const h = harness()
    h.loop.arm(config({ mode: 'tap', tapIntervalMs: 200 }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)
    h.fake.setFrontmost(TERMINAL.pid)
    h.clock.advance(25)
    expect(h.fake.count('keyUp')).toBe(1)
    expect(h.fake.count('releaseAll')).toBeGreaterThanOrEqual(1)
  })
})

describe('Windows timer resolution', () => {
  it('raises it at arm and lowers it exactly once across repeated teardowns', () => {
    const h = harness({ platform: 'win32' })
    h.loop.arm(config())
    expect(h.fake.count('beginHighResolutionTimers')).toBe(1)
    expect(h.fake.count('endHighResolutionTimers')).toBe(0)

    h.clock.advance(SETTLE_AND_GATE_MS)
    h.loop.disarm('user-stop')
    expect(h.fake.count('endHighResolutionTimers')).toBe(1)

    h.loop.disarm('user-stop')
    h.loop.releaseAll('signal')
    h.loop.dispose()
    expect(h.fake.count('beginHighResolutionTimers')).toBe(1)
    expect(h.fake.count('endHighResolutionTimers')).toBe(1)
  })

  it('re-raises it on a second arm', () => {
    const h = harness({ platform: 'win32' })
    h.loop.arm(config())
    h.loop.disarm('user-stop')
    h.loop.arm(config())
    expect(h.fake.count('beginHighResolutionTimers')).toBe(2)
    expect(h.fake.count('endHighResolutionTimers')).toBe(1)
  })

  it('never uses the macOS pid-targeted release path on Windows', () => {
    const h = harness({ platform: 'win32' })
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    h.fake.setFrontmost(TERMINAL.pid)
    h.clock.advance(25)
    expect(h.fake.count('keyUpToPid')).toBe(0)
    expect(h.fake.count('keyUp')).toBe(1)
  })

  it('does nothing on macOS', () => {
    const h = harness({ platform: 'darwin' })
    h.loop.arm(config())
    h.loop.disarm('user-stop')
    expect(h.fake.count('beginHighResolutionTimers')).toBe(0)
    expect(h.fake.count('endHighResolutionTimers')).toBe(0)
  })
})

describe('releaseAll', () => {
  it('is idempotent and stops the loop dead', () => {
    const h = harness()
    h.loop.arm(config({ keyIds: ['key-w', 'key-left-shift'] }))
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(2)

    expect(h.loop.releaseAll('signal')).toBe(2)
    expect(h.loop.releaseAll('signal')).toBe(0)
    expect(h.loop.releaseAll('app-quit')).toBe(0)
    expect(h.fake.count('keyUp')).toBe(2)
    expect(h.loop.armed).toBe(false)

    h.fake.reset()
    h.clock.advance(5_000)
    expect(h.fake.ops).toHaveLength(0)
  })

  it('posts a global releaseAll even when nothing was held', () => {
    const h = harness()
    h.loop.arm(config())
    expect(h.loop.releaseAll('user-stop')).toBe(0)
    expect(h.fake.count('releaseAll')).toBe(1)
  })
})

describe('session limit and settings', () => {
  it('releases and disarms when the maximum session time is reached', () => {
    const h = harness()
    const settings: Settings = {
      theme: 'system',
      panicHotkey: 'CommandOrControl+Alt+Shift+K',
      maxSessionMinutes: 1,
      autoCheckUpdates: true,
      windowsUseVirtualKeys: false,
    }
    h.loop.applySettings(settings)
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    h.clock.advance(61_000)
    expect(h.fake.count('keyUp')).toBe(1)
    expect(h.loop.armed).toBe(false)
    expect(h.released.some((entry) => entry.reason === 'max-session-time')).toBe(true)
  })

  it('forwards settings to the adapter', () => {
    const h = harness()
    h.loop.applySettings({
      theme: 'dark',
      panicHotkey: 'CommandOrControl+Alt+Shift+K',
      maxSessionMinutes: 0,
      autoCheckUpdates: false,
      windowsUseVirtualKeys: true,
    })
    expect(h.fake.count('applySettings')).toBe(1)
  })
})

describe('state reporting', () => {
  it('emits only on change, and walks armed-waiting to settling to firing', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    h.clock.advance(2_000)

    expect(h.states.map((state) => state.phase)).toEqual([
      'armed-waiting',
      'settling',
      'firing',
    ])
    const firing = h.states[2]
    expect(firing?.firingKeyIds).toEqual(['key-w'])
    expect(firing?.onTarget).toBe(true)
    expect(firing?.focusedPid).toBe(MINECRAFT.pid)
  })

  it('reports the whole intended set while tapping, so the UI cannot strobe', () => {
    const h = harness()
    h.loop.arm(config({ mode: 'tap', tapIntervalMs: 100, buttonIds: ['left'] }))
    h.clock.advance(SETTLE_AND_GATE_MS + 1_000)
    const firing = h.states.filter((state) => state.phase === 'firing')
    expect(firing).toHaveLength(1)
    expect(firing[0]?.firingKeyIds).toEqual(['key-w'])
    expect(firing[0]?.firingButtonIds).toEqual(['left'])
  })
})

describe('native failures', () => {
  it('surfaces a throwing focus read and never presses on it', () => {
    const clock = createFakeClock()
    const fake = createFakeNative(clock)
    const errors: string[] = []
    const throwing: InjectorNative = {
      ...fake.native,
      getFrontmostPid(): number | null {
        throw new Error('CGWindowListCopyWindowInfo failed')
      },
    }
    const loop = createHoldLoop({
      native: throwing,
      clock,
      spinMs: 0,
      platform: 'darwin',
      onError: (_code, message) => errors.push(message),
    })
    loop.arm(config())
    clock.advance(1_000)

    expect(fake.inputOps()).toHaveLength(0)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('getFrontmostPid failed')
    loop.dispose()
  })
})

// ---------------------------------------------------------------------------

describe('self-disarm', () => {
  // Regression: the loop can end its own session, but nothing said so. Main is
  // the only owner of the session lifecycle, and the last state frame a
  // self-disarm emits is indistinguishable from an ordinary focus loss, so main
  // soft-released and stayed armed forever against a loop that had stopped
  // ticking: a dead session that still counted up and still refused to fire.
  it('announces a session the loop ended itself', () => {
    const h = harness()
    h.loop.applySettings(settingsWith({ maxSessionMinutes: 1 }))
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)
    expect(h.selfDisarms).toEqual([])

    h.clock.advance(61_000)
    expect(h.selfDisarms).toEqual(['max-session-time'])
    expect(h.loop.armed).toBe(false)
    expect(h.fake.count('keyUp')).toBe(1)
  })

  it('stays quiet when the disarm is the one main asked for', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    h.loop.disarm('user-stop')
    expect(h.loop.armed).toBe(false)
    // Main already knows: it is the one that asked.
    expect(h.selfDisarms).toEqual([])

    h.loop.releaseAll('panic-hotkey')
    expect(h.selfDisarms).toEqual([])
  })
})

describe('pid recycling', () => {
  const IMPOSTOR: AppInfo = {
    identity: 'com.example.impostor',
    name: 'Impostor',
    pid: MINECRAFT.pid,
    path: null,
  }

  // Regression: the pid -> identity snapshot was trusted for a full second with
  // no liveness check, and the pre-assert guard compared pid numbers only. On
  // Windows a pid comes back off a free list within seconds, so the loop kept
  // firing into whatever process inherited the number.
  it('lets go when the pid it is pressing into becomes a different process', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    // The game exits, its pid is reissued, and the new owner is frontmost. The
    // number in `getFrontmostPid()` never changes.
    h.fake.setApps([IMPOSTOR, TERMINAL, OUR_APP])
    h.clock.advance(TARGET_IDENTITY_RECHECK_MS + FOCUS_TICK_MS)

    expect(h.fake.count('keyUp')).toBe(1)
    expect(h.loop.state.phase).toBe('armed-waiting')

    // And it does not start pressing into the impostor either.
    h.fake.reset()
    h.clock.advance(5_000)
    expect(h.fake.inputOps()).toHaveLength(0)
  })

  it('stops the repeat asserts too, not just the hold', () => {
    const h = harness()
    h.loop.arm(config({ mode: 'hold-repeat', repeatInitialMs: 0, repeatIntervalMs: 33 }))
    h.clock.advance(SETTLE_AND_GATE_MS + 200)
    expect(h.fake.count('keyDownRepeat')).toBeGreaterThan(0)

    h.fake.setApps([IMPOSTOR, TERMINAL, OUR_APP])
    h.clock.advance(TARGET_IDENTITY_RECHECK_MS + FOCUS_TICK_MS)
    h.fake.reset()
    h.clock.advance(1_000)
    expect(h.fake.inputOps()).toHaveLength(0)
  })

  it('keeps holding when the same pid is still the same process', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    h.clock.advance(10_000)
    expect(h.fake.count('keyUp')).toBe(0)
    expect(h.loop.state.phase).toBe('firing')
  })

  it('keeps holding when the identity snapshot cannot be rebuilt', () => {
    const h = harness()
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.fake.count('keyDown')).toBe(1)

    // A native failure is not evidence the target died, so it must not be
    // treated as one. The error is reported, the hold survives.
    h.fake.throwOnListApplications(true)
    h.clock.advance(2_000)
    expect(h.fake.count('keyUp')).toBe(0)
    expect(h.errors.some((error) => error.message.includes('listApplications'))).toBe(true)
  })
})

describe('blocked targets', () => {
  it('reports an elevated target once, not once per tick', () => {
    const h = harness({ platform: 'win32' })
    h.fake.setBlockingReport(ELEVATED_REPORT)
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)

    expect(h.blocked).toEqual([
      {
        code: 'elevated-target',
        message: ELEVATED_REPORT.message,
        appName: 'Minecraft',
      },
    ])

    h.clock.advance(30_000)
    expect(h.blocked).toHaveLength(1)
    expect(h.fake.count('describeForegroundBlocking')).toBe(1)
  })

  it('does not re-report the same target after focus flicks away and back', () => {
    const h = harness({ platform: 'win32' })
    h.fake.setBlockingReport(ELEVATED_REPORT)
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.blocked).toHaveLength(1)

    h.fake.setFrontmost(TERMINAL.pid)
    h.clock.advance(200)
    h.fake.setFrontmost(MINECRAFT.pid)
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.blocked).toHaveLength(1)
  })

  it('says nothing when the adapter reports the target is reachable', () => {
    const h = harness({ platform: 'win32' })
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS + 5_000)
    expect(h.blocked).toEqual([])
  })

  it('ignores a report about some other window', () => {
    const h = harness({ platform: 'win32' })
    h.fake.setBlockingReport({ ...ELEVATED_REPORT, app: TERMINAL })
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS)
    expect(h.blocked).toEqual([])
  })

  it('is silent on an adapter that cannot answer the question', () => {
    const h = harness({ platform: 'darwin', extensions: false })
    h.loop.arm(config())
    h.clock.advance(SETTLE_AND_GATE_MS + 1_000)
    expect(h.fake.count('describeForegroundBlocking')).toBe(0)
    expect(h.blocked).toEqual([])
  })
})
