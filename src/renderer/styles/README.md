# Design tokens

Three files, imported in this order by `global.css`, which is the only stylesheet the renderer
entry needs to import:

```ts
import '@renderer/styles/global.css'
```

- `fonts.css` declares the two typefaces.
- `tokens.css` declares every value.
- `global.css` spends them: reset, base type, focus, scrollbars, drag regions.

`tokens.test.ts` asserts the contract below on the real files. If you change a value, run
`npx vitest run src/renderer/styles/tokens.test.ts` before you commit.

## The one rule

Colour encodes state and nothing else.

`--sig` is amber and it means "current is flowing". Nothing else in the app is coloured. Not a
brand accent, not a hover, not a focus ring, not a link, not a selected key, not a chart, not a
logo. Misreading whether keys are firing is the one failure mode that actually hurts the user, so
amber has to be unambiguous everywhere it appears.

Two corollaries that are easy to forget:

- Selection is a neutral fill (`--sel`), and it is static. VIA can pulse its selected key because
  exactly one key is ever selected. With fifteen keys selected, fifteen looping glows is noise.
  All of the motion budget goes to the firing state.
- The focus ring is `--text`, not `--sig`. A focused button is not firing anything.

If you need to separate two things and you reach for a colour, use weight, size, spacing or a
border instead.

## Tokens

### Surfaces

| Token | Means |
| --- | --- |
| `--bg` | The window ground, behind every band. |
| `--bg-raised` | Panels above the ground: header, sheets, popovers, menus. |
| `--plate` | The machined tray the keycaps are set into. |
| `--cap` | A keycap body / its front face. |
| `--cap-top` | The lit upper bevel of a keycap. Light comes from above. |
| `--cap-edge` | The cut edge where a cap meets the plate. |

### Text

| Token | Means |
| --- | --- |
| `--text` | Primary reading text and key legends. Also the focus ring. |
| `--text-dim` | Secondary text: sub-legends, metadata, inactive labels. |
| `--text-faint` | The quietest tier that is still real information. Still clears AA. |

### Lines

| Token | Means |
| --- | --- |
| `--line` | Hairline separators between bands and rows. |
| `--line-strong` | A deliberate boundary: plate outline, input border. |

### Signal (reserved)

| Token | Means |
| --- | --- |
| `--sig` | The amber fill of a firing key, and the live holding indicator. Nothing else. |
| `--sig-ink` | The legend printed on top of a firing fill. |
| `--sig-glow` | The halo colour around a firing element. Use as a `box-shadow` colour. |

### Status

| Token | Means |
| --- | --- |
| `--ok` | A completed recovery, or a granted permission. Never decoration. |
| `--danger` | A real failure, or a destructive action. Never decoration. |

### Selected (neutral, never animated)

| Token | Means |
| --- | --- |
| `--sel` | Fill of a selected keycap or chip. |
| `--sel-edge` | Its ring. |
| `--sel-text` | Legend colour on a selected fill. |

### Depth

| Token | Means |
| --- | --- |
| `--shadow-1` | Resting lift: a plate, a chip. |
| `--shadow-2` | Something that arrived: sheet, popover, menu. |

### Geometry

| Token | Means |
| --- | --- |
| `--u` | The key unit, in CSS pixels. Everything on the board is a multiple of it. |
| `--gap` | Gutter between keycaps, `0.09 * --u`. Subtract it inside the unit box. |
| `--radius-1` | 3px. Inner faces, chips, tags. |
| `--radius-2` | 6px. Keycaps, buttons, inputs. |
| `--radius-3` | 10px. Plates, panels, sheets. |
| `--keyboard-units` | 22.5, the width of a full-size 104 board in units. |
| `--keyboard-inset` | Total horizontal padding of the keyboard band, both sides combined. |
| `--space-1` … `--space-7` | 4, 8, 12, 16, 24, 32, 48px layout scale. Dense on purpose. |
| `--press-travel` | How far a keycap travels when it fires. Zeroed under reduced motion. |
| `--titlebar-height` | Height of the drag band. |
| `--titlebar-lights-inset` | Leading clearance for the macOS traffic lights. Set to 0 on Windows. |

`--u` is solved from the viewport rather than stepped at a breakpoint:

```css
--u: clamp(30px, calc((100vw - var(--keyboard-inset)) / var(--keyboard-units)), 48px);
```

It lands on exactly 48px at the 1180px default window, tapers continuously as the window narrows
(about 44px at the 1100px minimum), and floors at 30px. Below the floor the keyboard band scrolls
horizontally instead of shrinking further, because dual-legend keys stop being readable.

