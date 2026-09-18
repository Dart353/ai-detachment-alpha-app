/**
 * The preload's bridge, as the renderer sees it. The contract itself lives in
 * `src/shared/ipc.ts`; this only attaches it to `window` so no component has to
 * import a type to call `window.api`.
 */
declare global {
  interface Window {
    api: import('../../shared/ipc').Api
    /**
     * The zustand stores, attached by `main.tsx` in development and under the
     * e2e flag so the smoke test can drive the app through the same actions the
     * UI calls. Never present in a packaged launch.
     */
    __ada?: {
      useApp: typeof import('./store/app').useApp
      useRuntime: typeof import('./store/runtime').useRuntime
    }
  }
}

export {}
