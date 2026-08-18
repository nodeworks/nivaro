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
}

export type NotificationTarget =
  | { type: 'path'; path: string }
  | { type: 'chat'; room: string }
  | null

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

/** Convenience: run a resolved target (navigate or open the chat room). */
export function runNotificationTarget(
  target: NotificationTarget,
  navigate: (path: string) => void
): boolean {
  if (!target) return false
  if (target.type === 'chat') {
    openChatRoom(target.room)
    return true
  }
  navigate(target.path)
  return true
}
