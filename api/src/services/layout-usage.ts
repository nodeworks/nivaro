import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { getTenantId } from '../db/tenant-context.js'
import { sharedGatedRead } from './read-gate.js'

/**
 * Form usage per layout (#2597 usage today, #2598 friction, #2605 co-changes).
 *
 * The record form (ItemEditForm) sends one small event per form session when
 * it closes: which layout, which record, time spent on each step, whether it
 * saved, and the step a NEW record was left on without being created. The
 * server keeps one row per layout per UTC day (nivaro_layout_usage_daily) and
 * the distinct people and records that day (nivaro_layout_usage_seen): O(1)
 * per form session, nothing per keystroke. Rows older than 180 days are
 * pruned nightly (cron `layout-usage-prune`).
 *
 * "Changed after save" and the co-change pairs are mined from revisions, the
 * way the Table Editor's edit-frequency card does: read-gated and cached.
 *
 * Migration 461 creates the tables. Without them every writer is a no-op and
 * every reader answers empty (`ready: false`).
 */

export const DAILY = 'nivaro_layout_usage_daily'
export const SEEN = 'nivaro_layout_usage_seen'
export const KEEP_DAYS = 180

export interface UsageEvent {
  layout_id: number
  collection: string
  /** Saved record id; null = a new record. */
  item: string | null
  /** First event of a form session (counts the open, the person and the record). */
  open: boolean
  saved: boolean
  /** New record left without being created: the step it was on. */
  abandoned_step: string | null
  /** Milliseconds spent on each step (one key `__form__` for a form without steps). */
  steps: Record<string, number>
}

