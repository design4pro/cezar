import { defineConfig } from 'vitest/config'

// Three packages, the agent process's scripts and the host reconciler, one `npm test`. Each owns its own vitest
// config — this file only names them, so `npm test -w <pkg>` and the whole-repo run execute the
// identical setup:
//   - packages/cezar     Node ESM (NodeNext, `.js` relative imports)
//   - packages/api-client the Node-free contract package between the two
//   - packages/web        DOM code, resolved exactly as Vite bundles it
//   - .ai/scripts         the agent process's Node scripts (backlog-status.mjs), not a package
//   - host/reconciler     the host-layer reconcile script (ADR 0009), not a package either
export default defineConfig({
  test: {
    // The suites are still being grown; a project that currently matches no file must not
    // fail the validation gate. Root-level only — vitest rejects this inside a project.
    passWithNoTests: true,
    projects: [
      './packages/cezar/vitest.config.ts',
      './packages/api-client/vitest.config.ts',
      './packages/web/vitest.config.ts',
      './.ai/scripts/vitest.config.ts',
      './host/reconciler/vitest.config.ts',
    ],
  },
})
