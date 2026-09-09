import { describe, expect, it } from 'vitest'

import { createFocusWatcher } from './focus-watcher'
import type { AppInfo } from '../shared/types'

const SELF: AppInfo = {
  identity: 'com.keypressultimate.app',
  name: 'KeyPress Ultimate',
  pid: 1000,
  path: '/Applications/KeyPress Ultimate.app',
}
const GAME: AppInfo = {
  identity: 'com.mojang.minecraft',
  name: 'Minecraft',
  pid: 2000,
  path: '/Applications/Minecraft.app',
}

/**
 * Shipped in 0.1.0: with our own window frontmost the strip read
 * "Frontmost now  Unknown". The registry excludes our own app so it can never
 * be targeted, and the focus readout asked that same registry who was in front,
 * so it could not name the one app guaranteed to be running. "Unknown" reads as
 * broken at the exact moment the app is behaving correctly.
 */
describe('focus watcher self-recognition', () => {
  const registry = {
    findByPid: (pid: number): AppInfo | null => (pid === GAME.pid ? GAME : null),
  }

  it('names our own app when our window is frontmost, instead of reporting nothing', () => {
    const watcher = createFocusWatcher({
      native: { getFrontmostPid: () => SELF.pid },
      registry,
      selfApp: SELF,
      selfPids: [SELF.pid],
    })
    watcher.poll()
    expect(watcher.current()).toEqual(SELF)
    expect(watcher.current()?.name).toBe('KeyPress Ultimate')
  })

  it('still resolves other apps through the registry', () => {
    const watcher = createFocusWatcher({
      native: { getFrontmostPid: () => GAME.pid },
      registry,
      selfApp: SELF,
      selfPids: [SELF.pid],
    })
    watcher.poll()
    expect(watcher.current()).toEqual(GAME)
  })

  it('reports null for a pid that is neither us nor a known app', () => {
    const watcher = createFocusWatcher({
      native: { getFrontmostPid: () => 9999 },
      registry,
      selfApp: SELF,
      selfPids: [SELF.pid],
    })
    watcher.poll()
    expect(watcher.current()).toBeNull()
  })
})