export interface StepStat {
  /** Total milliseconds on the step. */
  ms: number
  /** Sessions that spent time on it. */
  n: number
  /** New records abandoned on it. */
  a: number
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const STEP_KEY = /^[A-Za-z0-9_:. -]{1,100}$/
const MAX_STEP_MS = 2 * 60 * 60_000
const MAX_STEPS = 30

/** Machine-maintained columns that change on every save: never "changed by a person". */
const MACHINE_KEYS = new Set([
  'id',
  'updated_at',
  'date_updated',
  'user_updated',
  'updated_by',
  'modified_at',
  'modified_by',
  'date_created',
  'user_created',
  'created_at',
  'created_by'
])

export function isPersonField(k: string): boolean {
  return !k.startsWith('_') && !MACHINE_KEYS.has(k)
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/** One beacon event, validated and clamped; null when it is not usable. */
export function sanitizeUsageEvent(raw: unknown): UsageEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const layoutId = Number(r.layout_id)
  if (!Number.isInteger(layoutId) || layoutId <= 0) return null
  const collection = typeof r.collection === 'string' ? r.collection : ''
  if (!IDENT.test(collection) || collection.length > 64) return null
  const item =
    (typeof r.item === 'string' || typeof r.item === 'number') &&
    String(r.item).length > 0 &&
    String(r.item).length <= 64 &&
    String(r.item) !== 'new'
      ? String(r.item)
      : null
  const steps: Record<string, number> = {}
  if (r.steps && typeof r.steps === 'object' && !Array.isArray(r.steps)) {
    for (const [k, v] of Object.entries(r.steps as Record<string, unknown>)) {
      if (Object.keys(steps).length >= MAX_STEPS) break
      const ms = Number(v)
      if (!STEP_KEY.test(k) || !Number.isFinite(ms) || ms <= 0) continue
      steps[k] = Math.min(MAX_STEP_MS, Math.round(ms))
    }
  }
  const saved = r.saved === true
  const abandoned =
    !saved &&
    item == null &&
    typeof r.abandoned_step === 'string' &&
    STEP_KEY.test(r.abandoned_step)
      ? r.abandoned_step
      : null
  return {
    layout_id: layoutId,
    collection,
    item,
    open: r.open === true,
    saved,
    abandoned_step: abandoned,
    steps
  }
}

export function parseStepStats(json: unknown): Record<string, StepStat> {
  if (typeof json !== 'string' || !json) return {}
  try {
    const v = JSON.parse(json) as Record<string, Partial<StepStat>>
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, StepStat> = {}
    for (const [k, s] of Object.entries(v)) {
      if (!s || typeof s !== 'object') continue
      out[k] = { ms: Number(s.ms) || 0, n: Number(s.n) || 0, a: Number(s.a) || 0 }
    }
    return out
  } catch {
    return {}
  }
}

/** Adds one event's step time and abandon to a day's stored step stats. */
export function mergeStepStats(prev: unknown, ev: UsageEvent): string {
  const stats = parseStepStats(prev)
  const bump = (k: string) => {
    if (!stats[k]) stats[k] = { ms: 0, n: 0, a: 0 }
    return stats[k]
  }
  for (const [k, ms] of Object.entries(ev.steps)) {
    const s = bump(k)
    s.ms += ms
    s.n += 1
  }
  if (ev.abandoned_step) bump(ev.abandoned_step).a += 1
  return JSON.stringify(stats)
}

export interface FrictionStep {
  key: string
  avg_ms: number
  sessions: number
  abandons: number
}

/** Several days of rows → totals and per-step averages (slowest first). */
export function rollUpFriction(
  rows: Array<{ opens?: unknown; saves?: unknown; abandons?: unknown; step_stats?: unknown }>
): { opens: number; saves: number; abandons: number; steps: FrictionStep[] } {
  const sum: Record<string, StepStat> = {}
  let opens = 0
  let saves = 0
  let abandons = 0
  for (const r of rows) {
    opens += Number(r.opens) || 0
    saves += Number(r.saves) || 0
    abandons += Number(r.abandons) || 0
    for (const [k, s] of Object.entries(parseStepStats(r.step_stats))) {
      const t = sum[k] ?? { ms: 0, n: 0, a: 0 }
      t.ms += s.ms
      t.n += s.n
      t.a += s.a
      sum[k] = t
    }
  }
  const steps = Object.entries(sum)
    .map(([key, s]) => ({
      key,
      avg_ms: s.n > 0 ? Math.round(s.ms / s.n) : 0,
      sessions: s.n,
      abandons: s.a
    }))
    .sort((a, b) => b.avg_ms - a.avg_ms)
  return { opens, saves, abandons, steps }
}

function deltaKeys(delta: string | null): string[] {
  if (!delta) return []
  try {
    const v = JSON.parse(delta) as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v)) return []
    return Object.keys(v).filter(isPersonField)
  } catch {
    return []
  }
}

/** Field → how many revisions changed it (most first). */
export function countDeltaFields(
  deltas: Array<string | null>
): Array<{ field: string; changes: number }> {
  const counts = new Map<string, number>()
  for (const d of deltas) for (const k of deltaKeys(d)) counts.set(k, (counts.get(k) ?? 0) + 1)
  return [...counts.entries()]
    .map(([field, changes]) => ({ field, changes }))
    .sort((a, b) => b.changes - a.changes || a.field.localeCompare(b.field))
}

export interface CoChangePair {
  a: string
  b: string
  /** Revisions that changed both. */
  together: number
  /** together / revisions that changed either (Jaccard). */
  jaccard: number
}

/**
 * Fields changed in the same revision: per-field counts and the pairs that
 * move together (Jaccard ≥ minJaccard, together ≥ minTogether), best first.
 * Revisions touching more than `maxFieldsPerRevision` person fields are bulk
 * edits / imports and say nothing about how people fill a form: skipped.
 */
