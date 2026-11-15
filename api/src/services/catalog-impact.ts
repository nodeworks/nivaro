import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import {
  getTenantDb,
  getTenantSlug,
  runWithoutTenant,
  runWithTenantDb
} from '../db/tenant-context.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { getApp } from './io-holder.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Catalog import impact to owners (rt6 #19).
 *
 * A record's catalog lines keep the price they were given when they were added (rt4 #7 shows
 * "Catalog price now $412.00 (was $398.00 when added)" on the open form). When a catalog or
 * price / stock import changes the catalog under open, editable records, the people who own
 * those records hear it ONCE per import, not once per line or per record:
 *
 *   "Catalog update changed prices on 14 lines in 6 of your open records"
 *   + "See which" → the list, filtered to exactly those records.
 *
 * Where the catalog is: every O2M field whose options (or a layout's override of them) carry
 * `catalog_mode` (packages/shared CatalogPickerField): the line collection, its link to the
 * catalog (`item_field`), the price columns the catalog fills (`copy_fields` targets that are
 * money and not computed — the client's own rule), and the stock column (`related_columns`
 * marked stock, matched to the record by one '$parent.<field>').
 *
 * When: an import that writes a catalog / stock collection — a procedure or script that
 * announces its writes (raw-write-announcer.ts), a staged import finishing, or a collection
 * import job finishing — calls `noteCatalogChange`. Changes coalesce (QUIET_MS after the last
 * one, at most MAX_WAIT_MS after the first), then ONE pass compares, as the data stands now,
 * each line on an open record with the catalog: a line whose price differs, or whose quantity
 * the stock at the record's place no longer covers.
 *
 * Who: the record's current-step owners (the same resolver integration alerts use), each told
 * only about records they can read. Open + editable = a pipeline instance not completed, in a
 * step that is neither terminal nor locks the record.
 *
 * Opt-in per collection: `browser_config.catalog_notice: true` on the record's collection
 * (Data Model → Browser settings). Off by default.
 *
 * One notice: the notice carries a fingerprint of what it reported (`source.id`); the same
 * owner is not told the same lines at the same prices again (a re-run of the same file), and
 * older unread catalog notices to that owner are marked read when a new one lands.
 */

export const QUIET_MS = 20_000
export const MAX_WAIT_MS = 120_000
/** Past this many open records in one collection the pass skips it (a mass import, not a catalog). */
export const OPEN_RECORD_CAP = 20_000
/** Ids per collection kept before a change counts as "the whole collection". */
const IDS_CAP = 5_000
const SOURCES_TTL_MS = 5 * 60_000
const DEDUPE_DAYS = 7
export const SOURCE_KIND = 'catalog-impact'
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface CatalogSource {
  parent: string
  field: string
  lines: string
  fk: string
  itemField: string
  catalog: string
  qtyField: string
  /** line price column ← catalog column */
  prices: Array<{ line: string; catalog: string }>
  stock: {
    collection: string
    itemField: string
    valueField: string
    /** stock row column ← record (parent) column */
    matchField: string
    parentField: string
    sum: boolean
  } | null
}

interface RelationRow {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field?: string | null
}

function parseJson(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'object') return v
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

/** The single '$parent.<field>' a stock column matches the record by, or null. */
export function simpleParentMatch(
  match: unknown
): { matchField: string; parentField: string } | null {
  if (!match || typeof match !== 'object' || Array.isArray(match)) return null
  const entries = Object.entries(match as Record<string, unknown>)
  if (entries.length !== 1) return null
  const [col, raw] = entries[0]
  const v = raw && typeof raw === 'object' ? (raw as { _eq?: unknown })._eq : raw
  if (typeof v !== 'string' || !v.startsWith('$parent.')) return null
  const parentField = v.slice('$parent.'.length)
  if (!IDENT.test(col) || !IDENT.test(parentField)) return null
  return { matchField: col, parentField }
}

/** Pure: a field's catalog config read into a source, or null when it is not one. */
export function parseCatalogSource(
  parent: string,
  field: string,
  catalogMode: unknown,
  relations: RelationRow[]
): CatalogSource | null {
  const cfg = parseJson(catalogMode) as Record<string, unknown> | null
  if (!cfg || typeof cfg.item_field !== 'string' || !IDENT.test(cfg.item_field)) return null
  const o2m = relations.find(
    (r) => r.one_collection === parent && r.one_field === field && !r.junction_field
  )
  if (!o2m || !IDENT.test(o2m.many_collection) || !IDENT.test(o2m.many_field)) return null
  const lines = o2m.many_collection
  const itemField = cfg.item_field
  const m2o = relations.find(
    (r) => r.many_collection === lines && r.many_field === itemField && !!r.one_collection
  )
  const catalog = m2o?.one_collection
  if (!catalog || !IDENT.test(catalog)) return null
  const compute = (cfg.compute_fields ?? {}) as Record<string, unknown>
  const formats = (cfg.field_formats ?? {}) as Record<string, unknown>
  const copies = (cfg.copy_fields ?? {}) as Record<string, unknown>
  // The client's rule (CatalogPickerField priceFields): money the catalog fills, never a computed total.
  const prices = Object.entries(copies)
    .filter(
      ([line, cat]) =>
        IDENT.test(line) &&
        typeof cat === 'string' &&
        IDENT.test(cat) &&
        !(line in compute) &&
        (formats[line] === 'currency' || /(^|_)price$/i.test(line))
    )
    .map(([line, cat]) => ({ line, catalog: String(cat) }))
  const qtyField =
    typeof cfg.qty_field === 'string' && IDENT.test(cfg.qty_field) ? cfg.qty_field : 'quantity'
  let stock: CatalogSource['stock'] = null
  const warn = (cfg.qty_warning as { column?: unknown } | undefined)?.column
  for (const raw of Array.isArray(cfg.related_columns) ? cfg.related_columns : []) {
    const rc = raw as Record<string, unknown>
    const isStock =
      rc.stock === true || (rc.stock !== false && rc.key === 'on_hand') || rc.key === warn
    if (!isStock) continue
    const m = simpleParentMatch(rc.match)
    const c = String(rc.collection ?? '')
    const itf = String(rc.item_field ?? '')
    const vf = String(rc.value_field ?? '')
    if (!m || ![c, itf, vf].every((s) => IDENT.test(s))) continue
    stock = {
      collection: c,
      itemField: itf,
      valueField: vf,
      ...m,
      sum: rc.aggregate === 'sum'
    }
    break
  }
  if (prices.length === 0 && !stock) return null
  return { parent, field, lines, fk: o2m.many_field, itemField, catalog, qtyField, prices, stock }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Pure, the client twin of linePriceChange: both priced, differing by a cent or more. */
export function priceDiffers(lineValue: unknown, catalogValue: unknown): boolean {
  const was = num(lineValue)
  const now = num(catalogValue)
  if (was === null || now === null || was <= 0 || now <= 0) return false
  return Math.abs(now - was) >= 0.005
}

// ─── Discovery (cached per tenant) ───────────────────────────────────────────

const sourcesCache = new Map<string, { at: number; list: CatalogSource[] }>()

export async function catalogSources(): Promise<CatalogSource[]> {
  const key = currentTenantKey() ?? ''
  const hit = sourcesCache.get(key)
  if (hit && Date.now() - hit.at < SOURCES_TTL_MS) return hit.list
  const list = await readCatalogSources().catch(() => [] as CatalogSource[])
  sourcesCache.set(key, { at: Date.now(), list })
  return list
}

/** Every catalog source; `ignoreOptIn` for diagnostics (what would be watched if switched on). */
export async function readCatalogSources(
  opts: { ignoreOptIn?: boolean } = {}
): Promise<CatalogSource[]> {
  const found: Array<{ parent: string; field: string; mode: unknown }> = []
  const fields = (await db('nivaro_fields')
    .where('options', 'like', '%catalog_mode%')
    .select('collection', 'field', 'options')) as Array<{
    collection: string
    field: string
    options: unknown
  }>
  for (const f of fields) {
    const mode = (parseJson(f.options) as { catalog_mode?: unknown } | null)?.catalog_mode
    if (mode) found.push({ parent: f.collection, field: f.field, mode })
  }
  const placed = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .where('a.overrides', 'like', '%catalog_mode%')
    .select('l.collection', 'l.is_active', 'a.field', 'a.overrides')
    .catch(() => [])) as Array<{
    collection: string
    is_active: unknown
    field: string
    overrides: unknown
  }>
  for (const p of placed) {
    if (p.is_active === false || p.is_active === 0) continue
    const mode = (parseJson(p.overrides) as { options?: { catalog_mode?: unknown } } | null)
      ?.options?.catalog_mode
    if (mode) found.push({ parent: p.collection, field: p.field, mode })
  }
  if (found.length === 0) return []
  const parents = [...new Set(found.map((f) => f.parent))]
  // Opt-in per record collection (browser_config.catalog_notice).
  const cols = (await db('nivaro_collections')
    .whereIn('collection', parents)
    .select('collection', 'browser_config')) as Array<{
    collection: string
    browser_config: unknown
  }>
  const on = new Set(
    cols
      .filter(
        (c) =>
          (parseJson(c.browser_config) as { catalog_notice?: unknown } | null)?.catalog_notice ===
          true
      )
      .map((c) => c.collection)
  )
  if (opts.ignoreOptIn) for (const f of found) on.add(f.parent)
  const wanted = found.filter((f) => on.has(f.parent))
  if (wanted.length === 0) return []
  const relations = (await db('nivaro_relations')
    .whereIn('one_collection', [...on])
    .orWhereIn(
      'many_collection',
      db('nivaro_relations')
        .whereIn('one_collection', [...on])
        .select('many_collection')
    )
    .select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field'
    )) as RelationRow[]
  const byKey = new Map<string, CatalogSource>()
  for (const f of wanted) {
    const src = parseCatalogSource(f.parent, f.field, f.mode, relations)
    if (!src) continue
    const k = `${src.parent}.${src.field}`
    const prior = byKey.get(k)
    if (!prior) byKey.set(k, src)
    else {
      // A layout override and the field's own options: one source, every price column.
      for (const p of src.prices)
        if (!prior.prices.some((x) => x.line === p.line)) prior.prices.push(p)
      prior.stock = prior.stock ?? src.stock
    }
  }
  return [...byKey.values()]
}

