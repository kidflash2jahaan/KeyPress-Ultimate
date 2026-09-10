/**
 * Lazy access to CommonJS module bindings from code that also runs under ESM.
 *
 * WHY THIS FILE EXISTS
 *
 * electron-vite emits the main process as CommonJS. In CommonJS, `require`,
 * `__dirname` and `__filename` are per-module BINDINGS supplied by the module
 * wrapper. They are not properties of `globalThis`.
 *
 * Two separate call sites independently reached for
 * `(globalThis as { require?: ... }).require`, which is always `undefined`
 * there. Both threw on every launch of the packaged app: the session controller
 * could not reach `utilityProcess`, so the injector never forked and the UI
 * reported "KeyPress Ultimate could not start its input process", and the panic
 * hotkey could not reach `globalShortcut`, which refuses Start on its own.
 *
 * The unit tests never caught it because they inject their dependencies, so the
 * real accessors were never exercised. Centralising them here means there is
 * one implementation to get right, and `no-globalthis-cjs.test.ts` fails the
 * build if anyone reintroduces the globalThis form.
 *
 * `typeof` on an undeclared identifier is legal and does not throw, so each
 * accessor is also correct under ESM (vitest), where it reports absence.
 */

/** The CommonJS `require` for this module, or undefined under ESM. */
export function cjsRequire(): ((id: string) => unknown) | undefined {
  return typeof require === 'function' ? require : undefined
}

/** This module's `__dirname`, or undefined under ESM. */
export function cjsDirname(): string | undefined {
  return typeof __dirname === 'string' ? __dirname : undefined
}

/**
 * Require a module, or throw a message that names the caller so a packaging
 * regression is diagnosable from the log line alone.
 */
export function requireOrThrow(id: string, caller: string): Record<string, unknown> {
  const req = cjsRequire()
  if (req === undefined) {
    throw new Error(`${caller} needs injected dependencies outside the CommonJS main process`)
  }
  return req(id) as Record<string, unknown>
}
