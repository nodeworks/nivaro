import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { tenantState } from './ai-tenant-state.js'
import { boundedRaw } from './bounded-sql.js'

/**
 * Missed live updates (realtime idea 14) — the server half.
 *
 * After a reload, a screen compares field HASHES with what it showed before the reload
 * (packages/shared lib/missed-updates.ts). A field that changed while the tab heard no live event
 * for that record arrives here as a beacon: collection, record id, field NAMES, route, how long
 * the stale value sat on screen. Never a value, never a hash.
 *
 * Each miss is classified by what the server knows about the change:
 * - `delivery`  — the items service logged it (activity row) or it was broadcast (event journal):
 *                 the change was announced and did not reach the tab.
 * - `procedure` — nothing logged or broadcast, and a stored procedure (or trigger) on this
 *                 database updates that table and field: a raw write that never announced
 *                 (`EXEC nivaro_announce_writes` would fix it). The procedure is named.
 * - `raw`       — nothing logged or broadcast and no procedure found: some other direct write.
 * - `unknown`   — the lookup could not run (over budget, not SQL Server, an error).
 * A change found within IN_FLIGHT_MS before the reload is dropped (it may have been on its way).
 *
 * Stored as daily aggregates in `nivaro_missed_updates` (migration 530; skipped until it lands):
 * per route + collection + field + source + writer. Reloads that compared records and found
 * nothing are counted as `clean` ("trust reloads"); reloads that found something as `stale`.
 * Admin-only reads (routes/realtime-trust.ts) + a daily report section.
 */

const TABLE = 'nivaro_missed_updates'
/** A table probe through the per-tenant column probe (every table here has an `id`). */
const hasTable = (table: string) => hasColumn(table, 'id')
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
export const IN_FLIGHT_MS = 5000
export const MAX_RECORDS_PER_BEACON = 10
export const MAX_FIELDS_PER_RECORD = 20
/** Beacons one person may send per hour (each process). */
export const BEACONS_PER_USER_HOUR = 30
/** Records looked up per minute (each process) — the enrichment never becomes a load. */
export const LOOKUPS_PER_MINUTE = 120
/** Distinct aggregate rows a day may gain (a buggy client cannot fill the table). */
export const MAX_KEYS_PER_DAY = 3000
const LOOKUP_MS = 3000
const PROC_CACHE_MS = 60 * 60_000
const KEEP_DAYS = 90

export type MissedSource = 'delivery' | 'procedure' | 'raw' | 'unknown'

export interface MissedBeaconRecord {
  collection: string
  id: string
  fields: string[]
  gap_s: number
}

export interface MissedBeacon {
  route: string
  /** Seconds between the page going and coming back. */
  reload_s: number
  /** Seconds between the page going and this beacon being sent (clock-skew free). */
  went_ago_s: number
  compared: number
  missed: MissedBeaconRecord[]
}

const int = (v: unknown, max: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0
}

/** Pure: a beacon body → a clean beacon, or null when it is not one. */
export function sanitizeBeacon(body: unknown): MissedBeacon | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.route !== 'string' || !b.route.trim()) return null
  const compared = int(b.compared, 1000)
  if (compared === 0) return null
  const missed: MissedBeaconRecord[] = []
  for (const raw of Array.isArray(b.missed) ? b.missed : []) {
    if (missed.length >= MAX_RECORDS_PER_BEACON) break
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.collection !== 'string' || !IDENT.test(r.collection)) continue
    if ((typeof r.id !== 'string' && typeof r.id !== 'number') || String(r.id).length > 255)
      continue
    const fields = (Array.isArray(r.fields) ? r.fields : [])
      .filter((f): f is string => typeof f === 'string' && IDENT.test(f))
      .slice(0, MAX_FIELDS_PER_RECORD)
    if (fields.length === 0) continue
    missed.push({
      collection: r.collection,
      id: String(r.id),
      fields: [...new Set(fields)],
      gap_s: int(r.gap_s, 30 * 86_400)
    })
  }
  return {
    route: b.route.trim().slice(0, 300),
    reload_s: int(b.reload_s, 86_400),
    went_ago_s: int(b.went_ago_s ?? b.reload_s, 86_400),
    compared,
    missed
  }
}

