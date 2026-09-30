import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { businessHoursElapsed } from '../routes/sla.js'
import type { User } from '../types.js'
import { getSlaScheduleSync } from './business-hours.js'
import { parseColumnFilterOp } from './column-filter-ops.js'
import { parseJson } from './pipeline-engine.js'
import {
  applyQueueGate,
  applyQueueGatesToCache,
  type QueueGate,
  queueGatesFor
} from './queue-access.js'
import {
  applyTypedExtraPredicate,
  decodeCachedExtra,
  hasTypedExtraFilter,
  twinJsonPath
} from './queue-materialization-extra.js'
import type { QueueGroupSummary, QueueItem, QueueOwner, QueueScope, QueueStats } from './queues.js'
import { normalizeDisplayConfig } from './queues.js'

// Returns true when the requested sort/filters touch a field this SQL-pushdown
// path cannot (or intentionally does not) serve correctly: sla_status/
// aging_hours filters (business-hours SLA math is JS-only, not expressible as
// plain SQL), an owners sort (would need a SQL-level string aggregation across
// the M2M owners table), and a priority sort (composite of sla_status/at_risk/
// aging — same JS-only SLA math). extra.* filters and sorts ARE served here via
// JSON_VALUE over the cached `extra` JSON (a 6s live resolve otherwise — see
// jsonValueExpr below). The caller should route requests matching this to the
// existing live-resolve path instead of calling fetchMaterializedQueueItems.
// The cached extra JSON carries reserved keys (__ids, __t, __via) — split
// them back out so the API shape matches the live path's extra / extra_ids /
// via_addendum (see queue-materialization-extra.ts).
const splitExtra = decodeCachedExtra

export function requiresLiveResolveFallback(
  sort: string,
  _filters: Record<string, unknown>,
  opts: {
    /** Every cached row carries typed twins (#801), so date / number /
     *  boolean column filters can be answered in SQL. */
    typedTwins?: boolean
    /** #741: SLA and aging groups are computed at read time — live path. */
    groupBy?: string | null
  } = {}
): boolean {
  if (opts.groupBy && !groupKeySql(opts.groupBy)) return true
  const sortKey = sort.startsWith('-') ? sort.slice(1) : sort
  // Triage-label filters (#109) join a queue-local table the SQL pushdown
  // doesn't know — route to the live path, which filters in memory.
  if (_filters && Array.isArray((_filters as Record<string, unknown>).labels)) return true
  // Addendum presence is not cached (it changes outside any write to the
  // record) — a filter on it needs the live resolver's per-row summary.
  if (_filters && (_filters as Record<string, unknown>).addendums) return true
  // The cache stores at_risk + colour, never WHICH rule matched — a filter on
  // a specific highlight rule needs the live evaluator.
  if (_filters && (_filters as Record<string, unknown>).at_risk_rule) return true
  // Fulfilment figures (#7) and send-back counts (#85) are live-only reads —
  // neither rides the cache, so a filter or sort on them live-resolves.
  if (_filters && (_filters as Record<string, unknown>).fulfilment) return true
  if (_filters && (_filters as Record<string, unknown>).send_backs) return true
  if (sortKey === 'fulfilment' || sortKey === 'send_backs') return true
  // A date / number / boolean column filter carries its operator in the value.
  // `extra` holds whatever the source column stringified to (ISO one row,
  // MM/DD/YYYY the next), so the comparison is JS on the resolved rows, never
  // a JSON_VALUE string compare that would silently mis-order them.
  // Since #801 the cache stores a typed twin per extra value, read with the
  // same readers the live filter uses — only a cache written before that
  // (no twins yet; one rebuild fixes it) still needs the live path.
  if (!opts.typedTwins && hasTypedExtraFilter(_filters)) return true
  // An owners sort is served from the cache's owner_names (#800), written as
  // name-ordered ', '-joined names — the live sort key exactly. priority sorts and sla_status/
  // aging_hours filters are served from the cache via a narrow scan +
  // computeSla in JS (see fetchMaterializedQueueItems' useJsPath) — exact
  // business-hours math over the same cached inputs the table columns show,
  // WITHOUT the full live resolve that used to take ~48s on large queues.
  return false
}

// JSON path for an extra-field key: the cached `extra` object is FLAT — dotted
// display paths are literal keys ('divisions.name'), so the whole key is one
// quoted JSON property, never a nested path. Quotes stripped defensively (keys
// come from stored source config, not raw user input).
function extraJsonPath(field: string): string {
  return `$."${field.replace(/"/g, '')}"`
}

// One narrow-scanned cache row with its SLA already computed — the unit the
// JS filter/sort path operates on.
export interface NarrowScanRow {
  id: number
  label: string
  state: string | null
  collection: string
  at_risk: boolean
  has_owner: boolean
  sla_status: 'ok' | 'warning' | 'breached' | null
  aging_hours: number | null
  /** JSON_VALUE of the extra.* sort key when the request sorts by one; else null. */
  sort_val: string | null
}

const SLA_RANK: Record<string, number> = { ok: 1, warning: 2, breached: 3 }

/**
 * Mirrors applyColumnFilters' sla_status/aging_hours cases, sortItems'
 * nulls-last convention, and computePriorityScore's formula (queues.ts) —
 * over pre-computed narrow rows instead of hydrated QueueItems.
 */
