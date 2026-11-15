import type { Redis } from 'ioredis'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { liveModeOf } from './collection-live-mode.js'
import { type JournalEntry, journalTail } from './event-journal.js'
import { instanceKey } from './instance-key.js'
import { getApp } from './io-holder.js'
import {
  childDetailQuery,
  dependentTables,
  mapChildRows,
  mapSystemRows,
  planEmits,
  probeQuery,
  SYSTEM_TABLES,
  type SystemTable,
  systemDetailQuery
} from './outside-write-system.js'
import { announceRawWrites, BULK_CAP } from './raw-write-announcer.js'
import { runLongSql } from './run-long.js'

/**
 * The outside-write watcher (realtime safety net). Writes through the items service tell every
 * open screen at once; procedures and scripts announce through nivaro_announce_writes /
 * nivaro_raw_writes (#1875) — when they do. Most do not (SQL checks reports them as
 * "write-unannounced" and proposes the fix). Until then this watcher catches what they wrote:
 *
 *   every few seconds (setting, default 10) — on the process holding the scheduler lease, in the
 *   background pool, never in cloud mode — for each watched collection that has a changed-at
 *   column (date-updated field, else date_updated / updated_at / modified …) with an index
 *   starting on it, the rows whose stamp moved past the last look are read (an index seek, READPAST
 *   so a long transaction is never waited on) and announced through the raw-write announcer.
 *
 * Which collections: the ones people have open right now (list rooms and record viewers, from
 * the realtime board) — or a list an administrator chose. A collection without such an index is
 * refused, and the realtime page says why: no table scans every few seconds.
 *
 * The window is the database's own clock (no app/DB skew), and both of its clocks: app writes
 * stamp UTC, procedures often stamp GETDATE() (local). Each look reads
 *   (stamp > last − overlap AND stamp <= now − settle)   for UTC and for local time,
 * so a row stamped by a transaction that commits late is still seen, and remembers (id, stamp)
 * pairs it already looked at so no row is announced twice. A row whose id the app itself
 * announced in the last moments (the event journal) is skipped: screens already re-read it.
 *
 * Where SQL Server change tracking is on for the table (sys.change_tracking_tables), the watcher
 * reads CHANGETABLE(CHANGES …) from the last version it saw instead — no changed-at column or index
 * needed, and deletes are seen too (announced as removals). It lags one look behind the current
 * version, so a procedure's own announcement (drained every 5 s) lands in the journal first and the
 * row is skipped as already told. When the retained history no longer reaches the last version
 * (CHANGE_TRACKING_MIN_VALID_VERSION past it), one "many records changed" goes out and the version
 * resyncs. The timestamp poll stays the path for tables without change tracking.
 *
 * What it caught is counted per collection per hour (Redis, 25 hours) — the realtime page shows
 * "rows caught in 24 h": writes still made without announcing.
 */

export const OUTSIDE_WRITES_KEY = 'outside_writes'
export const MIN_INTERVAL_S = 5
export const MAX_INTERVAL_S = 300
export const DEFAULT_INTERVAL_S = 10
/** Collections watched at most per look (busiest first). */
export const MAX_WATCHED = 25
/** Rows read per collection per look; past it the collection is announced as a whole. */
export const ROW_CAP = 500
/** A look reaches this far back behind the last one (late commits). */
export const OVERLAP_S = 120
/** Rows younger than this wait for the next look (the app's own announce lands first). */
export const SETTLE_S = 3
/**
 * An app announcement this recent counts as "already told" for the same id: one interval plus
 * the settle time plus slack — the app's own event lands in the journal within a moment of its
 * write, and the watcher reads that row at the first look after SETTLE_S.
 */
export const recentWindowMs = (intervalS: number) => (intervalS + SETTLE_S + 2) * 1000
/** A watermark older than this is not resumed (a lease that moved long ago starts fresh). */
const RESUME_MAX_MS = 10 * 60_000
const CATALOG_TTL_MS = 10 * 60_000
const SEEN_MAX = 50_000

export type WatchMode = 'viewed' | 'chosen'

export interface OutsideWriteSettings {
  /** The watcher runs (default on; OUTSIDE_WRITE_WATCH=on|off wins). */
  enabled: boolean
  interval_seconds: number
  /** `viewed`: collections someone has open now (default). `chosen`: `collections`. */
  mode: WatchMode
  collections: string[]
}

export const OUTSIDE_WRITE_DEFAULTS: OutsideWriteSettings = {
  enabled: true,
  interval_seconds: DEFAULT_INTERVAL_S,
  mode: 'viewed',
  collections: []
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

/** Stored JSON → settings (pure; anything unreadable falls back to the default). */
export function normalizeOutsideWriteSettings(raw: unknown): OutsideWriteSettings {
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const n = Number(src.interval_seconds)
  const list = Array.isArray(src.collections) ? src.collections : []
  const collections = [
    ...new Set(list.map((c) => String(c).trim()).filter((c) => IDENT_RE.test(c)))
  ].slice(0, 100)
  return {
    enabled: src.enabled !== false,
    interval_seconds: Number.isFinite(n)
      ? Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Math.round(n)))
      : DEFAULT_INTERVAL_S,
    mode: src.mode === 'chosen' ? 'chosen' : 'viewed',
    collections
  }
}

/** OUTSIDE_WRITE_WATCH=on|off, or null when unset / unreadable. */
export function outsideWriteEnv(raw = process.env.OUTSIDE_WRITE_WATCH): boolean | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(v)) return true
  if (['off', 'false', '0', 'no'].includes(v)) return false
  return null
}

export const isCloudMode = () => !!process.env.CLOUD_META_DB_URL

// ── Storage: this instance's nivaro_settings_overrides row, key `outside_writes` ────────

