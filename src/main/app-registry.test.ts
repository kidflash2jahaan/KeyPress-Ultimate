/**
 * Tests for the three read-only "what is running / what does it look like"
 * modules of Task 7.
 *
 * `focus-watcher` and `icons` are covered here rather than in their own files
 * because Task 7's file list names exactly three test files, and these three
 * modules answer the same question: which real applications exist, which one is
 * frontmost, and what icon do we draw for it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '../shared/types'
import { DEFAULT_APP_LIST_TTL_MS, createAppRegistry } from './app-registry'
import { FOCUS_POLL_MS, createFocusWatcher } from './focus-watcher'
import { ICON_CSS_PX, ICON_SOURCE_PX, createIconCache } from './icons'

function makeApp(identity: string, name: string, pid: number): AppInfo {
  return { identity, name, pid, path: `/Applications/${name}.app` }
}

/** Stands in for the injector's `NativeInput`, which is not available in a test process. */
class FakeNative {
  apps: AppInfo[] = []
  frontmostPid: number | null = null
  listCalls = 0
  frontmostCalls = 0
  listThrows: Error | null = null

  listApplications(): AppInfo[] {
    this.listCalls += 1
    if (this.listThrows !== null) throw this.listThrows
    return this.apps.map((a) => ({ ...a }))
  }

  getFrontmostPid(): number | null {
    this.frontmostCalls += 1
    return this.frontmostPid
  }
}

describe('app registry', () => {
  it('still matches a target after the game restarts under a new pid', () => {
    const native = new FakeNative()
    native.apps = [makeApp('com.mojang.minecraft', 'Minecraft', 100)]
    let clock = 0
    const registry = createAppRegistry({ native, now: () => clock })

    // The user picks the target while the game is pid 100.
    const picked = registry.list().find((a) => a.name === 'Minecraft')
    expect(picked?.pid).toBe(100)
    const targetIdentity = picked!.identity

    // The game quits and comes back as a different process.
    native.apps = [makeApp('com.mojang.minecraft', 'Minecraft', 200)]
    clock += DEFAULT_APP_LIST_TTL_MS + 1

    expect(registry.isRunning(targetIdentity)).toBe(true)
    expect(registry.findByIdentity(targetIdentity)?.pid).toBe(200)
    expect(registry.pidsForTargets([targetIdentity])).toEqual([200])
  })

  it('reports a target as not running once nothing carries its identity', () => {
    const native = new FakeNative()
    native.apps = [makeApp('com.mojang.minecraft', 'Minecraft', 100)]
    const registry = createAppRegistry({ native })

    registry.refresh()
    native.apps = []
    registry.refresh()

    expect(registry.isRunning('com.mojang.minecraft')).toBe(false)
    expect(registry.findByIdentity('com.mojang.minecraft')).toBeNull()
    expect(registry.pidsForTargets(['com.mojang.minecraft'])).toEqual([])
  })

  it('excludes our own app by identity, case-insensitively', () => {
    const native = new FakeNative()
    native.apps = [
      makeApp('com.keypressultimate.app', 'KeyPress Ultimate', 10),
      makeApp('com.google.Chrome', 'Chrome', 11),
    ]
    const registry = createAppRegistry({
      native,
      selfIdentity: 'COM.KEYPRESSULTIMATE.APP',
    })

    expect(registry.list().map((a) => a.identity)).toEqual(['com.google.Chrome'])
  })

  it('excludes our own helper processes by pid', () => {
    const native = new FakeNative()
    native.apps = [makeApp('com.google.Chrome', 'Chrome', 11), makeApp('com.other', 'Other', 12)]
    const registry = createAppRegistry({ native, selfPids: [12] })

    expect(registry.list().map((a) => a.pid)).toEqual([11])
  })

  it('keys by identity, collapsing several processes of the same app', () => {
    const native = new FakeNative()
    native.apps = [
      makeApp('com.google.Chrome', 'Chrome', 11),
      makeApp('com.google.Chrome', 'Chrome', 12),
    ]
    const registry = createAppRegistry({ native })

    expect(registry.list()).toHaveLength(1)
    expect(registry.pidsForTargets(['com.google.Chrome'])).toEqual([11, 12])
  })

  it('drops entries with no usable identity', () => {
    const native = new FakeNative()
    native.apps = [makeApp('', 'Ghost', 1), makeApp('  ', 'Ghost2', 2), makeApp('ok', 'Real', 3)]
    const registry = createAppRegistry({ native })

    expect(registry.list().map((a) => a.identity)).toEqual(['ok'])
  })

  it('sorts by display name so the target strip is stable', () => {
    const native = new FakeNative()
    native.apps = [
      makeApp('c', 'zed', 3),
      makeApp('a', 'Alpha', 1),
      makeApp('b', 'beta', 2),
    ]
    const registry = createAppRegistry({ native })

    expect(registry.list().map((a) => a.name)).toEqual(['Alpha', 'beta', 'zed'])
  })

  it('caches for a short TTL and re-queries once it expires', () => {
    const native = new FakeNative()
    native.apps = [makeApp('a', 'Alpha', 1)]
    let clock = 0
    const registry = createAppRegistry({ native, now: () => clock, ttlMs: 500 })

    registry.list()
    registry.list()
    registry.list()
    expect(native.listCalls).toBe(1)

    clock += 501
    registry.list()
    expect(native.listCalls).toBe(2)
  })

  it('refresh bypasses the cache', () => {
    const native = new FakeNative()
    native.apps = [makeApp('a', 'Alpha', 1)]
    const registry = createAppRegistry({ native })

    registry.list()
    registry.refresh()
    expect(native.listCalls).toBe(2)
  })

  it('keeps serving the last good list when enumeration throws', () => {
    const native = new FakeNative()
    native.apps = [makeApp('a', 'Alpha', 1)]
    const registry = createAppRegistry({ native })
    expect(registry.refresh()).toHaveLength(1)

    native.listThrows = new Error('CGWindowListCopyWindowInfo failed')
    expect(() => registry.refresh()).not.toThrow()
    expect(registry.list().map((a) => a.identity)).toEqual(['a'])
  })

  it('returns an empty list when the very first enumeration throws', () => {
    const native = new FakeNative()
    native.listThrows = new Error('nope')
    const registry = createAppRegistry({ native })

    expect(registry.refresh()).toEqual([])
  })

  it('resolves target identities to the apps that are running now', () => {
    const native = new FakeNative()
    native.apps = [makeApp('a', 'Alpha', 1), makeApp('b', 'Beta', 2)]
    const registry = createAppRegistry({ native })

    expect(registry.resolveTargets(['b', 'missing']).map((a) => a.pid)).toEqual([2])
  })

  it('finds the app that owns a pid', () => {
    const native = new FakeNative()
    native.apps = [makeApp('a', 'Alpha', 1), makeApp('a', 'Alpha', 5)]
    const registry = createAppRegistry({ native })

    expect(registry.findByPid(5)?.identity).toBe('a')
    expect(registry.findByPid(999)).toBeNull()
  })
})