/** Test seam. */
export function resetCatalogImpactCache(): void {
  sourcesCache.clear()
  pending.clear()
  memoryBaselines.clear()
}

// ─── Coalescing ──────────────────────────────────────────────────────────────

interface Pending {
  tenant: { db: unknown; slug: string; tenantId: string } | null
  changes: Map<string, Set<string> | '*'>
  first: number
  timer: ReturnType<typeof setTimeout> | null
}
const pending = new Map<string, Pending>()

/**
 * An import wrote `collection` (ids, or null = "rows in it changed"). O(1) unless it is a
 * catalog or stock collection of an opted-in source (or sources are not known yet). Never throws.
 */
export function noteCatalogChange(
  collection: string,
  ids?: Array<string | number> | null,
  opts: { source?: string } = {}
): void {
  try {
    if (!collection || !IDENT.test(collection) || /^(nivaro_|directus_)/i.test(collection)) return
    const key = currentTenantKey() ?? ''
    const known = sourcesCache.get(key)
    if (
      known &&
      !known.list.some((s) => s.catalog === collection || s.stock?.collection === collection)
    ) {
      // Stale lists still refresh in the background so a newly opted-in source is heard.
      if (Date.now() - known.at > SOURCES_TTL_MS) void catalogSources()
      return
    }
    let p = pending.get(key)
    if (!p) {
      const tdb = getTenantDb()
      p = {
        tenant: key && tdb ? { db: tdb, slug: getTenantSlug() ?? key, tenantId: key } : null,
        changes: new Map(),
        first: Date.now(),
        timer: null
      }
      pending.set(key, p)
    }
    const cur = p.changes.get(collection)
    if (cur !== '*') {
      const list = (ids ?? []).filter((i) => i != null && String(i).trim() !== '')
      if (list.length === 0) p.changes.set(collection, '*')
      else {
        const set = cur ?? new Set<string>()
        for (const i of list) set.add(String(i))
        p.changes.set(collection, set.size > IDS_CAP ? '*' : set)
      }
    }
    if (p.timer) clearTimeout(p.timer)
    const wait = Math.max(0, Math.min(QUIET_MS, p.first + MAX_WAIT_MS - Date.now()))
    const entry = p
    entry.timer = setTimeout(() => flush(key, entry), wait)
    entry.timer.unref?.()
    void opts
  } catch {
    /* best-effort */
  }
}

