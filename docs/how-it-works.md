# How it works

This is what happens after you press Start: what checks the focus, what posts the keys, and why the app runs as two processes instead of one. The README covers enough if you only want to use the thing.

## Two processes

The window you see and the code that holds your keys down are different processes.

The main process owns the lifecycle: it lists the apps you can target, watches permissions, stores your presets, and checks for updates. When you press Start it forks a second process, the injector, and hands it your configuration. The injector is the only thing in the app that ever posts an input event. When you press Stop, the main process kills it.

The split buys two things. Renderer animation can't jitter key timing, because the loop doing the timing isn't sharing a thread with React. And each process watches the other: they exchange a heartbeat every 100 ms with a 300 ms timeout, so if the UI crashes, the injector releases every key and exits, and if the injector dies, the main process knows within a third of a second instead of leaving you to wonder.

## The tick

The injector runs a 25 ms loop. Every tick it does the same thing in the same order: ask the OS which window is frontmost, decide whether that window belongs to one of your targets, and then hold, release, or do nothing.

Two details make the loop trustworthy.

The first is that the focus check happens before every assert, not once at Start. There's no cached "we're on target" flag that can go stale. If the answer changes, the keys change on the next tick.

The second is that the loop schedules against an absolute deadline, `t0 + n * period`, rather than calling `setTimeout(fn, 25)` from inside itself. Recursive `setTimeout` accumulates every millisecond of lateness: measured at a 20 ms period, it drifted 140 ms over six seconds. Absolute deadlines don't drift, and a regression test holds p99 tick error under 1 ms over 300 ticks.

## Where "frontmost" comes from

On macOS it's the owner pid of the front layer-0 window from `CGWindowListCopyWindowInfo`. The obvious API, `NSWorkspace.frontmostApplication`, is not used, because it's wrong: during testing it reported the same stale application for 231 seconds across 16 real focus changes. The window-list call takes about 104 microseconds and has never been observed stale.

On Windows it's `GetForegroundWindow` followed by `GetWindowThreadProcessId`.

Either call can fail or return nothing. When that happens the answer is treated as "not on target", so the failure mode of not knowing where focus is, is releasing your keys.

Targets are matched by a stable identity rather than a pid: the bundle identifier on macOS, the lowercased executable path on Windows. That means your target survives the game quitting and restarting, and it means the app can reliably exclude itself.

## Why nothing fires while you're looking at the app

The app excludes itself from the target list, and every tick it also hard-checks the frontmost pid against its own. If KeyPress Ultimate is what's focused, the session sits in armed-waiting and holds nothing.

This is the thing people report as a bug most often, so the interface goes out of its way to say it: the plate border changes, and the status line reads "Armed, waiting for Minecraft" with the currently focused app named next to it. Nothing is broken. Switch to the game.

The alternative would be an app that can type into its own settings fields, which is not an app anyone should install.

## Regaining focus without closing your window

When focus lands back on a target, the loop doesn't press immediately. It waits 150 ms, then checks whether you're still physically holding a modifier, and only presses once your hands are clear, giving up after 2 seconds.

The reason is Cmd-Tab and Alt-Tab. At the instant the switch completes you're usually still holding Cmd or Alt. Press a held `W` into that and the game receives Cmd+W, which on macOS closes the window. The settle plus modifier gate exists so that switching into your game doesn't close your game.

## The three modes

- Hold sends one key-down when you arrive on target and one key-up when you leave. Nothing in between. The app never re-asserts a key it believes is already down, because blind re-assertion is how one held `W` becomes seven characters in a text field.
- Hold + Repeat re-sends the key-down with the OS autorepeat flag set, and never sends an intermediate key-up, which is what a real keyboard's typematic repeat looks like to an application. Defaults are 400 ms before the first repeat and 33 ms between repeats after that.
- Tap sends down and up pairs at an interval you choose, between 10 ms and 1000 ms. This is the autoclicker shape.

Locks (Caps Lock, Num Lock, Scroll Lock) and the scroll wheel can't be held, because there's no such thing as a held lock or a held scroll. They're drawn differently and converted into a single tap or a repeating scroll.

## macOS, specifically

Events are posted to `kCGHIDEventTap` from a single shared `CGEventSource` created with `kCGEventSourceStateHIDSystemState`, which puts them as close to the bottom of the input stack as an unprivileged process can get.

Two settings on that source matter more than they look. Its local-events suppression interval is forced from the 0.25s default to `0.0`, and its filter is set to permit all events. Without both, your own keyboard and mouse go dead while the app holds a key: the OS assumes a program posting events wants the human out of the way. A regression test reads the interval back and asserts it's zero.

Modifiers are posted as `kCGEventFlagsChanged` rather than key-down and key-up, because that's what the hardware does and what applications watch for. The cumulative modifier mask is stamped onto every other event the app posts, so a held Shift is actually a held Shift for the keys that follow.

