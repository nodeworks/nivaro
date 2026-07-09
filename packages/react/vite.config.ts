import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
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
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index'
    },
    rollupOptions: {
      // Externalize all npm packages — only bundle @nivaro/shared source
      external: (id) =>
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('\0') &&
        id !== '@nivaro/shared' &&
        !id.startsWith('@nivaro/shared/'),
      output: {
        preserveModules: false
      }
    }
  },
  resolve: {
    alias: {
      '@nivaro/shared': resolve(__dirname, '../shared/src/index.ts')
    }
  }
})
