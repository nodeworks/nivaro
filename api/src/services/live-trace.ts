/**
 * "Why didn't my page update?" — the trace for support and administrators.
 *
 * For one record (or one person) and a time window it lays side by side:
 *   - the live events the server emitted, from the durable event journal;
 *   - the writes that happened (the activity log, announcements still waiting in
 *     `nivaro_raw_writes`, and — where the collection keeps `date_updated` — a row that
 *     changed with no activity row at all, i.e. a procedure or script that never said so);
 *   - who was subscribed (sockets in the record/collection rooms right now), and which of
 *     them acknowledged an event (acknowledgements are sampled — see below).
 *
 * Read-only, administrators only, and value-free: ids, field NAMES, timestamps and
 * counts. Nothing here reads a field's value; the one column read off the record's own
 * table is `date_updated`, a timestamp.
 *
 * Honest limits, stated in the result rather than hidden: subscriptions are a snapshot of
 * NOW (the board keeps no history), and delivery acknowledgements exist only for the
 * sampled events (about 1 in `ack_every`, plus a time floor), so "not acknowledged" is a
 * hint, never proof of a miss.
 */

export const MATCH_MS = 20_000
export const DEFAULT_WINDOW_MS = 30 * 60_000
export const MAX_WINDOW_MS = 24 * 3_600_000
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

export interface TraceEvent {
  seq: number
  at: string
  room: string
  event: string
  action: string | null
  item: string | null
  fields: string[]
  /** `raw` for a procedure/script announcement, `import` for a staged import. */
  source: string | null
  bulk: number | null
  /** People whose client acknowledged this sampled event. */
  acked_by: string[]
}

export type TraceWriteKind = 'activity' | 'raw-pending' | 'row-timestamp'

export interface TraceWrite {
  kind: TraceWriteKind
  at: string
  action: string | null
  item: string | null
  /** activity: the writer's user id. raw-pending: who announced ("procedure:…"). */
  by: string | null
  fields: string[]
  activity_id: number | null
  /** A live event covers it (same record, within MATCH_MS). */
  announced: boolean
  matched_seq: number | null
}

export interface TraceSubscriber {
  user_id: string | null
  name: string
  sockets: number
  /** Which rooms they are in: the record's own room, or the whole collection's. */
  via: Array<'record' | 'collection'>
  apps: string[]
  /** They acknowledged at least one event in the window. */
  acked: boolean
  acked_events: number
}

export interface TracePerson {
  user_id: string
  name: string | null
  sockets: Array<{
    id: string
    app: string | null
    transport: string | null
    connected_at: string | null
    rooms: string[]
    rooms_total: number
  }>
}

export interface LiveTrace {
  mode: 'record' | 'person'
  window: { from: string; to: string }
  collection: string | null
  item: string | null
  live_mode: 'on' | 'batched' | 'off' | null
  journal: { available: boolean; retention_hours: number; truncated: boolean }
  events: TraceEvent[]
  writes: TraceWrite[]
  subscribers: TraceSubscriber[]
  person: TracePerson | null
  /** Per room: how many events went out in the window (person mode). */
  rooms: Array<{ room: string; events: number }>
  ack: { sampled_about_one_in: number; acked_events: number }
  /** Plain sentences, most important first. */
  findings: string[]
  subscription_note: string
}

export interface RawEventRow {
  seq: unknown
  at: unknown
  room: unknown
  event: unknown
  action?: unknown
  collection?: unknown
  item?: unknown
  changed_fields?: unknown
  extra?: unknown
}

function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function toFields(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).slice(0, 50)
  if (typeof v !== 'string' || !v.trim()) return []
  try {
    const p = JSON.parse(v)
    if (Array.isArray(p)) return p.map(String).slice(0, 50)
  } catch {
    /* a comma list (raw writes) */
  }
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50)
}

