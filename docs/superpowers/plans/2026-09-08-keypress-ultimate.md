# KeyPress Ultimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-platform Electron desktop app that holds selected keyboard keys and mouse buttons down continuously, but only while a user-chosen target application is frontmost.

**Architecture:** Electron main process owns lifecycle, app enumeration, permissions, presets and updates. A separate `utilityProcess` (the injector) owns all native input synthesis via koffi FFI, so renderer animation can never jitter key timing and a dead process on either side triggers a full key release. React + Vite renderer, driveable standalone in a browser against a mock bridge.

**Tech Stack:** Electron 3x, TypeScript (strict), React 19, Vite via electron-vite, koffi 3.2.1 FFI, zustand, motion (Framer Motion), vitest, electron-builder 26.

**Spec:** `docs/superpowers/specs/2026-09-08-keypress-ultimate-design.md` — read it first. Every requirement below traces to a measured finding recorded there.

## Global Constraints

- TypeScript `strict: true` everywhere. No `any` in shared or main code.
- Node >= 20, npm. Package manager is npm (lockfile committed).
- koffi pinned at `^3.2.1`. `@koromix/koffi-darwin-arm64`, `@koromix/koffi-darwin-x64`, `@koromix/koffi-win32-x64` are **explicit direct dependencies**, not left to optionalDependencies.
- Fonts: OFL-1.1 only. Geist Sans + Geist Mono, vendored under `src/renderer/assets/fonts/` with `OFL.txt`. Fontshare families (Satoshi, General Sans, Clash Display) are **banned** — their licence forbids redistribution in a public repo or installer.
- No em dashes in any user-facing copy. Use a comma, a colon, or two sentences.
- Colour encodes state and nothing else. Exactly one accent (amber `--sig`) meaning "current is flowing". No other coloured element anywhere.
- Never enable macOS App Sandbox: it silently no-ops `CGEventPost`.
- `releaseAll()` must be idempotent and must be reachable from every exit path.
- The app never runs headless/tray. Closing the last window quits the process on both platforms.
- Minimum window 1100x760. Layout is full-bleed horizontal bands, never a sidebar.

---

## File Structure

```
data/                         generated key + mouse data, validators (committed)
src/shared/                   types, IPC contract, key helpers, semver — imported by all 3 processes
src/main/                     app lifecycle, registry, session control, permissions, store, updater
src/injector/                 utilityProcess: hold loop + native adapters (the only code that posts input)
src/preload/                  contextBridge surface
src/renderer/                 React UI, tokens, components, mock bridge for browser-mode
.github/workflows/            ci.yml (test + typecheck), release.yml (tag -> signed artifacts)
```

Files that change together live together. `src/injector/native/{macos,windows}.ts` are the only
two files allowed to call koffi.

---

## Interface Contract (locked before parallel work begins)

`src/shared/types.ts` — every other task imports from here and must not redefine these.

```ts
export type Platform = 'darwin' | 'win32'
export type KeySection = 'function' | 'alphanum' | 'navigation' | 'numpad'

export interface KeyDef {
  id: string; label: string; subLabel?: string
  macLabel?: string; winLabel?: string
  section: KeySection; row: number
  unitWidth: number; unitHeight: number
  macKeyCode: number | null
  winVirtualKey: number | null; winScanCode: number | null; winExtended: boolean
  isModifier: boolean; holdable: boolean; extra?: boolean; notes?: string
}

export type MouseButtonId = 'left' | 'right' | 'middle' | 'back' | 'forward' | 'wheel-up' | 'wheel-down'

export interface MouseDef {
  id: MouseButtonId; label: string; description: string; holdable: boolean
  macButton: number | null; macDownType: number | null; macUpType: number | null
  winFlagDown: number | null; winFlagUp: number | null; winMouseData: number
}

/** identity is bundleId on macOS, lowercased exe path on Windows. Stable across restarts. */
export interface AppInfo {
  identity: string; name: string; pid: number
  path: string | null; iconDataUrl?: string
}

export type HoldMode = 'hold' | 'hold-repeat' | 'tap'

export interface SessionConfig {
  keyIds: string[]; buttonIds: string[]; targets: string[]
  mode: HoldMode
  repeatInitialMs: number; repeatIntervalMs: number; tapIntervalMs: number
}

export type SessionPhase = 'idle' | 'armed-waiting' | 'firing' | 'blocked' | 'error'

export interface SessionState {
  phase: SessionPhase
  startedAt: number | null
  firingKeyIds: string[]; firingButtonIds: string[]
  focusedApp: AppInfo | null
  onTarget: boolean
  message: string | null
}

export interface Preset { id: string; name: string; config: SessionConfig; updatedAt: number }

export interface Settings {
  theme: 'system' | 'dark' | 'light'
  panicHotkey: string           // Electron accelerator, default 'CommandOrControl+Alt+Shift+K'
  maxSessionMinutes: number     // 0 = unlimited, default 30
  autoCheckUpdates: boolean
  windowsUseVirtualKeys: boolean  // fallback for titles that ignore scancodes
}

export interface UpdateInfo {
  version: string; notes: string; url: string
  assetName: string; assetUrl: string; sha256: string | null; sizeBytes: number
}
```

