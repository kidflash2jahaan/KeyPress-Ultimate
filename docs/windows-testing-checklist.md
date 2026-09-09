# Windows native layer: risks and the Windows tester's checklist

> This is the verbatim risk register from the Windows spike, kept as the tester's script
> so the reproduction steps are not paraphrased. The code it describes now lives in
> `src/injector/native/windows.ts`; where the text says `windows-native.mjs`, read that
> file instead. A few exported names changed on the way in, and the map is at the bottom
> under "Quick smoke script for the tester".

Everything in `windows-native.mjs` was written on macOS 26.6 (arm64) from Microsoft Learn
and the koffi 3.2.1 documentation and source package. **No line of it has ever run on
Windows.** This file separates what was actually verified from what a human has to
confirm on a real machine, and gives the exact test for each.

Tester setup assumed below: Windows 11 x64, Node 24 / Electron, a normal (non-admin)
user account, one game that uses Raw Input or DirectInput (any modern FPS), Notepad, and
one app started with "Run as administrator" (Task Manager is convenient — it always runs
elevated).

---

## What WAS verified on this machine (do not re-litigate these)

| # | Fact | How |
|---|------|-----|
| V-1 | `sizeof(INPUT)` is **40** on 64-bit, with `type` at offset 0 and the union at offset **8** (a 4-byte alignment hole). `KEYBDINPUT` is 24 bytes with `dwExtraInfo` at +16; `MOUSEINPUT` is 32 bytes with `dwExtraInfo` at +24. | Declared the structs with `koffi.struct`/`koffi.union` and read `koffi.sizeof`/`koffi.offsetof` on darwin-arm64, which uses the same alignment rules as Windows x64 for these member types. |
| V-2 | The hand-written byte records the module sends are **byte-identical** to what koffi's own struct/union marshaller produces for the same `INPUT`. | `bytes-check.mjs` — 4/4 PASS, including a 3-record array. |
| V-3 | `koffi.union()` and `new koffi.Union(type)` exist and work in 3.2.1. But `koffi.decode(buf, INPUT)` returns `{ type: 1, u: {} }` — koffi cannot know which union arm is live, so **you cannot round-trip an INPUT through decode**. | Ran it. |
| V-4 | `lib.func(convention, name, ret, [args])` and `koffi.proto(convention, name, ret, [args])` both accept the `'__stdcall'` token, including on a non-Windows host. | Ran it against libSystem. |
| V-5 | Transient callbacks work: pointer arguments arrive as **BigInt**, `koffi.decode` reads them, the callback is invoked synchronously while the C call is on the stack. | qsort round-trip. |
| V-6 | An exception thrown **inside** a transient callback **propagated out** of the enclosing FFI call on koffi 3.2.1, contradicting the doc sentence "the C API will receive 0 or NULL". This is why `listApplications`' enum proc has an unconditional try/catch. | Ran it. |
| V-7 | Wide-string output works three equivalent ways: `koffi.decode(buf, 'char16_t', n)`, `koffi.decode.string16(buf)`, and `buf.toString('utf16le', 0, n*2)`. The `['\0'.repeat(n)]` array-of-string out-param pattern also works. | Wrote UTF-16 into a Buffer via memcpy and read it back. |
| V-8 | koffi 3.2.1 ships **prebuilt** `koffi.node` binaries for `win32-x64`, `win32-arm64` and `win32-ia32` as optional dependencies — no node-gyp, no build step. | Listed the files in `@koromix/koffi-win32-x64/win32_x64/koffi.node` and `@koromix/koffi-win32-arm64/win32_arm64/koffi.node`, and read `optionalDependencies` in koffi's package.json. |
| V-9 | koffi has **no** `GetLastError()` wrapper — `koffi.errno()` is POSIX errno. But koffi does protect the Windows last-error value across the call boundary (CHANGELOG 2.6.10: "Protect GetLastError() value from Node.js and V8 on Windows"; 3.2.0: "Make errno and GetLastError() available in async callbacks"), and its win32 binary imports both `GetLastError` and `SetLastError`. So calling `kernel32!GetLastError` through FFI right after the failing call is sound. | Read the shipped CHANGELOG and `strings` on the win32-x64 binary. |
| V-10 | koffi's `'long'` is 64-bit on LP64 hosts. Win32 `LONG` is always 32-bit and `LPARAM` is pointer-sized. The module therefore uses `int32` / `intptr` / `uintptr` explicitly and never `'long'`. Note that koffi's **own documentation example** for `EnumWindowsProc` uses `long lParam`, which is wrong for Win64. | Read koffi docs + `koffi.sizeof('long')`. |

