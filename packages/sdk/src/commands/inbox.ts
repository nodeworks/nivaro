/**
 * The caller's inbox beyond the list: snooze, acknowledge, bulk actions, archive, per-record
 * mutes, what they sent; their reminders; and search helpers (saved searches, per-collection
 * match counts and pages). Everything here acts on the caller's own rows only.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate } from '../index.js'
import type { GlobalSearchRecord } from './devex.js'

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * Snooze a notification until a time (`until`, ISO, in the future), wake it (`until: null`),
 * or sleep it until the record it names next changes (`untilChange: true`).
 */
export function snoozeNotification(
  id: number,
  opts: { until?: string | null; untilChange?: boolean }
): Command<{ data: { snoozed_until: ISODate | string | null; snooze_until_change?: boolean } }> {
  return cmd(
    'POST',
    `/notifications/${id}/snooze`,
    undefined,
    opts.untilChange ? { until_change: true } : { until: opts.until ?? null }
  )
}

/** Acknowledge a notification whose sender asked for an explicit acknowledgement. */
export function acknowledgeNotification(id: number): Command<{
  data: { id: number; ack: { required: true; at: ISODate; by: string } }
}> {
  return cmd('POST', `/notifications/${id}/acknowledge`)
}

/** The notification-center filter (the list's own) for "everything matching" actions. */
export interface NotificationFilter {
  status?: 'inbox' | 'read' | 'archived'
  unread?: boolean
  search?: string
  collection?: string
  sender?: string
  snoozed?: boolean
  lane?: 'critical' | 'needs_you' | 'fyi' | 'attention'
  category?: string
}

function filterBody(f: NotificationFilter): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * One action over several of the caller's notifications: explicit `ids` (up to 1000) or
 * everything matching `filter` (up to 2000). `snooze` needs a future `until`.
 */
export function bulkNotificationAction(body: {
  action: 'read' | 'archive' | 'snooze'
  ids?: number[]
  filter?: NotificationFilter
  until?: string
}): Command<{ data: { updated: number; ids?: number[] } }> {
  return cmd('POST', '/notifications/bulk-action', undefined, {
    action: body.action,
    ...(body.ids ? { ids: body.ids } : {}),
    ...(body.filter ? { filter: filterBody(body.filter) } : {}),
    ...(body.until ? { until: body.until } : {})
  })
}

/** Archive every read notification older than `days` (1–3650). */
export function archiveReadNotifications(days: number): Command<{ data: { updated: number } }> {
  return cmd('POST', '/notifications/archive-read', undefined, { days })
}

export interface SentNotificationGroup {
  key: string
  subject: string
  message: string | null
  created_at: ISODate
  lane: string | null
  category: string | null
  collection: string | null
  item: string | null
  recipients: Array<{
    id: string
    name: string
    read: boolean
    read_at: ISODate | null
    ack: 'pending' | 'acked' | null
    ack_at: string | null
  }>
  read_count: number
  ack_required: boolean
  ack_count: number
  total: number
}

/**
 * What the caller sent, grouped per message with each recipient's read / acknowledgement
 * state. Critical-lane sends only unless `lane: 'all'`.
 */
export function listSentNotifications(query?: {
  lane?: 'all'
  /** Groups (default 50, max 100). */
  limit?: number
}): Command<{ data: SentNotificationGroup[] }> {
  const params: Record<string, unknown> = {}
  if (query?.lane) params.lane = query.lane
  if (query?.limit != null) params.limit = query.limit
  return cmd('GET', '/notifications/sent', params)
}

/** Whether the caller muted notifications about one record. */
export function readRecordMute(
  collection: string,
  item: string | number
): Command<{ data: { muted: boolean } }> {
  return cmd('GET', `/notifications/mutes/${collection}/${item}`)
}

/** Mute or unmute notifications about one record for the caller; answers the new state. */
export function toggleRecordMute(
  collection: string,
  item: string | number
): Command<{ data: { muted: boolean } }> {
  return cmd('POST', `/notifications/mutes/${collection}/${item}/toggle`)
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export interface Reminder {
  id: number
  user: string
  note: string
  room: string | null
  remind_at: ISODate
  sent: boolean | number
}

/** The caller's reminders, soonest first; `includeSent` adds delivered ones (max 200). */
export function listReminders(includeSent?: boolean): Command<{ data: Reminder[] }> {
  return cmd('GET', '/reminders', includeSent ? { include_sent: 'true' } : undefined)
}

/** Remind the caller at `remind_at` (ISO, not in the past); delivered in-app. */
export function createReminder(body: { note: string; remind_at: string }): Command<{
  data: Reminder
}> {
  return cmd('POST', '/reminders', undefined, body)
}

/** Change the note or time of an undelivered reminder. */
export function updateReminder(
  id: number,
  body: { note?: string; remind_at?: string }
): Command<{ data: Reminder }> {
  return cmd('PATCH', `/reminders/${id}`, undefined, body)
}

/** Cancel (or clear a delivered) reminder. */
export function deleteReminder(id: number): Command<void> {
  return cmd('DELETE', `/reminders/${id}`)
}

// ─── Search helpers ───────────────────────────────────────────────────────────

export interface SavedSearch {
  id: string
  name: string
  q: string
  scope: string | null
  created_at: ISODate
}

/** The caller's saved searches. */
export function listSavedSearches(): Command<{ data: SavedSearch[] }> {
  return cmd('GET', '/global-search/saved')
}

/** Save a search for the caller. */
export function createSavedSearch(body: {
  name: string
  q: string
  scope?: string | null
}): Command<{ data: SavedSearch }> {
  return cmd('POST', '/global-search/saved', undefined, body)
}

/** Remove one of the caller's saved searches. */
export function deleteSavedSearch(id: string): Command<{ data: { ok: true } }> {
  return cmd('DELETE', `/global-search/saved/${encodeURIComponent(id)}`)
}

/**
 * How many records match `q` in each listed collection (up to 40), as the caller — the
 * search page's tabs. Empty when `q` is under 2 characters.
 */
export function readSearchCounts(
  q: string,
  collections: string[],
  opts?: { labels?: boolean }
): Command<{ data: Array<{ collection: string; display_name: string | null; count: number }> }> {
  return cmd('GET', '/global-search/counts', {
    q,
    collections: collections.join(','),
    ...(opts?.labels ? { labels: 1 } : {})
  })
}

/** One collection's search matches, a page at a time (default 25). */
export function readSearchRecords(
  q: string,
  collection: string,
  opts?: { offset?: number; limit?: number; labels?: boolean }
): Command<{ data: GlobalSearchRecord[]; total: number | null; query?: unknown }> {
  const params: Record<string, unknown> = { q, collection }
  if (opts?.offset != null) params.offset = opts.offset
  if (opts?.limit != null) params.limit = opts.limit
  if (opts?.labels) params.labels = 1
  return cmd('GET', '/global-search/records', params)
}