let settingsCache: { at: number; value: OutsideWriteSettings } | null = null

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    const obj = row.data ? JSON.parse(row.data) : {}
    return { id: row.id, data: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {} }
  } catch {
    return { id: row.id, data: {} }
  }
}

export async function getOutsideWriteSettings(): Promise<OutsideWriteSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value
  let value = OUTSIDE_WRITE_DEFAULTS
  try {
    value = normalizeOutsideWriteSettings((await readRow())?.data[OUTSIDE_WRITES_KEY])
  } catch {
    /* table absent / DB not ready — defaults */
  }
  settingsCache = { at: Date.now(), value }
  return value
}

export async function saveOutsideWriteSettings(patch: unknown): Promise<OutsideWriteSettings> {
  const row = await readRow()
  const stored = normalizeOutsideWriteSettings(row?.data[OUTSIDE_WRITES_KEY])
  const p =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  const next = normalizeOutsideWriteSettings({ ...stored, ...p })
  const data = { ...(row?.data ?? {}), [OUTSIDE_WRITES_KEY]: next }
  if (row)
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  else
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  settingsCache = null
  return next
}

/** The env switch over the stored value (and never in cloud mode). */
export function effectiveOutsideWrites(stored: OutsideWriteSettings): OutsideWriteSettings & {
  env: boolean | null
  cloud: boolean
} {
  const env = outsideWriteEnv()
  const cloud = isCloudMode()
  return { ...stored, enabled: !cloud && (env ?? stored.enabled), env, cloud }
}

// ── Which collections can be watched (catalog, cached) ──────────────────────────

export interface Watchable {
  collection: string
  watchable: boolean
  /** Why not (watchable = false), in plain words. */
  reason?: string
  reason_code?: 'not-table' | 'no-timestamp' | 'no-index' | 'no-key'
  /** How it is watched: SQL Server change tracking, or the changed-at column poll. */
  method?: WatchMethod | null
  schema?: string
  table?: string
  ts?: string
  pk?: string
}

export type WatchMethod = 'change-tracking' | 'timestamp'

/** Changed-at columns by name, when no field is marked date-updated. */
export const TS_NAMES = [
  'date_updated',
  'updated_at',
  'modified',
  'modified_at',
  'date_modified',
  'last_modified',
  'updated_on',
  'modified_on',
  'last_updated',
  'updated'
]

export interface TableFacts {
  schema: string
  table: string
  /** Date/time columns: lower-cased name → as written. */
  dateColumns: Map<string, string>
  /** Columns that lead an index (key position 1), lower-cased. */
  leading: Set<string>
  /** Primary key columns as written. */
  pk: string[]
  /** SQL Server change tracking is on for the table. */
  tracked?: boolean
}

/** Can this collection be watched, and on what (pure)? */
export function judgeWatchable(
  collection: string,
  facts: TableFacts | undefined,
  dateUpdatedFields: string[]
): Watchable {
  if (!facts)
    return {
      collection,
      watchable: false,
      reason_code: 'not-table',
      reason: 'Not a table in this database (a virtual collection, or the table is missing).'
    }
  const base = { collection, schema: facts.schema, table: facts.table }
  // change tracking needs neither a changed-at column nor an index — only a one-column key
  if (facts.tracked && facts.pk.length === 1)
    return { ...base, pk: facts.pk[0], watchable: true, method: 'change-tracking' }
  const marked = dateUpdatedFields
    .map((f) => facts.dateColumns.get(f.toLowerCase()))
    .find((c): c is string => !!c)
  const ts = marked ?? TS_NAMES.map((n) => facts.dateColumns.get(n)).find((c) => !!c)
  if (!ts)
    return {
      ...base,
      watchable: false,
      reason_code: 'no-timestamp',
      reason:
        'No changed-at column (a field marked “date updated”, or date_updated / updated_at / modified …).'
    }
  if (facts.pk.length !== 1)
    return {
      ...base,
      ts,
      watchable: false,
      reason_code: 'no-key',
      reason:
        facts.pk.length === 0
          ? 'No primary key, so a changed row cannot be named.'
          : 'The primary key has several columns, so a changed row cannot be named by one id.'
    }
  if (!facts.leading.has(ts.toLowerCase()))
    return {
      ...base,
      ts,
      pk: facts.pk[0],
      watchable: false,
      reason_code: 'no-index',
      reason: `No index starts with ${ts}: watching it would read the whole table every few seconds. Add an index on ${ts} to watch it.`
    }
  return { ...base, ts, pk: facts.pk[0], watchable: true, method: 'timestamp' }
}

let catalogCache: { at: number; map: Map<string, Watchable> } | null = null

