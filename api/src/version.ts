import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The running Nivaro version, resolved ONCE at import.
 *
 * Source of truth is the ROOT package.json — `pnpm release` bumps it and tags
 * the image from it, so a deployed container reports exactly the release it
 * was built from (api/package.json is never bumped and stayed 0.1.0 forever,
 * which is what every surface used to print).
 *
 * `NIVARO_VERSION` overrides it — the release image can bake the tag in even
 * if package.json is ever absent, and a dev can pin a label for testing.
 *
 * Resolution walks UP from this module: dev runs api/src/version.ts and the
 * build runs api/dist/version.js, both two levels below the repo/app root, but
 * the walk is tolerant rather than assuming a fixed depth.
 */
function resolveVersion(): string {
  const explicit = process.env.NIVARO_VERSION?.trim()
  if (explicit) return explicit.replace(/^v/, '')

  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      // Skip the api workspace's own manifest — only the root carries the
      // released version. Any other ancestor manifest with a version wins.
      if (pkg.version && pkg.name !== '@nivaro/api') return pkg.version
    } catch {
      /* keep walking — not every ancestor has a package.json */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return '0.0.0-dev'
}

export const NIVARO_VERSION = resolveVersion()