---

## R-01 — `SendInput` silently succeeds when UIPI blocks it — **HIGH**

Microsoft's own words, from the `SendInput` reference:

> This function fails when it is blocked by UIPI. Note that neither GetLastError nor the
> return value will indicate the failure was caused by UIPI blocking.

and from Remarks:

> This function is subject to UIPI. Applications are permitted to inject input only into
> applications that are at an equal or lesser integrity level.

So the return value cannot be trusted as proof that keys are being held. `describeForegroundBlocking()` exists precisely because of this.

**Test.** Run KeyPress Ultimate as a normal user. Start Task Manager (always elevated),
target it, press Start with a printable key. Record:
1. What does `SendInput` return? (expected: the full count, i.e. a lie)
2. What does `GetLastError()` return? (expected: 0; the ambiguous alternative is 5 = `ERROR_ACCESS_DENIED`)
3. Does `probeInjectionWorks()` correctly report `ok: false`?

Then repeat with KeyPress Ultimate itself started "as administrator" and confirm it works.

---

## R-02 — Scan-code injection acceptance in real games — **HIGH**

`KEYEVENTF_SCANCODE` with `wVk = 0` is the documented way to "simulate a physical
keystroke regardless of which keyboard is currently being used", and it is what games
reading DirectInput / Raw Input want. Whether a specific game accepts it is **not
something documentation can answer**.

**Test matrix** — for each of: a Win32 message-loop app (Notepad), a Raw-Input game, a
DirectInput game, a Unity game, an Unreal game, and one browser/Electron app:

| Check | Expected |
|---|---|
| Hold `KeyW` — does the character repeat / does the character move? | yes |
| Hold `ShiftLeft` + `KeyW` | both register |
| Hold `ArrowUp` (extended key) | registers as Up, **not** as Numpad 8 |
| Hold `NumpadEnter` (extended) vs `Enter` (not) | distinguishable |
| Hold `ControlRight` vs `ControlLeft` | distinguishable |
| Hold `mouseDown('left')` | fires and *holds* (not a single click) |
| Hold `mouseDown('x1')`/`('x2')` | maps to the same buttons the physical mouse's side buttons do |
| Does the cursor move at all during mouse-button injection? | **no** (dx=dy=0 and `MOUSEEVENTF_MOVE` is not set) |

**Also unverified and worth checking here:** whether `SendInput`-injected events surface
in the **Raw Input** stream (`WM_INPUT`) at all, and with what `RAWINPUTHEADER.hDevice`.
Microsoft documents `hDevice` as "can be zero if an input is received from a precision
touchpad" and says nothing about injected input. I could not find an authoritative
statement either way. Write a 30-line `WM_INPUT` logger and inject into it; the answer
determines whether Raw-Input-only games can ever work.

---

## R-03 — Held keys must survive every exit path — **HIGH**

The worst failure this app can produce is a stuck key in someone's game. `releaseAll()`
sends every outstanding key-up and button-up in one `SendInput` call (the API guarantees
the array is inserted serially with no other input interleaved).

**Test.** With keys held: (a) alt-tab away, (b) click Stop, (c) close the window,
(d) kill the Electron main process from Task Manager, (e) unplug/replug the keyboard,
(f) Win+L lock and unlock. After each, check `GetAsyncKeyState` for the held key — or
simply type in Notepad and see whether Shift/Ctrl is stuck.

Case (d) cannot be handled from JS. Decide deliberately: either accept it and document
"if you force-kill the app, tap the keys once to clear them", or add a watchdog.
Note `SendInput` "does not reset the keyboard's current state"; the doc's own advice is
to check `GetAsyncKeyState` and correct as necessary, which is worth doing on Start.

---

## R-04 — NumLock and Pause scan codes — **MEDIUM**

Microsoft's "Extended-Key Flag" prose says explicitly:

> Note that the Num Lock key has a separate scan code from the Pause key (which uses the
> same scan code without the extended-key flag), and is **not considered an extended key**
> despite appearing in the extended key name table.

But the same page's scan-code table gives NumLock as `0x0045` **or** `0xE045` ("as seen
in legacy keyboard messages"), and Chromium's `dom_code_data.inc` — which is what
browsers and Electron use — maps NumLock to `0xE045`. The module follows Chromium.

Pause is worse: the physical key emits the three-code sequence `0xE1 0x1D 0x45`, which a
single `INPUT` record cannot express. The module sends bare `0x45`.

**Test.** Inject `NumLock`; does the NumLock LED / state toggle? Inject `Pause`; does
anything receive it? If Pause does not work, grey it out in the UI rather than shipping a
key that silently does nothing. Also try `0x0045` for NumLock as a fallback.

