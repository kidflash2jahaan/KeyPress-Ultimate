/**
 * Contract tests for the design token layer.
 *
 * Three other agents build directly on these token NAMES, and the whole visual
 * language rests on one rule: colour encodes state, and --sig means "firing"
 * and nothing else. Both of those are the kind of thing that rots silently
 * during a refactor, so they are asserted here rather than trusted.
 *
 * The tests read the real .css files off disk. There is no CSS-in-JS to
 * introspect and no browser in the loop, so a tiny brace-matching scanner is
 * used instead of pulling in a full CSS parser.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(resolve(here, name), 'utf8')

/** Every stylesheet the renderer ships, for the rules that must hold in all of them. */
function componentStylesheets(): Array<[string, string]> {
  const roots = [resolve(here, '.'), resolve(here, '../components'), resolve(here, '..')]
  const seen = new Map<string, string>()
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith('.css')) continue
      const file = resolve(root, entry)
      seen.set(file, readFileSync(file, 'utf8'))
    }
  }
  return [...seen].map(([file, css]) => [file.slice(file.lastIndexOf('/') + 1), css])
}

const tokensCss = read('tokens.css')
const globalCss = read('global.css')
const fontsCss = read('fonts.css')

// --------------------------------------------------------------------------
// Minimal CSS scanner: comments out, then walk braces recording the selector
// path of every declaration block.
// --------------------------------------------------------------------------