`src/injector/native/types.ts`:

```ts
export interface NativeInput {
  init(): Promise<void>            // binds FFI, asserts struct layout, throws on mismatch
  listApplications(): AppInfo[]
  getFrontmostPid(): number | null // null = unknown; caller MUST treat as "not on target"
  keyDown(key: KeyDef): void
  keyUp(key: KeyDef): void
  mouseDown(btn: MouseDef): void
  mouseUp(btn: MouseDef): void
  releaseAll(): void               // idempotent, batched where the OS allows
  hasPermission(): boolean
  openPermissionSettings(): void
  dispose(): void
}
```

Injector message protocol (`src/shared/ipc.ts`), main -> injector:
`{t:'arm', config}` `{t:'disarm', reason}` `{t:'ping', n}` `{t:'settings', settings}`
injector -> main:
`{t:'state', firingKeyIds, firingButtonIds, onTarget, focusedPid}` `{t:'pong', n}`
`{t:'error', code, message}` `{t:'released', count}`

---

## Tasks

Tasks 1-3 are sequential (they define the contract). Tasks 4-9 are independent and
parallelisable. Tasks 10-13 integrate. Each task ends with a commit.

### Task 1: Scaffold + shared types
**Files:** `package.json`, `tsconfig*.json`, `electron.vite.config.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `vitest.config.ts`
**Produces:** every type in the Interface Contract above, verbatim.
Steps: init electron-vite + React + TS strict; add deps; write `types.ts` and `ipc.ts` exactly as
specified; `npm run typecheck` passes; commit.

### Task 2: Key + mouse data
**Files:** `data/{keys.json,mouse.json,generate.mjs,validate.mjs,crosscheck.mjs}`, `src/shared/keys.ts`
**Consumes:** `KeyDef`, `MouseDef`.
**Produces:** `getKeys()`, `getKeyById(id)`, `getMouseButtons()`, `platformLabel(key, platform)`, `keysBySection()`.
Copy the verified artifacts from the research scratchpad `data/` directory. Wire `validate.mjs`
(37 assertions) and `crosscheck.mjs` into `npm test`. crosscheck must resolve the SDK path via
`xcrun --show-sdk-path` and skip gracefully on non-macOS.
Test: 104 base keys (`extra !== true`), no duplicate ids, unique non-null platform codes, row unit
sums match ANSI geometry.

### Task 3: Native adapter interface + macOS implementation
**Files:** `src/injector/native/{types.ts,index.ts,macos.ts}`
**Reference:** `scratchpad/spike-macos/macos-native.mjs` — 695 lines, already exercised. Port it, do not reinvent.
Non-negotiables, each with a test:
- focus via `CGWindowListCopyWindowInfo` front layer-0 owner pid, never `NSWorkspace.frontmostApplication`
- one shared `CGEventSource` with `kCGEventSourceStateHIDSystemState`, suppression interval forced to `0.0`, filter set to permit all events. **Regression test reads the interval back and asserts 0.**
- post to `kCGHIDEventTap` (0)
- modifiers as `kCGEventFlagsChanged`, cumulative mask stamped on every posted event
- `NSAutoreleasePool` around enumeration (measured: 0.16MB vs 7.48MB over 50k calls)
- `listApplications()` filters `activationPolicy === 0`
Test without posting: rebuild the exact events and inspect type/keycode/flags/clickState, as
`scratchpad/spike-macos/10-verify.mjs` does.

### Task 4: Windows native implementation  *(parallel)*
**Files:** `src/injector/native/windows.ts`
**Reference:** `scratchpad/spike-windows/windows-native.mjs` (1286 lines) and `RISKS.md`. Port it.
- INPUT records written byte-by-byte into a preallocated Buffer, never koffi's union marshaller
- `init()` asserts sizeof/offsetof (40/8/24/32 on x64) and throws "Refusing to inject input with an unknown struct layout" on mismatch
- `KEYEVENTF_SCANCODE` with `wVk=0`, `KEYEVENTF_EXTENDEDKEY` for 0xE0 keys; VK fallback behind `settings.windowsUseVirtualKeys`
- `EnumWindows` transient callback, body fully try/caught, always returns 1, never `koffi.register`
- explicit widths everywhere: `int32`/`intptr`/`uintptr`/`uint32`/`uint16`/`int` for BOOL. Never `long`, never `bool`.
- six-stage window filter ending in `DwmGetWindowAttribute(DWMWA_CLOAKED=14)`, deduped per pid
- `describeForegroundBlocking()` for the UIPI/elevation case
Test on macOS: `bytes-check.mjs` equivalent asserting hand-written records are byte-identical to koffi's marshaller, plus module imports cleanly on a non-Windows host.

### Task 5: Hold loop + injector entry  *(parallel)*
**Files:** `src/injector/{entry.ts,hold-loop.ts}`
- absolute-deadline scheduler (`t0 + n*period - now()`) with 0.5ms spin correction. **Test: p99 tick error < 1ms over 300 ticks.**
- 25ms tick re-checks frontmost pid before every assert
- modes: `hold` (never re-assert), `hold-repeat` (re-send down only, autorepeat flag set, 400ms then 33ms), `tap` (down/up pairs)
- focus-gain: 150ms settle, then physical-modifier-clear gate, 2s timeout
- focus-loss: release immediately; on macOS post each up twice, `CGEventPostToPid(oldPid)` first
- release in reverse press order, modifiers last
- self-target guard: release if frontmost pid is one of ours
- 100ms heartbeat, 300ms timeout -> releaseAll + exit
- `process.on('exit'|'SIGINT'|'SIGTERM'|'SIGHUP'|'uncaughtException')` -> releaseAll
- Windows: `timeBeginPeriod(1)` at arm, balanced `timeEndPeriod(1)` at disarm and on exit

### Task 6: Session controller + journal + panic hotkey  *(parallel)*
**Files:** `src/main/{session-controller.ts,journal.ts,panic-hotkey.ts}`
- owns `utilityProcess` fork at arm, kill at disarm
- journal: fsync `userData/held-keys.json` before first key-down, delete after clean release. On
  launch, if it exists and its pid is dead, replay ups and emit "recovered, released N keys".
- failsafe fan-in: stop, focus loss, target quit, app quit, window close, uncaughtException,
  SIGINT/SIGTERM, `powerMonitor` suspend + lock-screen, permission revoked, heartbeat timeout, panic hotkey
- panic hotkey registered only while armed; **if `globalShortcut.register` returns false, refuse to Start**
- `maxSessionMinutes` cap
Test: state machine transitions, release ordering, journal recovery with a fake dead pid.

### Task 7: App registry, permissions, store  *(parallel)*
**Files:** `src/main/{app-registry.ts,focus-watcher.ts,permissions.ts,store.ts,icons.ts}`
- registry lists real apps only, keyed by identity not pid, excludes our own bundleId/exe
- icons via `app.getFileIcon`; render chips at 16px CSS so a 32px macOS source is exactly 2x
- permissions: `systemPreferences.isTrustedAccessibilityClient(false)`, 1s poll for the whole
  session, deep-link `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.
  Windows returns `{needsPermission:false}` always.