### Motion

| Token | Means |
| --- | --- |
| `--dur-fast` | 90ms. A key press or release. |
| `--dur-base` | 160ms. Hover, selection settle, a chip arriving or leaving. |
| `--dur-slow` | 260ms. A surface that changes size: settings sheet, popover. |
| `--ease-out` | `cubic-bezier(0.22, 0.61, 0.36, 1)`. Anything the user initiated. |
| `--ease-spring` | `cubic-bezier(0.34, 1.4, 0.64, 1)`. The release of a keycap only. |

Why these numbers, since "honest values" is the point:

- 90ms because a physical switch actuates in about 5ms and the eye reads anything under roughly
  100ms as instant. 90ms is the longest a press can take while still feeling like the key answered.
- 160ms because it is long enough to be seen as a transition, and short enough that selecting
  fifteen keys in a row never queues up a visible backlog.
- 260ms is the ceiling. Nothing in this app should be slower.
- `--ease-spring` overshoots at 1.4 rather than the usual 1.7, because the travel is 2px. A big
  overshoot on 2px reads as a rendering bug, not as springiness.

Nothing is slower than `--dur-slow`, and only `transform` and `opacity` are ever animated. Never
write `transition: all`.

### Type

| Token | Means |
| --- | --- |
| `--font-sans` | Geist, then the system fallbacks. UI and key legends. |
| `--font-mono` | Geist Mono, then the system fallbacks. Timers, counts, codes, key IDs. |

Use `--font-mono` (or the `[data-numeric]` attribute, which sets it) for anything that ticks. It
carries `font-variant-numeric: tabular-nums`, so the elapsed-time readout does not jitter.

The sans fallback stack is not boilerplate. Geist has no glyphs for the Apple modifier legends this
app has to print: U+2318 command, U+2325 option, U+2303 control, U+21EA caps lock, U+238B escape,
U+232B delete-left, U+2326 delete-right. CSS falls back per character, so `-apple-system`,
`'Segoe UI Symbol'` and `'Apple Symbols'` sit in the stack purely to supply those seven glyphs.
Do not shorten the stack. `tokens.test.ts` guards it.

## Theming

1. Bare `:root` carries the complete light palette. Every colour has its one canonical definition
   there, so no value lives only inside a media query.
2. Dark redefines only what changes, in two places: `@media (prefers-color-scheme: dark)` guarded
   as `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`. The second block comes
   last, so a manual "dark" choice beats a light OS at equal specificity.
3. `:root[data-theme="light"]` needs no palette of its own. The media block is guarded with
   `:not([data-theme="light"])`, so an explicit light choice falls straight back to the bare
   `:root` values and wins against a dark OS. That block exists only to pin `color-scheme`.
   One copy of light is deliberate: a third copy is a third thing to drift.

The two dark blocks have to stay byte-identical. `tokens.test.ts` fails if they diverge.

`color-scheme` is set in every branch so native scrollbars and form controls follow the theme.

## Reduced motion

`@media (prefers-reduced-motion: reduce)` in `tokens.css` collapses `--dur-*` to 1ms, flattens both
eases to `linear`, and sets `--press-travel: 0px`. A component that writes
`translateY(var(--press-travel))` therefore needs no media query of its own.

A catch-all rule clamps any remaining animation and transition durations. If a transform exists
purely as motion and cannot be expressed through `--press-travel`, put `data-motion-transform` on
the element and it is neutralised outright. Only use that attribute when the transform is motion
and nothing else, because it kills static transforms too.

## Frameless window

The window has no OS title bar, so the app has to hand back a place to grab.

- Put `.app-drag` on the header band, or on any strip that should move the window.
- Anything interactive inside a drag region must be undraggable or it stops responding to clicks.
  `global.css` already covers `button`, `a`, inputs, `[role="button"]`, `[role="menu"]`,
  `[role="menuitem"]` and anything with a real `tabindex`. For anything custom, add `.app-no-drag`.
- Overlays (`[role="dialog"]`, `[role="menu"]`, `[role="listbox"]`, `[data-overlay]`) are already
  no-drag, so grabbing a menu does not move the window.

## Hooks global.css already provides

Use these instead of re-solving them per component.

