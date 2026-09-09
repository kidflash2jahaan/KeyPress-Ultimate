import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CHECKSUMS_ASSET_NAME,
  GITHUB_OWNER,
  GITHUB_REPO,
  LATEST_RELEASE_API_URL,
  RELEASES_PAGE_URL,
  USER_RECHECK_COOLDOWN_MS,
  buildMacSwapScript,
  createAccessibilityGrantTracker,
  createUpdater,
  evaluateAccessibilityAfterUpdate,
  macAppBundlePath,
  selectReleaseAsset,
  type FileSink,
  type HttpBody,
  type HttpResponse,
  type ReleaseAsset,
  type SpawnLike,
  type SpawnOptions,
  type UpdaterDeps,
  type UpdaterFs,
} from './updater'

// ---------------------------------------------------------------------------
// Fakes. Nothing here touches the network, the real filesystem, or a process.
// ---------------------------------------------------------------------------

interface ResponseSpec {
  status?: number
  body?: string | Uint8Array
  headers?: Record<string, string>
}

function chunked(bytes: Uint8Array, size: number): HttpBody {
  return {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.slice(offset, offset + size)
      }
    },
  }
}

function makeResponse(spec: ResponseSpec): HttpResponse {
  const status = spec.status ?? 200
  const bytes =
    typeof spec.body === 'string' ? new TextEncoder().encode(spec.body) : spec.body
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => spec.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => new TextDecoder().decode(bytes ?? new Uint8Array()),
    body: bytes === undefined ? null : chunked(bytes, 3),
  }
}

function makeFetch(routes: Record<string, ResponseSpec>): {
  fetch: UpdaterDeps['fetch']
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url)
      const spec = routes[url]
      if (spec === undefined) return makeResponse({ status: 404, body: 'not found' })
      return makeResponse(spec)
    },
  }
}

interface FakeFs {
  fs: UpdaterFs
  files: Map<string, Uint8Array>
  modes: Map<string, number | undefined>
  dirs: string[]
  removed: string[]
  text(path: string): string
}

function makeFs(opts: { unwritable?: string[]; entries?: Record<string, string[]> } = {}): FakeFs {
  const files = new Map<string, Uint8Array>()
  const modes = new Map<string, number | undefined>()
  const dirs: string[] = []
  const removed: string[] = []
  const unwritable = new Set(opts.unwritable ?? [])

  const fs: UpdaterFs = {
    async mkdir(dir: string) {
      dirs.push(dir)
    },
    async rm(target: string) {
      removed.push(target)
      for (const key of [...files.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) files.delete(key)
      }
    },
    async writeFile(file: string, contents: string, mode?: number) {
      files.set(file, new TextEncoder().encode(contents))
      modes.set(file, mode)
    },
    async readdir(dir: string) {
      return opts.entries?.[dir] ?? []
    },
    async open(file: string): Promise<FileSink> {
      const parts: Uint8Array[] = []
      files.set(file, new Uint8Array())
      return {
        async write(chunk: Uint8Array) {
          parts.push(chunk)
          const total = parts.reduce((sum, part) => sum + part.length, 0)
          const joined = new Uint8Array(total)
          let at = 0
          for (const part of parts) {
            joined.set(part, at)
            at += part.length
          }
          files.set(file, joined)
        },
        async close() {},
      }
    },
    canWrite(target: string) {
      return !unwritable.has(target)
    },
  }

  return {
    fs,
    files,
    modes,
    dirs,
    removed,
    text: (path: string) => new TextDecoder().decode(files.get(path) ?? new Uint8Array()),
  }
}

interface SpawnCall {
  cmd: string
  args: string[]
  opts: SpawnOptions | undefined
  unrefed: boolean
}

function makeSpawn(exitCode: (call: SpawnCall) => number | null = () => 0): {
  spawn: SpawnLike
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawn: SpawnLike = (cmd, args, opts) => {
    const call: SpawnCall = { cmd, args: [...args], opts, unrefed: false }
    calls.push(call)
    return {
      unref() {
        call.unrefed = true
      },
      onExit(cb) {
        queueMicrotask(() => cb(exitCode(call)))
      },
    }
  }
  return { spawn, calls }
}

/** Advances 250ms per read, so the progress throttle lets every chunk through. */
function tickingClock(startAt = 0, stepMs = 250): () => number {
  let value = startAt - stepMs
  return () => {
    value += stepMs
    return value
  }
}

const MAC_EXEC_PATH = '/Applications/KeyPress Ultimate.app/Contents/MacOS/KeyPress Ultimate'
const MAC_BUNDLE = '/Applications/KeyPress Ultimate.app'

function baseDeps(over: Partial<UpdaterDeps> = {}): Partial<UpdaterDeps> {
  return {
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '1.0.0',
    isPackaged: true,
    execPath: MAC_EXEC_PATH,
    env: {},
    pid: 4242,
    tempDir: '/tmp',
    now: tickingClock(),
    delay: async () => {},
    quit: () => {},
    log: () => {},
    ...over,
  }
}

const MAC_ZIP_SHA = 'a'.repeat(64)

function macAsset(over: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    name: 'KeyPress-Ultimate-1.2.0-universal-mac.zip',
    size: 120,
    browser_download_url: 'https://downloads.test/mac.zip',
    digest: `sha256:${MAC_ZIP_SHA}`,
    ...over,
  }
}