function parseExtra(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || !v) return {}
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A journal row as the trace shows it (pure — exported for tests). */
export function eventFromRow(row: RawEventRow, ackedBy: ReadonlyMap<number, string[]>): TraceEvent {
  const extra = parseExtra(row.extra)
  const seq = Number(row.seq)
  const bulk = typeof extra.bulk === 'number' ? extra.bulk : null
  return {
    seq,
    at: iso(row.at),
    room: String(row.room ?? ''),
    event: String(row.event ?? ''),
    action: row.action == null ? null : String(row.action),
    item: row.item == null ? null : String(row.item),
    fields: toFields(row.changed_fields),
    source: typeof extra.source === 'string' ? extra.source : null,
    bulk,
    acked_by: ackedBy.get(seq) ?? []
  }
}

/**
 * Pair each write with the live event that announced it: same record (or a bulk `'*'`
 * event on the collection) within MATCH_MS. Each event can cover many writes (a burst), so
 * a write is announced when ANY event qualifies; the nearest one is named. Pure.
 */
export function matchWrites(
  writes: TraceWrite[],
  events: readonly TraceEvent[],
  matchMs = MATCH_MS
): TraceWrite[] {
  return writes.map((w) => {
    if (w.kind === 'raw-pending') return { ...w, announced: false, matched_seq: null }
    const t = Date.parse(w.at)
    let best: TraceEvent | null = null
    let bestGap = Number.POSITIVE_INFINITY
    for (const e of events) {
      if (e.item !== '*' && w.item != null && e.item !== w.item) continue
      const gap = Math.abs(Date.parse(e.at) - t)
      if (gap <= matchMs && gap < bestGap) {
        best = e
        bestGap = gap
      }
    }
    return { ...w, announced: best != null, matched_seq: best?.seq ?? null }
  })
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'under a minute'
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.round(m / 60)
  return `${h} hour${h === 1 ? '' : 's'}`
}

export interface AssembleInput {
  mode: 'record' | 'person'
  from: Date
  to: Date
  collection: string | null
  item: string | null
  liveMode: 'on' | 'batched' | 'off' | null
  journalAvailable: boolean
  journalTruncated: boolean
  retentionHours: number
  events: TraceEvent[]
  writes: TraceWrite[]
  subscribers: Array<Omit<TraceSubscriber, 'acked' | 'acked_events'>>
  person: TracePerson | null
  rooms: Array<{ room: string; events: number }>
  ackEvery: number
  now: Date
}

