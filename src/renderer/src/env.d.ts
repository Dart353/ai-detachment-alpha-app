/// <reference types="vite/client" />
/**
 * Build-time constants the renderer relies on.
 *
 * __APP_VERSION__ is injected by electron-vite (`define` in
 * electron.vite.config.ts) from package.json — the single source of truth
 * for the app version.
 *
 * The vite reference above is what types `import.meta.env`, which `main.tsx`
 * reads to expose the stores in development. The root tsconfig pins `types` to
 * node, so the client types have to be asked for explicitly.
 */
declare const __APP_VERSION__: string
