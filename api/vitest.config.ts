import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'extensions/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['src/db/migrations/**', 'src/index.ts']
    },
    setupFiles: ['src/test/setup.ts'],
    // graphql-ws imports `graphql` itself: inlined, it shares the test's graphql instance
    // (otherwise Node loads the CJS build beside vite's ESM one — "another realm").
    server: { deps: { inline: ['graphql-ws'] } }
  }
})
