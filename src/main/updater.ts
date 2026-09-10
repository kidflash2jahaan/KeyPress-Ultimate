/**
 * KeyPress Ultimate's auto-updater.
 *
 * Why this is hand-written instead of `electron-updater`:
 *
 *   electron-updater's macOS path does not install anything itself. It downloads
 *   the .zip, starts a localhost proxy and hands the feed to Squirrel.Mac, which
 *   does `SecCodeCopySelf()` on the running app, reads its designated
 *   requirement, and validates the new bundle against it. With no signature at
 *   all the first step fails outright; with an ad-hoc signature the designated
 *   requirement is literally `cdhash H"<slice>"`, which by construction no other
 *   build can satisfy. Without a paid Apple Developer ID certificate that path is
 *   dead. The Windows NSIS path does work unsigned, but shipping electron-updater
 *   on Windows only would mean two different update experiences.
 *
 * So: one updater, here, behaving identically on both platforms.
 *
 * Everything the updater touches from the outside world — the network, the
 * filesystem, child processes, the clock, `app` — arrives through `UpdaterDeps`.
 * The module imports neither `electron` nor anything else with a side effect at
 * load time, which is what makes it testable without a running app.
 *
 * Wiring (main process):
 *
 *   const updater = createUpdater({
 *     currentVersion: app.getVersion(),
 *     isPackaged: app.isPackaged,
 *     tempDir: app.getPath('temp'),
 *     quit: () => app.quit(),
 *   })
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { isNewer } from '@shared/semver'
import type { UpdateInfo } from '@shared/types'

// ---------------------------------------------------------------------------
// Repo constants
// ---------------------------------------------------------------------------

export const GITHUB_OWNER = 'kidflash2jahaan'
export const GITHUB_REPO = 'KeyPress-Ultimate'

export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

/** Where every refusal path sends the user. Always the same page. */
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

/** The release workflow uploads this next to the installers. */
export const CHECKSUMS_ASSET_NAME = 'SHA256SUMS.txt'

/**
 * The unauthenticated GitHub API allows 60 requests per hour per IP, and a
 * school or office NAT shares that budget across everyone behind it. One
 * automatic check per launch plus a throttled manual check keeps us far under
 * it even on a shared address.
 */
export const USER_RECHECK_COOLDOWN_MS = 60_000

/** Progress events are coalesced to this interval so the UI is not flooded. */
const PROGRESS_THROTTLE_MS = 100

/** Let the installer or swap script take a handle before we release ours. */
const QUIT_GRACE_MS = 300

const GITHUB_API_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': `KeyPressUltimate (+https://github.com/${GITHUB_OWNER}/${GITHUB_REPO})`,
}

// ---------------------------------------------------------------------------
// Injected surfaces
// ---------------------------------------------------------------------------

/** A response body, consumed as a stream of chunks so progress is real. */
export type HttpBody = AsyncIterable<Uint8Array>

export interface HttpResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  body: HttpBody | null
}

export interface HttpRequestInit {
  headers?: Record<string, string>
  redirect?: 'follow'
}

export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>

/** The write end of one staged file. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface UpdaterFs {
  mkdir(dir: string): Promise<void>
  /** Recursive and forgiving: a missing path is not an error. */
  rm(target: string): Promise<void>
  writeFile(file: string, contents: string, mode?: number): Promise<void>
  readdir(dir: string): Promise<string[]>
  open(file: string): Promise<FileSink>
  canWrite(target: string): boolean
}

export interface SpawnOptions {
  detached?: boolean
  stdio?: 'ignore'
  windowsHide?: boolean
}

export interface SpawnedProcess {
  unref(): void
  onExit(callback: (code: number | null) => void): void
}

export type SpawnLike = (cmd: string, args: string[], opts?: SpawnOptions) => SpawnedProcess

export interface UpdaterDeps {
  platform: NodeJS.Platform | string
  arch: string
  /** `app.getVersion()`. */
  currentVersion: string
  /** `app.isPackaged`. A dev build never updates itself automatically. */
  isPackaged: boolean
  /** `process.execPath`. On macOS the app bundle is derived from it. */
  execPath: string
  env: Record<string, string | undefined>
  pid: number
  /** `app.getPath('temp')`. Staging happens under it. */
  tempDir: string
  now: () => number
  delay: (ms: number) => Promise<void>
  /** `() => app.quit()`. Called only once an installer has been handed off. */
  quit: () => void
  log: (message: string, detail?: unknown) => void
  fetch: HttpFetch
  fs: UpdaterFs
  spawn: SpawnLike
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  percent: number
  bytesDone: number
  bytesTotal: number
}

