/**
 * The list of applications the user can pick as a target.
 *
 * The one rule that shapes this module: a target is an **identity**, never a
 * pid. `AppInfo.identity` is the bundle id on macOS and the lowercased exe path
 * on Windows, so a target the user picked while the game was pid 100 still
 * matches after the game is restarted as pid 200. Pids are cached alongside,
 * because the injector's focus gate compares pids, but nothing the user chose
 * is ever keyed by one.
 *
 * Enumeration itself belongs to the injector's `NativeInput` adapter (macOS
 * `CGWindowListCopyWindowInfo` / Windows `EnumWindows`). It is injected here so
 * this module carries no koffi and no Electron, and so the tests can run under
 * plain vitest.
 */
import type { AppInfo } from '../shared/types'
import type { NativeInput } from '../injector/native/types'

/** The only part of the native seam this module needs. */
export type AppLister = Pick<NativeInput, 'listApplications'>

/**
 * Short enough that the target strip feels live while the user is picking, long
 * enough that a repaint storm does not re-enumerate every window on every
 * frame. Enumeration is ~100us on macOS but is not free on Windows.
 */
export const DEFAULT_APP_LIST_TTL_MS = 1500

export interface AppRegistryDeps {
  native: AppLister
  /** Our own identity (bundle id / exe path), excluded from the list. */
  selfIdentity?: string | null
  /** Our own process ids, excluded as a second guard against self-targeting. */
  selfPids?: readonly number[]
  ttlMs?: number
  now?: () => number
}

export interface AppRegistry {
  /** Cached for a short TTL. Safe to call from a render loop. */
  list(): AppInfo[]
  /** Bypasses the cache. Wired to the UI's manual refresh. */
  refresh(): AppInfo[]
  findByIdentity(identity: string): AppInfo | null
  findByPid(pid: number): AppInfo | null
  isRunning(identity: string): boolean
  /** The subset of `identities` that is running right now, in list order. */
  resolveTargets(identities: readonly string[]): AppInfo[]
  /** Every live pid belonging to any of `identities`, for the focus gate. */
  pidsForTargets(identities: readonly string[]): number[]
  /** Forces the next `list()` to re-enumerate. */
  invalidate(): void
}

function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase()
}

function byName(a: AppInfo, b: AppInfo): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export function createAppRegistry(deps: AppRegistryDeps): AppRegistry {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? DEFAULT_APP_LIST_TTL_MS
  const selfIdentity =
    deps.selfIdentity === undefined || deps.selfIdentity === null
      ? null
      : normalizeIdentity(deps.selfIdentity)
  const selfPids = new Set<number>(deps.selfPids ?? [])

  let entries: AppInfo[] = []
  let pidsByIdentity = new Map<string, number[]>()
  let identityByPid = new Map<number, string>()
  let byIdentity = new Map<string, AppInfo>()
  let fetchedAt: number | null = null

  function rebuild(raw: readonly AppInfo[]): void {
    const nextEntries: AppInfo[] = []
    const nextPids = new Map<string, number[]>()
    const nextIdentityByPid = new Map<number, string>()
    const nextByIdentity = new Map<string, AppInfo>()

    for (const app of raw) {
      if (typeof app.identity !== 'string') continue
      const key = normalizeIdentity(app.identity)
      if (key === '') continue
      if (selfIdentity !== null && key === selfIdentity) continue
      if (selfPids.has(app.pid)) continue

      nextIdentityByPid.set(app.pid, key)
      const pids = nextPids.get(key)
      if (pids === undefined) {
        nextPids.set(key, [app.pid])
      } else if (!pids.includes(app.pid)) {
        pids.push(app.pid)
      }

      if (!nextByIdentity.has(key)) {
        const entry: AppInfo = { ...app }
        nextByIdentity.set(key, entry)
        nextEntries.push(entry)
      }
    }

    nextEntries.sort(byName)
    entries = nextEntries
    pidsByIdentity = nextPids
    identityByPid = nextIdentityByPid
    byIdentity = nextByIdentity
  }

  function fetch(): void {
    fetchedAt = now()
    let raw: readonly AppInfo[]
    try {
      raw = deps.native.listApplications()
    } catch {
      // Enumeration can fail transiently (a window vanishing mid-walk, a
      // permission blip). Keeping the last good list beats blanking the target
      // strip and losing the user's selection context.
      return
    }
    rebuild(Array.isArray(raw) ? raw : [])
  }

  function ensureFresh(): void {
    if (fetchedAt === null || now() - fetchedAt >= ttlMs) fetch()
  }

  function snapshot(): AppInfo[] {
    return entries.map((app) => ({ ...app }))
  }

  return {
    list(): AppInfo[] {
      ensureFresh()
      return snapshot()
    },

    refresh(): AppInfo[] {
      fetch()
      return snapshot()
    },

    findByIdentity(identity: string): AppInfo | null {
      ensureFresh()
      const found = byIdentity.get(normalizeIdentity(identity))
      return found === undefined ? null : { ...found }
    },

    findByPid(pid: number): AppInfo | null {
      ensureFresh()
      const key = identityByPid.get(pid)
      if (key === undefined) return null
      const found = byIdentity.get(key)
      return found === undefined ? null : { ...found }
    },

    isRunning(identity: string): boolean {
      ensureFresh()
      return byIdentity.has(normalizeIdentity(identity))
    },

    resolveTargets(identities: readonly string[]): AppInfo[] {
      ensureFresh()
      const wanted = new Set(identities.map(normalizeIdentity))
      return entries
        .filter((app) => wanted.has(normalizeIdentity(app.identity)))
        .map((app) => ({ ...app }))
    },

    pidsForTargets(identities: readonly string[]): number[] {
      ensureFresh()
      const pids: number[] = []
      for (const identity of identities) {
        for (const pid of pidsByIdentity.get(normalizeIdentity(identity)) ?? []) {
          if (!pids.includes(pid)) pids.push(pid)
        }
      }
      return pids
    },

    invalidate(): void {
      fetchedAt = null
    },
  }
}
