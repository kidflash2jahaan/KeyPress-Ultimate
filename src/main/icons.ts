/**
 * App icons for the target chips.
 *
 * `app.getFileIcon` is a disk hit per path, and the target strip re-renders on
 * every focus change, so the results are cached in memory keyed by path. The
 * cache stores the in-flight promise rather than the value, so ten chips asking
 * for the same icon at once produce one OS call, and it caches failures too: a
 * path that has no icon today will not have one on the next repaint either, and
 * retrying it forever is just a slow leak.
 *
 * Size note that the UI depends on: macOS caps `getFileIcon` at 32x32 whatever
 * you ask for. So the chip renders at 16px CSS, making the bitmap an exact 2x on
 * a Retina display. Asking for 'large' and drawing at 24px would upscale a 32px
 * source by 1.33 and look soft.
 *
 * Electron is injected rather than imported, so this module runs under vitest.
 */
import type { AppInfo } from '../shared/types'

/** 32 is macOS's hard cap for `getFileIcon`, whatever size you request. */
export const ICON_SOURCE_PX = 32
/** Render at 16 CSS px so a 32px source is an exact 2x. */
export const ICON_CSS_PX = 16

/** The part of Electron's `NativeImage` we use. */
export interface NativeImageLike {
  toDataURL(options?: unknown): string
  isEmpty(): boolean
}

/** Wired to Electron's `app` object by main. */
export interface IconSource {
  getFileIcon(path: string, options?: { size?: 'small' | 'normal' | 'large' }): Promise<
    NativeImageLike
  >
}

export interface IconCacheDeps extends IconSource {
  /** 'normal' is 32px on macOS, which is the cap anyway. */
  size?: 'small' | 'normal' | 'large'
}

export interface IconCache {
  /** Data URL, or null for a missing path or an unreadable icon. */
  get(path: string | null | undefined): Promise<string | null>
  /** Returns copies with `iconDataUrl` filled in where one exists. */
  decorate(apps: readonly AppInfo[]): Promise<AppInfo[]>
  clear(): void
  /** Number of cached paths, for tests and diagnostics. */
  count(): number
}

export function createIconCache(deps: IconCacheDeps): IconCache {
  const size = deps.size ?? 'normal'
  const cache = new Map<string, Promise<string | null>>()

  function load(path: string): Promise<string | null> {
    return deps
      .getFileIcon(path, { size })
      .then((image) => {
        if (image.isEmpty()) return null
        const url = image.toDataURL()
        return typeof url === 'string' && url !== '' ? url : null
      })
      .catch(() => null)
  }

  function get(path: string | null | undefined): Promise<string | null> {
    if (typeof path !== 'string' || path.trim() === '') return Promise.resolve(null)
    const existing = cache.get(path)
    if (existing !== undefined) return existing
    const pending = load(path)
    cache.set(path, pending)
    return pending
  }

  return {
    get,

    async decorate(apps: readonly AppInfo[]): Promise<AppInfo[]> {
      return Promise.all(
        apps.map(async (app) => {
          const iconDataUrl = await get(app.path)
          return iconDataUrl === null ? { ...app } : { ...app, iconDataUrl }
        }),
      )
    },

    clear(): void {
      cache.clear()
    },

    count(): number {
      return cache.size
    },
  }
}
