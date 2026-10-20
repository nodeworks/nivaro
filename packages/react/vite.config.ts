import { readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version?: string
  sideEffects: string[]
}

const reactSrc = resolve(__dirname, 'src')
const sharedSrc = resolve(__dirname, '../shared/src')

// Where a preserved module lands in dist: this package's src at the root (so
// dist/index.js stays the entry), @nivaro/shared's inlined source under
// shared/, and rollup's virtual helpers under _virtual/.
function modulePath(id: string | null): string {
  const file = (id ?? '').replace(/\0/g, '').replace(/\?.*$/, '')
  const strip = (p: string) => p.replace(/\.(tsx?|jsx?|mjs)$/, '')
  if (file.startsWith(`${reactSrc}/`)) return strip(relative(reactSrc, file))
  if (file.startsWith(`${sharedSrc}/`)) return `shared/${strip(relative(sharedSrc, file))}`
  return `_virtual/${strip(basename(file)).replace(/[^\w.-]/g, '_')}`
}

// The modules that must run when imported (they register on window or into
// a shared registry at load). package.json `sideEffects` lists them for the
// consumer's bundler; the build reads the same list so it never emits a bare
// `import './x.js'` for a module with nothing to run — a consumer walking the
// import graph would otherwise see every barrel neighbour as a dependency.
const effectful = new Set(
  pkg.sideEffects.filter((p) => p.startsWith('./dist/')).map((p) => p.slice('./dist/'.length))
)

export default defineConfig({
  // The package version, stamped on recorded chunks as their build (#1368).
  define: { __NIVARO_REACT_VERSION__: JSON.stringify(pkg.version ?? '') },
  plugins: [
    react(),
    dts({
      outDir: 'dist',
      tsconfigPath: './tsconfig.json',
      bundleTypes: { bundledPackages: ['@nivaro/shared'] },
      entryRoot: 'src',
      // Runtime bundling aliases @nivaro/shared to raw source (see resolve.alias below)
      // so shared's source ends up inlined in dist/index.js. Types must NOT follow that
      // same alias — they need to resolve @nivaro/shared through tsconfig `paths` to
      // shared's compiled dist/*.d.ts instead, or the dts bundler (@microsoft/api-extractor)
      // ends up trying to analyze raw .tsx source and crashes internally.
      aliasesExclude: ['@nivaro/shared']
    })
  ],
  build: {
    // Watch mode must not wipe dist on every rebuild — full.css (built
    // separately by build:css) and consumers reading dist live would break.
    // Polling because macOS fsevents delivers no events on some setups,
    // which silently breaks chokidar-based watching.
    emptyOutDir: !process.env.VITE_WATCH,
    watch: process.env.VITE_WATCH ? { chokidar: { usePolling: true, interval: 300 } } : undefined,
    lib: {
      // A second entry for the layout editor (`@nivaro/react/layout-editor`):
      // hosts import() it for admins only, so it stays out of the barrel.
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'layout-editor': resolve(__dirname, 'src/layout-editor.ts')
      },
      formats: ['es']
    },
    rollupOptions: {
      // Externalize all npm packages — only bundle @nivaro/shared source
      external: (id) =>
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('\0') &&
        id !== '@nivaro/shared' &&
        !id.startsWith('@nivaro/shared/'),
      treeshake: {
        moduleSideEffects: (id, external) => external || effectful.has(`${modulePath(id)}.js`)
      },
      // One file per source module, so a consumer's bundler tree-shakes and
      // code-splits the package like its own code: a screen that is only
      // reached through a lazy route takes its @nivaro/react modules with it
      // instead of every app downloading the whole package up front. As one
      // ~6.5 MB module it could only ever land in a single chunk.
      output: {
        preserveModules: true,
        entryFileNames: (chunk) => `${modulePath(chunk.facadeModuleId)}.js`
      }
    }
  },
  resolve: {
    alias: {
      '@nivaro/shared': resolve(__dirname, '../shared/src/index.ts')
    }
  }
})
