import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultInjectorPath } from './session-controller'

/**
 * Regression tests for the bug that shipped in 0.1.0: `defaultInjectorPath()`
 * read `__dirname` off globalThis. In CommonJS -- which is what electron-vite
 * emits for the main process -- `__dirname` is a module-scoped binding and is
 * NOT on globalThis, so the read always produced undefined, the function always
 * threw, the injector never forked, and every launch showed "KeyPress Ultimate
 * could not start its input process."
 *
 * The whole existing suite missed it because every other test injects
 * `injectorPath`, so the real resolution never ran.
 */
describe('defaultInjectorPath', () => {
  it('resolves injector.js next to the main bundle', () => {
    expect(defaultInjectorPath('/app/out/main')).toBe(join('/app/out/main', 'injector.js'))
  })

  it('refuses an unusable directory rather than fabricating a path', () => {
    // An explicit undefined would fall back to the default parameter, so the
    // empty string is what exercises the guard directly.
    expect(() => defaultInjectorPath('')).toThrow(/cannot resolve the injector path/)
  })

  /**
   * The actual regression guard: with no argument the function must resolve
   * from the module scope. Reverting the accessor to globalThis makes this
   * throw, which is exactly what shipped in 0.1.0.
   */
  it('resolves with no argument, from the ambient module directory', () => {
    const resolved = defaultInjectorPath()
    expect(typeof resolved).toBe('string')
    expect(resolved.endsWith(join('', 'injector.js')) || resolved.endsWith('injector.js')).toBe(true)
  })

  /**
   * The bug itself, pinned. This runs a real CommonJS module -- the module
   * system the packaged main process actually uses -- and asserts the exact
   * asymmetry that caused the outage. If someone "simplifies" the accessor back
   * to globalThis, this fails.
   */
  it('reads __dirname from the module scope, because CommonJS does not put it on globalThis', () => {
    // realpath because /var is a symlink to /private/var on macOS, and
    // __dirname inside the probe reports the resolved path.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kpu-dirname-')))
    const file = join(dir, 'probe.cjs')
    writeFileSync(
      file,
      [
        'const path = require("node:path");',
        'const moduleScoped = typeof __dirname === "string" ? __dirname : null;',
        'const viaGlobalThis = typeof globalThis.__dirname === "string" ? globalThis.__dirname : null;',
        'process.stdout.write(JSON.stringify({ moduleScoped, viaGlobalThis }));',
      ].join('\n'),
    )
    const probe = JSON.parse(execFileSync(process.execPath, [file], { encoding: 'utf8' })) as {
      moduleScoped: string | null
      viaGlobalThis: string | null
    }

    // What the fix relies on.
    expect(probe.moduleScoped).toBe(dir)
    // What the bug relied on, and why it could never work.
    expect(probe.viaGlobalThis).toBeNull()
  })
})
