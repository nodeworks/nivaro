/**
 * Where a Traffic Map thing lives elsewhere in the console (#1090 #1091). Pure — no React, no
 * fetches — so the inspector, the ticker actions and the hot table share one answer.
 */
import type { TrafficCatalog, TrafficEventWire } from './types'

/** A record page for a record id seen on an entity; null when the lane has no record page. */
export function recordUrl(
  lane: string,
  entity: string,
  record: string | null | undefined
): string | null {
  if (!record || entity.startsWith('__')) return null
  if (lane !== 'items' && lane !== 'system') return null
  if (!/^[A-Za-z0-9_]{1,128}$/.test(entity)) return null
  return `/collections/${encodeURIComponent(entity)}/${encodeURIComponent(record)}`
}

/** The console page an entity is configured on (collection list, page, widget, query…). */
export function entityUrl(lane: string, entity: string): string | null {
  if (entity.startsWith('__')) return null
  switch (lane) {
    case 'items':
    case 'system':
      return /^[A-Za-z0-9_]{1,128}$/.test(entity)
        ? `/collections/${encodeURIComponent(entity)}`
        : null
    case 'pages':
      return `/p/${encodeURIComponent(entity)}`
    case 'widgets':
      return '/widgets'
    case 'queries':
      return '/custom-queries'
    case 'inbound':
      return '/inbound-mappings'
    case 'extension':
      return '/extensions'
    default:
      return null
  }
}

export type CallerLinkKind = 'inbound' | 'profile' | 'api-keys' | 'jobs'
export interface CallerLink {
  kind: CallerLinkKind
  label: string
  url: string
}

/**
 * A caller node's places: an API key or a machine account → its card under Inbound calls
 * (filtered to it); a person → their profile (plus Inbound calls when they call on a token);
 * crons → Background jobs.
 */
export function callerLinks(key: string, catalog: TrafficCatalog | null): CallerLink[] {
  if (key === 'cron' || key.startsWith('cron:'))
    return [{ kind: 'jobs', label: 'Background jobs', url: '/background-jobs' }]
  const m = key.match(/^k(\d{1,12})$/)
  if (m) {
    return [
      {
        kind: 'inbound',
        label: 'Inbound calls',
        url: `/integration-health?tab=inbound&caller=${encodeURIComponent(`key:${m[1]}`)}`
      },
      { kind: 'api-keys', label: 'API key', url: '/api-keys' }
    ]
  }
  const u = key.match(/^u([0-9A-Fa-f-]{36})$/)
  if (u) {
    const id = u[1].toUpperCase()
    const inbound: CallerLink = {
      kind: 'inbound',
      label: 'Inbound calls',
      url: `/integration-health?tab=inbound&caller=${encodeURIComponent(`user:${id}`)}`
    }
    const profile: CallerLink = { kind: 'profile', label: 'Profile', url: `/users/${id}` }
    return catalog?.callers[key]?.kind === 'machine' ? [inbound, profile] : [profile, inbound]
  }
  return []
}

/** `GET /api/items/workflows/:id` + record 12 → `/api/items/workflows/12` (else the literal head). */
export function requestPathOf(
  route: string,
  record?: string | null
): { method: string; path: string } {
  const sp = route.indexOf(' ')
  const method = sp > 0 ? route.slice(0, sp).toUpperCase() : 'GET'
  let tpl = sp > 0 ? route.slice(sp + 1) : route
  // GraphQL routes carry ` · <operation>` after the path.
  const dot = tpl.indexOf(' · ')
  if (dot >= 0) tpl = tpl.slice(0, dot)
  if (record && tpl.includes(':id'))
    return { method, path: tpl.replace(':id', record).split('/:')[0] }
  const cut = tpl.indexOf('/:')
  return { method, path: cut >= 0 ? tpl.slice(0, cut) : tpl }
}

/**
 * #1090 — the API Analytics request list narrowed to one logged request: its path, method,
 * status and caller, in the seconds around it (the log row is written a moment later, so the
 * map never knows its id). The list opens the newest match with its body and Replay.
 */
export function requestUrl(
  ev: Pick<TrafficEventWire, 't' | 'route' | 'record' | 'status' | 'caller'>
): string {
  const { method, path } = requestPathOf(ev.route, ev.record)
  const p = new URLSearchParams()
  p.set('req_path', path)
  p.set('req_method', method)
  if (ev.status) p.set('req_status', String(ev.status))
  const k = ev.caller.match(/^k(\d+)$/)
  const u = ev.caller.match(/^u([0-9A-Fa-f-]{36})$/)
  if (k) p.set('req_key', k[1])
  else if (u) p.set('req_user', u[1])
  p.set('from', new Date(ev.t - 5_000).toISOString())
  p.set('to', new Date(ev.t + 15_000).toISOString())
  return `/api-analytics?${p.toString()}`
}
