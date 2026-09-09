/**
 * Adapter selection. Called once, at injector startup.
 *
 * The platform modules are imported dynamically and never at module scope,
 * because each one binds its own platform's libraries the moment it loads:
 * importing `./macos` on Windows would try to `koffi.load` libobjc, and
 * importing `./windows` on macOS would try to load user32. Selecting first and
 * loading second keeps the wrong one out of the process entirely.
 */
import type { NativeInput } from './types'

export type { NativeInput, NativeInputExtras } from './types'
export { hasNativeInputExtras } from './types'

/**
 * The adapter for an explicitly named platform. Rejects, rather than returning
 * a no-op stub, on a platform with no adapter: silently doing nothing would
 * leave the UI armed and the user believing keys were being held.
 */
export async function createNativeInputFor(platform: NodeJS.Platform): Promise<NativeInput> {
  switch (platform) {
    case 'darwin': {
      const { MacNativeInput } = await import('./macos')
      return new MacNativeInput()
    }
    case 'win32': {
      const { WindowsNativeInput } = await import('./windows')
      return new WindowsNativeInput()
    }
    default:
      throw new Error(
        `KeyPress Ultimate does not support ${platform}. It runs on macOS and Windows only.`,
      )
  }
}

/** The adapter for the platform this process is actually running on. */
export function createNativeInput(): Promise<NativeInput> {
  return createNativeInputFor(process.platform)
}
