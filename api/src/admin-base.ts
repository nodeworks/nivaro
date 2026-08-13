import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

/**
 * Where the admin SPA is actually reachable.
 *
 * Headless hosts (efp-new and friends) need an ABSOLUTE url to link into admin
 * pages — a relative one hits their own router, which has no such route, and
 * silently lands the user on their dashboard.
 *
 * `ADMIN_URL` is the configured answer and is right in development, where admin
 * runs on its own vite server. It is NOT reliable in a deployment: the release
 * image serves the admin build itself, and an operator may point ADMIN_URL at
 * whichever frontend is the "app" for that environment — which is exactly how a
 * replay link ended up opening efp-new.
 *
 * So: when this process is the one serving the admin build (the same
 * `existsSync` check server.ts registers static hosting on), admin lives at our
 * own public url by construction, and that beats any configured value.
 */
const servesAdminSpa = existsSync(join(import.meta.dirname, '../../admin/dist'))

export function adminBaseUrl(): string | null {
  const url = servesAdminSpa ? (config.PUBLIC_URL ?? config.ADMIN_URL) : config.ADMIN_URL
  return url ? url.replace(/\/$/, '') : null
}
