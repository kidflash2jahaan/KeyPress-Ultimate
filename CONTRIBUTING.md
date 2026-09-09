# Contributing

Bug reports are the most useful thing you can send, especially from Windows, where the native layer has had far less real-hardware time than the macOS one. Pull requests are welcome too, with the scope limits below.

## What this project won't accept

Saying this up front saves everyone the work:

- Anti-cheat evasion of any kind. No driver-level input, no timing jitter meant to look human, no hiding the process. If a game blocks synthetic input, the honest answer is that the game blocks synthetic input.
- A tray mode, a background daemon, or anything that keeps the app running invisibly. The app is a visible window or it isn't running, and closing the window quits the process. A tool that holds your keys down should never be something you can forget is open.
- Macro recording, key remapping, or a scripting language. This app holds keys down. That's the whole product.
- Per-window targeting, Linux support, and mobile. Out of scope for v1.
- Fonts or assets that can't be redistributed. See [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES/README.md).

Everything else is fair game: bug fixes, key data corrections, accessibility work, platform-specific input problems, and interface improvements that keep the existing rules.

## Getting set up

Node 20 or later, npm. There's no native toolchain to install, because input goes through koffi FFI rather than a compiled node module.

```sh
npm ci
npm test          # key-data validators plus the unit tests
npm run typecheck # main/injector/preload, then renderer
npm run lint
npm run dev       # the real app, with hot reload
```

To work on the interface without Electron, run `npx vite src/renderer` and open the printed URL. The renderer notices it isn't in Electron and falls back to the mock bridge in `src/renderer/mock/bridge.ts`, which enumerates fake apps, rotates the frontmost window on a timer, refuses Start for the same reasons the real controller does, and drives the session from idle through armed-waiting to firing. Nothing native loads, so nothing gets held down. Do UI work here.

## Where things live

```text
data/            generated key and mouse data, plus its validators
src/shared/      types, IPC contract, key helpers, semver. Imported by all three processes
src/main/        lifecycle, app registry, session control, permissions, store, updater
src/injector/    utilityProcess: the hold loop and the two native adapters
src/preload/     the contextBridge surface
src/renderer/    React UI, tokens, components, mock bridge
```

`src/injector/native/macos.ts` and `src/injector/native/windows.ts` are the only two files allowed to call koffi. If you find yourself importing koffi anywhere else, the change belongs behind the `NativeInput` interface in `src/injector/native/types.ts` instead.

## Rules that aren't negotiable

Each of these exists because breaking it produced a real, measured failure. They're explained in [docs/how-it-works.md](docs/how-it-works.md) and the design spec under `docs/superpowers/specs/`.

- `releaseAll()` stays idempotent and reachable from every exit path. If you add a new way for a session to end, wire it into the same fan-in as stop, focus loss, quit, crash, sleep and the panic hotkey.
- Never re-assert a key in hold mode. Blind re-assertion turns one held `W` into seven characters in a text field.
- Focus comes from `CGWindowListCopyWindowInfo`'s front layer-0 window owner on macOS, never `NSWorkspace.frontmostApplication`, which was measured frozen for 231 seconds across 16 real focus changes.
- The macOS event source keeps its local-events suppression interval at `0.0`. At the 0.25s default, the user's own keyboard and mouse go dead while the app holds a key. A regression test reads the value back.
- Never enable the macOS App Sandbox. It silently no-ops `CGEventPost`, so the app looks fine and does nothing.
- On Windows, INPUT records are written byte-by-byte into a preallocated Buffer, never through koffi's union marshaller, and `init()` asserts the struct layout before it will inject anything.
- `data/keys.json` and `data/mouse.json` are generated, never hand-edited. Change `data/generate.mjs` and re-run it. `data/validate.mjs` and `data/crosscheck.mjs` run as part of `npm test`, and crosscheck compares all 111 non-null macOS keycodes against Apple's `Events.h` through `xcrun --show-sdk-path`, skipping cleanly off macOS.
- Colour encodes state and nothing else. There is exactly one accent, the amber that means current is flowing. If a change introduces a second coloured element anywhere in the interface, it makes the one thing users can't afford to misread harder to read.
- At most one looping animation in the whole app, on the global holding indicator. Selection is static. `prefers-reduced-motion` is honoured.
- No em dashes in user-facing copy. Use a comma, a colon, or two sentences.
- TypeScript `strict`, and no `any` in `src/shared` or `src/main`.

## Testing

`npm test` runs the data validators and the vitest suite. Both have to be green before a pull request is reviewed, along with `npm run typecheck`.

The native layers are tested without posting any real input: the macOS tests rebuild the exact `CGEvent`s and inspect their type, keycode and flags, and the Windows tests assert that hand-written INPUT records are byte-identical to what koffi's marshaller produces, then check the module imports cleanly on a non-Windows host.

That leaves a gap, and it's worth being blunt about it: the Windows native code was written on macOS from Microsoft Learn and the koffi source. If you have a Windows machine, [docs/windows-testing-checklist.md](docs/windows-testing-checklist.md) is the script, and results from it are more valuable than most code changes.

Timing changes need the scheduler test to still pass at p99 tick error under 1 ms over 300 ticks. That test is the reason the loop uses absolute deadlines: recursive `setTimeout` drifted 140 ms over six seconds at a 20 ms period.

## Pull requests

- One change per pull request, with the reasoning in the description rather than only in the diff.
- Say which platform you tested on and how. "Typechecks" isn't testing.
- If you changed anything in the release, focus or failsafe paths, say what you did to confirm no key can be left down.
- New copy follows the writing rules above. Read it out loud first.