| Hook | Does |
| --- | --- |
| `.app-drag` | Marks a strip as the window drag region. |
| `.app-no-drag` | Opts an element back out of dragging inside one. |
| `.skip-link` | Keyboard-only skip target. Hidden until focused, then slides in. |
| `[data-focus-group]` | Draws one focus ring on a compound control when anything inside is focused. |
| `[data-selectable]` | Re-enables text selection on content worth copying. Body is `user-select: none`. |
| `[data-numeric]` | Mono face with tabular figures. Put it on anything that ticks. |
| `[data-scroll]` | Makes a pane scroll and keeps the scroll from chaining into the window. |
| `[data-overlay]` | Marks a floating surface. Already no-drag. |
| `[data-motion-transform]` | Neutralises a transform under reduced motion. Motion-only transforms. |

Scrollbars are themed through `scrollbar-width` and `scrollbar-color` rather than
`::-webkit-scrollbar`. Chromium ignores the webkit pseudo-elements on any scroller that also sets
the standard properties, and giving `::-webkit-scrollbar` a width forces a classic scrollbar that
takes layout space, which would shift the keyboard band the moment a pane overflowed.

## Contrast

Measured on the shipped values, WCAG 2.x. Every pair below passes.

| Pair | Light | Dark | Needs |
| --- | --- | --- | --- |
| `--text` on `--bg` | 16.39:1 | 16.83:1 | 4.5 |
| `--text-dim` on `--bg` | 6.00:1 | 7.05:1 | 4.5 |
| `--sig-ink` on `--sig` | 4.91:1 | 8.97:1 | 4.5 |
| `--text-faint` on `--bg` | 4.86:1 | 5.17:1 | 4.5 |
| `--ok` on `--bg` | 4.93:1 | 11.29:1 | 4.5 |
| `--danger` on `--bg` | 5.06:1 | 6.50:1 | 4.5 |
| `--sel-text` on `--sel` | 13.98:1 | 13.41:1 | 4.5 |
| `--sig` on `--plate` | 3.20:1 | 9.06:1 | 3.0 (1.4.11) |
| `--text` focus ring on any surface | 13.98:1 and up | 11.47:1 and up | 3.0 (1.4.11) |

### Values that were adjusted to get there

Six values changed from the original palette. Names are untouched; only the hex moved.

| Token | Theme | Was | Now | Why |
| --- | --- | --- | --- | --- |
| `--sig-ink` | light | `#FFFFFF` | `#1A0E03` | White on amber was 3.37:1, below AA. A dark ink gives 4.91:1 and matches dark theme, so a firing cap is always a hot amber fill with a dark legend burned into it. |
| `--sig` | light | `#E06A00` | `#D45F00` | The firing fill was 2.80:1 against `--plate`, under the 3:1 that 1.4.11 asks of a meaningful graphical object. 5% darker, same hue, now 3.20:1. |
| `--text-faint` | light | `#8E8E98` | `#6A6A74` | 2.95:1. A token named "faint" that fails AA is an accessibility bug waiting to be inherited. |
| `--text-faint` | dark | `#62626C` | `#82828C` | 3.26:1, same reason. Still a clear step below `--text-dim` (5.17 against 7.05). |
| `--ok` | light | `#16A34A` | `#137A39` | 2.99:1. `--ok` carries the recovery message text. |
| `--danger` | light | `#D93636` | `#C62A2A` | 4.21:1, just under. |

### One thing the tokens cannot fix on their own

Selected against unselected is only about 1.3:1 (`--sel` vs `--cap`) in both themes, and the ring
(`--sel-edge` vs `--cap`) is about 1.75:1. That is deliberate: pushing selection to 3:1 would make
it shout, and it would start competing with amber for attention, which is exactly what the one rule
forbids.

So selection has to carry a redundant non-colour channel, the same way firing does with the press
geometry. Whatever renders a selected key needs at least:

- a legend weight change (400 to 560), which survives greyscale and low vision,
- the `--sel-edge` ring, and
- `aria-pressed` on the control, for assistive tech.

Colour alone is not enough for this one state, and that is the intended trade.

## Fonts

Geist Sans and Geist Mono, variable builds, weight axis 100 to 900, one `.woff2` each. Vendored in
`../assets/fonts` with `OFL.txt` beside them. SIL Open Font License 1.1, copyright 2023 Vercel in
collaboration with basement.studio. The licence has to travel with the binaries, including inside
the packaged installer, so leave `OFL.txt` where it is.

`font-display: block`, not `swap`. These are local files that decode in a frame or two, so the
block period is invisible, and a swap would reflow every legend on a 104-key board mid-paint.

Fontshare families (Satoshi, General Sans, Clash Display) are banned in this project. Their licence
forbids redistribution in a public repo or an installer, which is exactly what this app does. Do not
add one, whatever a style guide suggests. `tokens.test.ts` fails the build if one appears.
