import { canOpenChatRoom, openChatRoom } from '../components/chat/chat-core'

/**
 * Every in-app notification must land somewhere meaningful — this is the ONE
 * resolver both bells, the notifications page, and My Work use to decide what
 * a click does. A row that resolves to null renders as plain text (no hover,
 * no cursor), which is the honest state for broadcast-style messages; it must
 * never render as a link that goes nowhere.
 *
 * Server writers use `collection` + `item` as the target: business collections
 * point at records (or the collection list when item is null), a handful of
 * system collections map to their owning pages, and the pseudo-collection
 * `__chat__` carries a chat room key.
 */

export interface NotificationRouteMap {
  /** Record route for a business collection — return null when the host has none. */
  record: (collection: string, item: string) => string | null
  /** Collection listing (item-less business notifications, e.g. view digests). */
  list?: (collection: string) => string | null
  report?: (id: string) => string | null
  queue?: (id: string) => string | null
  dashboard?: (id: string) => string | null
  /** Alert-manager page (metric/anomaly/per-record alert notifications). */
  alerts?: () => string | null
  imports?: () => string | null
  issues?: () => string | null
  /** Task list (a task-kind row); hosts without one fall back to my_work / url. */
  tasks?: (id?: string | null) => string | null
  approvals?: () => string | null
  access_requests?: () => string | null
  my_work?: () => string | null
}

export type NotificationTarget =
  | { type: 'path'; path: string }
  | { type: 'chat'; room: string }
  | { type: 'external'; url: string }
  | null

/** Server-side target spec (services/notification-target.ts) — what the
 *  notification is about and what a click should offer. */
export interface NotificationTargetSpec {
  kind:
    | 'record'
    | 'task'
    | 'approval'
    | 'access_request'
    | 'sla'
    | 'chat'
    | 'queue'
    | 'report'
    | 'alerts'
    | 'issue'
    | 'import'
    | 'dashboard'
    | 'my_work'
    | 'home'
    | 'external'
  collection?: string | null
  id?: string | number | null
  room?: string | null
  query?: string | null
  focus?: string | null
  tab?: string | null
  url?: string | null
  action?: 'open' | 'complete' | 'acknowledge' | 'review' | 'approve' | 'reply'
  task_id?: string | number | null
  instance_id?: string | number | null
}

/** An inline action the server says is safe to fire from a click. */
export interface NotificationActionSpec {
  key: string
  label: string
  method: 'POST' | 'PATCH'
  endpoint: string
  body?: Record<string, unknown>
  mark_read?: boolean
}

/** The notification row shape every surface receives (GET /notifications). */
export interface NotificationLike {
  collection?: string | null
  item?: string | null
  target?: NotificationTargetSpec | null
  /** Server-resolved URL for the recipient's app — the fallback when this
   *  host has no route for the kind (opens in a new tab when foreign). */
  url?: string | null
  actions?: NotificationActionSpec[] | null
}

const ALERT_COLLECTIONS = new Set([
  'nivaro_metric_alert_log',
  'nivaro_anomaly_log',
  'nivaro_alert_definitions',
  'nivaro_alert_log'
])
const IMPORT_COLLECTIONS = new Set(['nivaro_import_queue', 'nivaro_import_jobs'])

export function resolveNotificationTarget(
  collection: string | null | undefined,
  item: string | null | undefined,
  routes: NotificationRouteMap
): NotificationTarget {
  const c = collection?.trim()
  if (!c) return null
  const i = item != null && String(item).trim() !== '' ? String(item) : null

  if (c === '__chat__') {
    // Opening a room needs a registered chat dock — without one there is no
    // chat surface to open, so the row stays plain.
    return i && canOpenChatRoom() ? { type: 'chat', room: i } : null
  }

  if (c === 'nivaro_report_defs') {
    const p = i ? routes.report?.(i) : null
    return p ? { type: 'path', path: p } : null
  }
  if (c === 'nivaro_queues') {
    const p = i ? routes.queue?.(i) : null
    return p ? { type: 'path', path: p } : null
  }
  if (c === 'nivaro_dashboards') {
    const p = i ? routes.dashboard?.(i) : null
    return p ? { type: 'path', path: p } : null
  }
  if (ALERT_COLLECTIONS.has(c)) {
    const p = routes.alerts?.()
    return p ? { type: 'path', path: p } : null
  }
  if (IMPORT_COLLECTIONS.has(c)) {
    const p = routes.imports?.()
    return p ? { type: 'path', path: p } : null
  }
  if (c === 'nivaro_issues') {
    const p = routes.issues?.()
    return p ? { type: 'path', path: p } : null
  }
  // Any other system collection has no user-facing page — plain row, never a
  // /collections/nivaro_* route that would 404 or 403.
  if (/^nivaro_/i.test(c) || /^directus_/i.test(c)) return null

  if (i) {
    const p = routes.record(c, i)
    return p ? { type: 'path', path: p } : null
  }
  const p = routes.list?.(c)
  return p ? { type: 'path', path: p } : null
}