On focus loss, each key-up is posted twice: first with `CGEventPostToPid` aimed at the app that was holding the key, so it definitely sees the release even if it's about to stop receiving global events, and then globally to clear system state.

The App Sandbox is never enabled. Under the sandbox, `CGEventPost` silently does nothing, which is the worst possible failure: the app looks like it's working and no input arrives.

## Windows, specifically

Input goes through `SendInput` with `KEYEVENTF_SCANCODE` and `wVk = 0`, plus `KEYEVENTF_EXTENDEDKEY` for the 0xE0-prefixed keys, because games generally read scancodes rather than virtual keys. A few titles read virtual keys instead, so Settings has a "Send virtual keys instead of scancodes" switch that changes the method.

The INPUT records are written byte-by-byte into a preallocated Buffer rather than going through koffi's union marshaller, and `init()` asserts the struct sizes and offsets against `koffi.sizeof` and `koffi.offsetof` before injecting anything. If the layout doesn't match what's expected on x64, the app refuses to inject rather than posting garbage into whatever you had open.

`SendInput` returning success is never treated as proof that anything happened. Under User Interface Privilege Isolation, a non-elevated app injecting into an elevated window gets a success return and no effect. Elevation is detected separately and surfaced as a message telling you to restart the app as administrator.

The injector also raises the system timer resolution with `timeBeginPeriod(1)` at arm and balances it with `timeEndPeriod(1)` at disarm, because a `utilityProcess` doesn't inherit the raised resolution Chromium sets for itself, and a 25 ms loop on a 15.6 ms timer isn't a 25 ms loop.

## Why some games see nothing

Everything above posts into the operating system's event stream. An application that reads the event stream sees it, and can't tell the difference at that layer.

An application that opens input devices directly, through `IOHIDManager` on macOS or raw device reads elsewhere, is reading below the layer these events are injected into, so it sees nothing at all. There's no error and no signal: KeyPress Ultimate shows the keys as held and the game does nothing.

Fixing that means creating a virtual HID device, which is what Karabiner-Elements does on macOS with a kernel driver. That's a fundamentally heavier architecture, with a driver to sign and install, and it's out of scope.

Kernel-level anti-cheat is the same layering problem pointed the other way. Vanguard, Easy Anti-Cheat and BattlEye run below the event stream and can see that an event was synthesized rather than typed. No amount of care at this layer hides that, and this app doesn't try. Assume anti-cheat will notice.

## Making sure nothing stays down

A stuck key is the failure that actually hurts, so every path out of a session funnels into the same idempotent `releaseAll()`, which posts key-ups in reverse press order with modifiers last:

stop pressed, target loses focus, target quits, app quit, window close, `uncaughtException`, SIGINT, SIGTERM, SIGHUP, `powerMonitor` suspend, lock screen, permission revoked mid-session, heartbeat timeout, panic hotkey, and the session length cap (30 minutes by default).

That covers everything where some code of ours still gets to run. For the case where it doesn't, both processes killed at once, there's a journal: before the first key-down, the app writes and fsyncs the list of what it's about to hold to `held-keys.json` in its user data directory, and deletes the file after a clean release. On the next launch, if that file exists and the process that wrote it is dead, the app posts ups for everything listed and tells you it recovered and released N keys.

The panic hotkey is registered only while a session is armed. If `globalShortcut.register` returns false, meaning something else on the system already owns that combination, Start is refused rather than arming a session with a panic button that silently does nothing.

## Permissions

macOS requires Accessibility, and only Accessibility. Input Monitoring was tested and isn't needed for either keys or mouse buttons, so the app never asks for it. The check is `systemPreferences.isTrustedAccessibilityClient(false)`, polled once a second for the whole session rather than once at Start, so revoking the permission mid-hold releases your keys instead of stranding them.

macOS shows its permission prompt once per app identity and never again, so if you deny it, the in-app screen leads with a deep link into the Accessibility pane plus instructions for adding the app with the `+` button, rather than waiting on a dialog that won't come back.

Windows requires no permission at all. The only privilege question there is elevation, and that's checked at Start, not at launch.

## Key data

The 114 key definitions in `data/keys.json` (104 base ANSI keys plus 10 extras) aren't hand-typed. They're generated from Chromium's `dom_code_data.inc`, which is itself built from Apple's `HIToolbox/Events.h` and Microsoft's scancode specification, so the macOS keycodes and Windows scancodes come from the same authority the browsers use. A crosscheck script re-verifies all 111 non-null macOS keycodes against the `Events.h` in your installed SDK, and found zero mismatches. Hand-editing the JSON is not allowed, because a wrong keycode means the app confidently holds down the wrong key.
