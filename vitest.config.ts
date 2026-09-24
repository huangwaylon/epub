import { defineConfig } from 'vitest/config'

// Plugin-free so tests don't load the PWA/Svelte build plugins.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
