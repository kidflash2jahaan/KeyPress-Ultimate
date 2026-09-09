/**
 * `window.kpu`: the renderer's only door out.
 *
 * The shape below is not a design decision made here. It is the surface
 * `src/renderer/state/bridge.ts` declares and `src/renderer/mock/bridge.ts`
 * implements, method for method and event for event, so that the same UI runs
 * unchanged against a mock in a browser tab and against this bridge in the app.
 * The mock is the spec; this file is the other implementation of it.
 *
 * Two things this file does beyond forwarding calls:
 *
 * **It buffers pushes that arrive before the renderer is listening.** The store
 * subscribes only after its first round of `invoke` calls resolves, so anything
 * main pushes during startup, the crash-recovery notice above all, would land in
 * the gap and be lost. Channel subscriptions are therefore opened here, at
 * preload time, before a single line of renderer code runs, and whatever arrives
 * before the renderer subscribes is replayed to its first listener. That is what
 * makes "recovered, released 2 keys" reliable rather than a race.
 *
 * **It exposes nothing else.** No `ipcRenderer`, no `require`, no channel
 * strings, no way to name a channel the contract does not contain. The renderer
 * can call exactly these methods and subscribe to exactly these six events.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_EVENT,
  IPC_INVOKE,
  type DisarmReason,
  type IpcEventChannel,
  type IpcInvokeChannel,
} from '@shared/ipc'
import type { AppInfo, Preset, SessionConfig, SessionState, Settings, UpdateInfo } from '@shared/types'
import type {
  ArmResult,
  KpuEventMap,
  KpuEventName,
  PermissionState,
  SystemInfo,
} from '../main/ipc-handlers'

/**
 * The contract, restated here because the renderer's copy lives in the web
 * tsconfig and the preload lives in the node one. Any drift between the two is a
 * bug in this file, never in the renderer.
 */
export interface KpuBridge {
  systemInfo(): Promise<SystemInfo>

  apps: {
    list(): Promise<AppInfo[]>
    refresh(): Promise<AppInfo[]>
  }

  session: {
    arm(config: SessionConfig): Promise<ArmResult>
    disarm(reason: DisarmReason): Promise<void>
    getState(): Promise<SessionState>
  }

  permissions: {
    get(): Promise<PermissionState>
    openSettings(): Promise<void>
  }

  presets: {
    list(): Promise<Preset[]>
    save(preset: Preset): Promise<Preset[]>
    remove(id: string): Promise<Preset[]>
  }

  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }

  updates: {
    check(): Promise<UpdateInfo | null>
    download(): Promise<void>
    install(): Promise<void>
    openReleasesPage(): Promise<void>
  }

  win: {
    minimize(): Promise<void>
    close(): Promise<void>
  }

  on<K extends KpuEventName>(event: K, listener: (payload: KpuEventMap[K]) => void): () => void
}

// ---------------------------------------------------------------------------
// Invoke
// ---------------------------------------------------------------------------

async function invoke<T>(channel: IpcInvokeChannel, ...args: unknown[]): Promise<T> {
  return (await ipcRenderer.invoke(channel, ...args)) as T
}

// ---------------------------------------------------------------------------
// Events, with a startup buffer
// ---------------------------------------------------------------------------

const EVENT_CHANNELS: Readonly<Record<KpuEventName, IpcEventChannel>> = {
  sessionState: IPC_EVENT.sessionState,
  appsChanged: IPC_EVENT.appsChanged,
  permissionsChanged: IPC_EVENT.permissionsChanged,
  updateAvailable: IPC_EVENT.updateAvailable,
  updateProgress: IPC_EVENT.updateProgress,
  recoveryNotice: IPC_EVENT.recoveryNotice,
}

const EVENT_NAMES = Object.keys(EVENT_CHANNELS) as KpuEventName[]

/**
 * Deep enough to hold a burst of session frames during startup, shallow enough
 * that a renderer which never subscribes cannot grow this without bound.
 */
const MAX_BUFFERED_PER_EVENT = 32

