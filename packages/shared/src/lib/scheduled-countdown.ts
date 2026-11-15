import { countdownText } from './deadline-ticker'

/**
 * Countdown for scheduled changes (realtime round 7, item 12) — the words, kept pure so they
 * are tested. The record page shows the soonest pending change on the record as
 * "Status changes to Closed · in 2 h 14 m", and in full
 * "Status changes to Closed at 5:00 PM (scheduled by Mark)", counted on the page's shared
 * clock (lib/deadline-ticker.ts). Values arrive already cut to the fields the viewer may read
 * (GET /scheduled-changes/:collection/:id); a change with none of them left is not shown.
 */

export interface ScheduledChangeRow {
  id: string
  scheduled_at: string
  /** pending · applying · executed · failed · undone (· cancelled, never listed) */
  status?: string
  change_type?: string
  changes?: Record<string, unknown> | null
  created_by_name?: string | null
  can_manage?: boolean
  /** When it was applied / failed / undone. */
  executed_at?: string | null
  /** Why it was not applied (plain words). */
  error_message?: string | null
  /** The collection applies scheduled changes by themselves (default); false = an admin does. */
  auto_apply?: boolean
  /** Applied at its time (true) or early by an administrator (false). */
  applied_on_time?: boolean | null
  undo_until?: string | null
  can_undo?: boolean
}

const LISTED = new Set(['pending', 'applying', 'executed', 'failed', 'undone'])

/**
 * Every change the record page lists, cut to fields the viewer can read: waiting ones soonest
 * first, then what happened in the last day, newest first.
 */
export function readableRecent(
  rows: readonly ScheduledChangeRow[] | null | undefined,
  fields: readonly FieldLabelLike[] | null | undefined
): ScheduledChangeRow[] {
  const known = fields ? new Set(fields.map((f) => f.field)) : null
  const t = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0)
  const waiting = (r: ScheduledChangeRow) => r.status === 'pending' || r.status === 'applying'
  return (rows ?? [])
    .filter((r) => LISTED.has(r.status ?? 'pending'))
    .map((r) => ({
      ...r,
      changes: Object.fromEntries(
        Object.entries(r.changes ?? {}).filter(([k]) => !known || known.has(k))
      )
    }))
    .filter((r) => Object.keys(r.changes ?? {}).length > 0)
    .filter((r) => Number.isFinite(new Date(r.scheduled_at).getTime()))
    .sort((a, b) => {
      if (waiting(a) !== waiting(b)) return waiting(a) ? -1 : 1
      return waiting(a)
        ? t(a.scheduled_at) - t(b.scheduled_at)
        : t(b.executed_at) - t(a.executed_at)
    })
}

export type ChipKind = 'pending' | 'applying' | 'waiting-admin' | 'applied' | 'failed'

/**
 * What the header chip says: the soonest waiting change (counting down, "Applying…" once its
 * time has come, or waiting for an administrator where the collection does not apply them by
 * itself), else the latest outcome of the last day. Undone changes stay in the list only.
 */
export function chipOf(
  rows: readonly ScheduledChangeRow[],
  now: number
): { kind: ChipKind; row: ScheduledChangeRow } | null {
  for (const r of rows) {
    if (r.status === 'applying') return { kind: 'applying', row: r }
    if ((r.status ?? 'pending') === 'pending') {
      if (!isDue(r.scheduled_at, now)) return { kind: 'pending', row: r }
      return { kind: r.auto_apply === false ? 'waiting-admin' : 'applying', row: r }
    }
  }
  for (const r of rows) {
    if (r.status === 'executed') return { kind: 'applied', row: r }
    if (r.status === 'failed') return { kind: 'failed', row: r }
  }
  return null
}

export interface FieldLabelLike {
  field: string
  name?: string | null
  label?: string | null
}

/** Pending changes the viewer can read, soonest first. */
export function readablePending(
  rows: readonly ScheduledChangeRow[] | null | undefined,
  fields: readonly FieldLabelLike[] | null | undefined
): ScheduledChangeRow[] {
  const known = fields ? new Set(fields.map((f) => f.field)) : null
  return (rows ?? [])
    .filter((r) => (r.status ?? 'pending') === 'pending')
    .map((r) => {
      const changes = Object.fromEntries(
        Object.entries(r.changes ?? {}).filter(([k]) => !known || known.has(k))
      )
      return { ...r, changes }
    })
    .filter((r) => Object.keys(r.changes ?? {}).length > 0)
    .filter((r) => Number.isFinite(new Date(r.scheduled_at).getTime()))
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
}

/** "Status changes to Closed" / "Status is cleared" / "Status and 2 more fields change". */
export function changeSentence(
  changes: Record<string, unknown>,
  labelOf: (field: string) => string,
  formatValue: (field: string, value: unknown) => string
): string {
  const keys = Object.keys(changes)
  if (keys.length === 0) return 'A change'
  const first = keys[0]
  if (keys.length > 1) {
    const more = keys.length - 1
    return `${labelOf(first)} and ${more} more field${more === 1 ? '' : 's'} change`
  }
  const v = changes[first]
  if (v === null || v === undefined || v === '') return `${labelOf(first)} is cleared`
  return `${labelOf(first)} changes to ${formatValue(first, v)}`
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

/** "5:00 PM" today, "tomorrow 9:00 AM", "Tue 5:00 PM" within a week, else "Nov 20, 5:00 PM". */
export function whenText(at: string | number | Date, now: number, locale?: string): string {
  const d = new Date(at)
  const n = new Date(now)
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (sameDay(d, n)) return time
  const tomorrow = new Date(n)
  tomorrow.setDate(n.getDate() + 1)
  if (sameDay(d, tomorrow)) return `tomorrow ${time}`
  const days = (d.getTime() - now) / 86_400_000
  if (days > 0 && days < 6) return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
  const date = d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {})
  })
  return `${date}, ${time}`
}

/**
 * The countdown part: "in 2 h 14 m", "in under a minute", or — nothing applies it on its own
 * at the time — "due 12 m ago" once the time has passed.
 */
export function countdownPart(at: string | number | Date, now: number): string {
  const t = new Date(at).getTime()
  if (!Number.isFinite(t)) return ''
  if (t > now) return `in ${countdownText(t - now)}`
  return now - t < 60_000 ? 'due now' : `due ${countdownText(now - t)} ago`
}

/** Has the time passed (the change is waiting to be applied)? */
export function isDue(at: string | number | Date, now: number): boolean {
  const t = new Date(at).getTime()
  return Number.isFinite(t) && t <= now
}

/** "Status changes to Closed at 5:00 PM (scheduled by Mark)". */
export function fullSentence(sentence: string, when: string, by: string | null | undefined) {
  return `${sentence} at ${when}${by ? ` (scheduled by ${by})` : ''}`
}
