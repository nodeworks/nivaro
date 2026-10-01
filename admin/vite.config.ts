import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_TARGET = process.env.NIVARO_API_TARGET || 'http://localhost:3055'

const sharedSrc = fileURLToPath(new URL('../packages/shared/src', import.meta.url))

/** #1048 / #1180 — the release this bundle was built for (the root manifest `pnpm release`
 *  bumps); the dev server reports 'dev', which the API never judges as stale. */
const rootManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
) as { version?: string }

export default defineConfig(({ command }) => ({
  define: {
    __NIVARO_ADMIN_BUILD__: JSON.stringify(
      command === 'serve' ? 'dev' : process.env.VITE_APP_VERSION || rootManifest.version || 'dev'
    )
  },
  plugins: [
    react(),
    // Vite only watches the admin folder; files it serves from outside it
    // (the shared source below) never raised a change event, so edits there
    // never hot-reloaded. Watch that folder explicitly.
    {
      name: 'watch-shared-src',
      // After listen: adding it during config made the dependency scan crawl
      // the shared tree first and delayed the server by a minute.
      configureServer: (server) => {
        // `listening` may already have fired by the time this runs.
        const add = () => server.watcher.add(sharedSrc)
        if (server.httpServer?.listening) add()
        else server.httpServer?.once('listening', add)
      }
    }
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Dev server only: compile @nivaro/shared from SOURCE so edits hot-reload
      // like admin code. Through its dist/ build vite served a cached copy
      // after every rebuild (the watcher saw the change, the browser never
      // got it). Production builds and tsc still use the compiled dist/.
      ...(command === 'serve' ? { '@nivaro/shared': `${sharedSrc}/index.ts` } : {})
    }
  },
  optimizeDeps: {
    include: ['graphiql', '@graphiql/react', '@graphiql/plugin-explorer'],
    exclude: ['@nivaro/react', '@nivaro/shared', '@nivaro/sdk']
  },
  worker: {
    format: 'es'
  },
  // NIVARO_API_TARGET points the dev server at another API (pnpm dev:db);
  // VITE_CACHE_DIR keeps a second dev server off this one's dependency cache.
  ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
  server: {
    port: 3056,
    proxy: {
      '/api/': { target: API_TARGET, changeOrigin: true },
      '/form/': { target: API_TARGET, changeOrigin: true },
      '/socket.io/': { target: API_TARGET, changeOrigin: true, ws: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
}))
