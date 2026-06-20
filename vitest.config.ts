import { defineConfig } from 'vitest/config'

// A minimal, plugin-free config so unit tests run fast in Node and don't pull in
// the PWA/Svelte build plugins from vite.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