export function coChangePairs(
  deltas: Array<string | null>,
  opts: {
    minTogether?: number
    minJaccard?: number
    maxFieldsPerRevision?: number
    limit?: number
  } = {}
): { revisions: number; fields: Record<string, number>; pairs: CoChangePair[] } {
  const minTogether = opts.minTogether ?? 5
  const minJaccard = opts.minJaccard ?? 0.4
  const maxFields = opts.maxFieldsPerRevision ?? 12
  const limit = opts.limit ?? 200
  const single = new Map<string, number>()
  const pair = new Map<string, number>()
  let revisions = 0
  for (const d of deltas) {
    const keys = [...new Set(deltaKeys(d))].sort()
    if (keys.length === 0 || keys.length > maxFields) continue
    revisions++
    for (const k of keys) single.set(k, (single.get(k) ?? 0) + 1)
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const pk = `${keys[i]}\u0000${keys[j]}`
        pair.set(pk, (pair.get(pk) ?? 0) + 1)
      }
  }
  const pairs: CoChangePair[] = []
  for (const [pk, together] of pair) {
    if (together < minTogether) continue
    const [a, b] = pk.split('\u0000')
    const union = (single.get(a) ?? 0) + (single.get(b) ?? 0) - together
    const jaccard = union > 0 ? Math.round((together / union) * 1000) / 1000 : 0
    if (jaccard < minJaccard) continue
    pairs.push({ a, b, together, jaccard })
  }
  pairs.sort((x, y) => y.jaccard - x.jaccard || y.together - x.together)
  return { revisions, fields: Object.fromEntries(single), pairs: pairs.slice(0, limit) }
}

// ─── Database ───────────────────────────────────────────────────────────────

const readyCache = new Map<string, { at: number; ok: boolean }>()

/** Do migration 461's tables exist (per tenant; a miss is re-probed after 10 min)? */
export async function usageTablesReady(): Promise<boolean> {
  const key = getTenantId() ?? ''
  const hit = readyCache.get(key)
  if (hit && (hit.ok || Date.now() - hit.at < 10 * 60_000)) return hit.ok
  let ok = false
  try {
    ok = (await db.schema.hasTable(DAILY)) && (await db.schema.hasTable(SEEN))
  } catch {
    ok = false
  }
  readyCache.set(key, { at: Date.now(), ok })
  return ok
}

function isUniqueViolation(err: unknown): boolean {
  const code = (n: unknown) => n === 2627 || n === 2601 || n === '23505'
  const e = err as { number?: unknown; code?: unknown; errors?: unknown } | null
  if (!e || typeof e !== 'object') return false
  if (code(e.number) || code(e.code)) return true
  return Array.isArray(e.errors) && e.errors.some((x) => code((x as { number?: unknown })?.number))
}

const layoutCollections = new Map<
  string,
  { at: number; collection: string | null; conditions: unknown }
>()

/** A layout's collection and role conditions (cached 60 s); null = no such layout. */
export async function layoutUsageInfo(
  layoutId: number
): Promise<{ collection: string; conditions: unknown } | null> {
  const key = `${getTenantId() ?? ''}|${layoutId}`
  const hit = layoutCollections.get(key)
  if (hit && Date.now() - hit.at < 60_000)
    return hit.collection ? { collection: hit.collection, conditions: hit.conditions } : null
  const row = (await db('nivaro_collection_layouts')
    .where({ id: layoutId })
    .first('collection', 'conditions')) as { collection?: string; conditions?: unknown } | undefined
  const collection = row?.collection ?? null
  const conditions = row?.conditions ?? null
  layoutCollections.set(key, { at: Date.now(), collection, conditions })
  if (layoutCollections.size > 2000)
    layoutCollections.delete(layoutCollections.keys().next().value as string)
  return collection ? { collection, conditions } : null
}

/** The collection a layout belongs to (cached 60 s); null = no such layout. */
export async function layoutCollection(layoutId: number): Promise<string | null> {
  return (await layoutUsageInfo(layoutId))?.collection ?? null
}