function winAsset(over: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    name: 'KeyPress-Ultimate-Setup-1.2.0-x64.exe',
    size: 90,
    browser_download_url: 'https://downloads.test/setup.exe',
    digest: `sha256:${'b'.repeat(64)}`,
    ...over,
  }
}

function winPortableAsset(over: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    name: 'KeyPress-Ultimate-1.2.0-x64-portable.exe',
    size: 88,
    browser_download_url: 'https://downloads.test/portable.exe',
    digest: `sha256:${'c'.repeat(64)}`,
    ...over,
  }
}

function releaseJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tag_name: 'v1.2.0',
    name: 'KeyPress Ultimate 1.2.0',
    body: 'Fixed the thing.\nAdded another thing.',
    draft: false,
    prerelease: false,
    published_at: '2026-09-01T00:00:00Z',
    html_url: 'https://github.com/kidflash2jahaan/keypress-ultimate/releases/tag/v1.2.0',
    assets: [macAsset(), winAsset()],
    ...over,
  })
}

// ---------------------------------------------------------------------------
// Repo constants
// ---------------------------------------------------------------------------

describe('updater constants', () => {
  it('points at the real repo and nothing else', () => {
    expect(GITHUB_OWNER).toBe('kidflash2jahaan')
    expect(GITHUB_REPO).toBe('keypress-ultimate')
    expect(LATEST_RELEASE_API_URL).toBe(
      'https://api.github.com/repos/kidflash2jahaan/keypress-ultimate/releases/latest',
    )
    expect(RELEASES_PAGE_URL).toBe(
      'https://github.com/kidflash2jahaan/keypress-ultimate/releases/latest',
    )
  })
})

// ---------------------------------------------------------------------------
// check(): the semver gate
// ---------------------------------------------------------------------------

