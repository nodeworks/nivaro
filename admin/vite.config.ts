import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  optimizeDeps: {
    include: ['graphiql', '@graphiql/react', '@graphiql/plugin-explorer']
  },
  worker: {
    format: 'es'
  },
  server: {
    port: 3056,
    proxy: {
      '/api/': { target: 'http://localhost:3055', changeOrigin: true },
      '/form/': { target: 'http://localhost:3055', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