/** Every registered collection's watchability (three catalog reads, cached 10 minutes). */
export async function watchCatalog(fresh = false): Promise<Map<string, Watchable>> {
  if (!fresh && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS)
    return catalogCache.map
  const map = new Map<string, Watchable>()
  if (!isMssql(db)) return map
  const q = db('nivaro_collections').distinct('collection')
  if (await db.schema.hasColumn('nivaro_collections', 'is_virtual').catch(() => false))
    q.where((w) => w.whereNull('is_virtual').orWhere('is_virtual', false))
  const [collections, columns, keys, fields, tracked] = await Promise.all([
    q as unknown as Promise<Array<{ collection: string | null }>>,
    db.raw(`SELECT s.name AS sch, t.name AS tbl, c.name AS col
         FROM sys.columns c
         JOIN sys.tables t ON t.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE ty.name IN ('datetime', 'datetime2', 'smalldatetime', 'datetimeoffset')`) as Promise<
      Array<{ sch: string; tbl: string; col: string }>
    >,
    db.raw(`SELECT s.name AS sch, t.name AS tbl, c.name AS col, ic.key_ordinal AS ord,
              CAST(i.is_primary_key AS INT) AS pk
         FROM sys.indexes i
         JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE ic.key_ordinal > 0 AND i.is_disabled = 0 AND i.is_hypothetical = 0
          AND (ic.key_ordinal = 1 OR i.is_primary_key = 1)`) as Promise<
      Array<{ sch: string; tbl: string; col: string; ord: number; pk: number }>
    >,
    db('nivaro_fields')
      .where('special', 'like', '%date-updated%')
      .select('collection', 'field', 'db_column')
      .catch(() => []) as Promise<
      Array<{ collection: string; field: string; db_column: string | null }>
    >,
    db
      .raw(`SELECT s.name AS sch, t.name AS tbl
         FROM sys.change_tracking_tables ct
         JOIN sys.tables t ON t.object_id = ct.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id`)
      .catch(() => []) as Promise<Array<{ sch: string; tbl: string }>>
  ])
  const lc = (s: string) => s.toLowerCase()
  const tables = new Map<string, TableFacts>()
  const factsOf = (sch: string, tbl: string) => {
    const key = `${lc(sch)}.${lc(tbl)}`
    let f = tables.get(key)
    if (!f) {
      f = { schema: sch, table: tbl, dateColumns: new Map(), leading: new Set(), pk: [] }
      tables.set(key, f)
    }
    return f
  }
  for (const c of columns) factsOf(c.sch, c.tbl).dateColumns.set(lc(c.col), c.col)
  const pkParts = new Map<string, Array<{ col: string; ord: number }>>()
  for (const k of keys) {
    const f = factsOf(k.sch, k.tbl)
    if (Number(k.ord) === 1) f.leading.add(lc(k.col))
    if (Number(k.pk) === 1) {
      const key = `${lc(k.sch)}.${lc(k.tbl)}`
      const list = pkParts.get(key) ?? []
      list.push({ col: k.col, ord: Number(k.ord) })
      pkParts.set(key, list)
    }
  }
  for (const t of tracked) factsOf(t.sch, t.tbl).tracked = true
  for (const [key, list] of pkParts) {
    const f = tables.get(key)
    if (f) f.pk = list.sort((a, b) => a.ord - b.ord).map((p) => p.col)
  }
  const marked = new Map<string, string[]>()
  for (const f of fields) {
    const list = marked.get(lc(f.collection)) ?? []
    list.push(f.db_column || f.field)
    marked.set(lc(f.collection), list)
  }
  for (const r of collections) {
    const c = r.collection
    if (!c || /^(nivaro_|directus_|sysdiagrams$)/i.test(c)) continue
    const facts =
      tables.get(`dbo.${lc(c)}`) ?? [...tables.values()].find((t) => lc(t.table) === lc(c))
    map.set(lc(c), judgeWatchable(c, facts, marked.get(lc(c)) ?? []))
  }
  catalogCache = { at: Date.now(), map }
  return map
}

// ── What the app already announced (the event journal) ──────────────────────────

/** Collection → ids (or "the whole collection") announced in these journal entries (pure). */
export function journalAnnounced(
  entries: JournalEntry[]
): Map<string, { ids: Set<string>; whole: boolean }> {
  const out = new Map<string, { ids: Set<string>; whole: boolean }>()
  for (const e of entries) {
    if (e.event !== 'collection:update') continue
    const m = /^collection:(.+)$/.exec(e.room)
    if (!m) continue
    const key = m[1].toLowerCase()
    const g = out.get(key) ?? { ids: new Set<string>(), whole: false }
    const p = e.payload ?? {}
    const item = p.item
    if (item === '*' || p.many === true) g.whole = true
    else if (item != null) g.ids.add(String(item))
    if (Array.isArray(p.items)) for (const i of p.items) if (i != null) g.ids.add(String(i))
    out.set(key, g)
  }
  return out
}

export interface Recent {
  ids: Map<string, number>
  wholeAt: number
}

/**
 * The rows of one look that need announcing (pure): skips (id, stamp) pairs already looked at and
 * ids the app announced a moment ago (counted as `deduped`). Marks every row seen.
 */
export function pickNewRows(
  rows: Array<{ id: unknown; ts: unknown }>,
  seen: Map<string, number>,
  recent: Recent | undefined,
  now: number,
  seenTtlMs: number,
  recentMs: number
): { announce: string[]; deduped: number } {
  const announce = new Set<string>()
  let deduped = 0
  const told = (id: string) =>
    !!recent &&
    (now - recent.wholeAt <= recentMs || now - (recent.ids.get(id) ?? -Infinity) <= recentMs)
  for (const r of rows) {
    if (r.id == null) continue
    const id = String(r.id).trim()
    const key = `${id}|${String(r.ts ?? '')}`
    if (seen.has(key)) continue
    seen.set(key, now + seenTtlMs)
    if (told(id)) deduped++
    else announce.add(id)
  }
  return { announce: [...announce], deduped }
}

// ── The window ───────────────────────────────────────────────────────────────

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/

/** A database stamp (style 126, no zone) minus `seconds`, same form (pure). */
export function stampMinus(stamp: string, seconds: number): string {
  const ms = Date.parse(`${stamp}Z`) - seconds * 1000
  return new Date(ms).toISOString().slice(0, 23)
}

/** The later of two stamps (same form compares as text). */
export const laterStamp = (a: string, b: string | null | undefined) => (b && b > a ? b : a)

export interface WatchWindow {
  lowU: string
  highU: string
  lowL: string
  highL: string
}

const qid = (s: string) => `[${s.replace(/]/g, ']]')}]`

/**
 * The read for one collection's look (pure). Stamps are the database's own (validated before
 * they are written into the text); names come from the catalog. Two range seeks on the index.
 */
