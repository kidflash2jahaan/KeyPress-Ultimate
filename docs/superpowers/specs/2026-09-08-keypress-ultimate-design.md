# KeyPress Ultimate — Design Spec

Date: 2026-09-08
Status: approved (art direction, theming, presets, Mac signing, test sequencing all decided)

## 1. Purpose

A desktop app that holds keyboard keys and mouse buttons down for you, but only while a
game or app you chose is the frontmost window. You pick keys on a visual keyboard, pick
which apps count as targets, press Start, and the app takes over. Focus something else and
it releases instantly.

The canonical use case: hold `W` and left mouse button in Minecraft to AFK-farm, without
wedging a physical key under your keycap.

### Non-goals

- No background/tray/daemon mode. The app runs as a visible foreground app or not at all.
  Closing the window quits the process.
- No macro recording, no key remapping, no scripting language, no per-window targeting.
- No anti-cheat evasion. If a game blocks synthetic input we say so plainly.
- No mobile, no Linux (v1).

## 2. Platform parity requirement

macOS and Windows must behave identically from the user's point of view: same layout, same
states, same modes, same presets, same wording. Only three things differ, and each is
surfaced explicitly rather than hidden:

| Concern | macOS | Windows |
|---|---|---|
| Permission | Accessibility required | none required |
| Blocked injection | not applicable | UIPI blocks a non-elevated app injecting into an elevated game |
| Key legends | Command/Option/Return/Delete | Win/Alt/Enter/Backspace |

## 3. Architecture

Electron + TypeScript. React + Vite renderer. Native input via `koffi` FFI (verified:
koffi 3.2.1 loads under Node 24, resolves every needed CoreGraphics/ObjC symbol, and
handles `CGPoint` struct-by-value in both directions). No node-gyp, no compile step, and
universal Mac builds work because koffi ships prebuilt per-arch binaries.

### Process layout

```
main process                      renderer (BrowserWindow)
  app-registry                      TargetStrip
  focus-watcher                     Keyboard
  session-controller  <--IPC-->     MousePad + ModeControls
  permissions                       StatusBar / StartButton
  updater                           Settings, Presets
  store
       |
       | fork() at Start, kill() at Stop
       v
injector (utilityProcess)
  native adapter (mac | win)
  hold loop, held-set, releaseAll
```

The injector is a separate process on purpose: renderer animation can never jitter key
timing, and a bidirectional 100ms heartbeat (300ms timeout) means if either process dies
the other releases every held key.

### Modules and seams

Deep modules, small interfaces:

**`NativeInput`** — the one real seam in the app. Two adapters, `MacNativeInput` and
`WindowsNativeInput`, chosen once at injector startup.

```ts
interface NativeInput {
  init(): Promise<void>              // binds FFI, asserts struct layout, throws on mismatch
  listApplications(): AppInfo[]      // real windowed apps only
  getFrontmostPid(): number | null   // null means unknown -> caller must treat as "not on target"
  keyDown(key: KeyDef): void
  keyUp(key: KeyDef): void
  mouseDown(btn: MouseDef): void
  mouseUp(btn: MouseDef): void
  releaseAll(): void                 // idempotent, batched where the OS allows
  capabilities(): { needsPermission: boolean; hasPermission: boolean }
  dispose(): void
}
```

**`SessionController`** — owns the whole lifecycle. Interface is `arm(config)`,
`disarm(reason)`, and an event stream. Everything about focus gating, failsafes, heartbeat
and recovery lives behind it.

**`AppRegistry`** — `list()` returns real apps only, identified by stable identity (bundle
id on macOS, lowercased exe path on Windows) rather than pid, so a target survives the game
restarting.

**`Updater`** — `check()`, `download(onProgress)`, `install()`.

### Data model

`keys.json` (114 entries: 104 base ANSI + 10 extras) and `mouse.json` (7 entries) are
generated, validated, and committed. Never hand-edited; `generate.mjs` is the source and
`validate.mjs` + `crosscheck.mjs` run in CI. Every key carries: id, labels (with per-platform
overrides), section, row, unit width/height, `macKeyCode`, `winVirtualKey`, `winScanCode`,
`winExtended`, `isModifier`, and notes. All 111 non-null macOS keycodes were cross-checked
against Apple's `Events.h` with 0 mismatches.

Presets and settings are JSON in `app.getPath('userData')`, written atomically.

## 4. Runtime semantics

### Modes

- **Hold** (default) — one key-down at arm, one key-up at release. Nothing in between.
- **Hold + Repeat** — re-sends key-down only, never intermediate key-ups, with the OS
  autorepeat flag set so it mimics real typematic behaviour. Default 400ms initial then 33ms.
- **Tap** — down/up pairs at an interval, for autoclicker-style use. 10-1000ms.

