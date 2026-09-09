---
name: Bug report
about: Something doesn't work, or a key got stuck
title: ''
labels: bug
assignees: ''
---

Before filing, two things that aren't bugs:

- Nothing fires while the KeyPress Ultimate window is focused. That's the focus gating working. Tab into your target app and the keys light up.
- A kernel anti-cheat, or a game that reads raw HID, ignoring the input. See Limitations in the README. There's no fix coming for those.

If a key is stuck right now: press the panic hotkey (Cmd+Option+Shift+K on macOS, Ctrl+Alt+Shift+K on Windows), or tap the physical key. Then come back and file this.

## What happened

## What you expected instead

## Steps to reproduce

1.
2.
3.

Does it happen every time, or intermittently? If intermittently, roughly how often?

## Version and machine

- KeyPress Ultimate version:
- OS and version (for example macOS 26.1, or Windows 11 23H2):
- Mac only, Apple Silicon or Intel:
- Installed from the .dmg / the .exe installer / the portable build / built from source:
- Target app and version (for example Minecraft Java 1.21.4):
- Keys and buttons selected:
- Mode (Hold, Hold + Repeat, Tap) and the interval if you changed it:

## Windows only

- Is the game running as administrator?
- Is KeyPress Ultimate running as administrator?
- Did the "Send virtual keys instead of scancodes" switch in Settings change anything?

## macOS only

- Is KeyPress Ultimate turned on in System Settings > Privacy & Security > Accessibility?
- Did the app say anything about the permission needing to be re-granted after an update?

## What the app said

Paste the status line at the bottom of the window, and anything in the message area. If the app showed an error, the exact text matters more than a paraphrase of it.

## Anything else

Screenshots or a short screen recording help a lot for timing and visual bugs. If the app crashed, a crash log is welcome: on macOS look in Console under Crash Reports, on Windows in Event Viewer under Windows Logs > Application.

If a key was left down after the app exited, say whether the recovery message appeared on the next launch. That message names how many keys the journal released, and knowing whether it fired tells us which failsafe missed.