export function watchQuery(
  t: { schema: string; table: string; ts: string; pk: string },
  w: WatchWindow,
  cap = ROW_CAP
): string {
  for (const s of [w.lowU, w.highU, w.lowL, w.highL])
    if (!STAMP_RE.test(s)) throw new Error('bad stamp')
  const ts = qid(t.ts)
  return `SELECT TOP (${cap + 1}) CAST(${qid(t.pk)} AS NVARCHAR(255)) AS id, CONVERT(CHAR(23), ${ts}, 126) AS ts
  FROM ${qid(t.schema)}.${qid(t.table)} WITH (READPAST)
 WHERE (${ts} > '${w.lowU}' AND ${ts} <= '${w.highU}')
    OR (${ts} > '${w.lowL}' AND ${ts} <= '${w.highL}')`
}

// ── Change tracking ──────────────────────────────────────────────────────────

const VERSION_RE = /^\d{1,20}$/

/** CHANGETABLE read for one table between two versions (pure; versions validated). */
export function changeTableQuery(
  t: { schema: string; table: string; pk: string },
  last: string,
  upTo: string,
  cap = ROW_CAP
): string {
  if (!VERSION_RE.test(last) || !VERSION_RE.test(upTo)) throw new Error('bad version')
  return `SELECT TOP (${cap + 1}) CAST(ct.${qid(t.pk)} AS NVARCHAR(255)) AS id, ct.SYS_CHANGE_OPERATION AS op
  FROM CHANGETABLE(CHANGES ${qid(t.schema)}.${qid(t.table)}, ${last}) AS ct
 WHERE ct.SYS_CHANGE_VERSION <= ${upTo}`
}

export type CtStep =
  | { kind: 'start'; next: { ctLast: string; ctPending: string } }
  | { kind: 'resync'; next: { ctLast: string; ctPending: string } }
  | { kind: 'idle'; next: { ctLast: string; ctPending: string } }
  | { kind: 'read'; from: string; to: string; next: { ctLast: string; ctPending: string } }

/**
 * What one change-tracking look does (pure). Each look reads (last, pending] — `pending` being the
 * version the PREVIOUS look saw as current — so a change is always one look old before it is
 * judged (a procedure's own announcement has been drained into the journal by then). A history
 * that no longer reaches `last` (min valid version past it) resyncs with one "many changed".
 */
export function changeTrackingStep(
  st: { ctLast?: string; ctPending?: string } | null | undefined,
  current: string,
  minValid: string | null
): CtStep {
  const last = st?.ctLast
  const pending = st?.ctPending
  if (!last || !pending || !VERSION_RE.test(last) || !VERSION_RE.test(pending))
    return { kind: 'start', next: { ctLast: current, ctPending: current } }
  if (minValid != null && VERSION_RE.test(minValid) && BigInt(minValid) > BigInt(last))
    return { kind: 'resync', next: { ctLast: current, ctPending: current } }
  if (BigInt(pending) <= BigInt(last))
    return { kind: 'idle', next: { ctLast: last, ctPending: current } }
  return { kind: 'read', from: last, to: pending, next: { ctLast: pending, ctPending: current } }
}

/**
 * Change-tracking rows → what to announce per action (pure): I = added, U = changed, D = removed.
 * Ids the app announced a moment ago are skipped (`deduped`).
 */
export function changeTrackingAnnouncements(
  rows: Array<{ id: unknown; op: unknown }>,
  recentEntry: Recent | undefined,
  now: number,
  recentMs: number
): { create: string[]; update: string[]; delete: string[]; deduped: number } {
  const out = { create: new Set<string>(), update: new Set<string>(), delete: new Set<string>() }
  let deduped = 0
  for (const r of rows) {
    if (r.id == null) continue
    const id = String(r.id).trim()
    const told =
      !!recentEntry &&
      (now - recentEntry.wholeAt <= recentMs ||
        now - (recentEntry.ids.get(id) ?? -Infinity) <= recentMs)
    if (told) {
      deduped++
      continue
    }
    const op = String(r.op ?? 'U').toUpperCase()
    ;(op === 'I' ? out.create : op === 'D' ? out.delete : out.update).add(id)
  }
  return {
    create: [...out.create],
    update: [...out.update],
    delete: [...out.delete],
    deduped
  }
}

// ── State ────────────────────────────────────────────────────────────────────

interface CollState {
  /** High edge of the last look, UTC and local. */
  u: string
  l: string
  /** After a "many rows" look: nothing at or below this is read again. */
  floorU?: string
  floorL?: string
  /** Change tracking: the last version announced up to, and the one the next look reads to. */
  ctLast?: string
  ctPending?: string
}

export interface CollectionStatus {
  collection: string
  state: 'watching' | 'starting' | 'refused' | 'live-off' | 'error'
  /** How it was looked at (null when it was not). */
  method?: WatchMethod | null
  reason?: string
  at: number
  last_caught_at?: number | null
  viewers?: number
}

let lastTickAt = 0
let journalCursor: number | null = null
const states = new Map<string, CollState>()
const seenRows = new Map<string, Map<string, number>>()
const recent = new Map<string, Recent>()
const statusLocal = new Map<string, CollectionStatus>()
const countsLocal = new Map<string, { caught: number; deduped: number }>()
/** What the previous look announced itself (collection → ids / whole). */
let lastMine = new Map<string, { ids: Set<string>; whole: boolean }>()
let lastReport: TickReport | null = null

export interface TickReport {
  at: number
  watched: number
  caught: number
  deduped: number
  ms: number
}

const redisOf = (): Redis | null => (getApp()?.redis as Redis | undefined) ?? null
const rkey = (part: string) => `nvr:rt:outside:${instanceKey()}:${part}`
const hourOf = (ms: number) => Math.floor(ms / 3_600_000)

