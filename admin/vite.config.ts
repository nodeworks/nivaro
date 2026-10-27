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

/** #2451 — long-lived vendor chunks. A release re-downloads only the chunks whose bytes
 *  changed, so the app's own code (churns every release) is split from third-party code
 *  (churns on a dependency bump). RULE: only group what the entry already imports. A module
 *  used solely by a lazy route (monaco, graphiql, xlsx, rrweb, html2canvas) stays out of this
 *  map so rollup keeps it with its lazy importer; forcing it here would make the first load
 *  bigger. lucide-react and @nivaro/shared are deliberately NOT grouped: both are consumed through
 *  barrels the entry tree-shakes, so a group would hold every export a lazy route uses and
 *  swell the first load (measured +2.1 MB). */
const VENDOR_GROUPS: Array<[string, RegExp]> = [
  [
    'react',
    /\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|use-sync-external-store|react-is)\//
  ],
  ['floating', /\/node_modules\/@floating-ui\//],
  ['tanstack', /\/node_modules\/@tanstack\//],
  [
    'radix',
    /\/node_modules\/(@radix-ui|cmdk|react-remove-scroll[^/]*|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden|get-nonce)\//
  ],
  [
    'socket',
    /\/node_modules\/(socket\.io-client|socket\.io-parser|engine\.io-client|engine\.io-parser|@socket\.io)\//
  ],
  ['dnd', /\/node_modules\/@dnd-kit\//],
  [
    'editor',
    /\/node_modules\/(@tiptap|prosemirror-[^/]+|orderedmap|rope-sequence|w3c-keyname|linkifyjs|tippy\.js|@popperjs)\//
  ],
  [
    'charts',
    /\/node_modules\/(recharts|d3-[^/]+|victory-vendor|internmap|decimal\.js-light|recharts-scale|eventemitter3)\//
  ]
]

const staticCache = new Map<string, boolean>()

/** True when the module is in the STATIC import closure of an entry. Walks `importers`
 *  (static edges only; dynamic import() edges are `dynamicImporters`, the lazy-route
 *  boundary), so a module used only by lazy routes is never pulled into a vendor chunk. */
function isEntryStatic(id: string, getModuleInfo: (id: string) => any): boolean {
  const hit = staticCache.get(id)
  if (hit !== undefined) return hit
  const seen = new Set<string>()
  const stack = [id]
  let found = false
  while (stack.length) {
    const cur = stack.pop() as string
    if (seen.has(cur)) continue
    seen.add(cur)
    if (staticCache.get(cur) === true) {
      found = true
      break
    }
    const info = getModuleInfo(cur)
    if (!info) continue
    if (info.isEntry) {
      found = true
      break
    }
    for (const imp of info.importers as string[]) stack.push(imp)
  }
  // A fruitless walk visited every ancestor, so all of them are false too.
  if (found) staticCache.set(id, true)
  else for (const s of seen) staticCache.set(s, false)
  return found
}

function vendorChunk(id: string, { getModuleInfo }: { getModuleInfo: (id: string) => any }) {
  // Rollup's CJS interop proxies ("\0/…/react/index.js?commonjs-es-import") and helpers belong
  // with the package they wrap, else the first importer's chunk owns them and two vendor chunks
  // end up importing each other.
  const norm = id.replace(/\\/g, '/').replace(/\0/g, '').replace(/\?.*$/, '')
  if (/commonjsHelpers\.js$/.test(norm)) return 'react'
  const group = VENDOR_GROUPS.find(([, re]) => re.test(norm))
  if (!group || !isEntryStatic(id, getModuleInfo)) return undefined
  return group[0]
}

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
    // Maps are written for debugging but not linked from the bundles ('hidden'), and the
    // API never serves *.map unless ADMIN_SOURCEMAPS=public — they would publish the
    // admin's full source to anyone. ADMIN_SOURCEMAPS=public also links them again here.
    sourcemap: process.env.ADMIN_SOURCEMAPS === 'public' ? true : 'hidden',
    rollupOptions: { output: { manualChunks: vendorChunk } }
  }
}))
