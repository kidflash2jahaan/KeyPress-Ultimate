/**
 * The injector `utilityProcess` entry point.
 *
 * This process exists so that nothing else in the app can strand a key. It is
 * the only process that posts input, and it is separately killable and
 * separately survivable: renderer animation cannot jitter its timing, and if
 * the main process is Force Quit, the heartbeat here notices within 300ms and
 * releases everything before exiting.
 *
 * Its whole contract is the message protocol in `@shared/ipc`. Nothing else
 * crosses the boundary.
 *
 *   main -> injector   arm | disarm | ping | settings
 *   injector -> main   state | pong | error | released | blocked
 *
 * Every exit path in this file funnels into one idempotent `shutdown()`, which
 * calls `HoldLoop.releaseAll()` exactly once no matter how many handlers fire.
 * A stuck key is the worst failure this app has, so the release path is the
 * part with the most redundancy and the least cleverness.
 *
 * The runtime is a factory taking its port, its native adapter, its clock and
 * its `exit` function as arguments, so all of it, including the heartbeat
 * timeout and every signal handler, is driveable in a test with fakes and no
 * real input, no real timers and no real process.
 */
import type {
  DisarmReason,
  InjectorToMainMessage,
  MainToInjectorMessage,
} from '@shared/ipc'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '@shared/ipc'
import type { Platform, SessionConfig, Settings } from '@shared/types'
import type { HoldLoop, InjectorNative } from './hold-loop'
import { createHoldLoop } from './hold-loop'
import type { Clock, Scheduler } from './scheduler'
import { createScheduler, realClock } from './scheduler'

// ---------------------------------------------------------------------------
// The bits of Electron and Node this file touches, narrowed to what it uses.
// Structural interfaces rather than Electron types, so the runtime is testable
// without Electron and cannot accidentally reach for anything wider.
// ---------------------------------------------------------------------------

export interface InjectorMessageEvent {
  data: unknown
}

export interface InjectorPort {
  postMessage(message: InjectorToMainMessage): void
  on(event: 'message', listener: (event: InjectorMessageEvent) => void): unknown
}

export interface ProcessLike {
  on(event: string, listener: (...args: never[]) => void): unknown
  exit(code?: number): void
}

// ---------------------------------------------------------------------------
// Message validation. Anything arriving over IPC is untrusted shape.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseMainToInjectorMessage(value: unknown): MainToInjectorMessage | null {
  if (!isRecord(value)) return null
  switch (value.t) {
    case 'arm':
      return isRecord(value.config) ? { t: 'arm', config: value.config as unknown as SessionConfig } : null
    case 'disarm':
      return typeof value.reason === 'string'
        ? { t: 'disarm', reason: value.reason as DisarmReason }
        : null
    case 'ping':
      return typeof value.n === 'number' ? { t: 'ping', n: value.n } : null
    case 'settings':
      return isRecord(value.settings)
        ? { t: 'settings', settings: value.settings as unknown as Settings }
        : null
    default:
      return null
  }
}

/**
 * Our own pids, so the loop can refuse to press into our own window. The main
 * process pid arrives as `--main-pid=<n>` on the fork's argv; the frontmost
 * window always belongs to main, never to this process, but both are checked
 * because the check costs nothing.
 */