/** Tests only. */
export function resetOutsideWriteWatch(): void {
  lastTickAt = 0
  journalCursor = null
  states.clear()
  seenRows.clear()
  recent.clear()
  statusLocal.clear()
  countsLocal.clear()
  lastMine = new Map()
  settingsCache = null
  catalogCache = null
  trackedCache = null
  lastReport = null
}

/**
 * Fold the journal's announcements into `recent` — leaving out the watcher's OWN announcements
 * of the previous look (`mine`): those must not make the next change to the same row look told.
 */
export function noteJournal(
  entries: JournalEntry[],
  now: number,
  recentMs: number,
  mine: Map<string, { ids: Set<string>; whole: boolean }> = lastMine,
  into: Map<string, Recent> = recent
): void {
  for (const [c, g] of journalAnnounced(entries)) {
    const own = mine.get(c)
    const r = into.get(c) ?? { ids: new Map<string, number>(), wholeAt: -Infinity }
    if (g.whole && !own?.whole) r.wholeAt = now
    for (const id of g.ids) if (!own?.ids.has(id) && !own?.whole) r.ids.set(id, now)
    into.set(c, r)
  }
  for (const [c, r] of into) {
    for (const [id, at] of r.ids) if (now - at > recentMs) r.ids.delete(id)
    if (!r.ids.size && now - r.wholeAt > recentMs) into.delete(c)
  }
}

function pruneSeen(now: number): void {
  for (const [c, m] of seenRows) {
    for (const [k, exp] of m) if (exp <= now) m.delete(k)
    if (m.size > SEEN_MAX) {
      const drop = m.size - SEEN_MAX
      let i = 0
      for (const k of m.keys()) {
        if (i++ >= drop) break
        m.delete(k)
      }
    }
    if (!m.size) seenRows.delete(c)
  }
}

/** Collections someone has open now: list rooms + record viewers, busiest first. */
export async function viewedCollections(): Promise<Array<{ collection: string; viewers: number }>> {
  const counts = new Map<string, { collection: string; viewers: number }>()
  const add = (c: string, n: number) => {
    if (!c || /^(nivaro_|directus_|sysdiagrams$)/i.test(c)) return
    const k = c.toLowerCase()
    const cur = counts.get(k) ?? { collection: c, viewers: 0 }
    cur.viewers += n
    counts.set(k, cur)
  }
  try {
    const sock = await import('../plugins/socketio.js')
    const { boardStats } = await import('./realtime-board.js')
    const rooms = [
      ...sock.getLocalRealtimeStats().rooms,
      ...boardStats().flatMap((b) => b.rooms ?? [])
    ]
    for (const r of rooms) {
      const m = /^collection:(.+)$/.exec(r.room)
      if (m) add(m[1], r.size)
    }
    for (const v of sock.getRecordViewerSnapshot()) add(v.collection, v.viewers.length)
  } catch {
    /* no socket server here */
  }
  return [...counts.values()].sort((a, b) => b.viewers - a.viewers)
}

async function readClock(): Promise<{ u: string; l: string } | null> {
  const rows = (await db.raw(
    `SELECT CONVERT(CHAR(23), DATEADD(SECOND, -${SETTLE_S}, SYSUTCDATETIME()), 126) AS u,
            CONVERT(CHAR(23), DATEADD(SECOND, -${SETTLE_S}, SYSDATETIME()), 126) AS l`
  )) as Array<{ u: string; l: string }>
  const r = rows?.[0]
  return r && STAMP_RE.test(String(r.u).trim()) && STAMP_RE.test(String(r.l).trim())
    ? { u: String(r.u).trim(), l: String(r.l).trim() }
    : null
}

/** CHANGE_TRACKING_CURRENT_VERSION() as text (null when change tracking is off). */
/** The watcher's state key for the dependents group (system + child tables). */
const DEP_KEY = '__dependents__'
let trackedCache: { at: number; set: Set<string> } | null = null

/** dbo tables with change tracking on, lower-cased (cached 10 minutes). */
async function trackedTables(): Promise<Set<string>> {
  if (trackedCache && Date.now() - trackedCache.at < CATALOG_TTL_MS) return trackedCache.set
  const rows = (await db
    .raw(`SELECT t.name AS tbl FROM sys.change_tracking_tables ct
           JOIN sys.tables t ON t.object_id = ct.object_id
           JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = 'dbo'`)
    .catch(() => [])) as Array<{ tbl: string }>
  const set = new Set(rows.map((r) => r.tbl.toLowerCase()))
  trackedCache = { at: Date.now(), set }
  return set
}

/**
 * The dependents group: tracked system tables and the registered child / junction tables of the
 * collections being watched. One version pair for the group, one probe for which tables moved,
 * then one read per moved table; rows become aspects on the records they belong to
 * (outside-write-system.ts). Returns rows caught / deduped per owning collection.
 */
