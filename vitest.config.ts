import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer'),
    },
  },
  test: {
    globals: true,
    // jsdom everywhere so renderer component tests work without per-file
    // pragmas. Node built-ins still resolve, so shared and main tests are fine.
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'release/**'],
    restoreMocks: true,
  },
})
