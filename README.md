# KeyPress Ultimate

KeyPress Ultimate holds keyboard keys and mouse buttons down for you, but only while an app you picked is the frontmost window. Hold `W` and the left mouse button in Minecraft to AFK-farm, and everything releases the instant you tab away to Discord.

It's free and open source, it runs on macOS and Windows, and it has no account, no telemetry and no background daemon. Before you download it, read [Limitations](#limitations): some games won't see the input at all, and some anti-cheats will notice it.

## Download

Every build is on the [Releases page](../../releases/latest).

- macOS 13 or later: `KeyPress-Ultimate-<version>-universal.dmg`. One download covers Apple Silicon and Intel.
- Windows 10 and 11, 64-bit: `KeyPress-Ultimate-Setup-<version>-x64.exe`, or `KeyPress-Ultimate-<version>-x64-portable.exe` if you'd rather not install anything.

The app isn't signed by Apple or Microsoft, so the first launch takes an extra click on both platforms. [INSTALL.md](INSTALL.md) walks through that, the macOS Accessibility permission, and how to check the SHA-256 of your download.

## How it works

Pick your keys on the on-screen keyboard, pick which apps count as targets, press Start.

From then on the app checks which window is frontmost every 25 ms. If that window belongs to a target you chose, your keys are held down. If it belongs to anything else, they're released before the next tick, including when the frontmost window is KeyPress Ultimate itself.

That last part surprises people, so it's worth saying twice: while you're looking at the KeyPress Ultimate window, nothing is being pressed. The status line reads "Armed, waiting for Minecraft" and the keys sit still. That's the app working, not the app failing. Cmd-Tab or Alt-Tab into Minecraft and the keys light up.

Focus gating is the whole point. A held key that follows you out of the game and into your browser is how you end up typing `wwwwwwwwwwww` into a Google Doc, or holding Cmd+W and closing a window. This app can't do that, because the release doesn't wait for you to notice.

There are three modes. Hold sends one key-down on arrival and one key-up on departure, with nothing in between. Hold + Repeat adds the OS autorepeat an application expects, at 400 ms before the first repeat and 33 ms between repeats. Tap sends down-up pairs at an interval you pick, between 10 ms and 1000 ms, which is the autoclicker shape.

For the mechanics underneath, see [docs/how-it-works.md](docs/how-it-works.md).

## Limitations

Read these before you download. They're real, and none of them are getting fixed.

- Kernel-level anti-cheat detects this. Vanguard, Easy Anti-Cheat and BattlEye run below the operating system's event stream, so they can tell a synthesized key from a typed one no matter how carefully it was generated. Some games will ignore the keys. Some may ban you for using them. KeyPress Ultimate makes no attempt to evade anti-cheat and never will, so don't take it into a competitive multiplayer game and expect it to go unnoticed.
- Games that read the keyboard through raw HID may not see the input at all. A game that talks to `IOHIDManager` on macOS, or reads input devices directly rather than going through the OS event stream, is listening below the layer these events are posted into. There's no error to show you when that happens: the keys look held in KeyPress Ultimate and nothing moves in the game. Fixing it properly means shipping a virtual HID driver, which is a much heavier thing than this app is.
- Force-quitting both processes at once can leave a key down. If you `kill -9` the app mid-hold, no handler gets to run. The next launch reads its journal file, releases whatever was held, and tells you it did. Tapping the physical key also clears it.
- On Windows, a game running as administrator won't accept input from a non-elevated app. Windows blocks it at the OS level, a rule called User Interface Privilege Isolation (UIPI). The app detects the case and tells you to restart KeyPress Ultimate as administrator instead of silently doing nothing.

Where it does work well: Minecraft, most singleplayer Unity and Unreal games, browser games, and ordinary apps that want a key held down.

## macOS Accessibility permission

macOS won't let any app synthesize keyboard or mouse events without explicit permission, and holding a key down is exactly that. So on first use you'll be sent to System Settings > Privacy & Security > Accessibility to turn KeyPress Ultimate on. Windows has no equivalent step and asks for nothing.

Accessibility is the only permission the app requests. It never asks for Input Monitoring, which is the permission that would let it read what you type. The app checks its own permission once a second for the whole session rather than only at Start, so revoking it while keys are held releases them immediately instead of stranding them.

You may have to grant the permission again after an in-app update. The app isn't signed with a paid Apple certificate, so macOS identifies it by a fingerprint that changes with every build and treats the update as a different app. The app tells you when that's happened.

## Safety

A stuck key is the worst thing this app could do to you, so it's the failure the design spends the most on. Every one of these paths calls the same idempotent release, which posts key-ups in reverse press order with modifiers last:

- Focus loss: released before the next 25 ms tick. On macOS each key-up is posted twice, first directly to the app that was holding the key so it definitely sees the release, then globally to clear system state.
- Stop, quitting, closing the window, or the target app quitting: released, then the injector process is killed.
- Sleep and lock screen: `powerMonitor` suspend and the lock screen both release. You don't come back from a lid close with `W` still down.
- Crash: the keys are held by a separate process from the UI, and the two exchange a heartbeat every 100 ms with a 300 ms timeout. If either one dies, the other releases everything. An uncaught exception, SIGINT, SIGTERM or SIGHUP releases before exiting.
- Both processes killed at once: before the first key-down, the app fsyncs a journal of what it's about to hold to `held-keys.json`, and deletes it after a clean release. If that file is still there on the next launch and the process that wrote it is dead, the app posts the missing key-ups and tells you it recovered N keys.
- Panic hotkey: Cmd+Option+Shift+K on macOS, Ctrl+Alt+Shift+K on Windows. It's registered only while a session is armed, and shown in Settings so you can check it before you need it. If the OS refuses to register it, Start is refused too, because a panic button that silently does nothing is worse than no panic button.

There's also a session length cap, 30 minutes by default, so an app you forgot about doesn't hold a key all night.

One more deliberate choice: there's no tray mode and no background daemon. KeyPress Ultimate is a visible window or it isn't running, and closing the window quits the process on both platforms.

## Build from source

You need Node 20 or later and npm.

```sh
npm ci
npm test          # key-data validators plus the unit tests
npm run typecheck
npm run build     # compiles main, preload and renderer into out/
```

`npm run dev` starts the app with hot reload. To work on the interface without Electron at all, run `npx vite src/renderer` and open the printed URL: the renderer detects it isn't in Electron and runs against a mock bridge that enumerates fake apps, rotates the frontmost window on a timer, and drives the whole session state machine. Nothing native is loaded, so there's nothing to permit and nothing to hold down.

To produce installers, run `npx electron-builder --mac` or `npx electron-builder --win` after `npm run build`. Artifacts land in `dist/`. A local build is unsigned, so the Gatekeeper and SmartScreen steps in [INSTALL.md](INSTALL.md) apply to it the same way they apply to a release download.

Native input goes through koffi FFI rather than a compiled native module, so there's no node-gyp and no build toolchain to install.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports are welcome, and the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) asks for the things needed to reproduce a timing bug. Pull requests that add anti-cheat evasion will be closed.

## License

MIT, see [LICENSE](LICENSE). Third-party licenses and what each one obliges are listed in [THIRD_PARTY_LICENSES/README.md](THIRD_PARTY_LICENSES/README.md).