async function lookDependents(o: {
  now: number
  clock: { u: string; l: string }
  current: string
  watched: string[]
  catalog: Map<string, Watchable>
  recentMs: number
  mine: Map<string, { ids: Set<string>; whole: boolean }>
  wm: Record<string, string>
}): Promise<Map<string, { caught: number; deduped: number }>> {
  const counts = new Map<string, { caught: number; deduped: number }>()
  const tracked = await trackedTables()
  const { getRelations } = await import('./collections.js')
  const rels = (await getRelations()) as unknown as Parameters<typeof mapChildRows>[1]
  const system = SYSTEM_TABLES.filter((t) => tracked.has(t))
  const children = dependentTables(o.watched, rels, tracked).filter(
    (t) => !!o.catalog.get(t.toLowerCase())?.pk
  )
  const tables = [...system, ...children]
  if (!tables.length) return counts
  const st = states.get(DEP_KEY) ?? (await resumeState(DEP_KEY))
  const step = changeTrackingStep(st, o.current, null)
  const next = { ...(st ?? {}), u: o.clock.u, l: o.clock.l, ...step.next }
  states.set(DEP_KEY, next)
  o.wm[DEP_KEY] = JSON.stringify({ ...next, at: o.now })
  if (step.kind !== 'read') return counts
  const moved = (
    await runLongSql<{ t: string }>(probeQuery(tables, step.from, step.to), { timeoutMs: 5000 })
  ).map((r) => r.t)
  const bump = (c: string, k: 'caught' | 'deduped', n: number) => {
    const key = c.toLowerCase()
    const cur = counts.get(key) ?? { caught: 0, deduped: 0 }
    cur[k] += n
    counts.set(key, cur)
  }
  for (const t of moved) {
    try {
      let notices: ReturnType<typeof mapChildRows>
      if ((SYSTEM_TABLES as readonly string[]).includes(t)) {
        const rows = await runLongSql<Record<string, unknown>>(
          systemDetailQuery(t as SystemTable, step.from, step.to),
          { timeoutMs: 5000 }
        )
        const plan = mapSystemRows(t as SystemTable, rows)
        notices = plan.notices
        if (plan.people) {
          const { notePeopleChanged } = await import('./people-live.js')
          notePeopleChanged(plan.people.ids.length ? plan.people.ids : null, {
            created: plan.people.created
          })
          bump('nivaro_users', 'caught', plan.people.ids.length || 1)
        }
        if (plan.ops.length) {
          const { pokeOps } = await import('./ops-live.js')
          for (const topic of plan.ops) pokeOps(topic)
        }
        if (plan.files.length) {
          const { announceFileCarriers, recordsCarryingFile } = await import(
            './related-announce.js'
          )
          for (const f of plan.files.slice(0, 50))
            announceFileCarriers(await recordsCarryingFile(f))
          bump('nivaro_files', 'caught', plan.files.length)
        }
      } else {
        const pk = o.catalog.get(t.toLowerCase())?.pk as string
        const rows = await runLongSql<Record<string, unknown>>(
          childDetailQuery(t, pk, step.from, step.to),
          { timeoutMs: 5000 }
        )
        notices = mapChildRows(t, rels, rows)
      }
      const e = planEmits(notices, recent, o.now, o.recentMs)
      const { queueForeignAspect } = await import('./related-announce.js')
      const { announceRecordAspect } = await import('./record-events.js')
      for (const f of e.foreign) queueForeignAspect(f.collection, f.item, f.aspect)
      for (const r of e.record)
        announceRecordAspect(
          r.collection,
          r.item,
          r.aspects as Parameters<typeof announceRecordAspect>[2]
        )
      for (const n of [...e.record, ...e.foreign]) {
        const key = n.collection.toLowerCase()
        const m = o.mine.get(key) ?? { ids: new Set<string>(), whole: false }
        if (n.item === '*') m.whole = true
        else m.ids.add(n.item)
        o.mine.set(key, m)
        bump(n.collection, 'caught', 1)
      }
      if (e.deduped) bump(t, 'deduped', e.deduped)
    } catch {
      /* one table's read failing never stops the others */
    }
  }
  return counts
}

async function readChangeTrackingVersion(): Promise<string | null> {
  const [r] = (await db.raw(
    'SELECT CAST(CHANGE_TRACKING_CURRENT_VERSION() AS VARCHAR(20)) AS v'
  )) as Array<{ v: string | null }>
  const v = r?.v == null ? null : String(r.v).trim()
  return v && VERSION_RE.test(v) ? v : null
}

async function resumeState(collection: string): Promise<CollState | null> {
  const redis = redisOf()
  if (!redis) return null
  try {
    const raw = await redis.hget(rkey('wm'), collection.toLowerCase())
    if (!raw) return null
    const s = JSON.parse(raw) as CollState & { at?: number }
    if (!s.at || Date.now() - s.at > RESUME_MAX_MS) return null
    if (!STAMP_RE.test(s.u) || !STAMP_RE.test(s.l)) return null
    return s
  } catch {
    return null
  }
}

/**
 * One look (the cron body, every 5 s; it skips until the interval has passed). Returns null when
 * it did not look (off, cloud, not SQL Server, not due).
 */
