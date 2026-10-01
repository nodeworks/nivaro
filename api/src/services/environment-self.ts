import { config } from '../config.js'

/**
 * Registered API components that are NOT another environment, from the point
 * of view of the API answering the request. Every cross-environment view
 * (settings compare, env-var presence, service levels) probes the registry's
 * components beside a "This instance" column — a component that is this API
 * must never become a second column under a different label.
 *
 *  - `self`: its base URL names the API serving this request (the request's
 *    own host, PUBLIC_URL, ADMIN_URL, or loopback on our own port).
 *  - `loopback`: a loopback URL on another port. From a server, localhost is
 *    that server, never a developer's laptop — on staging a "Local dev"
 *    component would quietly read staging under a dev label.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    return LOOPBACK.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function selfOrLoopback(baseUrl: string, requestHost: string): 'self' | 'loopback' | null {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (LOOPBACK.has(host)) {
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    return port === config.PORT ? 'self' : 'loopback'
  }
  const own = new Set<string>([requestHost.toLowerCase()])
  for (const v of [config.PUBLIC_URL, config.ADMIN_URL]) {
    if (!v) continue
    try {
      own.add(new URL(v).host.toLowerCase())
    } catch {
      /* not a url */
    }
  }
  return own.has(u.host.toLowerCase()) ? 'self' : null
}

export interface SkippedComponent {
  name: string
  environment: string | null
  reason: string
}

/**
 * Split components into the ones to probe and the ones that are this API.
 * `selfEnvironment` is the registry's name for this API (a named-host match
 * beats a loopback one: on staging, localhost:3055 is also this API but its
 * component is labelled Local dev).
 */
export function partitionSelf<
  C extends { name: string; environment: number; base_url: string | null }
>(
  comps: C[],
  envs: Array<{ id: number; name: string }>,
  requestHost: string
): { probe: C[]; skipped: SkippedComponent[]; selfEnvironment: string | null } {
  const skipped: SkippedComponent[] = []
  let selfByHost: string | null = null
  let selfByLoopback: string | null = null
  const probe = comps.filter((c) => {
    if (!c.base_url) return false
    const why = selfOrLoopback(c.base_url, requestHost)
    if (!why) return true
    const envName = envs.find((e) => e.id === c.environment)?.name ?? null
    if (why === 'self') {
      if (isLoopbackUrl(c.base_url)) selfByLoopback ??= envName
      else selfByHost ??= envName
    }
    skipped.push({
      name: c.name,
      environment: envName,
      reason:
        why === 'self'
          ? 'points at the API serving this page — shown as This instance'
          : 'a localhost address, which from this server means the server itself'
    })
    return false
  })
  return { probe, skipped, selfEnvironment: selfByHost ?? selfByLoopback }
}