async function upsertDaily(ev: UsageEvent, day: string): Promise<void> {
  await db.transaction(async (trx) => {
    const row = (await trx(DAILY)
      .where({ layout_id: ev.layout_id, day })
      .forUpdate()
      .first('id', 'opens', 'saves', 'abandons', 'step_stats')) as
      | { id: number; opens: number; saves: number; abandons: number; step_stats: string | null }
      | undefined
    const step_stats = mergeStepStats(row?.step_stats ?? null, ev)
    const opens = ev.open ? 1 : 0
    const saves = ev.saved ? 1 : 0
    const abandons = ev.abandoned_step ? 1 : 0
    if (row) {
      await trx(DAILY)
        .where({ id: row.id })
        .update({
          opens: Number(row.opens) + opens,
          saves: Number(row.saves) + saves,
          abandons: Number(row.abandons) + abandons,
          step_stats,
          updated_at: new Date()
        })
    } else {
      await trx(DAILY).insert({
        layout_id: ev.layout_id,
        collection: ev.collection,
        day,
        opens,
        saves,
        abandons,
        step_stats,
        updated_at: new Date()
      })
    }
  })
}

async function markSeen(layoutId: number, day: string, kind: 'u' | 'r', ref: string) {
  try {
    await db.raw(
      `INSERT INTO ${SEEN} (layout_id, day, kind, ref) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${SEEN} WHERE layout_id = ? AND day = ? AND kind = ? AND ref = ?)`,
      [layoutId, day, kind, ref, layoutId, day, kind, ref]
    )
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }
}

/** Store one form session's event (the caller has checked the layout and access). */
export async function recordUsage(ev: UsageEvent, userId: string | null): Promise<void> {
  const day = utcDay()
  try {
    await upsertDaily(ev, day)
  } catch (err) {
    // Two first events of the day raced to insert: the loser adds onto the winner.
    if (!isUniqueViolation(err)) throw err
    await upsertDaily(ev, day)
  }
  if (ev.open && userId) await markSeen(ev.layout_id, day, 'u', userId.slice(0, 64))
  if (ev.open && ev.item) await markSeen(ev.layout_id, day, 'r', ev.item)
}

export interface UsageToday {
  ready: boolean
  day: string
  opens: number
  people: number
  records: number
}

export async function usageToday(layoutId: number): Promise<UsageToday> {
  const day = utcDay()
  if (!(await usageTablesReady())) return { ready: false, day, opens: 0, people: 0, records: 0 }
  const row = (await db(DAILY).where({ layout_id: layoutId, day }).first('opens')) as
    | { opens?: number }
    | undefined
  const seen = (await db(SEEN)
    .where({ layout_id: layoutId, day })
    .groupBy('kind')
    .select('kind')
    .count({ n: '*' })) as Array<{ kind: string; n: number | string }>
  const n = (k: string) => Number(seen.find((s) => s.kind === k)?.n ?? 0)
  return { ready: true, day, opens: Number(row?.opens ?? 0), people: n('u'), records: n('r') }
}

const TTL_MS = 10 * 60_000
const memo = new Map<string, { at: number; value: unknown }>()

