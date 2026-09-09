# KeyPress Ultimate: keyboard geometry and rendering notes

This describes how to render `keys.json` as a physically accurate full-size ANSI 104 keyboard.
Every dimension here is in **key units (u)**, the standard unit used by keyboard manufacturers
and keycap sets. Nothing in the data file is in pixels, so the UI picks one scale factor and
multiplies.

## 1. The unit

- `1u` = one standard square keycap pitch = **19.05 mm** (0.75 inch). This is the ANSI/ISO
  standard switch spacing, unchanged since the IBM Model M.
- A key of `unitWidth: 1.5` occupies 1.5 × 19.05 mm of horizontal pitch.
- Render scale: pick `U` in CSS pixels (a comfortable on-screen value is `U = 48px`, with
  `U = 34px` as a compact breakpoint). Then:
  - `keyWidth  = unitWidth  * U - gap`
  - `keyHeight = unitHeight * U - gap`
  - where `gap` is the visual gutter between caps, typically `0.09 * U` (≈ 4px at U=48).
  The gutter is subtracted *inside* the unit box so that a 1u key and two 0.5u keys occupy
  the same total pitch. Do not add the gutter as an outer margin, or rows will drift.

Because every row sums to an exact unit total (verified below), laying out with
`grid-template-columns` in fractional units or with absolute `left = cumulativeUnits * U`
both work. Absolute positioning is recommended for the numpad because of the 2u-tall keys.

## 2. Overall dimensions

| Block | Width | Notes |
| --- | --- | --- |
| Alphanumeric | 15u | The main block, rows 0-4 |
| Gap | 0.25u | |
| Navigation | 3u | PrtSc cluster + arrows |
| Gap | 0.25u | |
| Numpad | 4u | |
| **Total** | **22.5u** | |

Height:

| Band | Height |
| --- | --- |
| Function row | 1u |
| Vertical gap below function row | 0.5u |
| Main rows (5 rows × 1u) | 5u |
| **Total** | **6.5u** |

These are the real numbers: a tenkeyless (TKL) board is 18.25u × 6.5u (15 + 0.25 + 3), and a
full-size 104 is 22.5u × 6.5u. At `U = 48px` the whole keyboard is 1080 × 312 px, which is why
48px is a good default for a desktop window.

## 3. Vertical alignment across blocks

All three blocks share the same 6-row vertical rhythm. `row` in the data is the index within
the block's own band, and the bands line up like this:

| Screen row | y (u) | function | alphanum | navigation | numpad |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.0 | row 0: Esc, F1-F12 | — | — | — |
| — | 1.0 | *0.5u gap* | | | |
| 1 | 1.5 | — | row 0 (number row) | row 0 (PrtSc/ScrLk/Pause) | row 0 (NumLock / ÷ × −) |
| 2 | 2.5 | — | row 1 (QWERTY) | row 1 (Ins/Home/PgUp) | row 1 (7 8 9 +) |
| 3 | 3.5 | — | row 2 (home row) | row 2 (Del/End/PgDn) | row 2 (4 5 6) |
| 4 | 4.5 | — | row 3 (ZXCV) | row 3 (↑ only) | row 3 (1 2 3 Enter) |
| 5 | 5.5 | — | row 4 (modifiers) | row 4 (← ↓ →) | row 4 (0 .) |

So: `y = (section === 'function') ? row * 1u : 1.5u + row * 1u`.

The function section's `row: 1` (F13-F20) is **not** part of the 104 board. See §7.

## 4. The function row (15u, with gaps)

13 keys of 1u each = 13u, plus 2u of gaps:

```
Esc  [1u gap]  F1 F2 F3 F4  [0.5u gap]  F5 F6 F7 F8  [0.5u gap]  F9 F10 F11 F12
1u   +1.0      4×1u         +0.5        4×1u         +0.5        4×1u          = 15u
```