- store: atomic JSON writes for `Preset[]` and `Settings`, with schema versioning and safe defaults

### Task 8: Design tokens + keyboard rendering  *(parallel)*
**Files:** `src/renderer/styles/{tokens.css,global.css,fonts.css}`, `src/renderer/components/{Keyboard.tsx,Key.tsx,keyboard-layout.ts}`
- tokens for both themes on `:root`, dark under `@media (prefers-color-scheme: dark)` and
  `[data-theme="dark"]`, light override symmetric
- unit geometry from `data/layout-notes.md`: 1u base, alphanum 15u, nav 3u, numpad 4u, 0.25u block
  gaps, 22.5u x 6.5u total. U = 48px desktop, 34px compact, floored at 30px with horizontal scroll.
- six key states: idle, hover, selected (static fill, **no animation**), firing, disabled, unavailable
- extruded keycap, bottom-face inset clamped to max 8px
- animate transform/opacity only, `will-change: transform`, `translateY(2px)` fallback ready
Test: rendering 104 keys produces correct row unit sums; no key overlaps; snapshot both themes.

### Task 9: Remaining UI + mock bridge  *(parallel)*
**Files:** `src/renderer/{App.tsx,main.tsx}`, `src/renderer/components/{TitleBar,TargetStrip,MousePad,ModeControls,ActionBar,PresetMenu,SettingsSheet,PermissionGate,UpdateBanner}.tsx`, `src/renderer/state/*`, `src/renderer/mock/bridge.ts`
- full-bleed bands per the spec wireframe
- `armed-waiting` must read as intentional, not broken: plate border changes and the status line
  says "Armed, waiting for Minecraft", with the live focused app shown before Start is ever pressed
