import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const sharedSrc = fileURLToPath(new URL('../packages/shared/src', import.meta.url))

export default defineConfig(({ command }) => ({
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
  server: {
    port: 3056,
    proxy: {
      '/api/': { target: 'http://localhost:3055', changeOrigin: true },
      '/form/': { target: 'http://localhost:3055', changeOrigin: true },
      '/socket.io/': { target: 'http://localhost:3055', changeOrigin: true, ws: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
}))