interface Rule {
  /** Selector path from outermost at-rule down to the declaration block. */
  path: string[]
  /** Declarations in this block, in source order. */
  decls: Map<string, string>
  /** Character offset of the block's opening brace, for source-order checks. */
  at: number
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Normalises `[data-theme='dark']` and `[data-theme="dark"]` to one form. */
function normalise(selector: string): string {
  return selector.replace(/["']/g, '"').replace(/\s+/g, ' ').trim()
}

function parseRules(css: string): Rule[] {
  const src = stripComments(css)
  const rules: Rule[] = []
  const stack: string[] = []
  let buf = ''
  let decls = new Map<string, string>()
  const declStack: Array<Map<string, string>> = []
  let blockStart = 0

  const flushDecl = (): void => {
    const text = buf.trim()
    buf = ''
    if (text === '') return
    const colon = text.indexOf(':')
    if (colon === -1) return
    decls.set(text.slice(0, colon).trim(), text.slice(colon + 1).trim())
  }

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '{') {
      stack.push(normalise(buf))
      buf = ''
      declStack.push(decls)
      decls = new Map<string, string>()
      blockStart = i
    } else if (ch === '}') {
      flushDecl()
      if (decls.size > 0) rules.push({ path: [...stack], decls, at: blockStart })
      stack.pop()
      decls = declStack.pop() ?? new Map<string, string>()
    } else if (ch === ';') {
      flushDecl()
    } else {
      buf += ch
    }
  }
  return rules
}

const rules = parseRules(tokensCss)

function ruleFor(...path: string[]): Rule {
  const found = rules.find(
    (r) => r.path.length === path.length && r.path.every((s, i) => s === normalise(path[i] ?? '')),
  )
  if (found === undefined) throw new Error(`tokens.css has no rule for: ${path.join(' > ')}`)
  return found
}

const light = ruleFor(':root')
const darkAuto = ruleFor('@media (prefers-color-scheme: dark)', ':root:not([data-theme="light"])')
const darkManual = ruleFor(':root[data-theme="dark"]')
const lightManual = ruleFor(':root[data-theme="light"]')
const reduced = ruleFor('@media (prefers-reduced-motion: reduce)', ':root')

// --------------------------------------------------------------------------
// Contrast maths (WCAG 2.x relative luminance).
// --------------------------------------------------------------------------

function channel(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const h = hex.trim().replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a 6-digit hex colour: "${hex}"`)
  const r = channel(Number.parseInt(h.slice(0, 2), 16))
  const g = channel(Number.parseInt(h.slice(2, 4), 16))
  const b = channel(Number.parseInt(h.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Resolves a token in a theme, falling back to the bare :root definition. */
function token(theme: Rule, name: string): string {
  const value = theme.decls.get(name) ?? light.decls.get(name)
  if (value === undefined) throw new Error(`no token --${name.replace(/^--/, '')}`)
  return value
}

const CONTRACT_COLOURS = [
  '--bg',
  '--bg-raised',
  '--plate',
  '--cap',
  '--cap-top',
  '--cap-edge',
  '--text',
  '--text-dim',
  '--text-faint',
  '--line',
  '--line-strong',
  '--sig',
  '--sig-ink',
  '--sig-glow',
  '--ok',
  '--danger',
  '--sel',
  '--sel-edge',
  '--sel-text',
]

const CONTRACT_NON_COLOURS = [
  '--u',
  '--gap',
  '--radius-1',
  '--radius-2',
  '--radius-3',
  '--dur-fast',
  '--dur-base',
  '--dur-slow',
  '--ease-out',
  '--ease-spring',
  '--font-sans',
  '--font-mono',
]

describe('token contract', () => {
  it('defines every contract token on bare :root', () => {
    for (const name of [...CONTRACT_COLOURS, ...CONTRACT_NON_COLOURS]) {
      expect(light.decls.has(name), `bare :root is missing ${name}`).toBe(true)
    }
  })

  it('gives no colour its only definition inside a media query', () => {
    for (const name of darkAuto.decls.keys()) {
      if (!name.startsWith('--')) continue
      expect(light.decls.has(name), `${name} is only defined under prefers-color-scheme`).toBe(true)
    }
  })

  it('keeps the two dark blocks byte-identical', () => {
    expect([...darkManual.decls.entries()]).toEqual([...darkAuto.decls.entries()])
  })

  it('orders the manual dark override after the media block so it wins', () => {
    expect(darkManual.at).toBeGreaterThan(darkAuto.at)
  })

  it('pins color-scheme in every theme branch', () => {
    expect(light.decls.get('color-scheme')).toBe('light')
    expect(darkAuto.decls.get('color-scheme')).toBe('dark')
    expect(darkManual.decls.get('color-scheme')).toBe('dark')
    expect(lightManual.decls.get('color-scheme')).toBe('light')
  })

  it('restates the whole palette in dark, so no light value leaks through', () => {
    for (const name of CONTRACT_COLOURS) {
      expect(darkAuto.decls.has(name), `dark theme never redefines ${name}`).toBe(true)
    }
  })
})

describe('the one rule: colour encodes state', () => {
  it('never spends --sig outside a firing context', () => {
    // global.css owns focus, selection, scrollbars and chrome. None of them
    // are "current is flowing", so none of them may reach for the signal.
    expect(stripComments(globalCss)).not.toMatch(/var\(--sig/)
  })

  it('keeps selection neutral rather than amber', () => {
    for (const theme of [light, darkAuto]) {
      expect(token(theme, '--sel')).not.toBe(token(theme, '--sig'))
      expect(token(theme, '--sel-edge')).not.toBe(token(theme, '--sig'))
    }
  })

  it('never paints --sig as a text colour', () => {
    // --sig is tuned to the 3:1 that 1.4.11 asks of a graphical object, not to
    // the 4.5:1 that 1.4.3 asks of text. On --plate it measures 3.20:1 in the
    // light theme, so the status pill's own label was the least legible text
    // in the app. It carries the state as a border, a fill and a glow instead.
    for (const [name, css] of componentStylesheets()) {
      const offenders = [...stripComments(css).matchAll(/(^|[^-\w])color:\s*var\(--sig\s*[,)]/gm)]
      expect(offenders.map(() => name), `${name} paints text in --sig`).toEqual([])
    }
  })

  it('hardcodes no colour outside tokens.css', () => {
    for (const [name, css] of [
      ['global.css', globalCss],
      ['fonts.css', fontsCss],
    ] as const) {
      expect(stripComments(css), `${name} contains a raw hex colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })
})

