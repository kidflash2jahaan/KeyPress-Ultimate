/**
 * Browser mode.
 *
 *     npx vite src/renderer
 *
 * This is the config Vite picks up when `src/renderer` is the root, and it
 * exists for one reason: the whole interface has to be driveable in Chrome,
 * with no Electron, against the mock bridge in `mock/bridge.ts`. The renderer
 * bundle that electron-vite builds still comes from `electron.vite.config.ts`
 * at the repo root; this file never takes part in a packaged build.
 *
 * It only declares the `@shared` and `@renderer` aliases that electron-vite
 * and vitest already declare, and opens `fs.allow` far enough to reach
 * `src/shared` and `data/`, which sit above the root.
 */
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const projectRoot = resolve(import.meta.dirname, '../..')

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(projectRoot, 'src/shared'),
      '@renderer': resolve(projectRoot, 'src/renderer'),
    },
  },
  server: {
    fs: { allow: [projectRoot] },
  },
})