The gaps are structural, not data. Render them by inserting spacers after `key-escape`,
`key-f4`, and `key-f8`. The x offsets are:

| Key | x (u) |
| --- | --- |
| Esc | 0 |
| F1..F4 | 2, 3, 4, 5 |
| F5..F8 | 6.5, 7.5, 8.5, 9.5 |
| F9..F12 | 11, 12, 13, 14 |

## 5. The alphanumeric block (each row exactly 15u)

Row 0 — number row: 13 × 1u + Backspace 2u = **15u**
```
`  1  2  3  4  5  6  7  8  9  0  -  =  [Backspace 2u]
```

Row 1 — QWERTY: Tab 1.5u + 12 × 1u + Backslash 1.5u = **15u**
```
[Tab 1.5]  Q W E R T Y U I O P [ ]  [\ 1.5]
```

Row 2 — home row: CapsLock 1.75u + 11 × 1u + Enter 2.25u = **15u**
```
[Caps 1.75]  A S D F G H J K L ; '  [Enter 2.25]
```

Row 3 — bottom letters: LShift 2.25u + 10 × 1u + RShift 2.75u = **15u**
```
[LShift 2.25]  Z X C V B N M , . /  [RShift 2.75]
```

Row 4 — modifier row: 7 × 1.25u + Space 6.25u = **15u**
```
[Ctrl 1.25][Win 1.25][Alt 1.25]  [Space 6.25]  [Alt 1.25][Win 1.25][Menu 1.25][Ctrl 1.25]
```

This is the standard ANSI 104 bottom row. (The 1.5/1/1.5 "tsangan" bottom row is a
keyboard-enthusiast variant and is deliberately **not** used here.) Note that the Enter key on
ANSI is a single 2.25u rectangle on row 2 — it is only the *ISO* layout that has the tall
backwards-L Enter, which is why `unitHeight: 2` never appears in the alphanum block.

## 6. Navigation and numpad clusters

**Navigation (3u wide, x offset 15.25u).** A plain 3-column grid. Rows 0-2 are full; row 3
holds only the Up arrow (column 1); row 4 holds Left/Down/Right. Columns 0 and 2 of row 3 are
empty cells, which is what creates the classic inverted-T.

```
row 0:  PrtSc  ScrLk  Pause
row 1:  Insert Home   PgUp
row 2:  Delete End    PgDn
row 3:   ---    ↑      ---
row 4:    ←     ↓       →
```

**Numpad (4u wide, x offset 18.5u).** Two keys are double-height and overhang the row below,
which is why rows 2 and 4 do not sum to 4u:

```
row 0:  NumLock  /   *   -
row 1:    7      8   9   +      <- '+' is 1u wide, 2u tall, spans rows 1-2
row 2:    4      5   6  (+)
row 3:    1      2   3   Enter  <- 'Enter' is 1u wide, 2u tall, spans rows 3-4
row 4:  [  0  2u   ]  .  (Ent)
```

Only `numpad-add` and `numpad-enter` carry `unitHeight: 2`; the validator asserts exactly
that. When laying out with a CSS grid use `grid-row: span 2` on those two; when using absolute
positioning simply give them `height = 2 * U - gap`. Row 4's `0` is 2u wide, so row 4 has two
keys totalling 3u plus the 1u Enter overhang from row 3 = 4u.

## 7. Keys beyond the 104

`keys.json` holds **114** entries: the 104 base keys plus 10 marked `extra: true`. Extras must
not be drawn in the main grid; give them a separate opt-in strip (a "Mac / extended keys" panel).

| Extra | Section / row | Why |
| --- | --- | --- |
| `key-f13` … `key-f20` | function, row 1 | On Apple Extended keyboards. On Apple layouts F13/F14/F15 physically sit where a PC has PrtSc/ScrLk/Pause. |
| `key-fn` | navigation, row 5 | `kVK_Function` = 0x3F. Mac only. |
| `numpad-equals` | numpad, row 5 | Apple numpads carry `=` where a PC has Num Lock. |

Filter with `platformExclusive`: `'mac'`, `'win'`, or `null` (both). Three base keys are
`platformExclusive: 'win'` (`key-print-screen`, `key-scroll-lock`, `key-pause`) because they
have no macOS keycode at all. On macOS the UI should render them disabled with a tooltip
rather than hiding them, so the physical layout does not develop holes.

## 8. Labels

- `label` is the unshifted primary legend. `subLabel` is the shifted legend on the number row
  and symbol keys (`1`/`!`), and the navigation legend on the numpad (`7`/`Home`).
- `macLabel` / `winLabel` override `label` per platform when the key is genuinely named
  differently. Resolve as `platformLabel ?? label`. The ones that actually differ:

| id | macLabel | winLabel |
| --- | --- | --- |
| `key-enter` | Return | Enter |
| `key-backspace` | ⌫ Delete | Backspace |
| `key-delete` | ⌦ Delete | Delete |
| `key-insert` | Help | Insert |
| `numpad-num-lock` | Clear | Num Lock |
| `key-left-meta` / `key-right-meta` | ⌘ Command | Win |
| `key-left-alt` / `key-right-alt` | ⌥ Option | Alt |
| `key-left-ctrl` / `key-right-ctrl` | ⌃ Control | Ctrl |
| `key-left-shift` / `key-right-shift` | ⇧ Shift | Shift |
| `key-caps-lock` | ⇪ Caps Lock | Caps Lock |
| `key-escape` | ⎋ Esc | Esc |
| `key-tab` | ⇥ Tab | Tab |

Render the glyph and the word together on Mac (`⌘ Command`); the glyph alone is ambiguous to
users who don't know the symbols, and the word alone loses the visual anchor.

## 9. Keys that should be disabled in hold-mode

The data marks these with explanatory `notes`; the UI should visibly discourage selecting them:

- **Lock keys** — `key-caps-lock`, `numpad-num-lock`, `key-scroll-lock`. These toggle on the
  *down edge*. Holding them does not produce a sustained state; it just sets the lock once.
  Holding them down for minutes also risks the OS auto-repeating the toggle.
- **`key-fn`** — almost certainly not injectable (see §10).
- **Wheel entries in `mouse.json`** — `holdable: false`, see `mouse.json` notes.

The three lock keys carry `holdable: false` in the data, so the UI can grey them out
without re-deriving the list. `key-fn` is left `holdable: true` because its problem is
injectability, not hold semantics; it is gated by `platformExclusive: "mac"` plus its
`notes` instead, and stays behind the supervised manual test.

## 10. Platform caveats that affect the data

**Modifiers on macOS.** Shift/Ctrl/Option/Command are *not* delivered as KeyDown/KeyUp. macOS
sends `kCGEventFlagsChanged` (type 12) and carries the state in the event's flags mask. To hold
a modifier the app must post a flagsChanged event with both the keycode and the correct
`CGEventFlags` bit, and then **re-assert that flag mask on every subsequent synthetic event**,
or the modifier silently drops. All eight modifier entries carry this in `notes`.

**Enter vs numpad Enter on Windows.** They genuinely share `VK_RETURN` (0x0D). This is not a
data error; it is the Windows API. The pair is disambiguated by `winExtended: true` plus
scancode 0x1C on the numpad one. The validator therefore asserts that the
`(winVirtualKey, winExtended, winScanCode)` **triple** is unique, and allowlists this one VK
collision explicitly. macOS has a genuinely distinct code (`kVK_ANSI_KeypadEnter` = 0x4C).

**NumLock vs Pause scancodes.** Both are scancode 0x45 on real PS/2 hardware (Pause is actually
the prefixed sequence `E1 1D 45`, which `SendInput` cannot express). The data follows Chromium's
convention of marking NumLock extended (0xE045) and Pause non-extended (0x45) so the two remain
distinguishable. **Recommendation: inject by virtual key, not by scancode**, except where a
DirectInput/RawInput game requires scancodes — those games read scancodes directly and ignore VKs.

**PrintScreen.** Real hardware sends `E0 2A E0 37`. `MapVirtualKey(VK_SNAPSHOT, MAPVK_VK_TO_VSC)`
returns 0x54 (SysReq) on many systems rather than 0x37. The data carries 0x37 + extended, which
is the value that actually works with `SendInput`.

**F1-F12 on Apple hardware.** These only send F-keys when `fn` is held, unless the user enables
"Use F1, F2, etc. as standard function keys". This affects *physical* typing only — synthesized
`CGEvent`s with the F-key keycode are unaffected by that setting, so the app does not need to
care.

## 11. Provenance of the numbers

Nothing in `keys.json` was typed from memory:

- **`macKeyCode`** — parsed from Apple's `HIToolbox/Events.h` in the macOS 26.6 SDK at
  `.../MacOSX.sdk/System/Library/Frameworks/Carbon.framework/Versions/A/Frameworks/HIToolbox.framework/Versions/A/Headers/Events.h`.
  `crosscheck.mjs` re-parses that header and compares all 111 non-null values by constant name:
  **0 mismatches**.
- **`winScanCode` / `winExtended`** — derived from Chromium's `dom_code_data.inc`, whose `win`
  column encodes the 0xE0 prefix and is built from Microsoft's published Keyboard Scan Code
  Specification. The generator reads that file rather than hardcoding.
- **`winVirtualKey`** — Microsoft's *Virtual-Key Codes (Winuser.h)* reference table.
- **Mouse constants** — `CGEventType` and `CGMouseButton` values were obtained by *compiling and
  running* a C program against `ApplicationServices` on this machine (macOS 26.6 arm64), not from
  the header text, because those enum members are defined indirectly via IOKit `NX_*` constants.
  Confirmed: LeftMouseDown=1, LeftMouseUp=2, RightMouseDown=3, RightMouseUp=4, ScrollWheel=22,
  OtherMouseDown=25, OtherMouseUp=26; buttons Left=0, Right=1, Center=2.
  `MOUSEEVENTF_*` values come from Microsoft's `MOUSEINPUT` reference.

## 12. Files

- `keys.json` — 114 key definitions (104 base + 10 extras)
- `mouse.json` — 7 mouse entries (5 holdable + 2 wheel)
- `generate.mjs` — regenerates both from the authoritative sources
- `validate.mjs` — 39 assertions; exit code 0 = pass. Wired into `npm test`.
- `crosscheck.mjs` — independent re-verification against `Events.h`. Resolves the SDK with
  `xcrun --show-sdk-path` at runtime and exits 0 with a SKIP line off macOS. Wired into `npm test`.
- `dom_code_data.inc` — Chromium's DomCode table, vendored so `generate.mjs` runs from a
  clean checkout with no external inputs.

## 13. Mapping onto the shared type contract

`src/shared/types.ts` is the locked contract; `src/shared/keys.ts` is the only module that
reads these two JSON files. The data was reshaped to match it exactly:

- Every key carries `holdable: boolean` (see section 9).
- Mouse ids are the bare `MouseButtonId` union values (`left`, `wheel-up`, ...), not the
  older `mouse-` prefixed ids.
- Mouse fields are `macButton`, `macDownType`, `macUpType` (previously `macButtonCode`,
  `macEventTypeDown`, `macEventTypeUp`).

Four fields in the JSON are deliberately outside the contract and are read through
`getKeyMeta()` or straight from the JSON by the injector: `domCode` and `platformExclusive`
on keys, and `macDraggedType`, the `*Constant` provenance strings and
`repeatIntervalMsDefault` on mouse entries. JSON has no `undefined`, so the optional string
fields (`subLabel`, `macLabel`, `winLabel`, `notes`) are `null` on disk and are converted to
`undefined` once, in `keys.ts`.