---

## R-05 — Cross-process elevation detection — **MEDIUM**

`getProcessElevation(pid)` opens the target with `PROCESS_QUERY_INFORMATION (0x0400)`
because `OpenProcessToken` requires that right, then reads
`GetTokenInformation(..., TokenElevation, ...)`. From a medium-integrity process against
a high-integrity process of the same user this is **expected** to fail with
`ERROR_ACCESS_DENIED (5)`, and the module treats that denial as "probably elevated".
I could not confirm that this is what actually happens.

Separately, `processImagePath()` uses `PROCESS_QUERY_LIMITED_INFORMATION (0x1000)`, which
Microsoft documents as existing exactly "to provide access to a subset of the information
available through PROCESS_QUERY_INFORMATION" and as sufficient for
`QueryFullProcessImageName`. It should succeed even against elevated processes.

**Test.** With a non-elevated build:
1. `getProcessElevation(pid_of_task_manager)` → does it return `known:false, probablyElevated:true`, or does it actually read the token?
2. `processImagePath(pid_of_task_manager)` → does it return the path, or null?
3. Repeat against a protected process (e.g. an anti-cheat service) and check nothing throws.
4. Run KeyPress Ultimate elevated and confirm `getSelfElevation()` returns `{known:true, elevated:true}` and that step 1 now reads the token cleanly.

Also confirm the numeric assumptions: `TOKEN_QUERY = 0x0008` (Learn does not give token
access rights numerically; this comes from `winnt.h`) and `TokenElevation = 20` (derived
by counting the `TOKEN_INFORMATION_CLASS` enum from `TokenUser = 1`).

---

## R-06 — Window enumeration filters — **MEDIUM**

The filter chain is: `IsWindowVisible` → no `GW_OWNER` → Chen's Alt+Tab ownership rule →
`GetWindowTextLengthW > 0` → not `WS_EX_TOOLWINDOW` unless `WS_EX_APPWINDOW` →
`DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED)` is 0 → not our own pid.

Two things to confirm:

- **`DWMWA_CLOAKED == 14`.** The `DWMWINDOWATTRIBUTE` enum is printed as if 0-based but
  Learn states "IMPORTANT. The value of DWMWA_NCRENDERING_ENABLED is 1", shifting
  everything by one. Counting from 1 gives `DWMWA_CLOAKED = 14`, which is what every
  real implementation uses. Verify by cloak-checking a minimised Store app: it should
  report `DWM_CLOAKED_SHELL (0x2)`.
- **The Alt+Tab rule.** Chen's published `IsAltTabWindow` contains a well-known typo
  (`(hwndTry = GetLastActivePopup(hwndWalk)) != hwndTry`, always false). The module
  implements the corrected `!= hwndWalk` form and, critically, `break`s **without**
  assigning when it finds a visible popup, so an app showing a modal dialog is
  represented by its main window. Verify with an app that has a modal open.

**Test.** Compare `listApplications()` against the actual Alt+Tab list, with: several
Store/UWP apps (some minimised, some on another virtual desktop), Chrome with multiple
windows, a borderless-fullscreen game, a game in exclusive fullscreen, an app with a
splash screen, and something with a tray icon only (should NOT appear). Check the dedupe:
Chrome with 3 windows must produce one entry with `windowCount: 3`.

Known gaps I did not solve:
- A game running under a launcher (Steam, Epic, Riot) may present the launcher's process
  in the foreground during startup, then switch. The app should re-resolve the
  foreground pid continuously, not once at Start.
- Some anti-cheat setups run the game via a broker process, so the pid whose window is
  frontmost is not the pid of the executable the user picked. Match on **image path**,
  not pid, which is what `AppEntry.id` does.
- `EnumWindows` only enumerates the **current desktop station**. That is what we want,
  but it also means nothing works while the secure desktop (UAC prompt, Ctrl+Alt+Del) is
  up. Expect `GetForegroundWindow()` to return NULL there.

---

## R-07 — `probeInjectionWorks()` is a guess — **MEDIUM**

The probe injects a key down, reads `GetAsyncKeyState`, and injects the key up, on the
theory that a UIPI-blocked injection never reaches the asynchronous key-state table.
That theory is **not documented**. What *is* documented is the opposite case for
`BlockInput`: "calling the SendInput function while input is blocked will change the
asynchronous keyboard input-state table." So the probe may produce a false "it works"
when input is merely blocked rather than UIPI-blocked.