export function filterAndOrderNarrowRows(
  rows: NarrowScanRow[],
  filters: Record<string, unknown>,
  sort: string,
  weights?: {
    sla_warning: number
    sla_breached: number
    at_risk: number
    age_hour_cap: number
  } | null
): NarrowScanRow[] {
  let out = rows
  const sla = filters.sla_status
  if (sla != null && sla !== '') out = out.filter((r) => r.sla_status === sla)
  const aging = filters.aging_hours as { min?: number; max?: number } | undefined
  if (aging != null) {
    out = out.filter((r) => {
      if (r.aging_hours == null) return false
      if (aging.min != null && r.aging_hours < aging.min) return false
      if (aging.max != null && r.aging_hours > aging.max) return false
      return true
    })
  }
  const desc = sort.startsWith('-')
  const key = desc ? sort.slice(1) : sort
  if (!key) return out
  const val = (r: NarrowScanRow): number | string | null => {
    if (key === 'priority') {
      // Same formula as computePriorityScore in queues.ts (parity unit-tested);
      // weights come from display_config.priority_weights (#353).
      const w = weights ?? {
        sla_warning: 1000,
        sla_breached: 2000,
        at_risk: 500,
        age_hour_cap: 499
      }
      const sla =
        r.sla_status === 'breached'
          ? w.sla_breached
          : r.sla_status === 'warning'
            ? w.sla_warning
            : 0
      return sla + (r.at_risk ? w.at_risk : 0) + Math.min(r.aging_hours ?? 0, w.age_hour_cap)
    }
    if (key === 'aging_hours') return r.aging_hours
    if (key === 'sla_status') return r.sla_status ? (SLA_RANK[r.sla_status] ?? null) : null
    if (key === 'at_risk') return r.at_risk ? 1 : 0
    if (key === 'label') return r.label
    if (key === 'state') return r.state
    if (key === 'collection') return r.collection
    if (key.startsWith('extra.')) return r.sort_val
    return null
  }
  return [...out].sort((a, b) => {
    const va = val(a)
    const vb = val(b)
    // Nulls last regardless of direction — sortItems' convention. Ties break
    // on time-invariant facts (#503), same rule as sortItems' stableTie.
    const tie = () => {
      if (key === 'priority') {
        const ag = (b.aging_hours ?? -1) - (a.aging_hours ?? -1)
        if (ag !== 0) return ag
      }
      return a.collection.localeCompare(b.collection) || a.id - b.id
    }
    if (va == null && vb == null) return tie()
    if (va == null) return 1
    if (vb == null) return -1
    const cmp =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb))
    if (cmp !== 0) return desc ? -cmp : cmp
    return tie()
  })
}

/** QueueStats over an (already filtered) narrow-row set — feeds filtered_stats
 * on the JS path, matching the live path's post-filter stats semantics. */
export function statsFromNarrowRows(rows: NarrowScanRow[]): QueueStats {
  const by_state: Record<string, number> = {}
  let unowned = 0
  let sla_warning = 0
  let sla_breached = 0
  let at_risk = 0
  for (const r of rows) {
    const stateKey = r.state ?? 'none'
    by_state[stateKey] = (by_state[stateKey] ?? 0) + 1
    if (!r.has_owner) unowned++
    if (r.sla_status === 'warning') sla_warning++
    if (r.sla_status === 'breached') sla_breached++
    if (r.at_risk) at_risk++
  }
  return { total: rows.length, by_state, unowned, sla_warning, sla_breached, at_risk }
}

function computeSla(row: {
  entered_state_at: Date | null
  sla_duration_hours: number | null
  sla_warning_pct: number | null
  sla_business_hours_only: boolean
  /** Cached per-record zone override (regional clock); null = instance default. */
  sla_timezone?: string | null
}): { status: 'ok' | 'warning' | 'breached' | null; aging_hours: number | null } {
  // Aging (time in current state) is rule-independent — any row with an
  // entered_state_at gets it. Only the status thresholds need rule params.
  if (!row.entered_state_at) {
    return { status: null, aging_hours: null }
  }
  const now = new Date()
  const elapsed = row.sla_business_hours_only
    ? businessHoursElapsed(
        new Date(row.entered_state_at),
        now,
        row.sla_timezone ? { ...getSlaScheduleSync(), timeZone: row.sla_timezone } : undefined
      )
    : (now.getTime() - new Date(row.entered_state_at).getTime()) / (1000 * 60 * 60)
  const aging_hours = Math.round(elapsed * 10) / 10
  if (row.sla_duration_hours == null || row.sla_warning_pct == null) {
    return { status: null, aging_hours }
  }
  const pctUsed = (elapsed / row.sla_duration_hours) * 100
  const status = pctUsed >= 100 ? 'breached' : pctUsed >= row.sla_warning_pct ? 'warning' : 'ok'
  return { status, aging_hours }
}

/**
 * Breached-count per queue over the materialized cache — the badges endpoint's
 * SLA figure. Narrow scan of only rule-carrying rows (sla_duration_hours set),
 * exact business-hours math via the same computeSla the stats path uses.
 */
export async function breachedCountsByQueue(queueIds: string[]): Promise<Record<string, number>> {
  if (queueIds.length === 0) return {}
  const rows = (await db('nivaro_queue_items')
    .whereIn('queue_id', queueIds)
    .whereNotNull('sla_duration_hours')
    .select(
      'queue_id',
      'entered_state_at',
      'sla_duration_hours',
      'sla_warning_pct',
      'sla_business_hours_only',
      'sla_timezone'
    )) as Array<{
    queue_id: string
    entered_state_at: Date | null
    sla_duration_hours: number | null
    sla_warning_pct: number | null
    sla_business_hours_only: boolean | number | null
    sla_timezone: string | null
  }>
  const out: Record<string, number> = {}
  for (const r of rows) {
    const { status } = computeSla({
      entered_state_at: r.entered_state_at,
      sla_duration_hours: r.sla_duration_hours,
      sla_warning_pct: r.sla_warning_pct,
      sla_business_hours_only: !!r.sla_business_hours_only,
      sla_timezone: r.sla_timezone ?? null
    })
    if (status === 'breached') out[r.queue_id] = (out[r.queue_id] ?? 0) + 1
  }
  return out
}