/** Put the pieces together and say what they mean (pure — exported for tests). */
export function assembleTrace(input: AssembleInput): LiveTrace {
  const events = [...input.events].sort((a, b) => a.seq - b.seq)
  const writes = matchWrites(input.writes, events).sort((a, b) => b.at.localeCompare(a.at))
  const ackedEvents = events.filter((e) => e.acked_by.length > 0)
  const ackCount = new Map<string, number>()
  for (const e of ackedEvents)
    for (const u of new Set(e.acked_by.map((x) => x.toUpperCase())))
      ackCount.set(u, (ackCount.get(u) ?? 0) + 1)
  const subscribers: TraceSubscriber[] = input.subscribers.map((s) => {
    const n = s.user_id ? (ackCount.get(s.user_id.toUpperCase()) ?? 0) : 0
    return { ...s, acked: n > 0, acked_events: n }
  })

  const findings: string[] = []
  if (!input.journalAvailable)
    findings.push(
      'The event journal is not available on this instance (migration 427 has not run), so what was sent cannot be listed.'
    )
  if (input.liveMode === 'off')
    findings.push(
      `Live updates are switched off for ${input.collection ?? 'this collection'} (its live mode is "off"), so no event is sent for its writes by design.`
    )
  else if (input.liveMode === 'batched')
    findings.push(
      `${input.collection ?? 'This collection'} sends its live updates batched, so a page can lag by a couple of seconds behind a write.`
    )
  if (input.mode === 'record') {
    const unannounced = writes.filter((w) => w.kind !== 'raw-pending' && !w.announced)
    const pending = writes.filter((w) => w.kind === 'raw-pending')
    if (events.length === 0 && writes.length > 0 && input.journalAvailable)
      findings.push(
        'The record was written in this window, but no live event for it was sent. Pages open on it had no way to know.'
      )
    if (unannounced.length > 0) {
      const stamps = unannounced.filter((w) => w.kind === 'row-timestamp').length
      const acts = unannounced.length - stamps
      const parts: string[] = []
      if (acts > 0)
        parts.push(
          `${acts} saved write${acts === 1 ? '' : 's'} with no matching live event within ${MATCH_MS / 1000} seconds`
        )
      if (stamps > 0)
        parts.push(
          `${stamps} change${stamps === 1 ? '' : 's'} to the row (its updated time moved) with no activity entry at all — a procedure or script wrote it and did not announce it`
        )
      findings.push(`${parts.join('; ')}.`)
    }
    for (const w of pending) {
      const age = input.now.getTime() - Date.parse(w.at)
      findings.push(
        age > 120_000
          ? `A raw-write announcement from ${w.by ?? 'a script'} has been waiting ${ago(age)} and was never sent. The "raw-write-announcements" job may not be running.`
          : `A raw-write announcement from ${w.by ?? 'a script'} is queued and goes out within seconds.`
      )
    }
    if (writes.length === 0 && events.length === 0 && input.journalAvailable)
      findings.push('Nothing was written to or announced for this record in this window.')
    if (input.subscribers.length === 0)
      findings.push(
        'Nobody has this record open right now (no socket is in its room), so a page that looks stale here is not connected live.'
      )
    else if (events.length > 0 && ackedEvents.length === 0)
      findings.push(
        `${events.length} event${events.length === 1 ? ' was' : 's were'} sent and none was acknowledged. Acknowledgements exist only for about 1 event in ${input.ackEvery || 50}, so this alone does not mean it was missed.`
      )
    const silent = subscribers.filter((s) => !s.acked)
    if (ackedEvents.length > 0 && silent.length > 0)
      findings.push(
        `${silent.length} of ${subscribers.length} subscribed ${subscribers.length === 1 ? 'person' : 'people'} did not acknowledge any event that others acknowledged: ${silent
          .slice(0, 5)
          .map((s) => s.name)
          .join(', ')}${silent.length > 5 ? '…' : ''}.`
      )
  } else {
    if (input.person && input.person.sockets.length === 0)
      findings.push(
        'This person has no live connection right now, so nothing is being pushed to them. A page they have open is not updating live.'
      )
    if (input.person && input.person.sockets.length > 0 && events.length === 0)
      findings.push('Nothing was emitted to the rooms this person is in during this window.')
  }
  if (input.journalTruncated)
    findings.push('The list is capped; narrow the time window to see everything.')

  return {
    mode: input.mode,
    window: { from: input.from.toISOString(), to: input.to.toISOString() },
    collection: input.collection,
    item: input.item,
    live_mode: input.liveMode,
    journal: {
      available: input.journalAvailable,
      retention_hours: input.retentionHours,
      truncated: input.journalTruncated
    },
    events,
    writes,
    subscribers,
    person: input.person,
    rooms: input.rooms,
    ack: { sampled_about_one_in: input.ackEvery, acked_events: ackedEvents.length },
    findings,
    subscription_note:
      'Subscribers are who is connected now. The server keeps no history of who was connected earlier, and acknowledgements exist only for sampled events.'
  }
}

/** A window from the query, clamped: default last 30 minutes, at most 24 hours, `to` ≤ now. */
export function resolveWindow(
  from: unknown,
  to: unknown,
  now: Date = new Date()
): { from: Date; to: Date } | { error: string } {
  const parse = (v: unknown): Date | null | 'bad' => {
    if (v == null || v === '') return null
    const d = new Date(String(v))
    return Number.isNaN(d.getTime()) ? 'bad' : d
  }
  const f = parse(from)
  const t = parse(to)
  if (f === 'bad' || t === 'bad') return { error: 'from and to must be ISO dates' }
  const end = t && t.getTime() < now.getTime() ? t : now
  const start = f ?? new Date(end.getTime() - DEFAULT_WINDOW_MS)
  if (start.getTime() >= end.getTime()) return { error: 'from must be before to' }
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS)
    return { error: 'the window is at most 24 hours' }
  return { from: start, to: end }
}

export function validCollectionName(name: unknown): name is string {
  return typeof name === 'string' && ID_RE.test(name)
}