**Test.** Run the probe (a) normally, (b) with an elevated foreground window, (c) while
another app holds `BlockInput`, and record all three results. If (b) does not come back
false, the probe is useless and should be replaced or removed rather than shipped as a
reassurance.

Note the probe genuinely presses a key. It must stay behind an explicit user-initiated
button and never run on a timer.

---

## R-08 — Anti-cheat. Set expectations, do not fight it — **HIGH (product, not code)**

Factual, non-evasive summary for the UI:

- **User-mode input injection is not, by itself, a cheat**, and blanket-blocking
  `SendInput` would break accessibility tools, remote-desktop clients, streaming
  overlays and macro-capable keyboards. Most anti-cheat does not block it outright.
- Windows itself gives applications a way to *see* that input was injected:
  `KBDLLHOOKSTRUCT.flags` carries `LLKHF_INJECTED (0x00000010)` for any injected event
  and `LLKHF_LOWER_IL_INJECTED (0x00000002)` when it came from a lower-integrity process.
  Any game or anti-cheat that installs a low-level keyboard hook can therefore trivially
  tell our events from a real keypress and choose to ignore or flag them.
- **Kernel-mode anti-cheat** (Riot Vanguard, Easy Anti-Cheat, BattlEye, and similar) runs
  a driver with far more latitude: it can block user-mode injection into the protected
  process, refuse to let other processes query it, or treat automated holds as a
  bannable macro. Several of these load at boot.
- Many games' Terms of Service prohibit input automation regardless of how it is
  produced.

**Ship this as a one-line, honest, non-dismissible notice**, roughly:

> Some games — especially competitive ones with anti-cheat — deliberately ignore or block
> simulated input, and some ban accounts for using it. KeyPress Ultimate does not try to
> work around anti-cheat. If a game does not respond, it is not going to.

Do **not** implement, and do not accept a request to implement, anything that hides the
injected flag, spoofs a device, or otherwise evades detection.

**Test.** Try one Vanguard title, one EAC title, one BattlEye title and one single-player
game. Record which respond, and build the "known not to work" list from the results
rather than from guesswork.

---

## R-09 — Foreground polling cadence and the release race — **MEDIUM**

There is no cheap "foreground changed" callback available without a hook (`SetWinEventHook`
with `EVENT_SYSTEM_FOREGROUND` needs a message loop, which an Electron main process has,
but it also needs a registered callback whose lifetime must outlive the call — a
`koffi.register` case, not a transient one, with a real leak risk). The module ships
`getForegroundPid()` as a cheap poll instead.

**Test.** Measure `getForegroundPid()` cost on Windows (on macOS the analogous call was
sub-microsecond; expect a few µs here). Then decide the poll interval — 16–32 ms is
probably right — and confirm the worst-case window between "focus left the game" and
"keys released" is acceptable. Test alt-tabbing rapidly, and alt-tabbing *while* keys are
held, twenty times in a row, checking for a stuck key each time.

Also confirm: does `GetForegroundWindow()` ever return a window belonging to a *different*
process than the one visually in front during a fullscreen transition? Exclusive-fullscreen
mode switches are the likely failure.

---

## R-10 — ia32 / arm64 builds — **LOW**

`'__stdcall'` is passed on every declaration, which is mandatory on x86 and harmless
elsewhere. The 32-bit `INPUT` layout (28 bytes, union at offset 4) is asserted at init.
`GetWindowLongPtrW` does not exist on x86 — the module binds `GetWindowLongW` there
instead. None of this was executed.

**Test.** If you ship a 32-bit build at all, run `getDiagnostics()` on it and confirm the
layout assertion passes and `listApplications()` returns sensible results. If you do not
ship 32-bit, delete the ia32 branches rather than leaving untested code in.

For arm64 Windows: confirm the `@koromix/koffi-win32-arm64` binary loads under the
Electron ABI, and that x64 apps running under emulation still enumerate correctly.

---

## R-11 — Packaging: koffi's split packages — **MEDIUM**

koffi 3.x moved the native code out of the main package into per-platform
`optionalDependencies`. Its own migration guide warns:

> if you redistribute software that uses Koffi, you will probably need to change your
> packaging system or configure your bundler differently.

**Test.** Build the installer on/for Windows and confirm `@koromix/koffi-win32-<arch>` is
actually inside the asar-unpacked output and resolvable at runtime. Common failures:
electron-builder pruning optional deps, or the `.node` file being packed into the asar
where it cannot be `dlopen`ed. Set `asarUnpack` for `**/node_modules/@koromix/**`.
Then verify on a **clean** Windows VM with no build tools installed — that is the whole
point of choosing koffi.

---