describe('check() semver gate', () => {
  it('reports an update when the release tag is newer than the running version', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch, currentVersion: '1.0.0' }))

    const info = await updater.check()

    expect(info?.version).toBe('1.2.0')
    expect(info?.notes).toBe('Fixed the thing.\nAdded another thing.')
    expect(info?.assetName).toBe('KeyPress-Ultimate-1.2.0-universal-mac.zip')
    expect(info?.assetUrl).toBe('https://downloads.test/mac.zip')
    expect(info?.sizeBytes).toBe(120)
    expect(info?.sha256).toBe(MAC_ZIP_SHA)
  })

  it('returns null when the release tag equals the running version', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch, currentVersion: '1.2.0' }))

    expect(await updater.check()).toBeNull()
  })

  it('returns null when the release tag is older than the running version', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch, currentVersion: '2.0.0' }))

    expect(await updater.check()).toBeNull()
  })

  it('compares numerically, so 1.10.0 beats 1.9.0', async () => {
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: {
        body: releaseJson({
          tag_name: 'v1.10.0',
          assets: [macAsset({ name: 'KeyPress-Ultimate-1.10.0-universal-mac.zip' })],
        }),
      },
    })
    const updater = createUpdater(baseDeps({ fetch, currentVersion: '1.9.0' }))

    expect((await updater.check())?.version).toBe('1.10.0')
  })

  it('treats a prerelease tag as older than the same released version', async () => {
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: {
        body: releaseJson({
          tag_name: 'v1.2.0-beta.1',
          assets: [macAsset({ name: 'KeyPress-Ultimate-1.2.0-beta.1-universal-mac.zip' })],
        }),
      },
    })
    const updater = createUpdater(baseDeps({ fetch, currentVersion: '1.2.0' }))

    expect(await updater.check()).toBeNull()
  })

  it('ignores a garbage tag rather than offering an update to it', async () => {
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: { body: releaseJson({ tag_name: 'nightly' }) },
    })
    const updater = createUpdater(baseDeps({ fetch, currentVersion: '1.0.0' }))

    expect(await updater.check()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Asset selection
// ---------------------------------------------------------------------------

describe('selectReleaseAsset', () => {
  const assets: ReleaseAsset[] = [
    macAsset(),
    winAsset(),
    winPortableAsset(),
    { name: CHECKSUMS_ASSET_NAME, size: 200, browser_download_url: 'https://downloads.test/sums' },
    {
      name: 'KeyPress-Ultimate-1.2.0-universal.dmg',
      size: 400,
      browser_download_url: 'https://downloads.test/mac.dmg',
    },
  ]

  it('picks the universal mac zip on Apple Silicon, never the dmg', () => {
    const picked = selectReleaseAsset(assets, {
      platform: 'darwin',
      arch: 'arm64',
      version: '1.2.0',
      portable: false,
    })

    expect(picked?.name).toBe('KeyPress-Ultimate-1.2.0-universal-mac.zip')
  })

  it('picks the same universal mac zip on Intel', () => {
    const picked = selectReleaseAsset(assets, {
      platform: 'darwin',
      arch: 'x64',
      version: '1.2.0',
      portable: false,
    })

    expect(picked?.name).toBe('KeyPress-Ultimate-1.2.0-universal-mac.zip')
  })

  it('prefers an arch-specific mac zip when the release ships one', () => {
    const perArch: ReleaseAsset[] = [
      macAsset(),
      {
        name: 'KeyPress-Ultimate-1.2.0-arm64-mac.zip',
        size: 60,
        browser_download_url: 'https://downloads.test/mac-arm64.zip',
      },
    ]

    const picked = selectReleaseAsset(perArch, {
      platform: 'darwin',
      arch: 'arm64',
      version: '1.2.0',
      portable: false,
    })

    expect(picked?.name).toBe('KeyPress-Ultimate-1.2.0-arm64-mac.zip')
  })

  it('picks the NSIS installer on 64-bit Windows', () => {
    const picked = selectReleaseAsset(assets, {
      platform: 'win32',
      arch: 'x64',
      version: '1.2.0',
      portable: false,
    })

    expect(picked?.name).toBe('KeyPress-Ultimate-Setup-1.2.0-x64.exe')
  })

  it('falls back to the x64 installer on Windows on ARM, which has no native build', () => {
    const picked = selectReleaseAsset(assets, {
      platform: 'win32',
      arch: 'arm64',
      version: '1.2.0',
      portable: false,
    })

    expect(picked?.name).toBe('KeyPress-Ultimate-Setup-1.2.0-x64.exe')
  })

  it('picks the portable exe for a portable install so the manual path links the right file', () => {
    const picked = selectReleaseAsset(assets, {
      platform: 'win32',
      arch: 'x64',
      version: '1.2.0',
      portable: true,
    })

    expect(picked?.name).toBe('KeyPress-Ultimate-1.2.0-x64-portable.exe')
  })

  it('never hands a macOS asset to Windows', () => {
    const macOnly = [macAsset()]

    expect(
      selectReleaseAsset(macOnly, {
        platform: 'win32',
        arch: 'x64',
        version: '1.2.0',
        portable: false,
      }),
    ).toBeNull()
  })

  it('never hands a Windows asset to macOS', () => {
    const winOnly = [winAsset(), winPortableAsset()]

    expect(
      selectReleaseAsset(winOnly, {
        platform: 'darwin',
        arch: 'arm64',
        version: '1.2.0',
        portable: false,
      }),
    ).toBeNull()
  })

  it('returns null on an unsupported platform', () => {
    expect(
      selectReleaseAsset(assets, {
        platform: 'linux',
        arch: 'x64',
        version: '1.2.0',
        portable: false,
      }),
    ).toBeNull()
  })

  it('matches asset names case-insensitively', () => {
    const shouty = [macAsset({ name: 'KEYPRESS-ULTIMATE-1.2.0-UNIVERSAL-MAC.ZIP' })]

    expect(
      selectReleaseAsset(shouty, {
        platform: 'darwin',
        arch: 'arm64',
        version: '1.2.0',
        portable: false,
      })?.name,
    ).toBe('KEYPRESS-ULTIMATE-1.2.0-UNIVERSAL-MAC.ZIP')
  })
})

describe('check() asset selection', () => {
  it('selects the Windows installer when running on Windows', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(
      baseDeps({ fetch, platform: 'win32', arch: 'x64', execPath: 'C:\\app\\kpu.exe' }),
    )

    expect((await updater.check())?.assetName).toBe('KeyPress-Ultimate-Setup-1.2.0-x64.exe')
  })

  it('returns null when the release has no asset for this platform', async () => {
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: { body: releaseJson({ assets: [winAsset()] }) },
    })
    const updater = createUpdater(baseDeps({ fetch }))

    expect(await updater.check()).toBeNull()
  })

  it('explains the missing asset when the user asked for the check', async () => {
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: { body: releaseJson({ assets: [winAsset()] }) },
    })
    const updater = createUpdater(baseDeps({ fetch }))

    await expect(updater.check({ userInitiated: true })).rejects.toThrow(/no download/i)
  })
})

// ---------------------------------------------------------------------------
// check(): checksum resolution
// ---------------------------------------------------------------------------

describe('check() checksum resolution', () => {
  it("uses the asset's own digest field when GitHub supplies one", async () => {
    const { fetch, calls } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch }))

    expect((await updater.check())?.sha256).toBe(MAC_ZIP_SHA)
    expect(calls).toEqual([LATEST_RELEASE_API_URL])
  })

  it('falls back to SHA256SUMS.txt when the digest field is absent', async () => {
    const sums = `${'d'.repeat(64)}  KeyPress-Ultimate-1.2.0-universal-mac.zip\n${'e'.repeat(64)}  KeyPress-Ultimate-Setup-1.2.0-x64.exe\n`
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: {
        body: releaseJson({
          assets: [
            macAsset({ digest: null }),
            {
              name: CHECKSUMS_ASSET_NAME,
              size: 200,
              browser_download_url: 'https://downloads.test/sums',
            },
          ],
        }),
      },
      'https://downloads.test/sums': { body: sums },
    })
    const updater = createUpdater(baseDeps({ fetch }))

    expect((await updater.check())?.sha256).toBe('d'.repeat(64))
  })

  it('reads the binary-mode "*filename" form of sha256sum output', async () => {
    const sums = `${'f'.repeat(64)} *KeyPress-Ultimate-1.2.0-universal-mac.zip\n`
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: {
        body: releaseJson({
          assets: [
            macAsset({ digest: null }),
            {
              name: CHECKSUMS_ASSET_NAME,
              size: 200,
              browser_download_url: 'https://downloads.test/sums',
            },
          ],
        }),
      },
      'https://downloads.test/sums': { body: sums },
    })
    const updater = createUpdater(baseDeps({ fetch }))

    expect((await updater.check())?.sha256).toBe('f'.repeat(64))
  })

  it('reports the update with a null checksum when none can be resolved', async () => {
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: {
        body: releaseJson({ assets: [macAsset({ digest: null })] }),
      },
    })
    const updater = createUpdater(baseDeps({ fetch }))

    const info = await updater.check()

    expect(info?.version).toBe('1.2.0')
    expect(info?.sha256).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// check(): soft failures and caching