function flush(key: string, p: Pending): void {
  if (pending.get(key) === p) pending.delete(key)
  const changes = p.changes
  const run = () => {
    void runInBackgroundPool(() => runCatalogImpact(changes)).catch((err) =>
      console.warn('[catalog-impact] pass failed', err)
    )
  }
  if (p.tenant) runWithTenantDb(p.tenant.db as never, p.tenant.slug, run, p.tenant.tenantId)
  else runWithoutTenant(run)
}

// ─── The pass ────────────────────────────────────────────────────────────────

export interface RecordImpact {
  parent: string
  record: string
  priceLines: Set<string>
  shortLines: Set<string>
  /** What was found: "<record>|<line>|p<i>=<catalog price>" / "<record>|<line>|s=<available>". */
  marks: string[]
  /** The record field naming where stock is counted (for the notice's words). */
  placeField?: string | null
}

async function openEditableRecords(parent: string): Promise<string[] | null> {
  const inst = (await db('nivaro_workflow_instances')
    .where({ collection: parent })
    .whereNull('completed_at')
    .limit(OPEN_RECORD_CAP + 1)
    .select('item', 'current_state')) as Array<{ item: string; current_state: string | null }>
  if (inst.length > OPEN_RECORD_CAP) return null
  const stateIds = [...new Set(inst.map((i) => i.current_state).filter(Boolean))] as string[]
  const states = (await selectInChunks(stateIds, 500, (chunk) =>
    whereInList(db('nivaro_workflow_states'), 'id', chunk).select(
      'id',
      'is_terminal',
      'lock_record'
    )
  )) as Array<{ id: string; is_terminal: unknown; lock_record: unknown }>
  const closed = new Set(
    states
      .filter(
        (s) =>
          s.is_terminal === true ||
          s.is_terminal === 1 ||
          s.lock_record === true ||
          s.lock_record === 1
      )
      .map((s) => String(s.id).toUpperCase())
  )
  return inst
    .filter((i) => i.current_state && !closed.has(String(i.current_state).toUpperCase()))
    .map((i) => String(i.item))
}