export function parseOurPids(argv: readonly string[], selfPid: number): number[] {
  const pids = new Set<number>([selfPid])
  for (const arg of argv) {
    const match = /^--main-pid=(\d+)$/.exec(arg)
    if (match?.[1] !== undefined) pids.add(Number(match[1]))
  }
  return [...pids]
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface InjectorRuntimeOptions {
  port: InjectorPort
  native: InjectorNative
  ourPids?: readonly number[]
  platform?: Platform
  clock?: Clock
  /** Forwarded to the hold loop's scheduler. Pass 0 when driving with a fake clock. */
  spinMs?: number
  /** Called on the exit paths that are allowed to end the process. */
  exit: (code: number) => void
  onLog?: (message: string) => void
}

export interface InjectorRuntime {
  /** Subscribes to the port and starts the heartbeat watchdog. */
  start(): void
  /** Handles one already-received message payload. Exposed so tests need no port plumbing. */
  handleMessage(raw: unknown): void
  /**
   * Release everything and, unless `exitCode` is null, end the process.
   * Idempotent: the first call does the work, every later call is a no-op, so
   * five failsafes racing produce exactly one release.
   */
  shutdown(reason: DisarmReason, exitCode: number | null): void
  readonly shutdownCount: number
  readonly loop: HoldLoop
}

export function createInjectorRuntime(options: InjectorRuntimeOptions): InjectorRuntime {
  const clock = options.clock ?? realClock
  const port = options.port
  let watchdog: Scheduler | null = null
  /**
   * When main was last known to be alive. Seeded at `start()`, not at the first
   * ping: an injector that is armed and then never heard from again must have a
   * running deadline from the moment it exists, or a main that dies inside the
   * gap before its first ping leaves an armed injector with no liveness check
   * at all.
   */
  let lastHeardFromMainAt: number | null = null
  let shutdownCount = 0
  let started = false

  function log(message: string): void {
    options.onLog?.(message)
  }

  function post(message: InjectorToMainMessage): void {
    try {
      port.postMessage(message)
    } catch (error) {
      // A dead port is not a reason to skip releasing keys, so this is
      // swallowed deliberately and never rethrown.
      log(`postMessage failed: ${String(error)}`)
    }
  }

  const loop = createHoldLoop({
    native: options.native,
    ourPids: options.ourPids,
    platform: options.platform,
    clock,
    spinMs: options.spinMs,
    onState: (state) =>
      post({
        t: 'state',
        firingKeyIds: state.firingKeyIds,
        firingButtonIds: state.firingButtonIds,
        onTarget: state.onTarget,
        focusedPid: state.focusedPid,
      }),
    onReleased: (count) => post({ t: 'released', count }),
    onBlocked: (blocked) =>
      post({
        t: 'blocked',
        code: blocked.code,
        message: blocked.message,
        appName: blocked.appName,
      }),
    // The loop ended its own session, which main did not ask for and cannot
    // see. Leaving would be enough on its own, but the process has no reason to
    // stay: its session is over, and main forks a fresh injector per arm. An
    // exit is a signal main already handles, so it cannot stay armed against a
    // loop that has stopped ticking.
    onSelfDisarm: (reason) => {
      log(`hold loop ended its own session (${reason}), releasing and exiting`)
      shutdown(reason, 0)
    },
    onError: (code, message) => post({ t: 'error', code, message }),
    onLog: options.onLog,
  })

  function handleMessage(raw: unknown): void {
    const message = parseMainToInjectorMessage(raw)
    if (message === null) {
      log(`ignoring unrecognised message: ${JSON.stringify(raw)}`)
      return
    }
    // Any message from main counts as proof of life, pings included. The
    // deadline is never *disarmed* by silence, only pushed forward by contact:
    // a main that stops talking is a main this process has to outlive by as
    // little as possible.
    lastHeardFromMainAt = clock.now()
    switch (message.t) {
      case 'ping':
        post({ t: 'pong', n: message.n })
        return
      case 'arm':
        loop.arm(message.config)
        return
      case 'disarm':
        loop.disarm(message.reason)
        return
      case 'settings':
        loop.applySettings(message.settings)
        return
    }
  }

  function checkHeartbeat(): void {
    // Null only before `start()` has run, i.e. before the watchdog exists.
    if (lastHeardFromMainAt === null) return
    const silentFor = clock.now() - lastHeardFromMainAt
    if (silentFor < HEARTBEAT_TIMEOUT_MS) return
    log(`nothing from main for ${Math.round(silentFor)}ms, releasing and exiting`)
    shutdown('heartbeat-timeout', 1)
  }

  function shutdown(reason: DisarmReason, exitCode: number | null): void {
    if (shutdownCount > 0) {
      shutdownCount++
      return
    }
    shutdownCount++
    try {
      loop.releaseAll(reason)
    } catch (error) {
      log(`releaseAll threw during shutdown: ${String(error)}`)
    }
    try {
      options.native.dispose()
    } catch (error) {
      log(`dispose threw during shutdown: ${String(error)}`)
    }
    watchdog?.stop()
    watchdog = null
    if (exitCode !== null) options.exit(exitCode)
  }

  return {
    start(): void {
      if (started) return
      started = true
      port.on('message', (event) => handleMessage(event.data))
      // The deadline starts now, before a single message has arrived. Waiting
      // for the first ping would leave the window between fork and that ping
      // (one HEARTBEAT_INTERVAL_MS, and `arm` lands inside it) completely
      // unwatched, which is exactly when a main that dies strands a held key.
      lastHeardFromMainAt = clock.now()
      watchdog = createScheduler({
        periodMs: HEARTBEAT_INTERVAL_MS,
        clock,
        // No spin correction: this is a liveness check, not a timing-critical
        // path, and a busy-wait every 100ms for the life of the session would
        // be pure waste.
        spinMs: 0,
        onTick: checkHeartbeat,
        onError: (error) => log(`heartbeat check failed: ${String(error)}`),
      })
      watchdog.start()
    },
    handleMessage,
    shutdown,
    get shutdownCount(): number {
      return shutdownCount
    },
    loop,
  }
}

// ---------------------------------------------------------------------------
// Failsafes
// ---------------------------------------------------------------------------

export const FAILSAFE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * Every path out of this process, wired to the same idempotent shutdown.
 *
 * `exit` passes a null exit code because the process is already leaving and
 * calling `process.exit()` from inside an `exit` handler is undefined; the
 * handler's only job there is the synchronous release.
 */
export function installFailsafeHandlers(runtime: InjectorRuntime, proc: ProcessLike): void {
  proc.on('exit', () => {
    runtime.shutdown('app-quit', null)
  })
  for (const signal of FAILSAFE_SIGNALS) {
    proc.on(signal, () => {
      runtime.shutdown('signal', 0)
    })
  }
  proc.on('uncaughtException', () => {
    runtime.shutdown('uncaught-exception', 1)
  })
}

// ---------------------------------------------------------------------------
// Bootstrap. Runs only inside a real utilityProcess, so importing this module
// in a test does nothing.
// ---------------------------------------------------------------------------

/**
 * Resolved at runtime rather than statically, so this module imports cleanly
 * on a machine where the native adapter cannot load, and so a test can import
 * the runtime without pulling koffi into the process.
 */
async function loadNativeInput(): Promise<InjectorNative> {
  const module: unknown = await import('./native/index')
  if (isRecord(module)) {
    const candidate = module.createNativeInput
    if (typeof candidate === 'function') {
      // The factory picks the adapter for this platform and imports only that
      // one, so the wrong platform's koffi bindings never enter the process.
      return await (candidate as () => InjectorNative | Promise<InjectorNative>)()
    }
  }
  throw new Error('src/injector/native/index.ts must export createNativeInput(): NativeInput')
}

async function bootstrap(port: InjectorPort): Promise<void> {
  let native: InjectorNative
  try {
    native = await loadNativeInput()
    await native.init()
  } catch (error) {
    port.postMessage({
      t: 'error',
      code: 'ffi-init-failed',
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }

  const runtime = createInjectorRuntime({
    port,
    native,
    ourPids: parseOurPids(process.argv, process.pid),
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    exit: (code) => {
      process.exit(code)
    },
    onLog: (message) => {
      // stdout of a utilityProcess is piped to main, so this is how the
      // injector is debugged in a packaged build.
      console.log(`[injector] ${message}`)
    },
  })

  installFailsafeHandlers(runtime, process as unknown as ProcessLike)
  runtime.start()
}

const parentPort = (process as unknown as { parentPort?: InjectorPort | null }).parentPort
if (parentPort !== undefined && parentPort !== null) {
  void bootstrap(parentPort)
}
