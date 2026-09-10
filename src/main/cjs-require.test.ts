import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { cjsDirname, cjsRequire, requireOrThrow } from './cjs-require'

/**
 * Shipped broken in 0.1.0 and again in 0.1.1: two call sites read `require` off
 * globalThis. In CommonJS -- what electron-vite emits for the main process --
 * `require` is a module-scoped binding and is not on globalThis, so both threw
 * on every launch. The injector never forked ("could not start its input
 * process") and the panic hotkey could not register, which refuses Start by
 * itself. Every unit test injected its dependencies, so nothing exercised them.
 */
describe('CommonJS binding accessors', () => {
  it('reaches a real module through the module-scoped require', () => {
    const req = cjsRequire()
    expect(typeof req).toBe('function')
    expect(requireOrThrow('node:path', 'test')).toHaveProperty('join')
  })

  it('reports a directory', () => {
    expect(typeof cjsDirname()).toBe('string')
  })

  it('resolves electron the way the session controller does', () => {
    expect(() => requireOrThrow('electron', 'SessionController')).not.toThrow()
  })

  /**
   * The asymmetry that caused both outages, pinned against a real CommonJS
   * module rather than asserted from memory.
   */
  it('proves globalThis.require is undefined in CommonJS while the binding works', () => {
    const probe = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          [
            'const fs=require("node:fs"),os=require("node:os"),p=require("node:path");',
            'const d=fs.mkdtempSync(p.join(os.tmpdir(),"kpu-req-"));',
            'const f=p.join(d,"probe.cjs");',
            'fs.writeFileSync(f,[',
            '  \'const viaBinding = typeof require === "function";\',',
            '  \'const viaGlobalThis = typeof globalThis.require === "function";\',',
            '  \'process.stdout.write(JSON.stringify({viaBinding, viaGlobalThis}));\'',
            '].join("\\n"));',
            'process.stdout.write(require("node:child_process").execFileSync(process.execPath,[f],{encoding:"utf8"}));',
          ].join(''),
        ],
        { encoding: 'utf8' },
      ),
    ) as { viaBinding: boolean; viaGlobalThis: boolean }

    expect(probe.viaBinding).toBe(true)
    expect(probe.viaGlobalThis).toBe(false)
  })
})

/**
 * A source guard, because the same mistake was made twice independently by two
 * different authors working in two different files. Reading a CommonJS binding
 * off globalThis silently yields undefined in the packaged app and is caught by
 * no type check and no injected-dependency test.
 */
describe('no CommonJS binding is read off globalThis', () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
    }
    return out
  }

  it('no source file reads require, __dirname or __filename from globalThis', () => {
    // Strip comments first: the explanation of this very bug mentions the
    // pattern in prose, and a guard that trips on its own documentation is a
    // guard people delete.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    const pattern = /globalThis[^\n]{0,80}\b(require|__dirname|__filename)\b/
    const offenders = sourceFiles(join(__dirname, '..'))
      .filter((file) => pattern.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => file.split('/src/')[1] ?? file)

    expect(offenders, 'use the accessors in src/main/cjs-require.ts instead').toEqual([])
  })
})