/**
 * Every line on an open, editable record of `src` whose price differs from the catalog's now,
 * or whose quantity the stock at the record's place does not cover — as the data stands.
 */
export async function impactsFor(src: CatalogSource): Promise<RecordImpact[]> {
  const open = await openEditableRecords(src.parent)
  if (!open || open.length === 0) return []
  const cols = [
    'l.id as line_id',
    `l.${src.fk} as record`,
    `l.${src.itemField} as item`,
    `l.${src.qtyField} as qty`,
    ...src.prices.flatMap((p, i) => [`l.${p.line} as lp${i}`, `c.${p.catalog} as cp${i}`])
  ]
  const rows = (await selectInChunks(open, 1000, (chunk) => {
    let q = whereInList(db(`${src.lines} as l`), `l.${src.fk}`, chunk)
    if (src.prices.length > 0) q = q.leftJoin(`${src.catalog} as c`, 'c.id', `l.${src.itemField}`)
    return q.whereNotNull(`l.${src.itemField}`).select(cols) as unknown as Promise<
      Record<string, unknown>[]
    >
  })) as Record<string, unknown>[]
  if (rows.length === 0) return []

  const out = new Map<string, RecordImpact>()
  const get = (record: string) => {
    let r = out.get(record)
    if (!r) {
      r = {
        parent: src.parent,
        record,
        priceLines: new Set(),
        shortLines: new Set(),
        marks: [],
        placeField: src.stock?.parentField ?? null
      }
      out.set(record, r)
    }
    return r
  }
  for (const row of rows) {
    for (let i = 0; i < src.prices.length; i++) {
      if (!priceDiffers(row[`lp${i}`], row[`cp${i}`])) continue
      const r = get(String(row.record))
      r.priceLines.add(String(row.line_id))
      r.marks.push(`${row.record}|${row.line_id}|p${i}=${num(row[`cp${i}`])}`)
    }
  }
  if (src.stock) {
    const st = src.stock
    const recordIds = [...new Set(rows.map((r) => String(r.record)))]
    const places = new Map<string, string>()
    const parents = (await selectInChunks(recordIds, 1000, (chunk) =>
      whereInList(db(src.parent), 'id', chunk).select('id', `${st.parentField} as place`)
    )) as Array<{ id: unknown; place: unknown }>
    for (const p of parents)
      if (p.place != null && p.place !== '') places.set(String(p.id).toUpperCase(), String(p.place))
    const itemIds = [...new Set(rows.map((r) => String(r.item)))]
    const placeIds = [...new Set(places.values())]
    const have = new Map<string, number>()
    if (itemIds.length > 0 && placeIds.length > 0) {
      const stockRows = (await selectInChunks(itemIds, 1000, (chunk) =>
        whereInList(
          whereInList(db(st.collection), st.matchField, placeIds),
          st.itemField,
          chunk
        ).select(`${st.itemField} as item`, `${st.matchField} as place`, `${st.valueField} as v`)
      )) as Array<{ item: unknown; place: unknown; v: unknown }>
      for (const s of stockRows) {
        const k = `${String(s.item).toUpperCase()}|${String(s.place).toUpperCase()}`
        const v = num(s.v) ?? 0
        have.set(k, st.sum ? (have.get(k) ?? 0) + v : Math.max(have.get(k) ?? 0, v))
      }
    }
    for (const row of rows) {
      const qty = num(row.qty)
      const place = places.get(String(row.record).toUpperCase())
      if (qty == null || qty <= 0 || !place) continue
      const k = `${String(row.item).toUpperCase()}|${place.toUpperCase()}`
      const available = have.get(k) ?? 0
      if (qty <= available) continue
      const r = get(String(row.record))
      r.shortLines.add(String(row.line_id))
      r.marks.push(`${row.record}|${row.line_id}|s=${available}`)
    }
  }
  return [...out.values()].filter((r) => r.priceLines.size > 0 || r.shortLines.size > 0)
}