export interface ChangeEvidence {
  /** The lookup could not run. */
  failed?: boolean
  /** Latest activity row (items service write) for the record in the window (ms), null = none. */
  activityAt: number | null
  /** Latest journaled live event for the record in the window (ms), null = none. */
  journalAt: number | null
  /** Procedures / triggers that update the table and name the field. */
  procs: string[]
}

export type Classified = { source: MissedSource; writer: string } | { inFlight: true }

/**
 * Pure: what kind of miss is this? `wentAt` = when the page went (server clock).
 * A change logged or broadcast within IN_FLIGHT_MS before the page went may still have been on
 * its way: not a miss.
 */
export function classifyMissed(e: ChangeEvidence, wentAt: number): Classified {
  if (e.failed) return { source: 'unknown', writer: '' }
  const seenAt = Math.max(e.activityAt ?? 0, e.journalAt ?? 0)
  if (seenAt > 0) {
    if (seenAt > wentAt - IN_FLIGHT_MS) return { inFlight: true }
    return {
      source: 'delivery',
      writer: e.activityAt != null ? 'items service' : 'announced write'
    }
  }
  if (e.procs.length > 0) return { source: 'procedure', writer: e.procs.slice(0, 2).join(', ') }
  return { source: 'raw', writer: '' }
}

export interface AggregateRow {
  day: string
  kind: 'missed' | 'clean' | 'stale'
  route: string
  collection: string
  field: string
  source: string
  writer: string
  hits: number
  records: number
  gap_s: number
  sample_item: string | null
}

/** Pure: one beacon's classified misses → the aggregate rows to add. */
export function aggregateBeacon(
  beacon: MissedBeacon,
  classified: Array<{ record: MissedBeaconRecord; c: Classified }>,
  day: string
): AggregateRow[] {
  const rows = new Map<string, AggregateRow>()
  let anyMissed = false
  for (const { record, c } of classified) {
    if ('inFlight' in c) continue
    for (const field of record.fields) {
      anyMissed = true
      const key = [record.collection, field, c.source, c.writer].join('\u0000')
      const row = rows.get(key) ?? {
        day,
        kind: 'missed' as const,
        route: beacon.route,
        collection: record.collection,
        field,
        source: c.source,
        writer: c.writer.slice(0, 120),
        hits: 0,
        records: 0,
        gap_s: 0,
        sample_item: null
      }
      row.hits++
      row.records++
      row.gap_s = Math.max(row.gap_s, record.gap_s)
      row.sample_item = record.id
      rows.set(key, row)
    }
  }
  const out = [...rows.values()]
  out.push({
    day,
    kind: anyMissed ? 'stale' : 'clean',
    route: beacon.route,
    collection: '',
    field: '',
    source: '',
    writer: '',
    hits: 1,
    records: beacon.compared,
    gap_s: 0,
    sample_item: null
  })
  return out
}

// ─── Limits (per process, per tenant) ────────────────────────────────────────

const limits = tenantState(() => ({
  beacons: new Map<string, number[]>(),
  lookups: [] as number[],
  procs: new Map<string, { at: number; names: string[] }>(),
  keysToday: { day: '', count: -1 },
  prunedDay: ''
}))

/** Pure-ish: may this person send another beacon now? (records the send when yes) */
export function takeBeaconSlot(
  store: Map<string, number[]>,
  userId: string,
  now: number,
  perHour = BEACONS_PER_USER_HOUR
): boolean {
  const recent = (store.get(userId) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= perHour) {
    store.set(userId, recent)
    return false
  }
  recent.push(now)
  store.set(userId, recent)
  if (store.size > 5000) store.delete(store.keys().next().value as string)
  return true
}

function takeLookup(now: number): boolean {
  const l = limits()
  l.lookups = l.lookups.filter((t) => now - t < 60_000)
  if (l.lookups.length >= LOOKUPS_PER_MINUTE) return false
  l.lookups.push(now)
  return true
}

// ─── Evidence lookups ────────────────────────────────────────────────────────

const likeEscape = (s: string) => s.replace(/[[\]%_]/g, (c) => `[${c}]`)

