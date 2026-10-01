// api/src/services/traffic-taps/req-facts.ts
/**
 * Typed reads off the Fastify request a Traffic Map tap receives (`ev.req` is `unknown` on the
 * event so the map stays framework-free). Every read is defensive: a missing field is null.
 */
import type { TrafficRequestEvent } from '../traffic-map.js'

export interface ReqLike {
  url?: string
  raw?: { url?: string }
  headers?: Record<string, unknown>
  ip?: string
  body?: unknown
  authMethod?: string
  masqueradeAdminId?: string
  apiKeySimulatedId?: number | null
  workspaceId?: string
  user?: { id?: string; api_key_sandbox?: boolean } | null
}

export function reqOf(ev: TrafficRequestEvent): ReqLike | null {
  const r = ev.req
  return r && typeof r === 'object' ? (r as ReqLike) : null
}

/** The query string (without `?`), '' when none. */
export function queryOf(r: ReqLike | null): string {
  const url = r?.raw?.url ?? r?.url ?? ''
  const i = url.indexOf('?')
  return i < 0 ? '' : url.slice(i + 1)
}

/** True when the query string carries `name=<truthy>` (1 / true / yes). */
export function queryFlag(r: ReqLike | null, name: string): boolean {
  const q = queryOf(r)
  if (!q) return false
  try {
    const v = new URLSearchParams(q).get(name)
    return v !== null && /^(1|true|yes|on)$/i.test(v)
  } catch {
    return false
  }
}

export function headerOf(r: ReqLike | null, name: string): string | null {
  const v = r?.headers?.[name]
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null
  return typeof v === 'string' ? v : null
}

/** First x-forwarded-for hop, else the socket peer (same rule as the request log). */
export function clientIpOf(r: ReqLike | null): string | null {
  const fwd = headerOf(r, 'x-forwarded-for')
  const first = (fwd ?? '').split(',')[0].trim()
  return (first || r?.ip || null)?.slice(0, 64) ?? null
}