/** Pure: a mark split into its key ("<record>|<line>|p0") and value. */
export function splitMark(mark: string): [string, string] {
  const at = mark.lastIndexOf('=')
  return at < 0 ? [mark, ''] : [mark.slice(0, at), mark.slice(at + 1)]
}

/**
 * Pure: only what is NEW since the last look — a line that did not differ before, or now
 * differs by another amount. A line that already said "price changed" at the same catalog
 * price is not news; neither is anything when there was no last look (the first pass sets it).
 */
export function newSinceLastLook(
  impacts: RecordImpact[],
  baseline: Map<string, string> | null
): RecordImpact[] {
  if (!baseline) return []
  const out: RecordImpact[] = []
  for (const r of impacts) {
    const marks = r.marks.filter((m) => {
      const [k, v] = splitMark(m)
      return baseline.get(k) !== v
    })
    if (marks.length === 0) continue
    const line = (m: string) => splitMark(m)[0].split('|')[1]
    out.push({
      parent: r.parent,
      record: r.record,
      priceLines: new Set(marks.filter((m) => /\|p\d+$/.test(splitMark(m)[0])).map(line)),
      shortLines: new Set(marks.filter((m) => splitMark(m)[0].endsWith('|s')).map(line)),
      marks,
      placeField: r.placeField ?? null
    })
  }
  return out
}

// The last look per source: Redis (shared by every process, 30 days) or this process.
const BASELINE_TTL_S = 30 * 86_400
const memoryBaselines = new Map<string, Map<string, string>>()
const baselineKey = (src: CatalogSource) =>
  `nvr:catimpact:${currentTenantKey() || '-'}:${src.parent}.${src.field}`

