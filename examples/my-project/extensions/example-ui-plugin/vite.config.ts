import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/ui.tsx',
      formats: ['iife'],
      name: 'NivaroPlugin_Example',
      fileName: () => 'ui.js'
    },
    outDir: '.',
    emptyOutDir: false,
    rollupOptions: {
      external: ['react', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react/jsx-runtime': '__NVR_JSX__'
        },
        banner: `
var React = window.__NIVARO__.React;
var __NVR_JSX__ = {
  jsx: React.createElement,
  jsxs: React.createElement,
  Fragment: React.Fragment,
  createElement: React.createElement,
};
`
      }
    }
  }
})