export async function outsideWriteTick(now = Date.now()): Promise<TickReport | null> {
  if (isCloudMode() || !isMssql(db)) return null
  const settings = effectiveOutsideWrites(await getOutsideWriteSettings())
  if (!settings.enabled) return null
  if (now - lastTickAt < settings.interval_seconds * 1000 - 500) return null
  lastTickAt = now
  const t0 = Date.now()

  // 1. what the app announced since the last look (dedupe)
  const recentMs = recentWindowMs(settings.interval_seconds)
  const tail = await journalTail(journalCursor)
  if (tail) {
    if (journalCursor != null) noteJournal(tail.entries, now, recentMs)
    journalCursor = tail.seq
  }
  const mine = new Map<string, { ids: Set<string>; whole: boolean }>()
  lastMine = mine

  // 2. which collections
  const viewed = await viewedCollections()
  const viewers = new Map(viewed.map((v) => [v.collection.toLowerCase(), v.viewers]))
  const wanted = settings.mode === 'chosen' ? settings.collections : viewed.map((v) => v.collection)
  const list = wanted.slice(0, MAX_WATCHED)
  const report: TickReport = { at: now, watched: 0, caught: 0, deduped: 0, ms: 0 }
  if (!list.length) {
    lastReport = { ...report, ms: Date.now() - t0 }
    return lastReport
  }
  const catalog = await watchCatalog()
  const clock = await readClock()
  if (!clock) return null
  pruneSeen(now)
  const seenTtl = (OVERLAP_S + SETTLE_S + settings.interval_seconds * 2) * 1000
  const wm: Record<string, string> = {}
  let ctCurrent: string | null = null
  const statuses: CollectionStatus[] = []
  const caughtBy = new Map<string, { caught: number; deduped: number }>()

  for (const c of list) {
    const key = c.toLowerCase()
    const status: CollectionStatus = {
      collection: c,
      state: 'watching',
      at: now,
      viewers: viewers.get(key) ?? 0,
      last_caught_at: statusLocal.get(key)?.last_caught_at ?? null
    }
    statuses.push(status)
    const j = catalog.get(key)
    status.method = j?.watchable ? (j.method ?? 'timestamp') : null
    if (
      !j?.watchable ||
      !j.schema ||
      !j.table ||
      !j.pk ||
      (j.method !== 'change-tracking' && !j.ts)
    ) {
      status.state = 'refused'
      status.reason = j?.reason ?? 'Not a registered collection.'
      continue
    }
    if ((await liveModeOf(j.collection).catch(() => 'on')) === 'off') {
      status.state = 'live-off'
      status.reason = 'Realtime is switched off for this collection (Data Model → Settings).'
      continue
    }
    let st = states.get(key) ?? (await resumeState(key))
    if (j.method === 'change-tracking') {
      try {
        report.watched++
        ctCurrent ??= await readChangeTrackingVersion()
        if (!ctCurrent) throw new Error('change tracking version unreadable')
        const qualified = `${qid(j.schema)}.${qid(j.table)}`
        const [mv] = (await db.raw(
          `SELECT CAST(CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(N'${qualified.replace(/'/g, "''")}')) AS VARCHAR(20)) AS v`
        )) as Array<{ v: string | null }>
        const step = changeTrackingStep(st, ctCurrent, mv?.v ?? null)
        const counts = { caught: 0, deduped: 0 }
        if (step.kind === 'start') status.state = 'starting'
        else if (step.kind === 'resync') {
          // the kept history no longer reaches our version: tell screens once, start again
          await announceRawWrites(j.collection, null, { source: 'outside-write-watch' })
          mine.set(key, { ids: new Set(), whole: true })
          counts.caught = 1
        } else if (step.kind === 'read') {
          const rows = await runLongSql<{ id: unknown; op: unknown }>(
            changeTableQuery({ schema: j.schema, table: j.table, pk: j.pk }, step.from, step.to),
            { timeoutMs: 5000 }
          )
          if (rows.length > ROW_CAP) {
            await announceRawWrites(j.collection, null, { source: 'outside-write-watch' })
            mine.set(key, { ids: new Set(), whole: true })
            counts.caught = rows.length
          } else {
            const a = changeTrackingAnnouncements(rows, recent.get(key), now, recentMs)
            const own = new Set<string>()
            for (const [action, ids] of [
              ['create', a.create],
              ['update', a.update],
              ['delete', a.delete]
            ] as const) {
              if (!ids.length) continue
              await announceRawWrites(j.collection, ids, { action, source: 'outside-write-watch' })
              for (const id of ids) own.add(id)
            }
            if (own.size) mine.set(key, { ids: own, whole: own.size > BULK_CAP })
            counts.caught = own.size
            counts.deduped = a.deduped
          }
        }
        st = { ...(st ?? {}), u: clock.u, l: clock.l, ...step.next }
        states.set(key, st)
        wm[key] = JSON.stringify({ ...st, at: now })
        if (counts.caught) status.last_caught_at = now
        report.caught += counts.caught
        report.deduped += counts.deduped
        if (counts.caught || counts.deduped) caughtBy.set(key, counts)
      } catch (err) {
        status.state = 'error'
        status.reason = /timeout/i.test(err instanceof Error ? err.message : '')
          ? 'The look took longer than 5 seconds and was stopped.'
          : 'The change-tracking read failed; it is tried again next time.'
      }
      continue
    }
    if (!st) {
      // first sight: start from now (nothing before this moment is announced)
      states.set(key, { u: clock.u, l: clock.l })
      wm[key] = JSON.stringify({ u: clock.u, l: clock.l, at: now })
      status.state = 'starting'
      continue
    }
    states.set(key, st)
    const w: WatchWindow = {
      lowU: laterStamp(stampMinus(st.u, OVERLAP_S), st.floorU),
      highU: clock.u,
      lowL: laterStamp(stampMinus(st.l, OVERLAP_S), st.floorL),
      highL: clock.l
    }
    try {
      report.watched++
      const rows = await runLongSql<{ id: unknown; ts: unknown }>(
        watchQuery({ schema: j.schema, table: j.table, ts: j.ts ?? '', pk: j.pk }, w),
        { timeoutMs: 5000 }
      )
      const counts = { caught: 0, deduped: 0 }
      if (rows.length > ROW_CAP) {
        // a bulk change: one "many records changed", and the window moves past it
        await announceRawWrites(j.collection, null, { source: 'outside-write-watch' })
        mine.set(key, { ids: new Set(), whole: true })
        counts.caught = rows.length
        st = { u: clock.u, l: clock.l, floorU: clock.u, floorL: clock.l }
      } else {
        const seen = seenRows.get(key) ?? new Map<string, number>()
        seenRows.set(key, seen)
        const picked = pickNewRows(rows, seen, recent.get(key), now, seenTtl, recentMs)
        if (picked.announce.length) {
          await announceRawWrites(j.collection, picked.announce, {
            source: 'outside-write-watch'
          })
          // past the announcer's cap the ids go out as one "many changed" event
          mine.set(key, {
            ids: new Set(picked.announce),
            whole: picked.announce.length > BULK_CAP
          })
        }
        counts.caught = picked.announce.length
        counts.deduped = picked.deduped
        st = { ...st, u: clock.u, l: clock.l }
      }
      states.set(key, st)
      wm[key] = JSON.stringify({ ...st, at: now })
      if (counts.caught) status.last_caught_at = now
      report.caught += counts.caught
      report.deduped += counts.deduped
      if (counts.caught || counts.deduped) caughtBy.set(key, counts)
    } catch (err) {
      status.state = 'error'
      status.reason = /timeout/i.test(err instanceof Error ? err.message : '')
        ? 'The look took longer than 5 seconds and was stopped.'
        : 'The look failed; it is tried again next time.'
    }
  }

  // tables whose rows belong to the open records (system + child tables), via change tracking
  try {
    ctCurrent ??= await readChangeTrackingVersion()
    if (ctCurrent) {
      const dep = await lookDependents({
        now,
        clock,
        current: ctCurrent,
        watched: list,
        catalog,
        recentMs,
        mine,
        wm
      })
      for (const [k, n] of dep) {
        const cur = caughtBy.get(k) ?? { caught: 0, deduped: 0 }
        caughtBy.set(k, { caught: cur.caught + n.caught, deduped: cur.deduped + n.deduped })
        report.caught += n.caught
        report.deduped += n.deduped
      }
    }
  } catch {
    /* change tracking unreadable here: the dependents wait for the next look */
  }

  for (const s of statuses) statusLocal.set(s.collection.toLowerCase(), s)
  for (const [k, n] of caughtBy) {
    const cur = countsLocal.get(`${hourOf(now)}|${k}`) ?? { caught: 0, deduped: 0 }
    countsLocal.set(`${hourOf(now)}|${k}`, {
      caught: cur.caught + n.caught,
      deduped: cur.deduped + n.deduped
    })
  }
  for (const k of countsLocal.keys())
    if (Number(k.split('|')[0]) < hourOf(now) - 25) countsLocal.delete(k)
  const redis = redisOf()
  if (redis) {
    try {
      const pipe = redis.multi()
      if (Object.keys(wm).length) {
        pipe.hset(rkey('wm'), wm)
        pipe.expire(rkey('wm'), 3600)
      }
      const st: Record<string, string> = {}
      for (const s of statuses) st[s.collection.toLowerCase()] = JSON.stringify(s)
      pipe.hset(rkey('status'), st)
      pipe.expire(rkey('status'), 3600)
      if (caughtBy.size) {
        const hk = rkey(`h:${hourOf(now)}`)
        for (const [k, n] of caughtBy) {
          if (n.caught) pipe.hincrby(hk, `c:${k}`, n.caught)
          if (n.deduped) pipe.hincrby(hk, `d:${k}`, n.deduped)
        }
        pipe.expire(hk, 25 * 3600)
      }
      pipe.set(rkey('tick'), JSON.stringify({ ...report, ms: Date.now() - t0 }), 'EX', 3600)
      await pipe.exec()
    } catch {
      /* counters are best effort */
    }
  }
  lastReport = { ...report, ms: Date.now() - t0 }
  return lastReport
}