// Applies queue_id + scope (mine/unowned/claimed/all) to a fresh query builder.
// Shared by the stats/availableValues queries (scope-filtered, pre-column-filter —
// see fetchQueueItems' computeStats(scoped)/computeAvailableValues(scoped) convention
// in queues.ts) and as the seed for the column-filtered `base` used for total/rows.
/** #742 — an `addendums` source's rows follow their PARENT record's access:
 *  no read on the parent collection hides them all, and the parent's row
 *  filter / user scopes hide the addendums of parents the viewer cannot see. */
interface AddendumCacheGate {
  sourceId: number
  parentCollection: string
  deny: boolean
  gate: QueueGate | null
}

async function addendumCacheGatesFor(user: User, queueId: string): Promise<AddendumCacheGate[]> {
  const rows = (await db('nivaro_queue_sources')
    .where({ queue_id: queueId, type: 'addendums' })
    .whereNotNull('collection')
    .select('id', 'collection')
    .catch(() => [])) as Array<{ id: number; collection: string }>
  if (rows.length === 0) return []
  const { can } = await import('./permissions.js')
  const { queueGateFor } = await import('./queue-access.js')
  return Promise.all(
    rows.map(async (r) => {
      const readable = await can(user, 'read', r.collection)
      return {
        sourceId: Number(r.id),
        parentCollection: r.collection,
        deny: !readable,
        gate: readable ? await queueGateFor(user, r.collection) : null
      }
    })
  )
}

function applyAddendumCacheGates(qb: Knex.QueryBuilder, gates: AddendumCacheGate[], user: User) {
  for (const g of gates) {
    if (g.deny || g.gate?.deny) {
      qb.whereNot('qi.source_id', g.sourceId)
      continue
    }
    if (!g.gate) continue
    const gate = g.gate
    const visibleParents = db(g.parentCollection).select(
      db.raw('CAST(??.?? AS NVARCHAR(255))', [g.parentCollection, 'id'])
    )
    applyQueueGate(visibleParents, gate, user)
    const visibleAddendums = db('nivaro_addendums as a')
      .where('a.parent_collection', g.parentCollection)
      .whereIn('a.parent_id', visibleParents)
      .select(db.raw('CAST(a.id AS NVARCHAR(255))'))
    qb.where(function () {
      this.whereNot('qi.source_id', g.sourceId).orWhereIn('qi.item_id', visibleAddendums)
    })
  }
}

async function cacheGatesFor(
  user: User,
  queueId: string
): Promise<{ gates: QueueGate[]; addendumGates: AddendumCacheGate[] }> {
  const [gates, addendumGates] = await Promise.all([
    queueGatesFor(user, queueId),
    addendumCacheGatesFor(user, queueId)
  ])
  return { gates, addendumGates }
}

/**
 * #741 — the SQL twin of queueGroupKey (queues.ts) for the attributes the
 * cache can group in SQL. sla_status and aging depend on business-hours math
 * done at read time, so those live-resolve (requiresLiveResolveFallback).
 */
export function groupKeySql(attribute: string): { sql: string; bindings: string[] } | null {
  if (attribute === 'state') return { sql: `COALESCE(qi.state, 'No state')`, bindings: [] }
  if (attribute === 'collection') return { sql: 'qi.collection', bindings: [] }
  if (attribute === 'at_risk')
    return {
      sql: `CASE WHEN qi.at_risk = 1 THEN 'At risk' ELSE 'Not at risk' END`,
      bindings: []
    }
  if (attribute === 'owners')
    return {
      sql: `CASE WHEN qi.owner_names IS NULL OR qi.owner_names = '' THEN 'No owners' ELSE qi.owner_names END`,
      bindings: []
    }
  if (attribute.startsWith('extra.')) {
    const path = extraJsonPath(attribute.slice('extra.'.length))
    return {
      sql: `CASE WHEN JSON_VALUE(qi.extra, ?) IS NULL OR JSON_VALUE(qi.extra, ?) = '' THEN '—' ELSE JSON_VALUE(qi.extra, ?) END`,
      bindings: [path, path, path]
    }
  }
  return null
}

/** Group headers over the cache: one GROUP BY for counts, at-risk and sums,
 *  plus the breached count from a narrow SLA scan of rule-carrying rows (SLA
 *  status is computed at read time, like every cached SLA figure). */
