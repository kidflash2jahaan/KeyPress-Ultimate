import { describe, expect, it, vi } from 'vitest'
import {
  ACCESSIBILITY_SETTINGS_URL,
  PERMISSION_POLL_MS,
  createMemoryPromptState,
  createPermissions,
} from './permissions'

/** Records exactly how Electron's isTrustedAccessibilityClient was called. */
function fakeTrust(granted: boolean): {
  isTrusted: (prompt: boolean) => boolean
  prompts: boolean[]
  set: (value: boolean) => void
} {
  let value = granted
  const prompts: boolean[] = []
  return {
    prompts,
    set(next: boolean) {
      value = next
    },
    isTrusted(prompt: boolean): boolean {
      prompts.push(prompt)
      return value
    },
  }
}

describe('permissions', () => {
  it('exposes the Accessibility deep link verbatim and never opens it itself', () => {
    expect(ACCESSIBILITY_SETTINGS_URL).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    )

    const permissions = createPermissions({
      platform: 'darwin',
      isTrusted: () => false,
    })

    expect(permissions.status().settingsUrl).toBe(ACCESSIBILITY_SETTINGS_URL)
  })

  it('polls once a second for the whole session so a mid-hold revocation is seen', () => {
    expect(PERMISSION_POLL_MS).toBe(1000)
  })

  it('reports no permission requirement on Windows without consulting macOS APIs', () => {
    const isTrusted = vi.fn(() => false)
    const permissions = createPermissions({ platform: 'win32', isTrusted })

    const status = permissions.status()

    expect(status.needsPermission).toBe(false)
    expect(status.hasPermission).toBe(true)
    expect(status.promptWasAlreadyUsed).toBe(false)
    expect(isTrusted).not.toHaveBeenCalled()
  })

  it('request() on Windows resolves granted without prompting', async () => {
    const isTrusted = vi.fn(() => false)
    const permissions = createPermissions({ platform: 'win32', isTrusted })

    expect((await permissions.request()).hasPermission).toBe(true)
    expect(isTrusted).not.toHaveBeenCalled()
  })

  it('reports granted Accessibility on macOS without prompting', () => {
    const trust = fakeTrust(true)
    const permissions = createPermissions({ platform: 'darwin', isTrusted: trust.isTrusted })

    const status = permissions.status()

    expect(status.needsPermission).toBe(true)
    expect(status.hasPermission).toBe(true)
    expect(trust.prompts).toEqual([false])
  })

  it('prompts exactly once, then reports that the prompt is spent', async () => {
    const trust = fakeTrust(false)
    const permissions = createPermissions({ platform: 'darwin', isTrusted: trust.isTrusted })

    expect(permissions.status().promptWasAlreadyUsed).toBe(false)

    const first = await permissions.request()
    expect(first.hasPermission).toBe(false)
    expect(first.promptWasAlreadyUsed).toBe(true)
    expect(trust.prompts).toContain(true)

    const promptsAfterFirst = trust.prompts.filter((p) => p).length
    const second = await permissions.request()
    expect(second.promptWasAlreadyUsed).toBe(true)
    // The system dialog never reappears for an identity that already answered,
    // so asking again would leave the UI waiting on nothing.
    expect(trust.prompts.filter((p) => p).length).toBe(promptsAfterFirst)
  })

  it('remembers across launches that the prompt was already spent', async () => {
    const promptState = createMemoryPromptState()
    const first = createPermissions({
      platform: 'darwin',
      isTrusted: () => false,
      promptState,
    })
    await first.request()

    const prompts: boolean[] = []
    const relaunched = createPermissions({
      platform: 'darwin',
      isTrusted: (prompt: boolean) => {
        prompts.push(prompt)
        return false
      },
      promptState,
    })

    expect(relaunched.status().promptWasAlreadyUsed).toBe(true)
    await relaunched.request()
    expect(prompts.every((p) => p === false)).toBe(true)
  })

  it('does not prompt when permission is already granted', async () => {
    const trust = fakeTrust(true)
    const permissions = createPermissions({ platform: 'darwin', isTrusted: trust.isTrusted })

    await permissions.request()

    expect(trust.prompts.every((p) => p === false)).toBe(true)
  })

  it('emits a change event when permission is revoked mid-session', () => {
    const trust = fakeTrust(true)
    const permissions = createPermissions({ platform: 'darwin', isTrusted: trust.isTrusted })
    const seen: boolean[] = []
    permissions.onChange((status) => seen.push(status.hasPermission))

    permissions.check()
    permissions.check()
    trust.set(false)
    permissions.check()
    permissions.check()

    expect(seen).toEqual([false])
    expect(permissions.status().hasPermission).toBe(false)
  })

  it('emits when permission is granted while the app waits on the gate', () => {
    const trust = fakeTrust(false)
    const permissions = createPermissions({ platform: 'darwin', isTrusted: trust.isTrusted })
    const seen: boolean[] = []
    permissions.onChange((status) => seen.push(status.hasPermission))

    permissions.check()
    trust.set(true)
    permissions.check()

    expect(seen).toEqual([true])
  })

  it('start polls on the 1s interval and stop ends it', () => {
    vi.useFakeTimers()
    try {
      const isTrusted = vi.fn(() => true)
      const permissions = createPermissions({ platform: 'darwin', isTrusted })

      permissions.start()
      const afterStart = isTrusted.mock.calls.length
      vi.advanceTimersByTime(PERMISSION_POLL_MS * 3)
      expect(isTrusted.mock.calls.length).toBe(afterStart + 3)

      permissions.stop()
      vi.advanceTimersByTime(PERMISSION_POLL_MS * 5)
      expect(isTrusted.mock.calls.length).toBe(afterStart + 3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll on Windows, where there is nothing to revoke', () => {
    vi.useFakeTimers()
    try {
      const isTrusted = vi.fn(() => false)
      const permissions = createPermissions({ platform: 'win32', isTrusted })

      permissions.start()
      vi.advanceTimersByTime(PERMISSION_POLL_MS * 10)
      permissions.stop()

      expect(isTrusted).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives a throwing trust check by reporting no permission', () => {
    const permissions = createPermissions({
      platform: 'darwin',
      isTrusted: () => {
        throw new Error('systemPreferences unavailable')
      },
    })

    expect(() => permissions.check()).not.toThrow()
    expect(permissions.status().hasPermission).toBe(false)
  })

  it('unsubscribes a change listener', () => {
    const trust = fakeTrust(false)
    const permissions = createPermissions({ platform: 'darwin', isTrusted: trust.isTrusted })
    const seen: boolean[] = []
    const off = permissions.onChange((s) => seen.push(s.hasPermission))

    trust.set(true)
    permissions.check()
    off()
    trust.set(false)
    permissions.check()

    expect(seen).toEqual([true])
  })
})