describe('focus watcher', () => {
  it('polls at 250ms, well above the injector 25ms gate', () => {
    expect(FOCUS_POLL_MS).toBe(250)
  })

  it('emits on change only, not on every tick', () => {
    const native = new FakeNative()
    native.apps = [makeApp('a', 'Alpha', 1), makeApp('b', 'Beta', 2)]
    const registry = createAppRegistry({ native })
    const watcher = createFocusWatcher({ native, registry })
    const seen: (string | null)[] = []
    watcher.onChange((focused) => seen.push(focused?.identity ?? null))

    native.frontmostPid = 1
    watcher.poll()
    watcher.poll()
    watcher.poll()
    native.frontmostPid = 2
    watcher.poll()
    watcher.poll()

    expect(seen).toEqual(['a', 'b'])
  })

  it('reports null when the frontmost pid is unknown', () => {
    const native = new FakeNative()
    native.apps = [makeApp('a', 'Alpha', 1)]
    const registry = createAppRegistry({ native })
    const watcher = createFocusWatcher({ native, registry })
    const seen: (AppInfo | null)[] = []
    watcher.onChange((focused) => seen.push(focused))

    native.frontmostPid = 1
    watcher.poll()
    native.frontmostPid = null
    watcher.poll()

    expect(seen.map((a) => a?.identity ?? null)).toEqual(['a', null])
    expect(watcher.current()).toBeNull()
    expect(watcher.currentPid()).toBeNull()
  })

  it('emits when an unknown pid becomes frontmost', () => {
    const native = new FakeNative()
    const registry = createAppRegistry({ native })
    const watcher = createFocusWatcher({ native, registry })
    const seen: number[] = []
    watcher.onChange(() => seen.push(watcher.currentPid() ?? -1))

    native.frontmostPid = 77
    watcher.poll()
    watcher.poll()

    expect(seen).toEqual([77])
    expect(watcher.current()).toBeNull()
  })

  it('swallows a throwing frontmost lookup and reports unknown', () => {
    const native = {
      getFrontmostPid(): number | null {
        throw new Error('boom')
      },
    }
    const watcher = createFocusWatcher({ native })

    expect(() => watcher.poll()).not.toThrow()
    expect(watcher.currentPid()).toBeNull()
  })

  it('start polls on an interval and stop ends it', () => {
    vi.useFakeTimers()
    try {
      const native = new FakeNative()
      const watcher = createFocusWatcher({ native })

      watcher.start()
      const afterStart = native.frontmostCalls
      expect(afterStart).toBe(1) // immediate first read, no 250ms blank

      vi.advanceTimersByTime(FOCUS_POLL_MS * 3)
      expect(native.frontmostCalls).toBe(afterStart + 3)

      watcher.stop()
      vi.advanceTimersByTime(FOCUS_POLL_MS * 5)
      expect(native.frontmostCalls).toBe(afterStart + 3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('unsubscribes a listener', () => {
    const native = new FakeNative()
    const watcher = createFocusWatcher({ native })
    const seen: number[] = []
    const off = watcher.onChange(() => seen.push(1))

    native.frontmostPid = 1
    watcher.poll()
    off()
    native.frontmostPid = 2
    watcher.poll()

    expect(seen).toHaveLength(1)
  })
})

describe('icon cache', () => {
  function fakeIcon(dataUrl: string, empty = false): { toDataURL(): string; isEmpty(): boolean } {
    return { toDataURL: () => dataUrl, isEmpty: () => empty }
  }

  it('renders 32px macOS icons as 16px CSS for an exact 2x', () => {
    expect(ICON_SOURCE_PX).toBe(32)
    expect(ICON_CSS_PX).toBe(16)
    expect(ICON_SOURCE_PX / ICON_CSS_PX).toBe(2)
  })

  it('fetches once per path and serves the cache afterwards', async () => {
    const getFileIcon = vi.fn(async () => fakeIcon('data:image/png;base64,AAA'))
    const cache = createIconCache({ getFileIcon })

    expect(await cache.get('/Applications/Chrome.app')).toBe('data:image/png;base64,AAA')
    expect(await cache.get('/Applications/Chrome.app')).toBe('data:image/png;base64,AAA')
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('collapses concurrent requests for the same path into one call', async () => {
    const getFileIcon = vi.fn(async () => fakeIcon('data:x'))
    const cache = createIconCache({ getFileIcon })

    const [a, b] = await Promise.all([cache.get('/A.app'), cache.get('/A.app')])

    expect(a).toBe('data:x')
    expect(b).toBe('data:x')
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('returns null for a missing path without calling the OS', async () => {
    const getFileIcon = vi.fn(async () => fakeIcon('data:x'))
    const cache = createIconCache({ getFileIcon })

    expect(await cache.get(null)).toBeNull()
    expect(getFileIcon).not.toHaveBeenCalled()
  })

  it('caches a failure instead of retrying it on every list refresh', async () => {
    const getFileIcon = vi.fn(async () => {
      throw new Error('no such file')
    })
    const cache = createIconCache({ getFileIcon })

    expect(await cache.get('/gone.app')).toBeNull()
    expect(await cache.get('/gone.app')).toBeNull()
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('treats an empty native image as no icon', async () => {
    const getFileIcon = vi.fn(async () => fakeIcon('data:image/png;base64,', true))
    const cache = createIconCache({ getFileIcon })

    expect(await cache.get('/empty.app')).toBeNull()
  })

  it('decorates apps with icon data urls and leaves the rest of AppInfo alone', async () => {
    const getFileIcon = vi.fn(async (p: string) => fakeIcon(`data:${p}`))
    const cache = createIconCache({ getFileIcon })
    const apps: AppInfo[] = [makeApp('a', 'Alpha', 1), { ...makeApp('b', 'Beta', 2), path: null }]

    const decorated = await cache.decorate(apps)

    expect(decorated[0]?.iconDataUrl).toBe('data:/Applications/Alpha.app')
    expect(decorated[0]?.identity).toBe('a')
    expect(decorated[1]?.iconDataUrl).toBeUndefined()
  })

  it('clear drops the cache so a reinstalled app picks up a new icon', async () => {
    const getFileIcon = vi.fn(async () => fakeIcon('data:x'))
    const cache = createIconCache({ getFileIcon })

    await cache.get('/A.app')
    cache.clear()
    await cache.get('/A.app')

    expect(getFileIcon).toHaveBeenCalledTimes(2)
  })
})