- at most one looping animation in the whole app (the global holding indicator)
- `prefers-reduced-motion` honoured
- **mock bridge**: `window.kpu` implemented against fake data when not in Electron, so the entire
  UI is driveable in Chrome for the flow test

### Task 10: Preload + IPC wiring
**Files:** `src/preload/index.ts`, `src/main/{index.ts,window.ts,ipc-handlers.ts}`
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (koffi lives in main/injector, not renderer).
Window: 1180x820 default, 1100x760 min, `titleBarStyle: 'hiddenInset'` on macOS with a custom bar on Windows.
`window-all-closed` quits on **both** platforms (the app must not linger on macOS).

### Task 11: Updater
**Files:** `src/main/updater.ts`
**Reference:** `scratchpad/release/updater-sketch.ts` (typechecks clean against Electron 44). Port it.
Refuses to self-update from `/AppTranslocation/` or a non-writable location and falls back to
opening the Releases page. Rate-limit failures are silent unless user-initiated.

### Task 12: Packaging + CI + release
**Files:** `electron-builder.yml`, `.github/workflows/{ci.yml,release.yml}`, `build/entitlements.mac.plist`
**Reference:** `scratchpad/release/{electron-builder.yml,release.yml}` (validated against app-builder-lib's schema).
- self-signed cert from GitHub Secrets, stable identifier `com.keypressultimate.app`
- `asarUnpack: ["node_modules/koffi/**","node_modules/@koromix/**"]`, `npmRebuild: false`, `mac.x64ArchFiles: "**/koffi.node"`
- **CI must assert both `darwin_arm64/koffi.node` and `darwin_x64/koffi.node` exist in the packaged app, and fail the build otherwise.** Without this the universal app silently ships broken on Intel.
- `LSAppNapIsDisabled: true` via `mac.extendInfo`

### Task 13: Docs + first release
**Files:** `README.md`, `INSTALL.md`, `THIRD_PARTY_LICENSES/`, `LICENSE`
INSTALL.md copy comes from `scratchpad/release/install-notes.md`: macOS Gatekeeper "Open Anyway"
walkthrough, why Control-click no longer works, Accessibility grant, Windows SmartScreen.
README states the anti-cheat limitation plainly.

---

## Self-Review

**Spec coverage:** §3 architecture -> Tasks 1,5,6,10. §4 semantics -> Tasks 3,4,5,6. §5 permissions
-> Task 7. §6 interface -> Tasks 8,9. §7 packaging -> Tasks 11,12. §8 testing -> folded into each
task. §9 limitations -> Task 13.

**Type consistency:** `SessionConfig`/`SessionState`/`AppInfo`/`NativeInput` are defined once in the
contract above and imported everywhere. `releaseAll()` is spelled identically in Tasks 3,4,5,6.

**Known gap, accepted:** the supervised real-input tests are deliberately deferred to after Task 13
by user decision, and are tracked in the spec §8.