## R-12 — `uiAccess` is not a viable escape hatch — **INFORMATIONAL (decided, do not revisit)**

Setting `uiAccess="true"` in the manifest would let a medium-IL app drive higher-IL UI.
Microsoft's requirements make it impractical for this project: the app must be
**Authenticode-signed**, and must be **installed in a secure location that requires a UAC
prompt for access** (e.g. Program Files) — and even then, launched by a non-admin user it
starts as "medium+" and still cannot touch anything at high IL.

The realistic options are therefore:
1. Ship `asInvoker` (default) and tell the user to run as administrator when the target is
   elevated. **Recommended.**
2. Ship `requireAdministrator`, which forces a UAC prompt on every launch and makes
   drag-and-drop from Explorer stop working. Not recommended for a normal-user tool.

The manifest shape, for reference:

```xml
<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
  <security>
    <requestedPrivileges>
      <requestedExecutionLevel level="asInvoker" uiAccess="false" />
    </requestedPrivileges>
  </security>
</trustInfo>
```

Electron sets `asInvoker` by default; only touch this if you consciously choose option 2.

---

## R-13 — Things deliberately NOT done

- **No low-level keyboard hook** (`WH_KEYBOARD_LL`). It would give a real
  focus/keystate signal but requires a registered callback called from the message loop,
  and any JS stall over the hook timeout gets the hook silently unregistered by Windows.
- **No `SetWinEventHook`.** Same registered-callback lifetime problem; polling is safer
  for v1. Revisit only with a measured reason.
- **No `keybd_event`/`mouse_event`.** Superseded by `SendInput`, and they cannot be
  batched atomically.
- **No `INPUT_HARDWARE`.** `HARDWAREINPUT` is declared only so the union's size is right;
  `SendInput` does not usefully accept `INPUT_HARDWARE` from user mode.
- **No absolute mouse movement.** The brief is buttons only. If movement is ever added,
  remember `MOUSEEVENTF_ABSOLUTE` coordinates are 0–65535 normalised to the **primary**
  monitor unless `MOUSEEVENTF_VIRTUALDESK` is also set.

---

## Quick smoke script for the tester

The spike's loose exports are now methods on one adapter, `windowsNative`, exported from
`src/injector/native/windows.ts`. The names map straight across, with three exceptions:

| Spike | Shipped |
|---|---|
| `getForegroundPid()` | `windowsNative.getFrontmostPid()`, which returns `null` (not 0) when unknown |
| `listApplications()` (rich entries) | `windowsNative.listWindows()`; `listApplications()` now returns the shared `AppInfo` shape |
| `getHeld()` | `getHeldKeyIds()` and `getHeldButtonIds()` |
| `isTrusted()` / `openAccessibilitySettings()` | `hasPermission()` / `openPermissionSettings()` |

`init()` is now explicit and asynchronous, and it must be awaited before anything that
touches the FFI. A failure is also parked on `windowsNative.initError`.

Run this from the built app's Node context (`npm run build` first, or point `tsx` at the
source):

```
node --input-type=module -e "
import { windowsNative } from './out/injector/native/windows.js';
await windowsNative.init().catch(e => { console.error('init failed:', e.message); process.exit(1); });
console.log(JSON.stringify(windowsNative.getDiagnostics(), null, 2));
console.log('foreground:', JSON.stringify(windowsNative.getForegroundApplication(), null, 2));
console.log('frontmost pid:', windowsNative.getFrontmostPid());
console.log('blocking:', JSON.stringify(windowsNative.describeForegroundBlocking(), null, 2));
const apps = windowsNative.listWindows();
console.log('apps:', apps.length);
for (const a of apps) console.log('  ', a.pid, a.windowCount, a.name, '|', a.title, '|', a.path);
console.log('enumeration errors:', windowsNative.getLastEnumerationErrors());
"
```

Expected: `initialised: true`, the `measuredLayout` block reporting `sizeofINPUT: 40` and
`unionOffset: 8`, `winmmAvailable: true`, and an app list that matches Alt+Tab. **This
script does not inject anything**, so it is safe to run before any of the injection tests.

Two more things worth recording while you are there:

- `windowsNative.beginHighResolutionTimers(1)` should return 0 (`TIMERR_NOERROR`), and
  every call must be balanced by `endHighResolutionTimers(1)`. `getTimerPeriodDepth()`
  should be back to 0 before you exit.
- `windowsNative.getDiagnostics().measuredLayout` is what the init assertion compared
  against. If init ever fails with "Refusing to inject input with an unknown struct
  layout", paste that block into the bug report: it names the field that disagreed.