// ---------------------------------------------------------------------------

describe('check() failure handling', () => {
  it('is silent on a 403, because a shared school NAT burns the 60/hour budget', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { status: 403, body: 'rate limited' } })
    const log = vi.fn()
    const updater = createUpdater(baseDeps({ fetch, log }))

    expect(await updater.check()).toBeNull()
    expect(log).toHaveBeenCalled()
  })

  it('is silent on a 429', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { status: 429, body: 'slow down' } })
    const updater = createUpdater(baseDeps({ fetch }))

    expect(await updater.check()).toBeNull()
  })

  it('surfaces the rate limit only when the user asked for the check', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { status: 403, body: 'rate limited' } })
    const updater = createUpdater(baseDeps({ fetch }))

    await expect(updater.check({ userInitiated: true })).rejects.toThrow(/rate limit/i)
  })

  it('is silent when the network throws outright', async () => {
    const updater = createUpdater(
      baseDeps({
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND api.github.com')
        },
      }),
    )

    expect(await updater.check()).toBeNull()
  })

  it('is silent when GitHub returns something that is not JSON', async () => {
    const { fetch } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: '<html>nope</html>' } })
    const updater = createUpdater(baseDeps({ fetch }))

    expect(await updater.check()).toBeNull()
  })

  it('hits the network at most once per launch for automatic checks', async () => {
    const { fetch, calls } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch }))

    const first = await updater.check()
    const second = await updater.check()
    const third = await updater.check()

    expect(calls).toEqual([LATEST_RELEASE_API_URL])
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('does not retry after an automatic check failed, so a rate limit is not hammered', async () => {
    const { fetch, calls } = makeFetch({ [LATEST_RELEASE_API_URL]: { status: 403 } })
    const updater = createUpdater(baseDeps({ fetch }))

    await updater.check()
    await updater.check()

    expect(calls).toHaveLength(1)
  })

  it('skips the automatic check entirely in a dev build', async () => {
    const { fetch, calls } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch, isPackaged: false }))

    expect(await updater.check()).toBeNull()
    expect(calls).toEqual([])
  })

  it('still answers a user-initiated check in a dev build', async () => {
    const { fetch, calls } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch, isPackaged: false }))

    expect((await updater.check({ userInitiated: true }))?.version).toBe('1.2.0')
    expect(calls).toEqual([LATEST_RELEASE_API_URL])
  })

  it('throttles repeated user-initiated checks to one request per cooldown', async () => {
    let clock = 0
    const { fetch, calls } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch, now: () => clock }))

    await updater.check({ userInitiated: true })
    clock += USER_RECHECK_COOLDOWN_MS - 1
    await updater.check({ userInitiated: true })

    expect(calls).toHaveLength(1)

    clock += 2
    await updater.check({ userInitiated: true })

    expect(calls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// canSelfUpdate()
// ---------------------------------------------------------------------------

describe('canSelfUpdate()', () => {
  it('refuses in an unpackaged dev build', () => {
    const updater = createUpdater(baseDeps({ isPackaged: false }))

    const capability = updater.canSelfUpdate()

    expect(capability.ok).toBe(false)
    expect(capability.reason).toMatch(/development/i)
  })

  it('refuses from an App Translocation mount and says to move it to Applications', () => {
    const updater = createUpdater(
      baseDeps({
        execPath:
          '/private/var/folders/x1/T/AppTranslocation/9F3A/d/KeyPress Ultimate.app/Contents/MacOS/KeyPress Ultimate',
        fs: makeFs().fs,
      }),
    )

    const capability = updater.canSelfUpdate()

    expect(capability.ok).toBe(false)
    expect(capability.reason).toMatch(/Applications/)
  })

  it('refuses when the app bundle itself is not writable', () => {
    const updater = createUpdater(baseDeps({ fs: makeFs({ unwritable: [MAC_BUNDLE] }).fs }))

    const capability = updater.canSelfUpdate()

    expect(capability.ok).toBe(false)
    expect(capability.reason).toMatch(/permission/i)
  })

  it('refuses when the parent directory is not writable, as on a standard macOS account', () => {
    const updater = createUpdater(baseDeps({ fs: makeFs({ unwritable: ['/Applications'] }).fs }))

    const capability = updater.canSelfUpdate()

    expect(capability.ok).toBe(false)
    expect(capability.reason).toMatch(/\/Applications/)
  })

  it('refuses when the bundle path is not a .app at all', () => {
    const updater = createUpdater(baseDeps({ execPath: '/usr/local/bin/kpu', fs: makeFs().fs }))

    expect(updater.canSelfUpdate().ok).toBe(false)
  })

  it('allows a writable app bundle in /Applications', () => {
    const updater = createUpdater(baseDeps({ fs: makeFs().fs }))

    expect(updater.canSelfUpdate()).toEqual({ ok: true })
  })

  it('refuses the Windows portable build, which has no installer to run', () => {
    const updater = createUpdater(
      baseDeps({
        platform: 'win32',
        execPath: 'D:\\tools\\KeyPress-Ultimate-portable.exe',
        env: { PORTABLE_EXECUTABLE_FILE: 'D:\\tools\\KeyPress-Ultimate-portable.exe' },
      }),
    )

    const capability = updater.canSelfUpdate()

    expect(capability.ok).toBe(false)
    expect(capability.reason).toMatch(/portable/i)
  })

  it('allows an installed Windows build', () => {
    const updater = createUpdater(
      baseDeps({
        platform: 'win32',
        execPath: 'C:\\Users\\j\\AppData\\Local\\Programs\\keypress-ultimate\\KeyPress Ultimate.exe',
        env: {},
      }),
    )

    expect(updater.canSelfUpdate()).toEqual({ ok: true })
  })

  it('refuses an unsupported platform', () => {
    const updater = createUpdater(baseDeps({ platform: 'linux' }))

    expect(updater.canSelfUpdate().ok).toBe(false)
  })
})

describe('macAppBundlePath', () => {
  it('walks up from the executable to the bundle root', () => {
    expect(macAppBundlePath(MAC_EXEC_PATH)).toBe(MAC_BUNDLE)
  })
})

// ---------------------------------------------------------------------------
// download()
// ---------------------------------------------------------------------------

const PAYLOAD = 'the new build, pretend this is a zip'
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')

function downloadableInfo(sha256: string | null = PAYLOAD_SHA) {
  return {
    version: '1.2.0',
    notes: 'notes',
    url: 'https://github.com/kidflash2jahaan/keypress-ultimate/releases/tag/v1.2.0',
    assetName: 'KeyPress-Ultimate-1.2.0-universal-mac.zip',
    assetUrl: 'https://downloads.test/mac.zip',
    sha256,
    sizeBytes: PAYLOAD.length,
  }
}

describe('download()', () => {
  it('streams to a staging dir and returns the file path', async () => {
    const { fetch } = makeFetch({
      'https://downloads.test/mac.zip': {
        body: PAYLOAD,
        headers: { 'content-length': String(PAYLOAD.length) },
      },
    })
    const fsFake = makeFs()
    const updater = createUpdater(baseDeps({ fetch, fs: fsFake.fs }))

    const dest = await updater.download(downloadableInfo(), () => {})

    expect(dest).toBe('/tmp/keypress-ultimate-update-4242/KeyPress-Ultimate-1.2.0-universal-mac.zip')
    expect(fsFake.text(dest)).toBe(PAYLOAD)
    expect(fsFake.dirs).toContain('/tmp/keypress-ultimate-update-4242')
  })

  it('reports real byte progress that ends at 100 percent', async () => {
    const { fetch } = makeFetch({
      'https://downloads.test/mac.zip': {
        body: PAYLOAD,
        headers: { 'content-length': String(PAYLOAD.length) },
      },
    })
    const updater = createUpdater(baseDeps({ fetch, fs: makeFs().fs }))

    const seen: { percent: number; bytesDone: number; bytesTotal: number }[] = []
    await updater.download(downloadableInfo(), (p) => seen.push(p))

    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((p) => p.bytesTotal === PAYLOAD.length)).toBe(true)
    expect(seen.map((p) => p.bytesDone)).toEqual([...seen.map((p) => p.bytesDone)].sort((a, b) => a - b))
    const last = seen[seen.length - 1]
    expect(last?.percent).toBe(100)
    expect(last?.bytesDone).toBe(PAYLOAD.length)
  })

  it('deletes the file and throws when the checksum does not match', async () => {
    const { fetch } = makeFetch({ 'https://downloads.test/mac.zip': { body: PAYLOAD } })
    const fsFake = makeFs()
    const updater = createUpdater(baseDeps({ fetch, fs: fsFake.fs }))

    const wrong = downloadableInfo('9'.repeat(64))

    await expect(updater.download(wrong, () => {})).rejects.toThrow(/checksum/i)
    expect(fsFake.files.size).toBe(0)
    expect(fsFake.removed).toContain('/tmp/keypress-ultimate-update-4242')
  })

  it('names both hashes in the mismatch error so a bad mirror is diagnosable', async () => {
    const { fetch } = makeFetch({ 'https://downloads.test/mac.zip': { body: PAYLOAD } })
    const updater = createUpdater(baseDeps({ fetch, fs: makeFs().fs }))

    await expect(updater.download(downloadableInfo('9'.repeat(64)), () => {})).rejects.toThrow(
      new RegExp(`${'9'.repeat(64)}[\\s\\S]*${PAYLOAD_SHA}`),
    )
  })

  it('refuses to download at all when no checksum was published', async () => {
    const { fetch, calls } = makeFetch({ 'https://downloads.test/mac.zip': { body: PAYLOAD } })
    const updater = createUpdater(baseDeps({ fetch, fs: makeFs().fs }))

    await expect(updater.download(downloadableInfo(null), () => {})).rejects.toThrow(/SHA-256/)
    expect(calls).toEqual([])
  })

  it('throws on a failed HTTP status instead of writing a truncated file', async () => {
    const { fetch } = makeFetch({ 'https://downloads.test/mac.zip': { status: 502, body: 'bad' } })
    const fsFake = makeFs()
    const updater = createUpdater(baseDeps({ fetch, fs: fsFake.fs }))

    await expect(updater.download(downloadableInfo(), () => {})).rejects.toThrow(/502/)
  })

  it('clears any previous staging dir before writing', async () => {
    const { fetch } = makeFetch({ 'https://downloads.test/mac.zip': { body: PAYLOAD } })
    const fsFake = makeFs()
    const updater = createUpdater(baseDeps({ fetch, fs: fsFake.fs }))

    await updater.download(downloadableInfo(), () => {})

    expect(fsFake.removed[0]).toBe('/tmp/keypress-ultimate-update-4242')
  })

  it('accepts an uppercase published checksum', async () => {
    const { fetch } = makeFetch({ 'https://downloads.test/mac.zip': { body: PAYLOAD } })
    const updater = createUpdater(baseDeps({ fetch, fs: makeFs().fs }))

    await expect(
      updater.download(downloadableInfo(PAYLOAD_SHA.toUpperCase()), () => {}),
    ).resolves.toContain('KeyPress-Ultimate-1.2.0-universal-mac.zip')
  })
})

