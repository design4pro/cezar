import { defineConfig } from 'vitest/config'

// The agent process's own scripts (ADR 0008): plain Node ESM, no package, no DOM. Only the
// `__tests__/` suites run here — the shell entrypoints beside them are not unit-tested.
export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['__tests__/**/*.test.mjs'],
  },
})