const withQuery = (path: string, spec: NotificationTargetSpec) => {
  const parts: string[] = []
  if (spec.query) parts.push(spec.query)
  if (spec.tab) parts.push(`tab=${encodeURIComponent(spec.tab)}`)
  if (spec.focus) parts.push(`focus=${encodeURIComponent(spec.focus)}`)
  if (parts.length === 0) return path
  return `${path}${path.includes('?') ? '&' : '?'}${parts.join('&')}`
}

/** Is `url` on this app's origin (so it can be navigated in-app)? */
function sameOriginPath(url: string): string | null {
  try {
    if (typeof window === 'undefined') return null
    const u = new URL(url, window.location.origin)
    if (u.origin !== window.location.origin) return null
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return null
  }
}

/**
 * Structured resolution: the server's target spec mapped onto THIS host's
 * routes (kind by kind), falling back to the server-resolved `url` — same
 * origin → in-app path, foreign origin → external (new tab) — and finally to
 * the legacy collection + item resolution. A row still resolving to null
 * renders as plain text.
 */
export function resolveNotificationTargetFor(
  n: NotificationLike,
  routes: NotificationRouteMap
): NotificationTarget {
  const spec = n.target ?? null
  if (spec) {
    const p = (path: string | null | undefined): NotificationTarget =>
      path ? { type: 'path', path: withQuery(path, spec) } : null
    let hit: NotificationTarget = null
    switch (spec.kind) {
      case 'record':
      case 'sla':
      case 'approval': {
        if (spec.collection && spec.id != null)
          hit = p(routes.record(spec.collection, String(spec.id)))
        else if (spec.collection) hit = p(routes.list?.(spec.collection))
        else if (spec.kind === 'approval') hit = p(routes.approvals?.())
        break
      }
      case 'task':
        hit = p(routes.tasks?.(spec.id != null ? String(spec.id) : null) ?? routes.my_work?.())
        break
      case 'access_request':
        hit = p(routes.access_requests?.())
        break
      case 'chat':
        hit = spec.room && canOpenChatRoom() ? { type: 'chat', room: spec.room } : null
        break
      case 'queue':
        hit = spec.id != null ? p(routes.queue?.(String(spec.id))) : null
        break
      case 'report':
        hit = spec.id != null ? p(routes.report?.(String(spec.id))) : null
        break
      case 'dashboard':
        hit = spec.id != null ? p(routes.dashboard?.(String(spec.id))) : null
        break
      case 'alerts':
        hit = p(routes.alerts?.())
        break
      case 'import':
        hit = p(routes.imports?.())
        break
      case 'issue':
        hit = p(routes.issues?.())
        break
      case 'my_work':
        hit = p(routes.my_work?.())
        break
      case 'home':
        hit = { type: 'path', path: '/' }
        break
      case 'external':
        hit = spec.url ? { type: 'external', url: spec.url } : null
        break
    }
    if (hit) return hit
    if (n.url) {
      const local = sameOriginPath(n.url)
      return local ? { type: 'path', path: local } : { type: 'external', url: n.url }
    }
    return null
  }
  return resolveNotificationTarget(n.collection, n.item, routes)
}

/** Convenience: run a resolved target (navigate, open the chat room, or open
 *  a foreign-app URL in a new tab). */
export function runNotificationTarget(
  target: NotificationTarget,
  navigate: (path: string) => void
): boolean {
  if (!target) return false
  if (target.type === 'chat') {
    openChatRoom(target.room)
    return true
  }
  if (target.type === 'external') {
    if (typeof window !== 'undefined') window.open(target.url, '_blank', 'noopener')
    return true
  }
  navigate(target.path)
  return true
}