// ---------------------------------------------------------------------------
// The macOS swap script
// ---------------------------------------------------------------------------

describe('buildMacSwapScript', () => {
  const script = buildMacSwapScript()

  it('waits for our pid to exit before touching anything', () => {
    expect(script).toMatch(/kill -0 "\$PID"/)
    const waitAt = script.indexOf('kill -0')
    const moveAt = script.indexOf('mv "$TARGET"')
    expect(waitAt).toBeGreaterThan(-1)
    expect(moveAt).toBeGreaterThan(waitAt)
  })

  it('gives up rather than swapping under a live process that never quit', () => {
    expect(script).toMatch(/timed out/i)
  })

  it('moves the running bundle aside before anything is written, never overwriting in place', () => {
    const moveAt = script.indexOf('mv "$TARGET" "$BACKUP"')
    const dittoAt = script.indexOf('ditto "$STAGED" "$TARGET"')

    expect(moveAt).toBeGreaterThan(-1)
    expect(dittoAt).toBeGreaterThan(moveAt)
  })

  it('aborts if the bundle cannot be moved aside', () => {
    expect(script).toMatch(/if ! mv "\$TARGET" "\$BACKUP"/)
  })

  it('rolls the backup back when ditto fails, and still relaunches', () => {
    const rollback = script.slice(script.indexOf('else'))

    expect(rollback).toMatch(/rm -rf "\$TARGET"/)
    expect(rollback).toMatch(/mv "\$BACKUP" "\$TARGET"/)
    expect(script.lastIndexOf('open -n')).toBeGreaterThan(script.indexOf('mv "$BACKUP" "$TARGET"'))
  })

  it('deletes the backup only on the success branch', () => {
    const success = script.slice(
      script.indexOf('if /usr/bin/ditto'),
      script.indexOf('echo "ditto failed'),
    )

    expect(success).toMatch(/rm -rf "\$BACKUP"/)
  })

  it('uses ditto and never cp -r, which flattens framework symlinks', () => {
    expect(script).toContain('/usr/bin/ditto')
    expect(script).not.toContain('cp -r')
    expect(script).not.toContain('unzip')
  })

  it('logs to swap.log inside the staging dir', () => {
    expect(script).toContain('LOG="$WORK/swap.log"')
  })

  it('takes its paths as arguments, never interpolating them into the script body', () => {
    expect(script).not.toContain('/tmp/staging/extracted')
    expect(script).not.toContain(MAC_BUNDLE)
    expect(script).toContain('PID="$1"')
  })

  it('relaunches with open -n so the new bundle starts fresh', () => {
    expect(script).toMatch(/\/usr\/bin\/open -n "\$TARGET"/)
  })
})

