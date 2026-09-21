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
 * `NIVARO_VERSION` overrides it ONLY when it is version-shaped. That variable
 * is already owned by the deployment as the IMAGE TAG (every compose file uses
 * `nodeworks/nivaro:${NIVARO_VERSION:-latest}`, and the host .env passes it
 * into the container), so it is frequently the literal `latest` — which is not
 * a version and must never be reported as one. A pinned numeric tag IS the
 * running version, so that case is honored.
 *
 * Resolution walks UP from this module: dev runs api/src/version.ts and the
 * build runs api/dist/version.js, both two levels below the repo/app root, but
 * the walk is tolerant rather than assuming a fixed depth.
 */
function resolveVersion(): string {
  const explicit = process.env.NIVARO_VERSION?.trim().replace(/^v/, '')
  if (explicit && /^\d+\.\d+/.test(explicit)) return explicit

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

/**
 * The @nivaro/react version this build's admin SPA was compiled against.
 *
 * Admin and every headless frontend (efp-new) render the SAME shared
 * components, but ship on separate schedules: admin rebuilds with every
 * release, a frontend only when its `@nivaro/react` pin is bumped and
 * redeployed. A record form that behaves differently in the two apps is,
 * more often than not, the two apps running different shared code. The
 * workspace manifest is copied into the release image beside the API, and
 * admin is built from that same workspace, so its version IS the admin's
 * shared-code version. `/api/version` reports it as `react`; a frontend's
 * version.json reports its installed pin as `nivaro_react`; the Environments
 * page compares the two.
 */
function resolveReactVersion(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, 'packages', 'react', 'package.json'), 'utf8')
      ) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export const NIVARO_REACT_VERSION = resolveReactVersion()