interface RedisChain {
  del(key: string): RedisChain
  hset(key: string, data: Record<string, string>): RedisChain
  expire(key: string, s: number): RedisChain
  exec(): Promise<unknown>
}
type RedisLike = {
  exists(key: string): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
  multi(): RedisChain
}
const redisOf = (): RedisLike | null => (getApp()?.redis as RedisLike | undefined) ?? null

async function loadBaseline(src: CatalogSource): Promise<Map<string, string> | null> {
  const key = baselineKey(src)
  const redis = redisOf()
  if (redis) {
    try {
      if (!(await redis.exists(key))) return null
      return new Map(Object.entries(await redis.hgetall(key)))
    } catch {
      /* fall through to this process */
    }
  }
  return memoryBaselines.get(key) ?? null
}

async function saveBaseline(src: CatalogSource, impacts: RecordImpact[]): Promise<void> {
  const key = baselineKey(src)
  const data: Record<string, string> = { '': '' } // never empty: "looked, found nothing"
  for (const r of impacts)
    for (const m of r.marks) {
      const [k, v] = splitMark(m)
      data[k] = v
    }
  memoryBaselines.set(key, new Map(Object.entries(data)))
  const redis = redisOf()
  if (!redis) return
  try {
    await redis.multi().del(key).hset(key, data).expire(key, BASELINE_TTL_S).exec()
  } catch {
    /* this process keeps it */
  }
}

/** Pure: the subject of one owner's notice. */
export function impactSubject(t: { records: number }): string {
  return `Catalog update affects ${t.records} of your records`
}

/** Pure: the notice body — one plain line per kind of change. */
export function impactBody(t: {
  priceLines: number
  shortLines: number
  /** The record field that names where stock is counted ("supporting_warehouse"). */
  placeField?: string | null
}): string {
  const out: string[] = []
  if (t.priceLines === 1)
    out.push(
      '1 line has a new price. It keeps its old price until you choose the new one on the record.'
    )
  else if (t.priceLines > 1)
    out.push(
      `${t.priceLines} lines have a new price. Each keeps its old price until you choose the new one on the record.`
    )
  if (t.shortLines > 0) {
    const place = t.placeField
      ? `the ${t.placeField.replace(/_id$/i, '').replace(/_/g, ' ').toLowerCase()}`
      : 'the record\u2019s location'
    out.push(
      `${t.shortLines} line${t.shortLines === 1 ? ' asks' : 's ask'} for more than is in stock at ${place}.`
    )
  }
  return out.join('\n')
}

/** Pure: a short, stable fingerprint of what one notice reports. */
export function impactFingerprint(impacts: RecordImpact[]): string {
  const marks = impacts.flatMap((r) => r.marks.map((m) => `${r.parent}|${m}`)).sort()
  return createHash('sha1').update(marks.join('\n')).digest('hex').slice(0, 20)
}

/** Run one pass over the coalesced changes: find what is new, tell each owner once. */
export async function runCatalogImpact(
  changes: Map<string, Set<string> | '*'>
): Promise<{ records: number; notified: number }> {
  const sources = await catalogSources()
  const all: RecordImpact[] = []
  for (const src of sources) {
    if (!changes.has(src.catalog) && !(src.stock && changes.has(src.stock.collection))) continue
    try {
      const now = await impactsFor(src)
      const before = await loadBaseline(src)
      await saveBaseline(src, now)
      all.push(...newSinceLastLook(now, before))
    } catch (err) {
      console.warn(`[catalog-impact] ${src.parent}.${src.field}:`, (err as Error).message)
    }
  }
  if (all.length === 0) return { records: 0, notified: 0 }
  // One impact per record (several catalog fields on one record fold together).
  const byRecord = new Map<string, RecordImpact>()
  for (const r of all) {
    const k = `${r.parent}::${r.record}`
    const prior = byRecord.get(k)
    if (!prior) byRecord.set(k, r)
    else {
      for (const l of r.priceLines) prior.priceLines.add(l)
      for (const l of r.shortLines) prior.shortLines.add(l)
      prior.marks.push(...r.marks)
    }
  }
  const impacts = [...byRecord.values()]
  const { batchRecordOwners } = await import('./integration-alerts.js')
  const owners = await batchRecordOwners(
    impacts.map((r) => ({ collection: r.parent, item: r.record }))
  )
  const perOwner = new Map<string, RecordImpact[]>()
  for (const r of impacts) {
    for (const o of owners.get(`${r.parent}::${r.record}`) ?? []) {
      const list = perOwner.get(o) ?? []
      list.push(r)
      perOwner.set(o, list)
    }
  }
  let notified = 0
  for (const [ownerId, list] of perOwner) {
    try {
      if (await tellOwner(ownerId, list)) notified++
    } catch (err) {
      console.warn('[catalog-impact] notice failed', (err as Error).message)
    }
  }
  return { records: impacts.length, notified }
}