type AnyListener = (payload: never) => void

const listeners = new Map<KpuEventName, Set<AnyListener>>()
const buffered = new Map<KpuEventName, unknown[]>()
/** An event replays its startup buffer to the first subscriber, once. */
const replayed = new Set<KpuEventName>()

for (const name of EVENT_NAMES) {
  listeners.set(name, new Set())
  buffered.set(name, [])
  ipcRenderer.on(EVENT_CHANNELS[name], (_event: IpcRendererEvent, payload: unknown) => {
    dispatch(name, payload)
  })
}

function dispatch(name: KpuEventName, payload: unknown): void {
  const set = listeners.get(name)
  if (set === undefined || set.size === 0) {
    if (replayed.has(name)) return // Nobody is listening any more, and nobody replays twice.
    const queue = buffered.get(name)
    if (queue !== undefined && queue.length < MAX_BUFFERED_PER_EVENT) queue.push(payload)
    return
  }
  for (const listener of [...set]) {
    try {
      ;(listener as (value: unknown) => void)(payload)
    } catch {
      // One broken listener must not stop the others, and must never reject
      // back across the bridge.
    }
  }
}

function subscribe<K extends KpuEventName>(
  event: K,
  listener: (payload: KpuEventMap[K]) => void,
): () => void {
  const set = listeners.get(event)
  if (set === undefined) return () => undefined
  set.add(listener as AnyListener)

  if (!replayed.has(event)) {
    replayed.add(event)
    const queue = buffered.get(event) ?? []
    buffered.set(event, [])
    // Asynchronously, so a subscriber never gets a callback before its own
    // `on()` call has returned. The mock bridge replays the current session
    // state the same way.
    for (const payload of queue) {
      queueMicrotask(() => {
        try {
          listener(payload as KpuEventMap[K])
        } catch {
          // Same reasoning as above.
        }
      })
    }
  }

  return () => {
    set.delete(listener as AnyListener)
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

const bridge: KpuBridge = {
  systemInfo: () => invoke<SystemInfo>(IPC_INVOKE.systemInfo),

  apps: {
    list: () => invoke<AppInfo[]>(IPC_INVOKE.appsList),
    refresh: () => invoke<AppInfo[]>(IPC_INVOKE.appsRefresh),
  },

  session: {
    arm: (config: SessionConfig) => invoke<ArmResult>(IPC_INVOKE.sessionArm, config),
    disarm: (reason: DisarmReason) => invoke<void>(IPC_INVOKE.sessionDisarm, reason),
    getState: () => invoke<SessionState>(IPC_INVOKE.sessionGetState),
  },

  permissions: {
    get: () => invoke<PermissionState>(IPC_INVOKE.permissionsGet),
    openSettings: () => invoke<void>(IPC_INVOKE.permissionsOpenSettings),
  },

  presets: {
    list: () => invoke<Preset[]>(IPC_INVOKE.presetsList),
    save: (preset: Preset) => invoke<Preset[]>(IPC_INVOKE.presetsSave, preset),
    remove: (id: string) => invoke<Preset[]>(IPC_INVOKE.presetsDelete, id),
  },

  settings: {
    get: () => invoke<Settings>(IPC_INVOKE.settingsGet),
    set: (patch: Partial<Settings>) => invoke<Settings>(IPC_INVOKE.settingsSet, patch),
  },

  updates: {
    check: () => invoke<UpdateInfo | null>(IPC_INVOKE.updatesCheck),
    download: () => invoke<void>(IPC_INVOKE.updatesDownload),
    install: () => invoke<void>(IPC_INVOKE.updatesInstall),
    openReleasesPage: () => invoke<void>(IPC_INVOKE.updatesOpenReleasesPage),
  },

  win: {
    minimize: () => invoke<void>(IPC_INVOKE.windowMinimize),
    close: () => invoke<void>(IPC_INVOKE.windowClose),
  },

  on: subscribe,
}

contextBridge.exposeInMainWorld('kpu', bridge)