Never re-assert in Hold mode. Blind re-assertion produces duplicated input (seven key-downs
means seven characters in a text field).

### Focus gating

The injector re-checks the frontmost pid before every assert, on a 25ms tick scheduled
against an absolute deadline (not recursive `setTimeout`, which drifts +140ms over six
seconds at a 20ms period).

Focus source is `CGWindowListCopyWindowInfo`'s front layer-0 window owner on macOS
(104us mean, never stale) and `GetForegroundWindow` + `GetWindowThreadProcessId` on Windows.
**Not** `NSWorkspace.frontmostApplication`, which was measured frozen for 231 seconds across
16 real focus changes.

On focus gain: wait 150ms, then gate the first press on a physical-modifier-clear check,
timing out at 2s. This exists because the user is usually still holding Cmd or Alt at the
instant a Cmd+Tab lands, which would turn a held `W` into Cmd+W (close window).

On focus loss: release immediately. On macOS post each key-up twice, first via
`CGEventPostToPid` to the app that was holding the key so it actually sees the release, then
globally to clear system state.

### Failsafes

A stuck key is the worst failure this app has. Every one of these calls the same idempotent
`releaseAll()`:

stop pressed · target loses focus · target quits · app quit · window close ·
`uncaughtException` · SIGINT/SIGTERM/SIGHUP · powerMonitor suspend · lock-screen ·
permission revoked mid-session · heartbeat timeout · panic hotkey.

Plus, for the case where both processes are SIGKILLed at once and no handler can run: an
fsynced journal at `userData/held-keys.json` written before the first key-down and deleted
after a clean release. On next launch, if the file exists and its pid is dead, post ups for
everything listed and show "recovered, released N keys".

Panic hotkey defaults to `CommandOrControl+Alt+Shift+K`, registered only while a session is
armed. If registration fails, Start is refused rather than giving the user a panic button
that silently does nothing.

Release order is reverse press order, modifiers last.

### Self-targeting guard

The app excludes itself from the target list by identity, and hard-checks the frontmost pid
against its own pids every tick. If our window is focused, the state is ARMED-waiting and
nothing is pressed, shown explicitly so it never looks broken.

### macOS specifics

- Post to `kCGHIDEventTap` (0) from one shared `CGEventSource` created with
  `kCGEventSourceStateHIDSystemState`.
- Force the source's local-events suppression interval from its 0.25s default to 0.0 and set
  the filter to permit all events. Without this the user's real keyboard and mouse go dead
  while the tool holds keys. Non-negotiable, with a regression test reading the value back.
- Modifiers are posted as `kCGEventFlagsChanged`, not key-down/up, and the cumulative flag
  mask is stamped on every other posted event.
- Never enable App Sandbox: it silently no-ops `CGEventPost`.

### Windows specifics

- `SendInput` with `KEYEVENTF_SCANCODE`, `wVk = 0`, and `KEYEVENTF_EXTENDEDKEY` for the
  0xE0-prefixed keys. VK-based injection is the fallback toggle for titles that need it.
- INPUT records are written byte-by-byte into a preallocated Buffer, never through koffi's
  union marshaller, and the struct layout is asserted against `koffi.sizeof`/`offsetof` at
  init (40/8/24/32 on x64). Layout mismatch refuses to inject rather than posting garbage.
- `EnumWindows` uses a transient callback, never `koffi.register` (8192 process-wide slots,
  leaked per call). The callback body is fully try/caught and always returns 1.
- `SendInput`'s return value is never treated as proof of success: under UIPI it reports
  success while nothing happens. Elevation is detected separately and surfaced as
  "Rust is running as administrator - restart KeyPress Ultimate as administrator".
- `timeBeginPeriod(1)` at arm, balanced `timeEndPeriod(1)` at disarm, because utilityProcess
  does not inherit Chromium's raised timer resolution.

Locks (CapsLock/NumLock/ScrollLock) and scroll wheel are not holdable; they are rendered
visually distinct and convert to a single tap or repeat-scroll.

## 5. Permissions