// ── The report (any process: Redis, else this process) ───────────────────────

export interface OutsideWriteReport {
  last_tick: TickReport | null
  statuses: CollectionStatus[]
  /** Collection (lower-cased) → rows caught / skipped as already announced, last 24 hours. */
  counts: Record<string, { caught: number; deduped: number }>
}

export async function outsideWriteReport(now = Date.now()): Promise<OutsideWriteReport> {
  const counts: Record<string, { caught: number; deduped: number }> = {}
  const bump = (k: string, field: 'caught' | 'deduped', n: number) => {
    const cur = counts[k] ?? { caught: 0, deduped: 0 }
    cur[field] += n
    counts[k] = cur
  }
  const redis = redisOf()
  if (redis) {
    try {
      const hours = Array.from({ length: 24 }, (_, i) => hourOf(now) - i)
      const pipe = redis.multi()
      for (const h of hours) pipe.hgetall(rkey(`h:${h}`))
      pipe.hgetall(rkey('status'))
      pipe.get(rkey('tick'))
      const res = (await pipe.exec()) ?? []
      for (let i = 0; i < hours.length; i++) {
        const h = (res[i]?.[1] ?? {}) as Record<string, string>
        for (const [f, v] of Object.entries(h)) {
          const kind = f.startsWith('c:') ? 'caught' : f.startsWith('d:') ? 'deduped' : null
          if (kind) bump(f.slice(2), kind, Number(v) || 0)
        }
      }
      const st = (res[hours.length]?.[1] ?? {}) as Record<string, string>
      const statuses: CollectionStatus[] = []
      for (const v of Object.values(st)) {
        try {
          statuses.push(JSON.parse(v) as CollectionStatus)
        } catch {
          /* skip */
        }
      }
      const tickRaw = res[hours.length + 1]?.[1] as string | null | undefined
      let last: TickReport | null = null
      try {
        last = tickRaw ? (JSON.parse(tickRaw) as TickReport) : null
      } catch {
        last = null
      }
      return { last_tick: last ?? lastReport, statuses, counts }
    } catch {
      /* fall through to this process's own figures */
    }
  }
  for (const [k, n] of countsLocal) {
    const [h, c] = [Number(k.split('|')[0]), k.slice(k.indexOf('|') + 1)]
    if (h < hourOf(now) - 23) continue
    bump(c, 'caught', n.caught)
    bump(c, 'deduped', n.deduped)
  }
  return { last_tick: lastReport, statuses: [...statusLocal.values()], counts }
}