async function cached<T>(key: string, who: string | null | undefined, fn: () => Promise<T>) {
  const k = `${getTenantId() ?? ''}|${key}`
  const hit = memo.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T
  const { value } = await sharedGatedRead(key, who, fn)
  memo.set(k, { at: Date.now(), value })
  if (memo.size > 500) memo.delete(memo.keys().next().value as string)
  return value
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

/**
 * Update revisions made within 24 h of a record's creation, newest first
 * (capped). `layoutId` narrows to records opened with that form.
 */
async function changedAfterSaveDeltas(
  collection: string,
  days: number,
  layoutId: number | null
): Promise<Array<string | null>> {
  const within24h = isMssql(db)
    ? 'ua.timestamp <= DATEADD(hour, 24, ca.timestamp)'
    : "ua.timestamp <= ca.timestamp + interval '24 hours'"
  const top = isMssql(db) ? 'TOP 5000 ' : ''
  const limit = isMssql(db) ? '' : ' LIMIT 5000'
  const scope =
    layoutId != null
      ? ` AND u.item IN (SELECT ref FROM ${SEEN} WHERE layout_id = ? AND kind = 'r')`
      : ''
  const since = daysAgo(days)
  const sql = `SELECT ${top}u.delta AS delta
    FROM nivaro_revisions u
    JOIN nivaro_activity ua ON ua.id = u.activity
    JOIN nivaro_activity ca ON ca.collection = u.collection AND ca.item = u.item AND ca.action = 'create'
    WHERE u.collection = ? AND ua.action = 'update'
      AND ua.timestamp >= ? AND ca.timestamp >= ? AND ${within24h}${scope}
    ORDER BY u.id DESC${limit}`
  const binds: Array<string | number | Date> = [collection, since, since]
  if (layoutId != null) binds.push(layoutId)
  return rawRows<{ delta: string | null }>(await db.raw(sql, binds)).map((r) => r.delta)
}

export interface LayoutFriction {
  ready: boolean
  days: number
  opens: number
  saves: number
  abandons: number
  steps: FrictionStep[]
  changed_after_save: {
    /** 'layout' = records opened with this form; 'collection' = every record (too few seen yet). */
    scope: 'layout' | 'collection'
    revisions: number
    fields: Array<{ field: string; changes: number }>
  }
}

/** Records seen with a form before "changed after save" narrows to them. */
const MIN_SEEN_RECORDS = 20

export async function layoutFriction(
  layoutId: number,
  collection: string,
  who: string | null | undefined,
  days = 30
): Promise<LayoutFriction> {
  return cached(`layout-friction|${layoutId}|${days}`, who, async () => {
    const ready = await usageTablesReady()
    const rolled = ready
      ? rollUpFriction(
          await db(DAILY)
            .where({ layout_id: layoutId })
            .where('day', '>=', utcDay(daysAgo(days)))
            .select('opens', 'saves', 'abandons', 'step_stats')
        )
      : { opens: 0, saves: 0, abandons: 0, steps: [] }
    let scope: 'layout' | 'collection' = 'collection'
    if (ready) {
      const seen = (await db(SEEN)
        .where({ layout_id: layoutId, kind: 'r' })
        .countDistinct({ n: 'ref' })
        .first()) as { n?: number | string } | undefined
      if (Number(seen?.n ?? 0) >= MIN_SEEN_RECORDS) scope = 'layout'
    }
    let deltas: Array<string | null> = []
    try {
      deltas = await changedAfterSaveDeltas(collection, 90, scope === 'layout' ? layoutId : null)
    } catch {
      deltas = []
    }
    return {
      ready,
      days,
      ...rolled,
      changed_after_save: {
        scope,
        revisions: deltas.length,
        fields: countDeltaFields(deltas).slice(0, 25)
      }
    }
  })
}

/** Fields people change in the same save (last 90 days of update revisions). */
export async function collectionCoChanges(collection: string, who: string | null | undefined) {
  return cached(`layout-cochange|${collection}`, who, async () => {
    const rows = (await db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('r.collection', collection)
      .whereIn('a.action', ['update', 'create'])
      .where('a.timestamp', '>=', daysAgo(90))
      .orderBy('r.id', 'desc')
      .limit(5000)
      .select('r.delta')) as Array<{ delta: string | null }>
    return { days: 90, ...coChangePairs(rows.map((r) => r.delta)) }
  })
}

/** Nightly: usage older than KEEP_DAYS goes. */
export async function pruneLayoutUsage(days = KEEP_DAYS): Promise<{ daily: number; seen: number }> {
  if (!(await usageTablesReady())) return { daily: 0, seen: 0 }
  const cutoff = utcDay(daysAgo(days))
  const daily = Number(await db(DAILY).where('day', '<', cutoff).delete())
  const seen = Number(await db(SEEN).where('day', '<', cutoff).delete())
  return { daily, seen }
}
