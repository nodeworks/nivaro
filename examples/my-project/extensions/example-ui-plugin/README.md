# example-ui-plugin

Demonstrates how to build a Nivaro extension with a UI bundle. Written in TypeScript + JSX; compiled to IIFE JavaScript that self-registers via `window.__NIVARO__`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | API side source — routes, hooks, cron |
| `src/ui.tsx` | Admin UI source — React component (TypeScript + JSX) |
| `index.js` | Compiled API side (loaded by Nivaro at startup) |
| `ui.js` | Compiled UI bundle — pre-built IIFE, served to admin |
| `manifest.json` | Declares `ui.js` and slot metadata |
| `vite.config.ts` | Builds `src/ui.tsx` → `ui.js` (IIFE, React externalized) |
| `tsconfig.json` | UI type-check config (`jsx: react-jsx`, bundler resolution) |
| `tsconfig.api.json` | API compile config (`NodeNext`) |

## How it works

1. Nivaro API loads `index.js` at startup via the extension loader
2. Loader reads `manifest.json` and registers a route to serve `ui.js`
3. Admin fetches `/api/extensions/manifest` and injects `<script src="/api/extensions/example-ui-plugin/ui.js">`
4. `ui.js` executes, calls `window.__NIVARO__.registerPlugin(...)` to register slot components
5. Pages with `<PluginSlot>` render the plugin UI

## Development

```bash
# Install deps (from this directory)
pnpm install

# Build both UI bundle and API side
pnpm build

# Watch mode for UI during development
pnpm dev
```

After building, hot-reload the API side without restarting Nivaro:

```bash
curl -X POST http://localhost:3055/api/extensions/reload \
  -H "Authorization: Bearer <static-token>"
```

## Docker mount

```yaml
services:
  nivaro:
    image: nivaro:latest
    volumes:
      - ./example-ui-plugin:/app/extensions/example-ui-plugin
```

The pre-built `index.js` and `ui.js` are committed alongside the TypeScript source so the plugin works out of the box without a build step.