/** Tell one owner about what is new on records they own (only those they can read). */
export async function tellOwner(ownerId: string, impacts: RecordImpact[]): Promise<boolean> {
  const { getUser } = await import('./users.js')
  const user = await getUser(ownerId)
  if (!user) return false
  // Only records this person can read are named to them.
  const { compileAccessGates, visibleIds } = await import('./record-access.js')
  const { isAdminUser } = await import('./ai-plan-steps.js')
  const actingAdmin = await isAdminUser(user).catch(() => false)
  const byParent = new Map<string, RecordImpact[]>()
  for (const r of impacts) byParent.set(r.parent, [...(byParent.get(r.parent) ?? []), r])
  const seen: RecordImpact[] = []
  for (const [parent, list] of byParent) {
    const gates = await compileAccessGates(user, parent, { actingAdmin })
    const ok = await visibleIds(
      gates,
      list.map((r) => r.record)
    )
    const upper = new Set([...ok].map((i) => i.toUpperCase()))
    seen.push(...list.filter((r) => upper.has(r.record.toUpperCase())))
  }
  if (seen.length === 0) return false
  const fp = `${SOURCE_KIND}:${impactFingerprint(seen)}`
  // The same lines at the same prices were already reported to this person: say nothing.
  const since = new Date(Date.now() - DEDUPE_DAYS * 86_400_000)
  const already = await db('nivaro_notifications')
    .where({ recipient: user.id })
    .where('timestamp', '>=', since)
    .where('detail', 'like', `%"id":"${fp}"%`)
    .first('id')
    .catch(() => null)
  if (already) return false

  const priceLines = seen.reduce((n, r) => n + r.priceLines.size, 0)
  const shortLines = seen.reduce((n, r) => n + r.shortLines.size, 0)
  // The list link goes to the collection holding most of them.
  const counts = new Map<string, RecordImpact[]>()
  for (const r of seen) counts.set(r.parent, [...(counts.get(r.parent) ?? []), r])
  const [topParent, topList] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  const subject = impactSubject({ records: seen.length })
  const message = impactBody({
    priceLines,
    shortLines,
    placeField: seen.find((r) => r.shortLines.size > 0)?.placeField ?? null
  })

  const app = getApp()
  if (!app) return false
  const { notifyUser } = await import('./notification-channels.js')
  // Older unread catalog notices to this person are superseded by this one.
  const older = (await db('nivaro_notifications')
    .where({ recipient: user.id, status: 'inbox' })
    .where('detail', 'like', `%"id":"${SOURCE_KIND}:%`)
    .select('id')
    .catch(() => [])) as Array<{ id: number }>
  await notifyUser(app, user.id, {
    subject,
    message,
    category: 'other',
    target: {
      kind: 'record',
      collection: topParent,
      query: `ids=${topList
        .slice(0, 500)
        .map((r) => encodeURIComponent(r.record))
        .join(',')}`
    },
    source: { kind: SOURCE_KIND, label: 'Catalog update', id: fp },
    why: 'You own the current step of these records.'
  })
  if (older.length > 0) {
    await db('nivaro_notifications')
      .whereIn(
        'id',
        older.map((o) => o.id)
      )
      .update({ status: 'read', read_at: new Date() })
      .catch(() => {})
    const { announceNotificationsRead } = await import('./user-sync.js')
    announceNotificationsRead(user.id)
  }
  return true
}
