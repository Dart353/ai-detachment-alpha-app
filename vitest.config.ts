import { defineConfig } from 'vitest/config'

// Only the pure logic in main/shared is unit tested; nothing here needs a DOM,
// so the node environment keeps the suite fast and free of jsdom surprises.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true
  }
})
