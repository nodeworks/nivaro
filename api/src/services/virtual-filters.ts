/**
 * Filter keys that are not columns: they ask something ABOUT a record that
 * another table answers (who wrote to it, whether an addendum is in flight).
 * Both filter surfaces compile them here, so `filter=`, `conditions=` and the
 * GraphQL filter inputs cannot disagree.
 *
 * Leaf module: imports the database handle and nothing from the items service.
 */
import type { Knex } from 'knex'
import { db } from '../db/index.js'

type QB = Knex.QueryBuilder

export const ORIGIN_FIELD = '$origin'
export const ADDENDUMS_FIELD = '$addendums'
export const AT_RISK_FIELD = '$at_risk'

export const RECORD_ORIGINS = ['person', 'machine', 'import', 'integration'] as const
export type RecordOrigin = (typeof RECORD_ORIGINS)[number]

export interface OriginFilter {
  /** true = a write of these origins exists; false = none exists. */
  include: boolean
  origins: RecordOrigin[]
  since: Date | null
  until: Date | null
  /** Only writes by this account. */
  by: string | null
  /** Only these activity actions (create, update, delete). */
  actions: string[] | null
}

const ACTIONS = new Set(['create', 'update', 'delete'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function list(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function when(v: unknown): Date | null {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Accepted shapes, on either surface:
 *   "integration"                       a write by an integration exists
 *   ["import", "integration"]           a write by either exists
 *   {_in: [...]} / {_eq: "..."}         the same, spelled with an operator
 *   {_nin: ["person"]}                  no person has ever written to it
 *   {_in: ["integration"], days: 7}     … within the last 7 days
 *   {_in: [...], since, until, by, action}
 * `op` is the condition surface's own operator and wins over the value's.
 *
 * Returns null when nothing usable was named — the caller narrows to nothing.
 */
export function parseOriginFilter(
  value: unknown,
  op?: string,
  now: Date = new Date()
): OriginFilter | null {
  let include = true
  let names: string[] = []
  let extra: Record<string, unknown> = {}

  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const v = value as Record<string, unknown>
    extra = v
    if (v._nin !== undefined || v._neq !== undefined) {
      include = false
      names = list(v._nin ?? v._neq)
    } else {
      names = list(v._in ?? v._eq ?? v.origins ?? v.origin ?? v.in)
    }
  } else {
    names = list(value)
  }
  if (op === '_nin' || op === '_neq') include = false
  else if (op === '_in' || op === '_eq') include = true
  else if (op && op !== '') return null

  const origins = [...new Set(names.map((n) => n.toLowerCase()))].filter((n): n is RecordOrigin =>
    (RECORD_ORIGINS as readonly string[]).includes(n)
  )
  if (origins.length === 0) return null

  let since = when(extra.since)
  const days = Number(extra.days)
  if (!since && Number.isFinite(days) && days > 0)
    since = new Date(now.getTime() - Math.min(days, 3650) * 86_400_000)
  const by = typeof extra.by === 'string' && UUID.test(extra.by) ? extra.by : null
  const actions = list(extra.action ?? extra.actions).filter((a) => ACTIONS.has(a))

  return {
    include,
    origins,
    since,
    until: when(extra.until),
    by,
    actions: actions.length ? actions : null
  }
}

// ── the origin column (migration 340) may be absent on an older database ─────
let originColumn: { value: boolean; at: number } | null = null

/** Resolved before the synchronous filter compilers run. A hit is kept for the
 *  life of the process; a miss is asked again after a minute. */
export async function primeOriginColumn(): Promise<boolean> {
  if (originColumn && (originColumn.value || Date.now() - originColumn.at < 60_000))
    return originColumn.value
  let value = false
  try {
    value = await db.schema.hasColumn('nivaro_activity', 'origin')
  } catch {
    value = false
  }
  originColumn = { value, at: Date.now() }
  return value
}

export function resetOriginColumnProbe(): void {
  originColumn = null
}

/**
 * EXISTS / NOT EXISTS over the activity log, keyed on (collection, item) — the
 * index migration 321 built. A row written before origins were stored carries
 * none and matches no origin.
 */
export function applyOriginFilter(q: QB, collection: string, f: OriginFilter | null): void {
  if (!f || !originColumn?.value) {
    q.whereRaw('1 = 0')
    return
  }
  const exists = function (this: QB) {
    this.select(db.raw('1'))
      .from('nivaro_activity as oa')
      .where('oa.collection', collection)
      .whereRaw('oa.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
      .whereIn('oa.origin', f.origins)
    if (f.since) this.where('oa.timestamp', '>=', f.since)
    if (f.until) this.where('oa.timestamp', '<=', f.until)
    if (f.by) this.where('oa.user', f.by)
    if (f.actions) this.whereIn('oa.action', f.actions)
  }
  if (f.include) q.whereExists(exists)
  else q.whereNotExists(exists)
}

/** 'active' = an addendum still in flight, 'none' = none in flight, 'any' = ever had one. */
export function applyAddendumsFilter(q: QB, collection: string, rawValue: unknown): void {
  let v: unknown = rawValue
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    v = o._eq ?? o._in ?? o.value
  }
  const want = String(Array.isArray(v) ? v[0] : (v ?? 'active'))
  if (!['active', 'none', 'any'].includes(want)) {
    q.whereRaw('1 = 0')
    return
  }
  const activeOnly = want !== 'any'
  const cb = function (this: QB) {
    this.select(db.raw('1'))
      .from('nivaro_addendums as adm')
      .where('adm.parent_collection', collection)
      .whereRaw('adm.parent_id = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
    if (activeOnly) this.whereNotIn('adm.status', ['approved', 'rejected'])
  }
  if (want === 'none') q.whereNotExists(cb)
  else q.whereExists(cb)
}

// ── at-risk rules ────────────────────────────────────────────────────────────
// The rules are read before the synchronous compile and kept for a few
// seconds. The route module is loaded lazily: it imports the items service.
type RiskModule = typeof import('../routes/at-risk.js')
type RuleRow = Parameters<RiskModule['parseActiveRules']>[0][number] & { collection?: string }

let riskModule: RiskModule | null = null
const RISK_TTL_MS = 15_000
const primedRisk = new Map<string, { at: number; rows: RuleRow[] }>()

function riskIds(value: unknown): { any: boolean; ids: number[] } {
  let v: unknown = value
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    v = o._in ?? o._eq ?? o.value
  }
  const raw = list(v)
  return {
    any: raw.some((x) => x === 'any' || x === '*'),
    ids: [...new Set(raw.map((x) => Number(x)).filter((n) => Number.isFinite(n)))].sort(
      (a, b) => a - b
    )
  }
}

function riskKey(value: unknown): string {
  const { any, ids } = riskIds(value)
  return any ? 'any' : ids.join(',')
}

export function resetPrimedRisk(): void {
  primedRisk.clear()
}

/** Every `$at_risk` value in a filter, at any depth. */
export function collectRiskValues(filter: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(filter)) {
    for (const f of filter) collectRiskValues(f, out)
    return out
  }
  if (!filter || typeof filter !== 'object') return out
  for (const [k, v] of Object.entries(filter as Record<string, unknown>)) {
    if (k === AT_RISK_FIELD) out.push(v)
    else if (k !== ORIGIN_FIELD && k !== ADDENDUMS_FIELD) collectRiskValues(v, out)
  }
  return out
}

export function filterNamesOrigin(filter: unknown): boolean {
  if (Array.isArray(filter)) return filter.some((f) => filterNamesOrigin(f))
  if (!filter || typeof filter !== 'object') return false
  return Object.entries(filter as Record<string, unknown>).some(
    ([k, v]) => k === ORIGIN_FIELD || filterNamesOrigin(v)
  )
}

/** Everything the synchronous compilers below need, read ahead of them. */
export async function primeVirtualFilters(filter: unknown): Promise<void> {
  if (!filter || typeof filter !== 'object') return
  if (filterNamesOrigin(filter)) await primeOriginColumn()
  const values = collectRiskValues(filter)
  if (values.length === 0) return
  riskModule ??= await import('../routes/at-risk.js')
  for (const value of values) {
    const key = riskKey(value)
    const hit = primedRisk.get(key)
    if (hit && Date.now() - hit.at < RISK_TTL_MS) continue
    const { any, ids } = riskIds(value)
    const rows = (await db('nivaro_at_risk_rules')
      .where({ is_active: true })
      .modify((b) => {
        if (!any) void b.whereIn('id', ids.length ? ids : [-1])
      })
      .orderBy('id')) as RuleRow[]
    primedRisk.set(key, { at: Date.now(), rows })
  }
}

/** OR across the named rules, AND inside each. A value that was not primed,
 *  names no rule of this collection, or cannot compile matches nothing. */
export function applyRiskFilter(q: QB, collection: string, value: unknown): void {
  const mod = riskModule
  const rows = (primedRisk.get(riskKey(value))?.rows ?? []).filter(
    (r) => r.collection === collection
  )
  if (!mod || rows.length === 0) {
    q.whereRaw('1 = 0')
    return
  }
  const rules = mod.parseActiveRules(rows)
  if (rules.length === 0) {
    q.whereRaw('1 = 0')
    return
  }
  q.where(function (this: QB) {
    for (const rule of rules) {
      this.orWhere(function (this: QB) {
        if (!mod.applyRuleConditions(this as never, collection, rule.conditions))
          this.whereRaw('1 = 0')
      })
    }
  })
}

// ── GraphQL spelling ─────────────────────────────────────────────────────────
// A GraphQL name cannot start with `$`, so the inputs spell these with a
// leading underscore and the resolver renames them on the way in.
export const GRAPHQL_VIRTUAL_KEYS: Record<string, string> = {
  _state: '$state',
  _origin: ORIGIN_FIELD,
  _addendums: ADDENDUMS_FIELD,
  _at_risk: AT_RISK_FIELD,
  _integrations: '$integrations'
}

const LEAVE_ALONE = new Set(['_link'])

/** Renames the GraphQL spellings at every depth of a filter. Pure. */
export function translateVirtualKeys(filter: unknown): unknown {
  if (Array.isArray(filter)) return filter.map((f) => translateVirtualKeys(f))
  if (!filter || typeof filter !== 'object' || filter instanceof Date) return filter
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(filter as Record<string, unknown>)) {
    const real = GRAPHQL_VIRTUAL_KEYS[k]
    if (real) {
      // The value belongs to the virtual filter; its keys are not field names.
      out[real] = v
      continue
    }
    out[k] = LEAVE_ALONE.has(k) ? v : translateVirtualKeys(v)
  }
  return out
}
