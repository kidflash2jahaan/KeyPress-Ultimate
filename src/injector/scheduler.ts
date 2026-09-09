/**
 * Absolute-deadline tick scheduler.
 *
 * The obvious way to run a periodic loop in Node is recursive
 * `setTimeout(tick, period)`. It drifts, badly and without bound: measured on
 * this project's reference machine, a 20ms recursive `setTimeout` was
 * **+139.8ms mean / +279.8ms p99** off an ideal schedule after 300 ticks, i.e.
 * about 140ms of accumulated lateness in six seconds. That is the single most
 * likely timing bug in an input-synthesis product, so it is designed out here
 * rather than guarded against later.
 *
 * The fix has two parts:
 *
 *   1. Every deadline is computed from a fixed origin, `t0 + n * periodMs`, and
 *      the delay handed to `setTimeout` is `deadline - now()`. Lateness on one
 *      tick therefore shortens the next delay instead of pushing the whole
 *      schedule back. This alone gets p99 error to about 1.08ms.
 *   2. The timer is armed `spinMs` *early* and the last fraction of a
 *      millisecond is burned in a busy loop. At the default 0.5ms that buys
 *      p99 0.58ms for ~1.2% of one core at a 20ms period. A 2ms spin is
 *      measurably more accurate and costs 10x the CPU, which is not worth it
 *      for input synthesis.
 *
 * Deadlines that have already passed when a tick fires (a stalled event loop,
 * a machine wake) are coalesced into that tick and reported as `skipped`,
 * rather than firing as a burst of catch-up ticks. A burst would mean a burst
 * of key asserts, which is exactly the thing this product must never do.
 *
 * Everything that touches time goes through the injectable `Clock`, so the
 * hold loop can be driven deterministically in tests with no real timers.
 */

/** Opaque timer identity. Whatever the `Clock` implementation hands back. */
export type TimerHandle = unknown

/**
 * The seam between this module and real time. `now()` must be monotonic and in
 * milliseconds; it is compared against itself and never against wall clock.
 */
export interface Clock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/** Monotonic real time. `hrtime` rather than `Date.now`, so a clock step cannot skew the schedule. */
export const realClock: Clock = {
  now: () => Number(process.hrtime.bigint()) / 1e6,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface SchedulerTick {
  /** 1-based index of the deadline this tick was armed for. */
  index: number
  /** `t0 + index * periodMs`. The ideal time this tick should have fired. */
  scheduledAt: number
  /** What the clock actually read when the callback ran. */
  firedAt: number
  /** `firedAt - scheduledAt`. Positive means late, which it essentially always is. */
  errorMs: number
  /**
   * Deadlines that had already elapsed by `firedAt` and were folded into this
   * tick instead of firing as catch-up ticks. Zero on a healthy loop.
   */
  skipped: number
}

export interface SchedulerOptions {
  /** Tick period in milliseconds. Floored at `MIN_PERIOD_MS`. */
  periodMs: number
  onTick: (tick: SchedulerTick) => void
  /** Defaults to `realClock`. Pass a fake to drive the loop deterministically. */
  clock?: Clock
  /**
   * Busy-wait budget before each deadline. Defaults to `DEFAULT_SPIN_MS`.
   * **Pass 0 when driving with a fake clock**, or the spin loop never exits:
   * a fake clock does not advance on its own.
   */
  spinMs?: number
  /** Called if `onTick` throws. The loop keeps running. */
  onError?: (error: unknown) => void
}

export interface Scheduler {
  start(): void
  stop(): void
  readonly running: boolean
  /** Number of times `onTick` has been invoked. */
  readonly tickCount: number
  /** The effective period, after flooring. */
  readonly periodMs: number
}

/** Measured sweet spot: p99 0.58ms at 20ms for ~1.2% of a core. */
export const DEFAULT_SPIN_MS = 0.5

/** Below this a spin-corrected loop costs more CPU than the accuracy is worth. */
export const MIN_PERIOD_MS = 1

export function createScheduler(options: SchedulerOptions): Scheduler {
  const clock = options.clock ?? realClock
  const spinMs = Math.max(0, options.spinMs ?? DEFAULT_SPIN_MS)
  const periodMs = Math.max(MIN_PERIOD_MS, options.periodMs)

  let running = false
  let handle: TimerHandle | null = null
  let origin = 0
  /** Index of the last deadline that has been consumed. */
  let index = 0
  let tickCount = 0

  function arm(): void {
    const deadline = origin + (index + 1) * periodMs
    const delay = deadline - clock.now() - spinMs
    handle = clock.setTimeout(fire, delay > 0 ? delay : 0)
  }

  function fire(): void {
    handle = null
    if (!running) return

    const target = index + 1
    const scheduledAt = origin + target * periodMs

    // Final approach. Skipped entirely when spinMs is 0, which is what makes
    // the loop safe to drive with a fake clock.
    if (spinMs > 0) {
      while (clock.now() < scheduledAt) {
        /* busy wait */
      }
    }

    const firedAt = clock.now()

    // Fold every deadline that has already elapsed into this one tick.
    let consumed = target
    while (origin + (consumed + 1) * periodMs <= firedAt) consumed++
    index = consumed
    tickCount++

    try {
      options.onTick({
        index: target,
        scheduledAt,
        firedAt,
        errorMs: firedAt - scheduledAt,
        skipped: consumed - target,
      })
    } catch (error) {
      options.onError?.(error)
    }

    // `onTick` is allowed to call stop().
    if (running) arm()
  }

  return {
    start(): void {
      if (running) return
      running = true
      origin = clock.now()
      index = 0
      arm()
    },
    stop(): void {
      if (!running) return
      running = false
      if (handle !== null) {
        clock.clearTimeout(handle)
        handle = null
      }
    },
    get running(): boolean {
      return running
    },
    get tickCount(): number {
      return tickCount
    },
    get periodMs(): number {
      return periodMs
    },
  }
}