async function materializedGroupSummaries(
  base: Knex.QueryBuilder,
  attribute: string,
  sums: string[]
): Promise<QueueGroupSummary[]> {
  const expr = groupKeySql(attribute)
  if (!expr) return []
  const safeSums = sums.filter((p) => /^[\w.]+$/.test(p)).slice(0, 12)
  // Grouped over a derived table: a parameterised key expression (extra.*
  // binds its JSON path) cannot be repeated in GROUP BY — each copy gets its
  // own parameter and SQL Server reads them as different expressions.
  const inner = base
    .clone()
    .clearSelect()
    .clearOrder()
    .select(db.raw(`${expr.sql} AS gk`, expr.bindings), 'qi.at_risk')
  safeSums.forEach((p, i) => {
    inner.select(
      db.raw(`TRY_CONVERT(float, JSON_VALUE(qi.extra, ?)) AS s${i}`, [twinJsonPath(p, 'n')])
    )
  })
  const q = db
    .from(inner.as('g'))
    .select('g.gk')
    .count('* as n')
    .select(db.raw('SUM(CASE WHEN g.at_risk = 1 THEN 1 ELSE 0 END) AS risky'))
    .groupBy('g.gk')
  safeSums.forEach((_p, i) => {
    q.select(db.raw(`SUM(g.s${i}) AS s${i}`))
  })
  const rows = (await q) as Array<Record<string, unknown>>
  const breachedRows = (await base
    .clone()
    .clearSelect()
    .clearOrder()
    .whereNotNull('qi.sla_duration_hours')
    .select(
      db.raw(`${expr.sql} AS gk`, expr.bindings),
      'qi.entered_state_at',
      'qi.sla_duration_hours',
      'qi.sla_warning_pct',
      'qi.sla_business_hours_only',
      'qi.sla_timezone'
    )) as Array<{
    gk: string
    entered_state_at: Date | null
    sla_duration_hours: number | null
    sla_warning_pct: number | null
    sla_business_hours_only: boolean
    sla_timezone: string | null
  }>
  const breached = new Map<string, number>()
  for (const r of breachedRows) {
    if (
      computeSla({ ...r, sla_business_hours_only: !!r.sla_business_hours_only }).status ===
      'breached'
    )
      breached.set(r.gk, (breached.get(r.gk) ?? 0) + 1)
  }
  const { orderQueueGroups } = await import('./queues.js')
  return orderQueueGroups(
    rows.map((r) => {
      const key = String(r.gk)
      const out: QueueGroupSummary = {
        key,
        count: Number(r.n),
        breached: breached.get(key) ?? 0,
        at_risk: Number(r.risky ?? 0),
        sums: {}
      }
      safeSums.forEach((p, i) => {
        const v = r[`s${i}`]
        if (v != null) out.sums[p] = Number(v)
      })
      return out
    }),
    attribute
  )
}

function wantsUnseenFilter(filters: Record<string, unknown>): boolean {
  const v = filters.unseen
  return v === true || v === 'yes' || v === 'true' || (Array.isArray(v) && v.includes('yes'))
}

/**
 * #643 on the materialized cache: record-unseen's rule (an edit, a pipeline
 * move or a comment by someone else after the viewer's last open) keyed on
 * the cache's `qi.collection` / `qi.item_id`, since cache rows span several
 * collections. services/record-unseen.ts `whereUnseen` is the same rule for a
 * single collection's own `id`; keep the two in step.
 */
export function applyUnseenToCache(qb: Knex.QueryBuilder, userId: string): void {
  const viewed = (b: Knex.QueryBuilder) =>
    b
      .where('v.user', userId)
      .whereRaw('v.collection = qi.collection')
      .whereRaw('v.item_id = qi.item_id')
  qb.where((outer) => {
    outer
      .whereExists(
        viewed(
          db('nivaro_record_views as v').join('nivaro_activity as a', function () {
            this.on('a.collection', '=', 'v.collection').andOn('a.item', '=', 'v.item_id')
          })
        )
          .whereIn('a.action', ['create', 'update'])
          .whereRaw('a.[timestamp] > v.last_viewed_at')
          .where((b) => b.whereNull('a.user').orWhereNot('a.user', userId))
          .select(db.raw('1'))
      )
      .orWhereExists(
        viewed(
          db('nivaro_record_views as v')
            .join('nivaro_workflow_instances as i', function () {
              this.on('i.collection', '=', 'v.collection').andOn('i.item', '=', 'v.item_id')
            })
            .join('nivaro_workflow_history as h', 'h.instance', 'i.id')
        )
          .whereRaw('h.[timestamp] > v.last_viewed_at')
          .where((b) => b.whereNull('h.user').orWhereNot('h.user', userId))
          .select(db.raw('1'))
      )
      .orWhereExists(
        viewed(
          db('nivaro_record_views as v').join('nivaro_comments as c', function () {
            this.on('c.collection', '=', 'v.collection').andOn('c.item', '=', 'v.item_id')
          })
        )
          .whereRaw('c.created_at > v.last_viewed_at')
          .whereNot('c.user', userId)
          .select(db.raw('1'))
      )
  })
}

function applyScope(
  qb: Knex.QueryBuilder,
  queueId: string,
  user: User,
  scope: QueueScope,
  cacheGates: { gates: QueueGate[]; addendumGates: AddendumCacheGate[] } = {
    gates: [],
    addendumGates: []
  }
): Knex.QueryBuilder {
  qb.where('qi.queue_id', queueId)
  // The viewer's row filter + user scopes per source collection — the cache
  // holds every viewer's rows, so it is narrowed here, on every read.
  applyQueueGatesToCache(qb, cacheGates.gates, user)
  applyAddendumCacheGates(qb, cacheGates.addendumGates, user)
  if (scope === 'mine') {
    qb.whereExists(function () {
      this.select('*')
        .from('nivaro_queue_item_owners as qio')
        .whereRaw('qio.queue_item_id = qi.id')
        .where('qio.user_id', user.id)
    })
  } else if (scope === 'unowned') {
    qb.whereNotExists(function () {
      this.select('*').from('nivaro_queue_item_owners as qio').whereRaw('qio.queue_item_id = qi.id')
    })
  } else if (scope === 'claimed') {
    qb.where('qi.claimed_by', user.id)
  }
  return qb
}