macOS asks for Accessibility only, never Input Monitoring (verified sufficient for both).
Gate on `systemPreferences.isTrustedAccessibilityClient(false)`, deep-link to
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`, and poll at
1s for the whole session so a mid-hold revocation releases keys instead of stranding them.

The prompt only ever appears once per app identity, so if the user denies it, the UI leads
with the deep link plus explicit "click + and pick it from Applications" instructions rather
than waiting forever on a dialog that will never reappear.

Windows shows no permission step at all. The elevation check runs at Start, not at launch.

## 6. Interface

Direction: **tactile hardware / BENCH**. Graphite, extruded keycaps with real depth, tight
radii, and a single sodium-amber that means exactly one thing: current is flowing. Dark and
light themes, following the OS by default with a manual override.

Layout is full-bleed horizontal bands. A sidebar is arithmetically impossible: a 260px rail
drops the key unit to 34px at the 1100px minimum window, making dual-legend keys unreadable.

```
┌ KeyPress Ultimate        ◍ armed · waiting for Minecraft     ⚙ ─ ✕ ┐
├ TARGETS  [▣ Minecraft] [▢ Chrome] [+]           focused: Terminal  │
├ KEYBOARD                         full width, 104 keys              │
├ MOUSE  L M R 4 5    │    MODE  Hold · Hold+Repeat · Tap            │
└ [ ▶ Start ]   W + LMB · 2 keys · 00:04:12         panic ⌘⌥⇧K       ┘
```

Presets live as a compact menu in the header, not a rail.

### The one rule that governs the visuals

Colour encodes state and nothing else. Amber is reserved absolutely for "firing", with no
other coloured element competing anywhere in the interface. Misreading whether keys are
firing is the one failure mode that actually hurts the user.

### Key states

`idle` · `hover` · `selected` (static fill, no animation) · `firing` (drops into amber) ·
`disabled` (lock keys in hold mode) · `unavailable` (key absent on this platform).

Selection is static and motion is spent entirely on firing. VIA pulses its selected key
because exactly one is selected; with 15 selected keys, 15 looping glows is noise.

For accessibility the firing state carries a redundant non-colour channel (the press
geometry) plus the textual status line, so it survives deuteranopia and protanopia.

### Motion

Animate transform and opacity only, `will-change: transform` on key bodies, with a
`translateY(2px)` fallback prepared if the 3D press geometry can't hold 60fps on Windows.
At most one looping animation in the entire app, on the global "holding" indicator. Full
`prefers-reduced-motion` support.

### Type

OFL-licensed only: Geist Sans and Geist Mono, bundled locally with `@font-face`. Fontshare
families (Satoshi, General Sans, Clash Display) are explicitly banned because their licence
forbids shipping them in a public repo or an installer.

## 7. Packaging, release, auto-update

- electron-builder 26.x. macOS universal dmg + zip; Windows NSIS + portable, x64.
- Signed with a **self-signed certificate** held in GitHub Secrets, giving a stable
  designated requirement so the Accessibility grant survives updates. Not notarized, so the
  first install has a one-time "Open Anyway" step, documented in INSTALL.md.
- koffi needs `asarUnpack: ["node_modules/koffi/**", "node_modules/@koromix/**"]`,
  `npmRebuild: false`, and `mac.x64ArchFiles: "**/koffi.node"`. The foreign-arch koffi
  package must be force-installed on the build runner, and CI asserts both `darwin_arm64`
  and `darwin_x64` koffi binaries exist in the packaged app or the build fails. Without this
  the universal app silently ships broken on Intel Macs.
- **Custom updater, not electron-updater.** electron-updater's macOS path requires a valid
  Developer ID signature and cannot work here. The custom updater polls the GitHub Releases
  API, compares semver, shows release notes and progress, verifies SHA-256 against the
  asset's own digest, then installs: Windows spawns the NSIS installer silently; macOS
  extracts with `ditto`, then a detached script waits for exit, renames the bundle aside,
  ditto's the new one in, and relaunches, rolling back on failure.
- Guards: refuses to self-update from `/AppTranslocation/` or a non-writable location, and
  falls back to "open the Releases page" instead of failing silently.
- GitHub Actions builds macos-latest + windows-latest on a version tag, then publishes with
  a SHA256SUMS asset.

## 8. Testing

- Unit: key data validation, semver compare, state machine transitions, release ordering,
  journal recovery.
- Timing regression: p99 tick error under 1ms over 300 ticks.
- Suppression regression: event source interval reads back 0.
- Renderer: runs standalone in a browser against a mock IPC bridge, so the full UI flow is
  driveable in Chrome without Electron.
- Supervised manual pass (deferred by decision, run before release): held key really reads
  as held in a real game, modifiers via FlagsChanged, HID vs session tap, held mouse drag,
  and the whole Windows half.

## 9. Known limitations, stated plainly in the app

- Kernel anti-cheat (Vanguard, EAC, BattlEye) detects synthetic input regardless of how it
  is generated. Some titles will ignore it, some may ban for it. No evasion will be added.
- Games reading the keyboard through IOHIDManager or raw HID may not see injected events at
  all. Karabiner solves this with a virtual HID driver, which is a much heavier architecture
  and out of scope for v1.
- A force-quit of both processes at once can still leave a key down until next launch
  recovers it, or until the user physically taps the key.
- Windows portable build cannot self-update; it switches to a download flow.
