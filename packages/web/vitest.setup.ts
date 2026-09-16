import { JSDOM } from 'jsdom'

// Node 26 defines `localStorage` as an experimental global ACCESSOR that returns `undefined`
// unless the process was started with `--localstorage-file`. vitest's jsdom environment copies
// a window key onto the global only when that key is not already `in global` — and since the
// accessor exists, jsdom's own Storage never lands, so every `localStorage.getItem(...)` in a
// component under test throws. `sessionStorage` is NOT a Node built-in, so it copies through
// untouched: that asymmetry is the whole bug, and the reason this file exists.
//
// A Storage cannot be built directly (`new Storage()` throws "Illegal constructor"), so take a
// real, spec-conforming pair from one throwaway window and install whichever half is missing.
// Guarding on absence keeps this correct on a Node that ships a working Storage and on one that
// does not, instead of pinning the suite to today's Node.
const { window: storageWindow } = new JSDOM('', { url: 'http://localhost/' })

for (const key of ['localStorage', 'sessionStorage'] as const) {
  if (globalThis[key]) continue
  Object.defineProperty(globalThis, key, {
    value: storageWindow[key],
    configurable: true,
    writable: true,
  })
}