// Stats + availableValues from the materialized cache, scope-filtered but never
// column-filtered (the computeStats(scoped) convention). Split out from
// fetchMaterializedQueueItems so fetchQueueItems can serve EXACT stats for a
// materialized queue even when the requested sort/filters force the ROWS through
// the live-resolve fallback (priority sort, sla_status filter, extra.* …) — the
// live path's QUEUE_SANITY_CEILING truncation must never cap the stat strip.
// Aggregate QueueStats over any nivaro_queue_items builder (scope-only for the
// headline stats; scope+column-filters for filtered_stats).
async function computeStatsForBuilder(baseFactory: () => Knex.QueryBuilder): Promise<QueueStats> {
  const statsRows = (await baseFactory()
    .select('qi.state')
    .count('* as n')
    .groupBy('qi.state')) as Array<{ state: string | null; n: number }>
  const by_state: Record<string, number> = {}
  let total = 0
  for (const r of statsRows) {
    by_state[r.state ?? 'none'] = Number(r.n)
    total += Number(r.n)
  }
  const unownedRow = (await baseFactory()
    .whereNotExists(function () {
      this.select('*').from('nivaro_queue_item_owners as qio').whereRaw('qio.queue_item_id = qi.id')
    })
    .count('* as n')
    .first()) as { n: number }
  const atRiskRow = (await baseFactory().where('qi.at_risk', true).count('* as n').first()) as {
    n: number
  }
  const slaScanRows = (await baseFactory()
    .whereNotNull('qi.sla_duration_hours')
    .select(
      'qi.entered_state_at',
      'qi.sla_duration_hours',
      'qi.sla_warning_pct',
      'qi.sla_business_hours_only',
      'qi.sla_timezone'
    )) as Array<{
    entered_state_at: Date | null
    sla_duration_hours: number | null
    sla_warning_pct: number | null
    sla_business_hours_only: boolean
  }>
  let sla_warning = 0
  let sla_breached = 0
  for (const r of slaScanRows) {
    const { status } = computeSla(r)
    if (status === 'warning') sla_warning++
    if (status === 'breached') sla_breached++
  }
  return {
    total,
    by_state,
    unowned: Number(unownedRow.n),
    sla_warning,
    sla_breached,
    at_risk: Number(atRiskRow.n)
  }
}

