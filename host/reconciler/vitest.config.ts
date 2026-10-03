import { defineConfig } from 'vitest/config'

// The host-layer reconciler (ADR 0009): one plain Node ESM script and its pure core. Only the
// `__tests__/` suites run here, and none of them reaches the network, `gh`, git or `~/.cezar`.
export default defineConfig({
  test: {
    name: 'host-reconciler',
    environment: 'node',
    include: ['__tests__/**/*.test.mjs'],
  },
})