/** Procedures / triggers on this database that UPDATE `table` and name `field` (cached 1 h). */
async function writersOf(table: string, field: string): Promise<string[]> {
  const knex = db as unknown as import('knex').Knex
  if (!isMssql(knex)) return []
  const key = `${table}.${field}`
  const cache = limits().procs
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < PROC_CACHE_MS) return hit.names
  const rows = await boundedRaw<{ name: string }>(
    `SELECT TOP 5 o.name AS name FROM sys.sql_modules m WITH (NOLOCK)
       JOIN sys.objects o WITH (NOLOCK) ON o.object_id = m.object_id
      WHERE o.type IN ('P', 'TR')
        AND o.name <> 'nivaro_announce_writes'
        AND m.definition LIKE ? AND m.definition LIKE ? AND m.definition LIKE '%UPDATE%'
        AND m.definition NOT LIKE '%nivaro_announce_writes%'
      ORDER BY o.modify_date DESC`,
    [`%${likeEscape(table)}%`, `%${likeEscape(field)}%`],
    { timeoutMs: LOOKUP_MS }
  )
  const names = rows.map((r) => String(r.name)).filter(Boolean)
  cache.set(key, { at: Date.now(), names })
  if (cache.size > 2000) cache.delete(cache.keys().next().value as string)
  return names
}