export interface SelfUpdateCapability {
  ok: boolean
  reason?: string
}

export interface Updater {
  /**
   * Resolves to the newer release, or null when there is nothing to install.
   * Automatic checks are silent about every failure and run at most once per
   * launch; a user-initiated check rejects so the UI can say what went wrong.
   */
  check(opts?: { userInitiated?: boolean }): Promise<UpdateInfo | null>
  /**
   * Streams the asset to a staging dir and verifies its SHA-256.
   *
   * The completed (100%) progress event is emitted on exactly one path: after
   * the hash of the bytes on disk matched the published SHA-256. Everything
   * emitted while the body is still arriving stops short of complete, so a
   * caller may treat "progress reached the total" as proof of verification.
   * Every failure rejects; nothing partial is ever left behind.
   */
  download(info: UpdateInfo, onProgress: (p: DownloadProgress) => void): Promise<string>
  /** Hands the swap to a detached process, then quits. */
  install(info: UpdateInfo, downloadedPath: string): Promise<void>
  canSelfUpdate(): SelfUpdateCapability
}

/** One release asset, as GitHub's REST API returns it. */
export interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  /** GitHub returns `"sha256:<hex>"`; older releases may have nothing. */
  digest?: string | null
}

interface ParsedRelease {
  tagName: string
  name: string
  body: string
  htmlUrl: string
  assets: ReleaseAsset[]
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

type PlatformPath = typeof nodePath.posix

function pathFor(platform: string): PlatformPath {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix
}

/** `.../Foo.app/Contents/MacOS/Foo` -> `.../Foo.app` */
export function macAppBundlePath(execPath: string): string {
  return nodePath.posix.resolve(execPath, '..', '..', '..')
}

/** `v1.2.3` / `1.2.3` -> `1.2.3`; anything that is not semver -> null. */
export function versionFromTag(tag: string): string | null {
  const trimmed = tag.trim()
  const withoutPrefix = /^[vV]/.test(trimmed) ? trimmed.slice(1) : trimmed
  const ok = /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(withoutPrefix)
  return ok ? withoutPrefix : null
}

function platformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return platform
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseAsset(value: unknown): ReleaseAsset | null {
  const record = asRecord(value)
  if (!record) return null
  const name = asString(record.name)
  const url = asString(record.browser_download_url)
  if (name === null || url === null) return null
  const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0
  return { name, size, browser_download_url: url, digest: asString(record.digest) }
}

function parseRelease(rawJson: string): ParsedRelease | null {
  const record = asRecord(JSON.parse(rawJson) as unknown)
  if (!record) return null
  const tagName = asString(record.tag_name)
  if (tagName === null) return null
  const assets = Array.isArray(record.assets)
    ? record.assets.map(parseAsset).filter((asset): asset is ReleaseAsset => asset !== null)
    : []
  return {
    tagName,
    name: asString(record.name) ?? tagName,
    body: asString(record.body) ?? '',
    htmlUrl: asString(record.html_url) ?? RELEASES_PAGE_URL,
    assets,
  }
}

// ---------------------------------------------------------------------------
// Asset selection
// ---------------------------------------------------------------------------

export interface AssetSelector {
  platform: NodeJS.Platform | string
  arch: string
  version: string
  /** True for the Windows portable .exe, which has no installer to run. */
  portable: boolean
}

/**
 * The names here must match electron-builder's `artifactName` templates exactly.
 * Matching is case-insensitive and never falls back across platforms: handing a
 * Windows .exe to macOS is worse than reporting no download at all.
 *
 * The macOS .dmg is deliberately not a candidate. It is the first-install
 * format; the in-app update path consumes the .zip, which `ditto` can expand
 * without mounting anything.
 */
export function selectReleaseAsset(
  assets: readonly ReleaseAsset[],
  selector: AssetSelector,
): ReleaseAsset | null {
  const { version } = selector
  const candidates: string[] = []

  if (selector.platform === 'darwin') {
    // A per-arch build wins when a release ships one; otherwise the universal
    // zip serves both Apple Silicon and Intel.
    if (selector.arch === 'arm64' || selector.arch === 'x64') {
      candidates.push(`KeyPress-Ultimate-${version}-${selector.arch}-mac.zip`)
    }
    candidates.push(`KeyPress-Ultimate-${version}-universal-mac.zip`)
  } else if (selector.platform === 'win32') {
    // There is no native ARM64 Windows build; x64 runs under emulation.
    candidates.push(
      selector.portable
        ? `KeyPress-Ultimate-${version}-x64-portable.exe`
        : `KeyPress-Ultimate-Setup-${version}-x64.exe`,
    )
  } else {
    return null
  }

  for (const candidate of candidates) {
    const wanted = candidate.toLowerCase()
    const found = assets.find((asset) => asset.name.toLowerCase() === wanted)
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// The macOS swap script
// ---------------------------------------------------------------------------

/**
 * Overwriting the running executable in place gets the process SIGKILLed by the
 * kernel with "Code Signature Invalid", so the swap cannot happen inside this
 * process at all. This script runs detached: it waits for our pid to exit, moves
 * the bundle aside (a rename on the same volume, atomic), copies the new one in,
 * and relaunches. If the copy fails it puts the old bundle back and relaunches
 * that instead, so a failed update can never leave the user with no app.
 *
 * `ditto` is Apple's own tool for this and is the only correct choice: it
 * preserves the symlinks inside .framework bundles, extended attributes and
 * ACLs. `cp -r` flattens framework symlinks and breaks the code signature seal.
 *
 * Every path arrives as an argument. Nothing is interpolated into the body, so
 * an app name with a space (which ours has) cannot break the script.
 */
export function buildMacSwapScript(): string {
  return `#!/bin/sh
# KeyPress Ultimate in-place update.
# Args: <pid> <staged.app> <target.app> <workdir>
PID="$1"; STAGED="$2"; TARGET="$3"; WORK="$4"
BACKUP="$TARGET.kpu-old"
LOG="$WORK/swap.log"
exec >>"$LOG" 2>&1
echo "--- $(date) waiting for pid $PID to exit ---"
i=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 0.2
  i=$((i+1))
  if [ "$i" -gt 150 ]; then
    echo "timed out waiting for the app to quit; leaving the install untouched"
    exit 1
  fi
done
sleep 0.3
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  echo "could not move the running bundle aside; nothing was changed"
  exit 1
fi
if /usr/bin/ditto "$STAGED" "$TARGET"; then
  /usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
  rm -rf "$BACKUP"
  echo "swap ok"
else
  echo "ditto failed; rolling back"
  rm -rf "$TARGET"
  mv "$BACKUP" "$TARGET"
fi
/usr/bin/open -n "$TARGET"
rm -rf "$WORK/extracted"
`
}

// ---------------------------------------------------------------------------
// Accessibility grant recovery
// ---------------------------------------------------------------------------

export interface AccessibilitySnapshot {
  version: string
  granted: boolean
}

export interface AccessibilityRecovery {
  needsRegrant: boolean
  previousVersion: string | null
  currentVersion: string
  message: string | null
}

const REGRANT_MESSAGE =
  'KeyPress Ultimate updated, and macOS dropped its Accessibility permission. ' +
  'Open System Settings > Privacy & Security > Accessibility and turn KeyPress ' +
  'Ultimate off and back on. This happens because the app is not signed with a ' +
  'paid Apple certificate, so macOS treats each build as a different app.'

/**
 * Detects the one case worth interrupting the user for: the permission was
 * granted before an update and is gone after it. Anything else (first launch, no
 * version change, never granted, still granted) stays quiet.
 */
export function evaluateAccessibilityAfterUpdate(
  previous: AccessibilitySnapshot | null,
  current: AccessibilitySnapshot,
): AccessibilityRecovery {
  const lost =
    previous !== null &&
    previous.version !== current.version &&
    previous.granted &&
    !current.granted

  return {
    needsRegrant: lost,
    previousVersion: previous?.version ?? null,
    currentVersion: current.version,
    message: lost ? REGRANT_MESSAGE : null,
  }
}

export interface AccessibilityGrantTrackerDeps {
  currentVersion: string
  isGranted: () => boolean
  read: () => AccessibilitySnapshot | null
  write: (snapshot: AccessibilitySnapshot) => void
}

export interface AccessibilityGrantTracker {
  /** Compares against the last launch, then records the current state. */
  check(): AccessibilityRecovery
}

/**
 * Call once per launch, after the permission layer is up. Persisting the
 * snapshot on every check is what makes the notice fire exactly once: the second
 * check sees the same version and stays quiet.
 *
 * Every failure is swallowed. A corrupt or unwritable state file must never stop
 * the app from starting.
 */
export function createAccessibilityGrantTracker(
  deps: AccessibilityGrantTrackerDeps,
): AccessibilityGrantTracker {
  return {
    check(): AccessibilityRecovery {
      let previous: AccessibilitySnapshot | null
      try {
        previous = deps.read()
      } catch {
        previous = null
      }

      let granted: boolean
      try {
        granted = deps.isGranted() === true
      } catch {
        granted = false
      }

      const current: AccessibilitySnapshot = { version: deps.currentVersion, granted }
      const status = evaluateAccessibilityAfterUpdate(previous, current)

      try {
        deps.write(current)
      } catch {
        // Nothing to do: the worst case is that the notice repeats next launch.
      }

      return status
    },
  }
}

// ---------------------------------------------------------------------------
// Default (production) dependencies
// ---------------------------------------------------------------------------

async function* streamOf(body: unknown): AsyncGenerator<Uint8Array> {
  if (body === null || body === undefined) return

  const iterable = body as { [Symbol.asyncIterator]?: unknown }
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body as AsyncIterable<Uint8Array>) yield chunk
    return
  }

  const streamed = body as {
    getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void }
  }
  const reader = streamed.getReader?.()
  if (!reader) return
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Uses the global fetch. The main process may prefer Electron's `net.fetch`
 * (Chromium's stack, so system proxies and certificates are honoured); it can
 * pass one in as `deps.fetch` without this module importing electron.
 */
const defaultFetch: HttpFetch = async (url, init) => {
  const globalFetch = (globalThis as { fetch?: (input: string, options?: unknown) => Promise<unknown> })
    .fetch
  if (!globalFetch) throw new Error('No fetch implementation is available.')

  const response = (await globalFetch(url, {
    headers: init?.headers,
    redirect: init?.redirect ?? 'follow',
  })) as {
    ok: boolean
    status: number
    headers: { get(name: string): string | null }
    text(): Promise<string>
    body: unknown
  }

  const body = response.body
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: () => response.text(),
    body: body === null || body === undefined ? null : { [Symbol.asyncIterator]: () => streamOf(body) },
  }
}

const defaultFs: UpdaterFs = {
  async mkdir(dir) {
    await fsp.mkdir(dir, { recursive: true })
  },
  async rm(target) {
    await fsp.rm(target, { recursive: true, force: true })
  },
  async writeFile(file, contents, mode) {
    await fsp.writeFile(file, contents, mode === undefined ? undefined : { mode })
  },
  async readdir(dir) {
    return fsp.readdir(dir)
  },
  async open(file) {
    const handle = await fsp.open(file, 'w')
    return {
      async write(chunk) {
        await handle.write(chunk)
      },
      async close() {
        await handle.close()
      },
    }
  },
  canWrite(target) {
    try {
      accessSync(target, fsConstants.W_OK)
      return true
    } catch {
      return false
    }
  },
}

const defaultSpawn: SpawnLike = (cmd, args, opts) => {
  const child = nodeSpawn(cmd, args, {
    detached: opts?.detached ?? false,
    stdio: 'ignore',
    windowsHide: opts?.windowsHide ?? true,
  })
  return {
    unref() {
      child.unref()
    },
    onExit(callback) {
      let done = false
      const once = (code: number | null): void => {
        if (done) return
        done = true
        callback(code)
      }
      child.once('error', () => once(null))
      child.once('close', (code) => once(code))
    },
  }
}

/**
 * Only a fallback. The main process should pass `app.isPackaged`; this exists so
 * a partially wired updater errs towards "development build" and refuses to
 * touch anything.
 */
function looksPackaged(execPath: string, platform: string): boolean {
  const base = pathFor(platform).basename(execPath).toLowerCase()
  return base !== 'electron' && base !== 'electron.exe'
}

// ---------------------------------------------------------------------------
// The updater
// ---------------------------------------------------------------------------

export function createUpdater(overrides: Partial<UpdaterDeps> = {}): Updater {
  const platform = overrides.platform ?? process.platform
  const execPath = overrides.execPath ?? process.execPath

  const deps: UpdaterDeps = {
    platform,
    arch: overrides.arch ?? process.arch,
    currentVersion: overrides.currentVersion ?? '0.0.0',
    isPackaged: overrides.isPackaged ?? looksPackaged(execPath, platform),
    execPath,
    env: overrides.env ?? process.env,
    pid: overrides.pid ?? process.pid,
    tempDir: overrides.tempDir ?? tmpdir(),
    now: overrides.now ?? Date.now,
    delay: overrides.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    quit: overrides.quit ?? (() => {}),
    log: overrides.log ?? (() => {}),
    fetch: overrides.fetch ?? defaultFetch,
    fs: overrides.fs ?? defaultFs,
    spawn: overrides.spawn ?? defaultSpawn,
  }

  const paths = pathFor(deps.platform)

  /** Set once a check has been attempted, successfully or not. */
  let attempted = false
  let cached: UpdateInfo | null = null
  let lastAttemptAt = 0

  function isPortableWindows(): boolean {
    if (deps.platform !== 'win32') return false
    const marker = deps.env.PORTABLE_EXECUTABLE_FILE
    return typeof marker === 'string' && marker.length > 0
  }

  function stagingDir(): string {
    return paths.join(deps.tempDir, `keypress-ultimate-update-${deps.pid}`)
  }

  // -- check ----------------------------------------------------------------

  async function resolveSha256(
    asset: ReleaseAsset,
    assets: readonly ReleaseAsset[],
  ): Promise<string | null> {
    // GitHub computes this itself on every release asset. Preferring it means
    // one request, and no trust in a file the release author uploaded by hand.
    const digest = asset.digest
    if (typeof digest === 'string' && digest.toLowerCase().startsWith('sha256:')) {
      return digest.slice('sha256:'.length).trim().toLowerCase()
    }

    const sums = assets.find((candidate) => candidate.name === CHECKSUMS_ASSET_NAME)
    if (!sums) return null

    try {
      const response = await deps.fetch(sums.browser_download_url, {
        headers: { 'User-Agent': GITHUB_API_HEADERS['User-Agent'] ?? 'KeyPressUltimate' },
        redirect: 'follow',
      })
      if (!response.ok) return null
      const text = await response.text()
      const wanted = asset.name.toLowerCase()
      for (const line of text.split(/\r?\n/)) {
        // sha256sum output: "<hex>  <name>", or "<hex> *<name>" in binary mode.
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim())
        if (!match) continue
        const hex = match[1]
        const named = match[2]
        if (hex === undefined || named === undefined) continue
        if (nodePath.posix.basename(named.trim()).toLowerCase() === wanted) return hex.toLowerCase()
      }
      return null
    } catch (error) {
      deps.log('Could not read the published checksums.', error)
      return null
    }
  }

