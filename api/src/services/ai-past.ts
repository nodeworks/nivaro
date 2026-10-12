/**
 * "Look at the past" (#1843): pure readers over a record's revision history —
 * what it looked like on a date, when a field changed and who changed it, and
 * how long it sat in each pipeline state. They take the rows listRevisions
 * returns (newest first) so they can be tested without a database; the Ask AI
 * tool in ai-watch-tools.ts supplies the access gate and the field allow-list.
 */

export interface PastRevision {
  timestamp?: Date | string | null
  action?: string | null
  data?: Record<string, unknown> | null
  delta?: Record<string, unknown> | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  event?: {
    kind: 'transition' | 'start'
    from_label: string | null
    to_label: string | null
    transition_label: string | null
    addendum?: unknown
  } | null
}

const ms = (t: Date | string | null | undefined): number => (t ? new Date(t).getTime() : Number.NaN)

export function whoOf(r: PastRevision): string {
  return [r.first_name, r.last_name].filter(Boolean).join(' ') || r.user_email || 'the system'
}

const hasSnapshot = (r: PastRevision): boolean =>
  !r.event && !!r.data && Object.keys(r.data).length > 0

/** Snapshot revisions, newest first, with a usable timestamp. */
function snapshots(revs: PastRevision[]): PastRevision[] {
  return revs
    .filter((r) => hasSnapshot(r) && !Number.isNaN(ms(r.timestamp)))
    .sort((a, b) => ms(b.timestamp) - ms(a.timestamp))
}

/** The record as the newest revision at or before `asOf` left it. */
export function snapshotAsOf(
  revs: PastRevision[],
  asOf: Date
): { data: Record<string, unknown>; at: string; by: string } | null {
  const hit = snapshots(revs).find((r) => ms(r.timestamp) <= asOf.getTime())
  if (!hit) return null
  return {
    data: hit.data as Record<string, unknown>,
    at: new Date(hit.timestamp as Date | string).toISOString(),
    by: whoOf(hit)
  }
}

export interface FieldChange {
  at: string
  by: string
  from: unknown
  to: unknown
}

/**
 * Every change to one field, newest first. A revision delta holds only the NEW
 * value, so "from" is the value the next older snapshot carried (null when the
 * history starts there — the record's creation).
 */
export function fieldChanges(revs: PastRevision[], field: string): FieldChange[] {
  const snaps = snapshots(revs)
  const out: FieldChange[] = []
  for (let i = 0; i < snaps.length; i++) {
    const r = snaps[i]
    const isCreate = r.action === 'create'
    const inDelta = !!r.delta && Object.hasOwn(r.delta, field)
    if (!inDelta && !isCreate) continue
    const to = inDelta ? (r.delta as Record<string, unknown>)[field] : r.data?.[field]
    const older = snaps[i + 1]
    const from = older ? (older.data?.[field] ?? null) : null
    if (!isCreate && JSON.stringify(from) === JSON.stringify(to ?? null)) continue
    if (isCreate && to == null) continue
    out.push({
      at: new Date(r.timestamp as Date | string).toISOString(),
      by: whoOf(r),
      from,
      to: to ?? null
    })
  }
  return out
}

export interface StateStay {
  state: string
  entered_at: string
  left_at: string | null
  days: number
}

/**
 * The record's own pipeline stays, oldest first, from the transition and start
 * events folded into its history (an addendum's own moves are left out).
 */
export function stateStays(revs: PastRevision[], now: Date): StateStay[] {
  const events = revs
    .filter(
      (r) => r.event && !r.event.addendum && r.event.to_label && !Number.isNaN(ms(r.timestamp))
    )
    .sort((a, b) => ms(a.timestamp) - ms(b.timestamp))
  const stays: StateStay[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const start = ms(e.timestamp)
    const end = i + 1 < events.length ? ms(events[i + 1].timestamp) : null
    stays.push({
      state: e.event?.to_label as string,
      entered_at: new Date(start).toISOString(),
      left_at: end == null ? null : new Date(end).toISOString(),
      days: Math.round((((end ?? now.getTime()) - start) / 86_400_000) * 10) / 10
    })
  }
  return stays
}

/** Total days per state (a state can be entered more than once). */
export function totalsByState(
  stays: StateStay[]
): Array<{ state: string; days: number; visits: number }> {
  const map = new Map<string, { state: string; days: number; visits: number }>()
  for (const s of stays) {
    const m = map.get(s.state) ?? { state: s.state, days: 0, visits: 0 }
    m.days = Math.round((m.days + s.days) * 10) / 10
    m.visits += 1
    map.set(s.state, m)
  }
  return [...map.values()].sort((a, b) => b.days - a.days)
}

/** "2026-03-01" -> end of that day (UTC); a full ISO stamp is used as given. */
export function parseAsOf(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59.999Z`) : new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}
