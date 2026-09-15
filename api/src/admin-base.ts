import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

/**
 * Where the admin SPA is actually reachable.
 *
 * Headless hosts (custom frontends) need an ABSOLUTE url to link into admin
 * pages — a relative one hits their own router, which has no such route, and
 * silently lands the user on their dashboard.
 *
 * `ADMIN_URL` is the configured answer and is right in development, where admin
 * runs on its own vite server. It is NOT reliable in a deployment: the release
 * image serves the admin build itself, and an operator may point ADMIN_URL at
 * whichever frontend is the "app" for that environment — which is exactly how a
 * replay link ended up opening a headless frontend.
 *
 * So: when this process is the one serving the admin build (the same
 * `existsSync` check server.ts registers static hosting on), admin lives at our
 * own public url by construction — UNLESS the operator named a DIFFERENT
 * admin host. A deployment whose headless frontend proxies `/api` on its own
 * origin sets PUBLIC_URL to that frontend (OIDC redirects, cookies), while the
 * admin build is reachable on the API's own host; there ADMIN_URL is the only
 * place that host can be named, and it must win. Both equal = one host, either
 * answer is right. The one remaining failure mode — ADMIN_URL pointed at the
 * headless frontend itself — is reported at boot (server.ts) rather than
 * guessed around: nothing in env can distinguish it from a genuine admin host.
 */
const servesAdminSpa = existsSync(join(import.meta.dirname, '../../admin/dist'))

const trim = (u: string | null | undefined) => (u ? u.replace(/\/$/, '') : null)

export function adminBaseUrl(): string | null {
  const admin = trim(config.ADMIN_URL)
  const pub = trim(config.PUBLIC_URL)
  // Development: admin runs on its own vite server, and a stale local
  // admin/dist from a past build must not redirect links to the API origin —
  // the configured ADMIN_URL is authoritative there.
  if (config.NODE_ENV === 'development' || !servesAdminSpa) return admin ?? pub
  if (admin && pub && admin !== pub) return admin
  return pub ?? admin
}