// ---------------------------------------------------------------------------
// install()
// ---------------------------------------------------------------------------

describe('install() on Windows', () => {
  function winDeps(over: Partial<UpdaterDeps> = {}): Partial<UpdaterDeps> {
    return baseDeps({
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\Users\\j\\AppData\\Local\\Programs\\keypress-ultimate\\KeyPress Ultimate.exe',
      env: {},
      ...over,
    })
  }

  it('spawns the NSIS installer detached with /S --force-run, then quits', async () => {
    const { spawn, calls } = makeSpawn()
    const quit = vi.fn()
    const updater = createUpdater(winDeps({ spawn, quit, fs: makeFs().fs }))

    await updater.install(downloadableInfo(), 'C:\\Temp\\setup.exe')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toBe('C:\\Temp\\setup.exe')
    expect(calls[0]?.args).toEqual(['/S', '--force-run'])
    expect(calls[0]?.opts?.detached).toBe(true)
    expect(calls[0]?.unrefed).toBe(true)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('refuses to install into a portable build and never spawns anything', async () => {
    const { spawn, calls } = makeSpawn()
    const quit = vi.fn()
    const updater = createUpdater(
      winDeps({
        spawn,
        quit,
        env: { PORTABLE_EXECUTABLE_FILE: 'D:\\tools\\kpu.exe' },
      }),
    )

    await expect(updater.install(downloadableInfo(), 'C:\\Temp\\setup.exe')).rejects.toThrow(
      /portable/i,
    )
    expect(calls).toEqual([])
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('install() on macOS', () => {
  const STAGING = '/tmp/keypress-ultimate-update-4242'
  const ZIP = `${STAGING}/KeyPress-Ultimate-1.2.0-universal-mac.zip`

  function macInstallFs(): FakeFs {
    return makeFs({ entries: { [`${STAGING}/extracted`]: ['KeyPress Ultimate.app'] } })
  }

  it('extracts with ditto, verifies the payload, then hands off to a detached script', async () => {
    const { spawn, calls } = makeSpawn()
    const fsFake = macInstallFs()
    const quit = vi.fn()
    const updater = createUpdater(baseDeps({ spawn, quit, fs: fsFake.fs }))

    await updater.install(downloadableInfo(), ZIP)

    const cmds = calls.map((call) => `${call.cmd} ${call.args[0]}`)
    expect(cmds[0]).toBe('/usr/bin/ditto -x')
    expect(calls[0]?.args).toEqual(['-x', '-k', ZIP, `${STAGING}/extracted`])

    const codesign = calls.find((call) => call.cmd === '/usr/bin/codesign')
    expect(codesign?.args).toEqual([
      '--verify',
      '--deep',
      '--strict',
      `${STAGING}/extracted/KeyPress Ultimate.app`,
    ])

    const swap = calls.find((call) => call.cmd === '/bin/sh')
    expect(swap?.args).toEqual([
      `${STAGING}/swap.sh`,
      '4242',
      `${STAGING}/extracted/KeyPress Ultimate.app`,
      MAC_BUNDLE,
      STAGING,
    ])
    expect(swap?.opts?.detached).toBe(true)
    expect(swap?.unrefed).toBe(true)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('writes the swap script executable', async () => {
    const { spawn } = makeSpawn()
    const fsFake = macInstallFs()
    const updater = createUpdater(baseDeps({ spawn, fs: fsFake.fs }))

    await updater.install(downloadableInfo(), ZIP)

    expect(fsFake.modes.get(`${STAGING}/swap.sh`)).toBe(0o755)
    expect(fsFake.text(`${STAGING}/swap.sh`)).toContain('mv "$TARGET" "$BACKUP"')
  })

  it('refuses when codesign rejects the extracted bundle', async () => {
    const { spawn, calls } = makeSpawn((call) => (call.cmd === '/usr/bin/codesign' ? 1 : 0))
    const fsFake = macInstallFs()
    const quit = vi.fn()
    const updater = createUpdater(baseDeps({ spawn, quit, fs: fsFake.fs }))

    await expect(updater.install(downloadableInfo(), ZIP)).rejects.toThrow(/codesign/i)
    expect(calls.some((call) => call.cmd === '/bin/sh')).toBe(false)
    expect(quit).not.toHaveBeenCalled()
  })

  it('refuses when the archive holds no .app bundle', async () => {
    const { spawn, calls } = makeSpawn()
    const fsFake = makeFs({ entries: { [`${STAGING}/extracted`]: ['README.txt'] } })
    const updater = createUpdater(baseDeps({ spawn, fs: fsFake.fs }))

    await expect(updater.install(downloadableInfo(), ZIP)).rejects.toThrow(/\.app/)
    expect(calls.some((call) => call.cmd === '/bin/sh')).toBe(false)
  })

  it('tolerates a failing xattr strip, which is defensive rather than required', async () => {
    const { spawn, calls } = makeSpawn((call) => (call.cmd === '/usr/bin/xattr' ? 1 : 0))
    const fsFake = macInstallFs()
    const updater = createUpdater(baseDeps({ spawn, fs: fsFake.fs }))

    await updater.install(downloadableInfo(), ZIP)

    expect(calls.some((call) => call.cmd === '/bin/sh')).toBe(true)
  })

  it('refuses to install from a translocated mount and never spawns anything', async () => {
    const { spawn, calls } = makeSpawn()
    const updater = createUpdater(
      baseDeps({
        spawn,
        fs: makeFs().fs,
        execPath:
          '/private/var/folders/x1/T/AppTranslocation/9F3A/d/KeyPress Ultimate.app/Contents/MacOS/KeyPress Ultimate',
      }),
    )

    await expect(updater.install(downloadableInfo(), ZIP)).rejects.toThrow(/Applications/)
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Accessibility grant recovery after an update
// ---------------------------------------------------------------------------

describe('evaluateAccessibilityAfterUpdate', () => {
  it('says nothing when there is no previous record', () => {
    const status = evaluateAccessibilityAfterUpdate(null, { version: '1.2.0', granted: false })

    expect(status.needsRegrant).toBe(false)
  })

  it('says nothing when the version did not change', () => {
    const status = evaluateAccessibilityAfterUpdate(
      { version: '1.2.0', granted: true },
      { version: '1.2.0', granted: false },
    )

    expect(status.needsRegrant).toBe(false)
  })

  it('flags the grant that a version change took away', () => {
    const status = evaluateAccessibilityAfterUpdate(
      { version: '1.1.0', granted: true },
      { version: '1.2.0', granted: false },
    )

    expect(status.needsRegrant).toBe(true)
    expect(status.previousVersion).toBe('1.1.0')
    expect(status.currentVersion).toBe('1.2.0')
    expect(status.message).toMatch(/Accessibility/)
  })

  it('says nothing when the grant survived the update', () => {
    const status = evaluateAccessibilityAfterUpdate(
      { version: '1.1.0', granted: true },
      { version: '1.2.0', granted: true },
    )

    expect(status.needsRegrant).toBe(false)
  })

  it('says nothing when the permission was never granted in the first place', () => {
    const status = evaluateAccessibilityAfterUpdate(
      { version: '1.1.0', granted: false },
      { version: '1.2.0', granted: false },
    )

    expect(status.needsRegrant).toBe(false)
  })
})

describe('createAccessibilityGrantTracker', () => {
  it('records the current version and grant so the next launch can compare', () => {
    let stored: { version: string; granted: boolean } | null = null
    const tracker = createAccessibilityGrantTracker({
      currentVersion: '1.2.0',
      isGranted: () => true,
      read: () => stored,
      write: (snapshot) => {
        stored = snapshot
      },
    })

    tracker.check()

    expect(stored).toEqual({ version: '1.2.0', granted: true })
  })

  it('detects the grant lost across an update exactly once', () => {
    let stored: { version: string; granted: boolean } | null = {
      version: '1.1.0',
      granted: true,
    }
    const tracker = createAccessibilityGrantTracker({
      currentVersion: '1.2.0',
      isGranted: () => false,
      read: () => stored,
      write: (snapshot) => {
        stored = snapshot
      },
    })

    expect(tracker.check().needsRegrant).toBe(true)
    expect(tracker.check().needsRegrant).toBe(false)
  })

  it('never throws when the persisted snapshot cannot be read', () => {
    const tracker = createAccessibilityGrantTracker({
      currentVersion: '1.2.0',
      isGranted: () => true,
      read: () => {
        throw new Error('state.json is corrupt')
      },
      write: () => {},
    })

    expect(tracker.check().needsRegrant).toBe(false)
  })

  it('never throws when the snapshot cannot be written', () => {
    const tracker = createAccessibilityGrantTracker({
      currentVersion: '1.2.0',
      isGranted: () => true,
      read: () => null,
      write: () => {
        throw new Error('disk full')
      },
    })

    expect(() => tracker.check()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Gaps the sections above leave open
// ---------------------------------------------------------------------------

describe('updater edge cases', () => {
  it('constructs with no injected dependencies at all', () => {
    const updater = createUpdater()

    expect(typeof updater.check).toBe('function')
    expect(typeof updater.canSelfUpdate().ok).toBe('boolean')
  })

  it('offers the portable exe to a portable Windows install, so the link is right', async () => {
    const { fetch } = makeFetch({
      [LATEST_RELEASE_API_URL]: {
        body: releaseJson({ assets: [winAsset(), winPortableAsset()] }),
      },
    })
    const updater = createUpdater(
      baseDeps({
        fetch,
        platform: 'win32',
        arch: 'x64',
        execPath: 'D:\\tools\\KeyPress-Ultimate-portable.exe',
        env: { PORTABLE_EXECUTABLE_FILE: 'D:\\tools\\KeyPress-Ultimate-portable.exe' },
      }),
    )

    expect((await updater.check())?.assetName).toBe('KeyPress-Ultimate-1.2.0-x64-portable.exe')
  })

  it('does not re-check automatically after a user-initiated check already ran', async () => {
    const { fetch, calls } = makeFetch({ [LATEST_RELEASE_API_URL]: { body: releaseJson() } })
    const updater = createUpdater(baseDeps({ fetch }))

    const manual = await updater.check({ userInitiated: true })

    expect(await updater.check()).toBe(manual)
    expect(calls).toHaveLength(1)
  })

  it('throws rather than writing an empty file when the response has no body', async () => {
    const { fetch } = makeFetch({ 'https://downloads.test/mac.zip': { status: 200 } })
    const updater = createUpdater(baseDeps({ fetch, fs: makeFs().fs }))

    await expect(updater.download(downloadableInfo(), () => {})).rejects.toThrow(/body/i)
  })

  it('deletes the partial file when the stream fails mid-download', async () => {
    const fsFake = makeFs()
    const failing: HttpResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      body: {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('half of a ')
          throw new Error('connection reset by peer')
        },
      },
    }
    const updater = createUpdater(baseDeps({ fetch: async () => failing, fs: fsFake.fs }))

    await expect(updater.download(downloadableInfo(), () => {})).rejects.toThrow(/connection reset/)
    expect(fsFake.files.size).toBe(0)
    expect(fsFake.removed).toContain('/tmp/keypress-ultimate-update-4242')
  })

  it('refuses to install on an unsupported platform and spawns nothing', async () => {
    const { spawn, calls } = makeSpawn()
    const updater = createUpdater(baseDeps({ spawn, platform: 'linux', fs: makeFs().fs }))

    await expect(updater.install(downloadableInfo(), '/tmp/whatever.zip')).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('reports progress against the declared size, not the guessed one', async () => {
    const { fetch } = makeFetch({
      'https://downloads.test/mac.zip': {
        body: PAYLOAD,
        headers: { 'content-length': String(PAYLOAD.length) },
      },
    })
    // sizeBytes deliberately wrong: content-length is the authority.
    const updater = createUpdater(baseDeps({ fetch, fs: makeFs().fs }))
    const info = { ...downloadableInfo(), sizeBytes: 999_999 }

    const seen: number[] = []
    await updater.download(info, (p) => seen.push(p.bytesTotal))

    expect(new Set(seen)).toEqual(new Set([PAYLOAD.length]))
  })
})
