import {
  type ActivityEntryInput,
  type ActivityLabels,
  activityWhy,
  actorName,
  actorOf,
  collectionNouns,
  HIDDEN_RECORD,
  readableTitle,
  renderActivitySentence
} from './activity-sentence.js'

/**
 * The Audit report's readable CSV (GET /api/reports/activity?format=csv&readable=1): every
 * entry as its sentence, who really did it and why, then the raw columns the old export had
 * (and a few more) so a spreadsheet can still filter on keys and ids. Labels are read as the
 * exporting administrator (POST /api/activity/labels's service), a page at a time.
 */

/** Newest entries one readable export holds; past it the answer says so (X-Export-Truncated). */
export const READABLE_CSV_MAX = 20_000
/** Entries per labels read (LABEL_LIMITS caps refs and people at 200 each). */
export const READABLE_CSV_CHUNK = 200

export const READABLE_CSV_COLUMNS = [
  'when',
  'sentence',
  'who',
  'why',
  'action_label',
  'collection_label',
  'record_label',
  'timestamp',
  'id',
  'action',
  'collection',
  'item',
  'user_id',
  'user_name',
  'user_email',
  'actor_kind',
  'origin',
  'group_key',
  'comment'
] as const

export type ReadableCsvRow = Record<(typeof READABLE_CSV_COLUMNS)[number], string>

function text(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

/** "2026-10-29 14:05" in `timeZone` (else the server's zone); '' for no/invalid time. */
export function csvWhen(ts: ActivityEntryInput['timestamp'], timeZone?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** A valid IANA zone from the query, else null. */
export function csvTimeZone(raw: unknown): string | null {
  const tz = text(raw).slice(0, 64)
  if (!tz) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

/** One enriched activity row → its CSV cells. */
export function readableCsvRow(
  entry: ActivityEntryInput,
  labels?: ActivityLabels | null
): ReadableCsvRow {
  const why = activityWhy(entry)
  const collection = text(entry.collection)
  const item = text(entry.item)
  const key = `${collection}:${item}`
  let record = ''
  if (collection && item && labels?.records && key in labels.records) {
    const l = labels.records[key]
    record = l == null ? HIDDEN_RECORD : text(l)
  }
  const userName = [text(entry.first_name), text(entry.last_name)].filter(Boolean).join(' ')
  const ts = entry.timestamp ? new Date(entry.timestamp) : null
  return {
    when: csvWhen(entry.timestamp, labels?.timeZone),
    sentence: renderActivitySentence(entry, labels),
    who: actorName(entry, labels),
    why: [why.reason && `Reason: ${why.reason}`, why.note && `Note: ${why.note}`, why.approval]
      .filter(Boolean)
      .join(' · '),
    action_label: readableTitle(text(entry.action)),
    collection_label: collection ? collectionNouns(collection, labels).plural : '',
    record_label: record,
    timestamp: ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : '',
    id: text(entry.id),
    action: text(entry.action),
    collection,
    item,
    user_id: text(entry.user ?? entry.user_id),
    user_name: userName,
    user_email: text(entry.user_email),
    actor_kind: actorOf(entry).kind,
    origin: text(entry.origin),
    group_key: text(entry.group_key),
    comment: text(entry.comment)
  }
}