export async function fetchMaterializedStats(
  queueId: string,
  user: User,
  scope: QueueScope
): Promise<{
  stats: QueueStats
  availableValues: {
    collection: string[]
    state: string[]
    owners: Array<{ id: string; name: string }>
  }
}> {
  const gates = await cacheGatesFor(user, queueId)
  const scopeBase = applyScope(db('nivaro_queue_items as qi'), queueId, user, scope, gates)

  const statsRows = (await scopeBase
    .clone()
    .select('qi.state')
    .count('* as n')
    .groupBy('qi.state')) as Array<{ state: string | null; n: number }>
  const by_state: Record<string, number> = {}
  let statsTotal = 0
  for (const r of statsRows) {
    by_state[r.state ?? 'none'] = Number(r.n)
    statsTotal += Number(r.n)
  }
  const unownedRow = (await scopeBase
    .clone()
    .whereNotExists(function () {
      this.select('*').from('nivaro_queue_item_owners as qio').whereRaw('qio.queue_item_id = qi.id')
    })
    .count('* as n')
    .first()) as { n: number }

  // sla_warning/sla_breached need business-hours math (computeSla is JS-only, not
  // expressible as plain SQL) — but only rows that CARRY an SLA rule can be
  // warning/breached, so the JS scan is restricted to sla_duration_hours IS NOT
  // NULL (usually a small fraction; zero when no SLA rules are configured).
  // at_risk is a plain bit — SQL count, no scan.
  const atRiskRow = (await scopeBase.clone().where('qi.at_risk', true).count('* as n').first()) as {
    n: number
  }
  const atRiskCount = Number(atRiskRow.n)

  const slaScanRows = (await scopeBase
    .clone()
    .whereNotNull('qi.sla_duration_hours')
    .select(
      'qi.entered_state_at',
      'qi.sla_duration_hours',
      'qi.sla_warning_pct',
      'qi.sla_business_hours_only',
      'qi.sla_timezone'
    )) as Array<{
    entered_state_at: Date | null
    sla_duration_hours: number | null
    sla_warning_pct: number | null
    sla_business_hours_only: boolean
  }>
  let sla_warning = 0
  let sla_breached = 0
  for (const r of slaScanRows) {
    const { status } = computeSla(r)
    if (status === 'warning') sla_warning++
    if (status === 'breached') sla_breached++
  }

  const collectionsRow = (await scopeBase
    .clone()
    .distinct('qi.collection as collection')) as Array<{
    collection: string
  }>
  const statesRow = (await scopeBase
    .clone()
    .whereNotNull('qi.state')
    .distinct('qi.state as state')) as Array<{
    state: string
  }>
  // Distinct users appearing as owners of this queue's cached items — feeds
  // the Owners filter combobox (mirrors computeAvailableValues' live path).
  const ownersRow = (await scopeBase
    .clone()
    .join('nivaro_queue_item_owners as qio', 'qio.queue_item_id', 'qi.id')
    .join('nivaro_users as u', 'u.id', 'qio.user_id')
    .distinct('u.id as id', 'u.first_name', 'u.last_name', 'u.email')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string
  }>

  return {
    stats: {
      total: statsTotal,
      by_state,
      unowned: Number(unownedRow.n),
      sla_warning,
      sla_breached,
      at_risk: atRiskCount
    },
    availableValues: {
      collection: collectionsRow.map((r) => r.collection).sort(),
      state: statesRow.map((r) => r.state).sort(),
      owners: ownersRow
        .map((u) => ({
          id: String(u.id),
          name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  }
}

export async function fetchMaterializedQueueItems(
  queueId: string,
  user: User,
  scope: QueueScope,
  options: {
    sort?: string
    filters?: Record<string, unknown>
    page?: number
    limit?: number
    withUnseen?: boolean
    group?: { by: string; key?: string | null; sums?: string[] }
  } = {}
): Promise<{
  items: QueueItem[]
  groups?: QueueGroupSummary[]
  stats: QueueStats
  filteredStats: QueueStats | null
  /** Rows per state under every active filter except State itself — the
   *  counts beside the State filter's options. */
  stateCounts: Record<string, number>
  availableValues: {
    collection: string[]
    state: string[]
    owners: Array<{ id: string; name: string }>
  }
  truncated: boolean
  total: number
}> {
  const filters = options.filters ?? {}

  // Priority weights (#353) from the queue's display_config — used by the
  // JS narrow-scan path's priority sort.
  const queueCfgRow = (await db('nivaro_queues').where({ id: queueId }).first('display_config')) as
    | { display_config?: string | null }
    | undefined
  const displayCfgWeights = normalizeDisplayConfig(
    parseJson(queueCfgRow?.display_config ?? null)
  ).priority_weights

  // scopeBase = queue_id + scope only (no column filters) — feeds stats and
  // availableValues, matching fetchQueueItems' computeStats(scoped)/
  // computeAvailableValues(scoped) which are computed on the scope-filtered set
  // BEFORE column filters, so the stat strip and filter dropdown options never
  // shrink as a viewer narrows the table via column filters.
  const gates = await cacheGatesFor(user, queueId)
  const scopeBase = applyScope(db('nivaro_queue_items as qi'), queueId, user, scope, gates)

  // base = scopeBase + column filters — feeds total count and the paginated rows.
  // sla_status/aging_hours filters and an owners sort are intentionally NOT
  // handled here — requiresLiveResolveFallback() is responsible for routing
  // those requests around this function entirely, so in practice this function
  // should never receive them, but the code must not silently pretend to
  // support them either.
  // baseNoState = everything except the State filter (feeds the state counts);
  // base adds it.
  const baseNoState = scopeBase.clone()
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]
  const collectionList = asList(filters.collection)
  if (collectionList.length > 0) baseNoState.whereIn('qi.collection', collectionList)
  const stateList = asList(filters.state)
  for (const [key, raw] of Object.entries(filters)) {
    if (!key.startsWith('extra.')) continue
    const values = asList(raw)
    if (values.length === 0) continue
    const field = key.slice('extra.'.length)
    const path = extraJsonPath(field)
    baseNoState.where(function () {
      for (const v of values) {
        const op = parseColumnFilterOp(v)
        if (op) {
          // A typed operator reads the twin (#801) — the same value the live
          // matcher parses, so both paths keep the same rows.
          this.orWhere(function () {
            applyTypedExtraPredicate(this, field, op)
          })
        } else {
          this.orWhereRaw('JSON_VALUE(qi.extra, ?) LIKE ?', [path, `%${v}%`])
        }
      }
    })
  }
  // "Unseen changes" (#643): the record-unseen rule as a predicate on the
  // cache's own (collection, item_id) — see applyUnseenToCache.
  if (wantsUnseenFilter(filters)) applyUnseenToCache(baseNoState, user.id)
  const labelList = asList(filters.label)
  if (labelList.length > 0) {
    baseNoState.where(function () {
      for (const v of labelList) {
        this.orWhereRaw('LOWER(qi.label) LIKE ?', [`%${v.toLowerCase()}%`])
      }
    })
  }
  if (filters.owners) {
    // Array = user-id multiselect (ANY match, via the owners M2M); string =
    // legacy substring match on the denormalized name string.
    if (Array.isArray(filters.owners)) {
      const ids = filters.owners.map(String).filter(Boolean)
      if (ids.length > 0) {
        baseNoState.whereExists(function () {
          this.select('*')
            .from('nivaro_queue_item_owners as qio')
            .whereRaw('qio.queue_item_id = qi.id')
            .whereIn('qio.user_id', ids)
        })
      }
    } else {
      baseNoState.whereRaw('LOWER(qi.owner_names) LIKE ?', [
        `%${String(filters.owners).toLowerCase()}%`
      ])
    }
  }
  if (filters.at_risk) baseNoState.where('qi.at_risk', filters.at_risk === 'yes')
  let base = baseNoState.clone()
  if (stateList.length > 0) base.whereIn('qi.state', stateList)
  const inStateFilter = (state: string | null) =>
    stateList.length === 0 || (state != null && stateList.includes(state))

  // #741 group-by: the headers come from grouped SQL over every filter, then
  // rows are narrowed to the one group being expanded (none for headers only).
  let groups: QueueGroupSummary[] | undefined
  let groupHeadersOnly = false
  if (options.group) {
    const expr = groupKeySql(options.group.by)
    if (expr) {
      groups = await materializedGroupSummaries(base, options.group.by, options.group.sums ?? [])
      if (options.group.key == null) {
        groupHeadersOnly = true
      } else {
        const key = options.group.key
        baseNoState.whereRaw(`(${expr.sql}) = ?`, [...expr.bindings, key])
        base = baseNoState.clone()
        if (stateList.length > 0) base.whereIn('qi.state', stateList)
      }
    }
  }

  const sort = options.sort ?? ''
  const desc = sort.startsWith('-')
  const sortKey = desc ? sort.slice(1) : sort
  const page = options.page ?? 1

  const FULL_ROW_COLUMNS = [
    'qi.id',
    'qi.collection',
    'qi.item_id',
    'qi.label',
    'qi.state',
    'qi.state_id',
    'qi.state_color',
    'qi.entered_state_at',
    'qi.sla_duration_hours',
    'qi.sla_warning_pct',
    'qi.sla_business_hours_only',
    'qi.sla_timezone',
    'qi.at_risk',
    'qi.at_risk_color',
    'qi.claimed_by',
    'qi.extra',
    'qi.url'
  ]
  interface FullRow {
    id: number
    collection: string
    item_id: string
    label: string
    state: string | null
    state_id: string | null
    state_color: string | null
    entered_state_at: Date | null
    sla_duration_hours: number | null
    sla_warning_pct: number | null
    sla_business_hours_only: boolean
    at_risk: boolean
    at_risk_color: string | null
    claimed_by: string | null
    extra: string | null
    url: string
  }

  // JS path: priority scoring and sla_status/aging_hours filtering need the
  // business-hours SLA math, which is JS-only. Instead of live-resolving the
  // whole queue (the old fallback — ~48s on an 80k-source queue), narrow-scan
  // the cached inputs, computeSla per row, then filter/sort/paginate in JS and
  // hydrate only the page's rows by id.
  const slaFilterActive = filters.sla_status != null && filters.sla_status !== ''
  const agingFilterActive = filters.aging_hours != null
  const useJsPath = sortKey === 'priority' || slaFilterActive || agingFilterActive

  let rows: FullRow[]
  let total: number
  let jsFilteredStats: QueueStats | null = null
  let stateCounts: Record<string, number> = {}

  if (useJsPath) {
    // Scanned without the State filter so the state counts see every state;
    // State is applied in JS below.
    const narrowQuery = baseNoState
      .clone()
      .select(
        'qi.id',
        'qi.label',
        'qi.state',
        'qi.collection',
        'qi.entered_state_at',
        'qi.sla_duration_hours',
        'qi.sla_warning_pct',
        'qi.sla_business_hours_only',
        'qi.sla_timezone',
        'qi.at_risk',
        db.raw(
          'CASE WHEN EXISTS (SELECT 1 FROM nivaro_queue_item_owners qio WHERE qio.queue_item_id = qi.id) THEN 1 ELSE 0 END AS has_owner'
        )
      )
    if (sortKey.startsWith('extra.')) {
      narrowQuery.select(
        db.raw('JSON_VALUE(qi.extra, ?) AS sort_val', [
          extraJsonPath(sortKey.slice('extra.'.length))
        ])
      )
    }
    const narrowRaw = (await narrowQuery) as Array<{
      id: number
      label: string
      state: string | null
      collection: string
      entered_state_at: Date | null
      sla_duration_hours: number | null
      sla_warning_pct: number | null
      sla_business_hours_only: boolean
      at_risk: boolean
      has_owner: number
      sort_val?: string | null
    }>
    const narrow: NarrowScanRow[] = narrowRaw.map((r) => {
      const sla = computeSla(r)
      return {
        id: r.id,
        label: r.label,
        state: r.state,
        collection: r.collection,
        at_risk: !!r.at_risk,
        has_owner: !!r.has_owner,
        sla_status: sla.status,
        aging_hours: sla.aging_hours,
        sort_val: r.sort_val ?? null
      }
    })
    const orderedAll = filterAndOrderNarrowRows(narrow, filters, sort, displayCfgWeights)
    for (const r of orderedAll) {
      const k = r.state ?? 'none'
      stateCounts[k] = (stateCounts[k] ?? 0) + 1
    }
    const ordered = orderedAll.filter((r) => inStateFilter(r.state))
    total = ordered.length
    jsFilteredStats = statsFromNarrowRows(ordered)

    const limit = groupHeadersOnly ? 0 : (options.limit ?? total)
    const pageIds = (limit > 0 ? ordered.slice((page - 1) * limit, page * limit) : []).map(
      (r) => r.id
    )
    const fetched = pageIds.length
      ? ((await db('nivaro_queue_items as qi')
          .whereIn('qi.id', pageIds)
          .select(FULL_ROW_COLUMNS)) as FullRow[])
      : []
    // whereIn loses the JS ordering — restore it by page-id position.
    const posById = new Map(pageIds.map((id, i) => [id, i]))
    rows = fetched.sort((a, b) => (posById.get(a.id) ?? 0) - (posById.get(b.id) ?? 0))
  } else {
    const countRow = (await base.clone().count('* as n').first()) as { n: number }
    total = Number(countRow.n)
    const stateRows = (await baseNoState
      .clone()
      .select('qi.state')
      .count('* as n')
      .groupBy('qi.state')) as Array<{ state: string | null; n: number }>
    stateCounts = Object.fromEntries(stateRows.map((r) => [r.state ?? 'none', Number(r.n)]))

    let idOrdered = false
    if (sortKey === 'label' || sortKey === 'state' || sortKey === 'collection') {
      base.orderBy(`qi.${sortKey}`, desc ? 'desc' : 'asc')
    } else if (sortKey === 'aging_hours' || sortKey === 'sla_status') {
      // entered_state_at is a correct proxy for elapsed time on non-business-hours
      // rules; for business_hours_only rules it's a documented approximation
      // (see design spec) — exact values are computed below, per returned row.
      // MSSQL has no boolean-scalar expressions usable directly in ORDER BY (T-SQL
      // rejects `col IS NULL` outside a predicate context), so nulls-last is done
      // via CASE WHEN — matching the CASE WHEN pattern already used for MSSQL-safe
      // ordering in services/permissions.ts. Nulls always sort last regardless of
      // direction, matching sortItems' null-handling convention in queues.ts.
      base.orderByRaw(
        `CASE WHEN qi.entered_state_at IS NULL THEN 1 ELSE 0 END ASC, qi.entered_state_at ${desc ? 'ASC' : 'DESC'}`
      )
    } else if (sortKey === 'at_risk') {
      base.orderBy('qi.at_risk', desc ? 'desc' : 'asc')
    } else if (sortKey === 'owners') {
      // No owners sorts last in both directions, like sortItems (#800).
      base.orderByRaw(
        `CASE WHEN qi.owner_names IS NULL OR qi.owner_names = '' THEN 1 ELSE 0 END ASC, qi.owner_names ${desc ? 'DESC' : 'ASC'}`
      )
    } else if (sortKey.startsWith('extra.')) {
      const path = extraJsonPath(sortKey.slice('extra.'.length))
      // Nulls last regardless of direction — matches sortItems' convention.
      base.orderByRaw(
        `CASE WHEN JSON_VALUE(qi.extra, ?) IS NULL THEN 1 ELSE 0 END ASC, JSON_VALUE(qi.extra, ?) ${desc ? 'DESC' : 'ASC'}`,
        [path, path]
      )
    } else {
      // MSSQL requires ORDER BY when OFFSET/FETCH is present; (SELECT NULL)
      // left pages nondeterministic — the cache row id is stable (#503).
      base.orderBy('qi.id', 'asc')
      idOrdered = true
    }
    // Ties on the requested key break on the cache row id, so two identical
    // requests page identically (#503). Never twice — MSSQL rejects a column
    // repeated in ORDER BY (error 169).
    if (!idOrdered) base.orderBy('qi.id', 'asc')

    const limit = options.limit ?? total
    const rowsQuery = base.clone().select(FULL_ROW_COLUMNS)
    // limit=0 (e.g. an unpaginated Kanban request against a zero-row materialized queue,
    // where total===0) would produce an invalid `OFFSET 0 FETCH NEXT 0 ROWS ONLY` against
    // MSSQL — skip the pagination clauses entirely; the WHERE clause already matches
    // nothing, so the result set is empty either way.
    if (limit > 0) rowsQuery.offset((page - 1) * limit).limit(limit)
    rows = groupHeadersOnly ? [] : ((await rowsQuery) as FullRow[])
  }

  const ownerRows =
    rows.length > 0
      ? ((await db('nivaro_queue_item_owners as qio')
          .join('nivaro_users as u', 'qio.user_id', 'u.id')
          .whereIn(
            'qio.queue_item_id',
            rows.map((r) => r.id)
          )
          .select(
            'qio.queue_item_id',
            'u.id as user_id',
            'u.first_name',
            'u.last_name',
            'u.email'
          )) as Array<{
          queue_item_id: number
          user_id: string
          first_name: string | null
          last_name: string | null
          email: string
        }>)
      : []
  const ownersByQueueItemId = new Map<number, QueueOwner[]>()
  for (const o of ownerRows) {
    const list = ownersByQueueItemId.get(o.queue_item_id) ?? []
    list.push({
      id: o.user_id,
      name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
    })
    ownersByQueueItemId.set(o.queue_item_id, list)
  }

  // Resolve real claimant display names in one extra bounded query (≤ page size
  // distinct ids) rather than a placeholder empty string — queue-kanban-board.tsx
  // renders `Claimed: ${item.claimed_by.name}`, so an empty name silently shows
  // blank for every claimed card in Kanban view.
  const claimedByIds = Array.from(
    new Set(rows.map((r) => r.claimed_by).filter((id): id is string => !!id))
  )
  const claimantNameById = new Map<string, string>()
  if (claimedByIds.length > 0) {
    const claimantRows = (await db('nivaro_users')
      .whereIn('id', claimedByIds)
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string
    }>
    for (const u of claimantRows) {
      claimantNameById.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email)
    }
  }

  // Predictive risk from per-state historical percentiles — cached rows carry
  // state_id since migration 147; NULL (pre-rebuild rows) simply never predicts.
  let durationStats: Map<string, { p50: number; p80: number; n: number }> | null = null
  try {
    const { getStateDurationStats } = await import('./predictive-sla.js')
    durationStats = await getStateDurationStats()
  } catch {
    durationStats = null
  }
  const { predictStuck } = await import('./predictive-sla.js')

  const items: QueueItem[] = rows.map((r) => {
    const sla = computeSla(r)
    const prediction = durationStats
      ? predictStuck(durationStats, r.state_id, sla.aging_hours)
      : { predicted: false, p80_hours: null, note: null }
    return {
      collection: r.collection,
      item_id: r.item_id,
      label: r.label,
      state: r.state,
      state_color: r.state_color,
      owners: ownersByQueueItemId.get(r.id) ?? [],
      sla_status: sla.status,
      at_risk: !!r.at_risk,
      at_risk_color: r.at_risk_color ?? null,
      predicted_risk: prediction.predicted,
      predicted_note: prediction.note,
      aging_hours: sla.aging_hours,
      state_entered_at: r.entered_state_at ? new Date(r.entered_state_at).toISOString() : null,
      claimed_by: r.claimed_by
        ? { id: r.claimed_by, name: claimantNameById.get(r.claimed_by) ?? '' }
        : null,
      ...splitExtra(r.extra),
      url: r.url
    }
  })
  if (options.withUnseen) {
    const { unseenForItems } = await import('./queues.js')
    const unseen = await unseenForItems(user.id, items).catch(() => new Map())
    for (const it of items) it.unseen = unseen.get(`${it.collection}:${it.item_id}`) ?? null
  }

  // Stats and availableValues come from the shared scope-filtered helper — see
  // fetchMaterializedStats above.
  const { stats, availableValues } = await fetchMaterializedStats(queueId, user, scope)

  const { hasActiveColumnFilters } = await import('./queues.js')
  // JS path already computed post-filter stats from the narrow scan (the SQL
  // builder can't express the sla/aging filters it applied).
  const filteredStats = hasActiveColumnFilters(filters)
    ? useJsPath
      ? jsFilteredStats
      : await computeStatsForBuilder(() => base.clone().clearSelect().clearOrder())
    : null

  return {
    items,
    ...(groups ? { groups } : {}),
    stats,
    filteredStats,
    stateCounts,
    availableValues,
    truncated: false,
    total
  }
}