async function latestAt(
  table: string,
  timeColumn: string,
  collection: string,
  item: string,
  from: Date
): Promise<number | null> {
  if (!(await hasTable(table))) return null
  const rows = (await db(table)
    .where('collection', collection)
    .where('item', item)
    .where(timeColumn, '>=', from)
    .max(`${timeColumn} as at`)) as Array<{ at: unknown }>
  const at = rows[0]?.at
  if (!at) return null
  const ms = new Date(at as string).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** What the server knows about a change to this record since the screen loaded it. */
export async function evidenceFor(
  record: MissedBeaconRecord,
  loadedAt: Date
): Promise<ChangeEvidence> {
  if (!takeLookup(Date.now())) return { failed: true, activityAt: null, journalAt: null, procs: [] }
  try {
    const [activityAt, journalAt] = await Promise.all([
      latestAt('nivaro_activity', 'timestamp', record.collection, record.id, loadedAt),
      latestAt('nivaro_event_journal', 'at', record.collection, record.id, loadedAt)
    ])
    let procs: string[] = []
    if (activityAt == null && journalAt == null) {
      const names = new Set<string>()
      for (const f of record.fields.slice(0, 3)) {
        for (const n of await writersOf(record.collection, f)) names.add(n)
      }
      procs = [...names]
    }
    return { activityAt, journalAt, procs }
  } catch {
    return { failed: true, activityAt: null, journalAt: null, procs: [] }
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

async function keysToday(day: string): Promise<number> {
  const k = limits().keysToday
  if (k.day === day && k.count >= 0) return k.count
  const r = (await db(TABLE).where('day', day).count('* as n')) as Array<{ n: unknown }>
  k.day = day
  k.count = Number(r[0]?.n ?? 0)
  return k.count
}

async function addRow(row: AggregateRow): Promise<void> {
  const where = {
    day: row.day,
    kind: row.kind,
    route: row.route,
    collection: row.collection,
    field: row.field,
    source: row.source,
    writer: row.writer
  }
  const now = new Date()
  const update = () =>
    db(TABLE)
      .where(where)
      .update({
        hits: db.raw('hits + ?', [row.hits]),
        records: db.raw('records + ?', [row.records]),
        gap_s_max: db.raw('CASE WHEN gap_s_max < ? THEN ? ELSE gap_s_max END', [
          row.gap_s,
          row.gap_s
        ]),
        gap_s_sum: db.raw('gap_s_sum + ?', [row.gap_s]),
        ...(row.sample_item ? { sample_item: row.sample_item } : {}),
        updated_at: now
      })
  if (Number(await update()) > 0) return
  if ((await keysToday(row.day)) >= MAX_KEYS_PER_DAY) return
  try {
    await db(TABLE).insert({
      ...where,
      hits: row.hits,
      records: row.records,
      gap_s_max: row.gap_s,
      gap_s_sum: row.gap_s,
      sample_item: row.sample_item,
      updated_at: now
    })
    limits().keysToday.count++
  } catch {
    // Another request inserted the same key a moment ago: add to it.
    await update().catch(() => {})
  }
}

async function pruneOld(day: string): Promise<void> {
  const l = limits()
  if (l.prunedDay === day) return
  l.prunedDay = day
  const cutoff = dayOf(Date.now() - KEEP_DAYS * 86_400_000)
  await db(TABLE)
    .where('day', '<', cutoff)
    .delete()
    .catch(() => {})
}

/**
 * Take one beacon: classify each miss, add the day's aggregates. Returns how many misses were
 * stored. `readable(collection)` is the caller's collection read check (a person reports only
 * on collections they may read).
 */
export async function recordMissedBeacon(
  beacon: MissedBeacon,
  readable: (collection: string) => Promise<boolean>,
  now = Date.now()
): Promise<{ stored: number; in_flight: number; skipped: number }> {
  if (!(await hasTable(TABLE))) return { stored: 0, in_flight: 0, skipped: beacon.missed.length }
  const day = dayOf(now)
  const wentAt = now - beacon.went_ago_s * 1000
  const allowed = new Map<string, boolean>()
  const classified: Array<{ record: MissedBeaconRecord; c: Classified }> = []
  let skipped = 0
  for (const record of beacon.missed) {
    let ok = allowed.get(record.collection)
    if (ok === undefined) {
      ok = await readable(record.collection).catch(() => false)
      allowed.set(record.collection, ok)
    }
    if (!ok) {
      skipped++
      continue
    }
    const loadedAt = new Date(wentAt - record.gap_s * 1000 - 1000)
    const evidence = await evidenceFor(record, loadedAt)
    classified.push({ record, c: classifyMissed(evidence, wentAt) })
  }
  const rows = aggregateBeacon(beacon, classified, day)
  for (const row of rows) await addRow(row).catch(() => {})
  void pruneOld(day)
  const inFlight = classified.filter((x) => 'inFlight' in x.c).length
  return { stored: classified.length - inFlight, in_flight: inFlight, skipped }
}

// ─── Reads (admin) ───────────────────────────────────────────────────────────

export interface MissedUpdateLine {
  collection: string
  field: string
  source: MissedSource
  writer: string
  hits: number
  gap_s_max: number
  gap_s_avg: number
  routes: string[]
  sample_item: string | null
  last_at: string | null
}

export interface MissedUpdateReport {
  available: boolean
  days: number
  /** Reloads that compared what they showed. */
  reloads_compared: number
  /** …and found nothing different (people reloaded a page that was right). */
  clean_reloads: number
  /** …and found at least one missed update. */
  stale_reloads: number
  misses: number
  by_source: Record<MissedSource, number>
  lines: MissedUpdateLine[]
  /** Per day, newest first: compared / clean / stale reloads and misses. */
  daily: Array<{ day: string; clean: number; stale: number; misses: number }>
}

interface StoredRow {
  day: string
  kind: string
  route: string
  collection: string
  field: string
  source: string
  writer: string
  hits: number
  records: number
  gap_s_max: number
  gap_s_sum: number
  sample_item: string | null
  updated_at: unknown
}

/** Pure: stored rows → the report. */
export function summarizeMissed(rows: StoredRow[], days: number): MissedUpdateReport {
  const by_source: Record<MissedSource, number> = { delivery: 0, procedure: 0, raw: 0, unknown: 0 }
  const lines = new Map<string, MissedUpdateLine & { gap_sum: number; routeSet: Set<string> }>()
  const daily = new Map<string, { day: string; clean: number; stale: number; misses: number }>()
  let clean = 0
  let stale = 0
  let misses = 0
  for (const r of rows) {
    const d = daily.get(r.day) ?? { day: r.day, clean: 0, stale: 0, misses: 0 }
    daily.set(r.day, d)
    const hits = Number(r.hits) || 0
    if (r.kind === 'clean') {
      clean += hits
      d.clean += hits
      continue
    }
    if (r.kind === 'stale') {
      stale += hits
      d.stale += hits
      continue
    }
    if (r.kind !== 'missed') continue
    misses += hits
    d.misses += hits
    const source = (
      ['delivery', 'procedure', 'raw', 'unknown'].includes(r.source) ? r.source : 'unknown'
    ) as MissedSource
    by_source[source] += hits
    const key = [r.collection, r.field, source, r.writer].join('\u0000')
    const at = r.updated_at ? new Date(r.updated_at as string).toISOString() : null
    const line = lines.get(key) ?? {
      collection: r.collection,
      field: r.field,
      source,
      writer: r.writer,
      hits: 0,
      gap_s_max: 0,
      gap_s_avg: 0,
      routes: [],
      sample_item: null,
      last_at: null,
      gap_sum: 0,
      routeSet: new Set<string>()
    }
    line.hits += hits
    line.gap_sum += Number(r.gap_s_sum) || 0
    line.gap_s_max = Math.max(line.gap_s_max, Number(r.gap_s_max) || 0)
    line.routeSet.add(r.route)
    if (at && (!line.last_at || at > line.last_at)) {
      line.last_at = at
      line.sample_item = r.sample_item ?? line.sample_item
    }
    lines.set(key, line)
  }
  return {
    available: true,
    days,
    reloads_compared: clean + stale,
    clean_reloads: clean,
    stale_reloads: stale,
    misses,
    by_source,
    lines: [...lines.values()]
      .map(({ gap_sum, routeSet, ...l }) => ({
        ...l,
        gap_s_avg: l.hits > 0 ? Math.round(gap_sum / l.hits) : 0,
        routes: [...routeSet].slice(0, 5)
      }))
      .sort((a, z) => z.hits - a.hits)
      .slice(0, 50),
    daily: [...daily.values()].sort((a, z) => z.day.localeCompare(a.day))
  }
}

export async function missedUpdateReport(
  opts: { days?: number; since?: Date; until?: Date } = {}
): Promise<MissedUpdateReport> {
  const days = Math.min(90, Math.max(1, Math.floor(opts.days ?? 7) || 7))
  if (!(await hasTable(TABLE))) return { ...summarizeMissed([], days), available: false }
  const from = dayOf((opts.since ?? new Date(Date.now() - (days - 1) * 86_400_000)).getTime())
  const qb = db(TABLE).where('day', '>=', from).limit(20_000)
  if (opts.until) qb.where('day', '<=', dayOf(opts.until.getTime()))
  const rows = (await qb.select(
    'day',
    'kind',
    'route',
    'collection',
    'field',
    'source',
    'writer',
    'hits',
    'records',
    'gap_s_max',
    'gap_s_sum',
    'sample_item',
    'updated_at'
  )) as StoredRow[]
  return summarizeMissed(rows, days)
}

const SOURCE_TEXT: Record<MissedSource, string> = {
  delivery: 'announced but not delivered',
  procedure: 'procedure without announce',
  raw: 'direct write without announce',
  unknown: 'source not checked'
}

/** Daily report rows ("Missed live updates: inventory_request.status ×40, source: …"). */
export function missedSectionRows(report: MissedUpdateReport): Array<{
  key: string
  label: string
  value: number
  unit: 'count'
  note?: string
  href?: string
  better: 'down' | 'up'
}> {
  if (!report.available || report.reloads_compared === 0) return []
  const rows: Array<{
    key: string
    label: string
    value: number
    unit: 'count'
    note?: string
    href?: string
    better: 'down' | 'up'
  }> = [
    {
      key: 'missed_total',
      label: 'Missed live updates',
      value: report.misses,
      unit: 'count',
      note: `${report.stale_reloads} of ${report.reloads_compared} checked reloads showed something stale`,
      href: '/realtime?tab=missed',
      better: 'down'
    },
    {
      key: 'trust_reloads',
      label: 'Reloads where nothing had changed',
      value: report.clean_reloads,
      unit: 'count',
      better: 'down'
    }
  ]
  for (const l of report.lines.slice(0, 6)) {
    const writer = l.writer && l.source === 'procedure' ? ` (${l.writer})` : ''
    rows.push({
      key: `missed_${`${l.collection}_${l.field}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .slice(0, 30)}`,
      label: `${l.collection}.${l.field}`,
      value: l.hits,
      unit: 'count',
      note: `source: ${SOURCE_TEXT[l.source]}${writer}`,
      better: 'down'
    })
  }
  return rows
}