  async function fetchLatest(): Promise<UpdateInfo | null> {
    const response = await deps.fetch(LATEST_RELEASE_API_URL, { headers: GITHUB_API_HEADERS })

    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `GitHub's release API is rate limited right now (HTTP ${response.status}). ` +
          'Unauthenticated checks share a budget of 60 an hour per network, so a ' +
          'school or office connection can use them up. Try again later, or open ' +
          'the Releases page.',
      )
    }
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status} for the latest release.`)
    }

    const release = parseRelease(await response.text())
    if (!release) throw new Error('GitHub returned a release in an unexpected shape.')

    const version = versionFromTag(release.tagName)
    if (version === null) {
      deps.log(`Ignoring release tag "${release.tagName}": not a version number.`)
      return null
    }
    if (!isNewer(version, deps.currentVersion)) return null

    const asset = selectReleaseAsset(release.assets, {
      platform: deps.platform,
      arch: deps.arch,
      version,
      portable: isPortableWindows(),
    })
    if (!asset) {
      throw new Error(
        `Release ${version} has no download for ${platformLabel(String(deps.platform))} (${deps.arch}).`,
      )
    }

    const sha256 = await resolveSha256(asset, release.assets)

    return {
      version,
      notes: release.body,
      url: release.htmlUrl,
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      sha256,
      sizeBytes: asset.size,
    }
  }

  async function check(opts: { userInitiated?: boolean } = {}): Promise<UpdateInfo | null> {
    const userInitiated = opts.userInitiated === true

    if (!userInitiated) {
      // A dev build never phones home, and the automatic check runs once per
      // launch whatever its outcome, so a rate limit is never hammered.
      if (!deps.isPackaged) return null
      if (attempted) return cached
    } else if (attempted && deps.now() - lastAttemptAt < USER_RECHECK_COOLDOWN_MS) {
      return cached
    }

    attempted = true
    lastAttemptAt = deps.now()

    try {
      cached = await fetchLatest()
      return cached
    } catch (error) {
      cached = null
      deps.log('Update check failed.', error)
      if (userInitiated) throw error
      return null
    }
  }

  // -- capability -----------------------------------------------------------

  function canSelfUpdate(): SelfUpdateCapability {
    if (!deps.isPackaged) {
      return {
        ok: false,
        reason: 'This is a development build, so it does not update itself.',
      }
    }

    if (deps.platform === 'win32') {
      if (isPortableWindows()) {
        return {
          ok: false,
          reason:
            'This is the portable build, which has no installer to update. ' +
            'Download the new portable .exe and replace this one.',
        }
      }
      return { ok: true }
    }

    if (deps.platform !== 'darwin') {
      return {
        ok: false,
        reason: `Automatic updates are not available on ${platformLabel(String(deps.platform))}.`,
      }
    }

    const bundle = macAppBundlePath(deps.execPath)

    // Gatekeeper's App Translocation: a quarantined app opened from ~/Downloads
    // runs from a randomised read-only mount, so nothing can be written and the
    // real path is deliberately hidden. Moving it is the only fix.
    if (bundle.includes('/AppTranslocation/')) {
      return {
        ok: false,
        reason:
          'KeyPress Ultimate is running from a temporary read-only location. ' +
          'Move it to your Applications folder, reopen it, then update.',
      }
    }

    if (!bundle.endsWith('.app')) {
      return {
        ok: false,
        reason: `KeyPress Ultimate is not running from an app bundle (${bundle}), so it cannot replace itself.`,
      }
    }

    // The swap renames the bundle aside, so the parent has to be writable too.
    // On a standard, non-admin macOS account /Applications is not.
    const parent = nodePath.posix.dirname(bundle)
    if (!deps.fs.canWrite(parent)) {
      return {
        ok: false,
        reason:
          `No write permission for ${parent}. Ask an administrator to update ` +
          'KeyPress Ultimate, or download the new version manually.',
      }
    }
    if (!deps.fs.canWrite(bundle)) {
      return {
        ok: false,
        reason:
          `No write permission for ${bundle}. Ask an administrator to update ` +
          'KeyPress Ultimate, or download the new version manually.',
      }
    }

    return { ok: true }
  }

  // -- download -------------------------------------------------------------

  async function download(
    info: UpdateInfo,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<string> {
    if (!info.sha256) {
      // Refuse before touching the network: an unverifiable binary is worse
      // than no update at all.
      throw new Error(
        `No SHA-256 was published for ${info.assetName}, so it cannot be verified. ` +
          'Download it from the Releases page instead.',
      )
    }

    const dir = stagingDir()
    const dest = paths.join(dir, info.assetName)

    await deps.fs.rm(dir)
    await deps.fs.mkdir(dir)

    const response = await deps.fetch(info.assetUrl, {
      headers: { 'User-Agent': GITHUB_API_HEADERS['User-Agent'] ?? 'KeyPressUltimate' },
      redirect: 'follow',
    })
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} for ${info.assetName}.`)
    }
    if (!response.body) {
      throw new Error(`Download failed: ${info.assetName} arrived with no body.`)
    }

    const declared = Number(response.headers.get('content-length'))
    const total = Number.isFinite(declared) && declared > 0 ? declared : info.sizeBytes

    const hash = createHash('sha256')
    const sink = await deps.fs.open(dest)
    let bytesDone = 0
    let lastEmit = Number.NEGATIVE_INFINITY

    /**
     * Progress emitted while bytes are still arriving must never *look*
     * finished. The renderer turns a completed fraction into "Downloaded and
     * verified.", and at this point nothing has been verified: the SHA-256 is
     * not compared until the whole body has been read. So an in-flight event is
     * deliberately held one byte, and one percent, short of the total. The only
     * completed event this function emits is the one after the comparison
     * passes, which is the first moment the claim on screen is true.
     */
    function reportStreaming(): void {
      const done = total > 0 ? Math.min(bytesDone, Math.max(total - 1, 0)) : bytesDone
      onProgress({
        bytesDone: done,
        bytesTotal: total,
        percent: total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0,
      })
    }

    try {
      try {
        for await (const chunk of response.body) {
          hash.update(chunk)
          bytesDone += chunk.length
          await sink.write(chunk)

          const now = deps.now()
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
            lastEmit = now
            reportStreaming()
          }
        }
      } finally {
        await sink.close()
      }
    } catch (error) {
      // A connection dropped mid-stream leaves a half-written file. Never keep
      // it: the next download would have to distinguish it from a whole one.
      await deps.fs.rm(dir)
      throw error
    }

    const actual = hash.digest('hex')
    if (actual !== info.sha256.toLowerCase()) {
      // Never keep, and never install, bytes we cannot vouch for.
      await deps.fs.rm(dir)
      throw new Error(
        `Checksum mismatch for ${info.assetName}. GitHub published ` +
          `${info.sha256.toLowerCase()} but the download hashed to ${actual}. ` +
          'The file was deleted and nothing was installed.',
      )
    }

    // Verified. Only now may the UI say so.
    onProgress({ bytesDone, bytesTotal: Math.max(total, bytesDone), percent: 100 })

    return dest
  }

  // -- install --------------------------------------------------------------

  function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = deps.spawn(cmd, args, { stdio: 'ignore' })
      child.onExit((code) => {
        if (code === 0) resolve()
        else reject(new Error(`${nodePath.posix.basename(cmd)} exited with ${String(code)}.`))
      })
    })
  }

  async function handOffAndQuit(cmd: string, args: string[]): Promise<void> {
    const child = deps.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    // Let the child take its handles before our process goes away.
    await deps.delay(QUIT_GRACE_MS)
    deps.quit()
  }

  async function installWindows(installerPath: string): Promise<void> {
    // electron-builder's NSIS installer takes NSIS's own `/S` plus its own
    // flags. With oneClick + perMachine:false there is no UAC prompt, so this
    // replaces the install and relaunches without the user seeing anything.
    await handOffAndQuit(installerPath, ['/S', '--force-run'])
  }

  async function installMac(zipPath: string): Promise<void> {
    const target = macAppBundlePath(deps.execPath)
    const work = nodePath.posix.dirname(zipPath)
    const extracted = nodePath.posix.join(work, 'extracted')

    await deps.fs.mkdir(extracted)
    await run('/usr/bin/ditto', ['-x', '-k', zipPath, extracted])

    const entries = await deps.fs.readdir(extracted)
    const appName = entries.find((entry) => entry.toLowerCase().endsWith('.app'))
    if (appName === undefined) {
      throw new Error('The update archive did not contain a .app bundle.')
    }
    const staged = nodePath.posix.join(extracted, appName)

    // Our releases are ad-hoc signed, so this proves the bundle is internally
    // consistent after the round trip. It is not a Gatekeeper check.
    try {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])
    } catch (error) {
      throw new Error('codesign rejected the downloaded bundle, so it was not installed.', {
        cause: error,
      })
    }

    // Nothing we download is quarantined (only LaunchServices-aware downloaders
    // set that), but strip it anyway so the relaunch can never hit Gatekeeper.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {})

    const script = nodePath.posix.join(work, 'swap.sh')
    await deps.fs.writeFile(script, buildMacSwapScript(), 0o755)

    await handOffAndQuit('/bin/sh', [script, String(deps.pid), staged, target, work])
  }

  async function install(info: UpdateInfo, downloadedPath: string): Promise<void> {
    const capability = canSelfUpdate()
    if (!capability.ok) {
      throw new Error(capability.reason ?? 'KeyPress Ultimate cannot update itself here.')
    }

    if (deps.platform === 'win32') {
      await installWindows(downloadedPath)
      return
    }
    if (deps.platform === 'darwin') {
      await installMac(downloadedPath)
      return
    }
    throw new Error(`Automatic updates are not available on ${platformLabel(String(deps.platform))}.`)
  }

  return { check, download, install, canSelfUpdate }
}