describe('WCAG AA contrast on the real values', () => {
  const themes: Array<[string, Rule]> = [
    ['light', light],
    ['dark', darkAuto],
  ]

  it.each(themes)('%s: body text on --bg clears 4.5:1', (_name, theme) => {
    expect(contrast(token(theme, '--text'), token(theme, '--bg'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(themes)('%s: --text-dim on --bg clears 4.5:1', (_name, theme) => {
    expect(contrast(token(theme, '--text-dim'), token(theme, '--bg'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(themes)('%s: --sig-ink on --sig clears 4.5:1', (_name, theme) => {
    expect(contrast(token(theme, '--sig-ink'), token(theme, '--sig'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(themes)('%s: --text-faint still clears 4.5:1 on --bg', (_name, theme) => {
    expect(contrast(token(theme, '--text-faint'), token(theme, '--bg'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(themes)('%s: status colours clear 4.5:1 on --bg', (_name, theme) => {
    expect(contrast(token(theme, '--ok'), token(theme, '--bg'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token(theme, '--danger'), token(theme, '--bg'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(themes)('%s: a firing cap clears 3:1 against the plate it sits in', (_name, theme) => {
    // 1.4.11: the firing fill is a graphical object that carries meaning.
    expect(contrast(token(theme, '--sig'), token(theme, '--plate'))).toBeGreaterThanOrEqual(3)
  })

  it.each(themes)('%s: --sel-text is readable on --sel', (_name, theme) => {
    expect(contrast(token(theme, '--sel-text'), token(theme, '--sel'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(themes)('%s: the focus ring (--text) clears 3:1 on every surface', (_name, theme) => {
    for (const surface of ['--bg', '--bg-raised', '--plate', '--cap', '--sel'] as const) {
      expect(contrast(token(theme, '--text'), token(theme, surface))).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('motion', () => {
  it('orders the duration tokens fast < base < slow', () => {
    const ms = (name: string): number => Number.parseFloat(token(light, name))
    expect(ms('--dur-fast')).toBeLessThan(ms('--dur-base'))
    expect(ms('--dur-base')).toBeLessThan(ms('--dur-slow'))
  })

  it('collapses durations and press travel under prefers-reduced-motion', () => {
    expect(reduced.decls.get('--dur-fast')).toBe('1ms')
    expect(reduced.decls.get('--dur-base')).toBe('1ms')
    expect(reduced.decls.get('--dur-slow')).toBe('1ms')
    expect(reduced.decls.get('--press-travel')).toBe('0px')
  })

  it('never uses `transition: all`', () => {
    expect(stripComments(globalCss)).not.toMatch(/transition:\s*all\b/)
  })
})

describe('fonts', () => {
  it('declares Geist Sans and Geist Mono and nothing else', () => {
    const families = [...stripComments(fontsCss).matchAll(/font-family:\s*'([^']+)'/g)].map(
      (m) => m[1],
    )
    expect(families).toEqual(['Geist', 'Geist Mono'])
  })

  it('ships no banned Fontshare family', () => {
    for (const banned of ['Satoshi', 'General Sans', 'Clash Display']) {
      expect(tokensCss.includes(`'${banned}'`)).toBe(false)
      expect(fontsCss.includes(`'${banned}'`)).toBe(false)
    }
  })

  it('vendors every referenced font file as a real woff2', () => {
    const urls = [...stripComments(fontsCss).matchAll(/url\('([^']+)'\)/g)].map((m) => m[1] ?? '')
    expect(urls.length).toBe(2)
    for (const url of urls) {
      const file = resolve(here, url)
      expect(existsSync(file), `${url} is referenced but not vendored`).toBe(true)
      expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2')
    }
  })

  it('blocks rather than swaps, so 104 legends never reflow mid-paint', () => {
    const displays = [...stripComments(fontsCss).matchAll(/font-display:\s*(\w+)/g)].map((m) => m[1])
    expect(displays).toEqual(['block', 'block'])
  })

  it('ships the OFL beside the binaries', () => {
    const licence = read('../assets/fonts/OFL.txt')
    expect(licence).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/)
  })

  it('keeps the Apple modifier glyph fallbacks in the sans stack', () => {
    // Geist has no U+2318/2325/2303/21EA/238B/232B/2326, and the key legends
    // need all seven. Per-character fallback supplies them from the system
    // faces below, so removing these breaks the Mac modifier row.
    const sans = token(light, '--font-sans')
    expect(sans).toMatch(/^'Geist',/)
    expect(sans).toMatch(/-apple-system/)
    expect(sans).toMatch(/'Segoe UI Symbol'/)
  })
})
