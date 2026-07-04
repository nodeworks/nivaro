import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { businessHoursElapsed } from '../routes/sla.js'
import type { User } from '../types.js'
import type { QueueItem, QueueOwner, QueueScope, QueueStats } from './queues.js'

// Returns true when the requested sort/filters touch a field this SQL-pushdown
// path cannot (or intentionally does not) serve correctly: extra.* fields (never
// materialized as real columns), sla_status/aging_hours filters (business-hours
// SLA math is JS-only, not expressible as plain SQL), and an owners sort (would
// need a SQL-level string aggregation across the M2M owners table). The caller
// should route requests matching this to the existing live-resolve path instead
// of calling fetchMaterializedQueueItems.
export function requiresLiveResolveFallback(
  sort: string,
  filters: Record<string, unknown>
): boolean {
  const sortKey = sort.startsWith('-') ? sort.slice(1) : sort
  if (sortKey.startsWith('extra.')) return true
  if (sortKey === 'owners') return true
  if (Object.keys(filters).some((k) => k.startsWith('extra.'))) return true
  if (filters.sla_status != null && filters.sla_status !== '') return true
  if (filters.aging_hours != null) return true
  return false
}

function computeSla(row: {
  entered_state_at: Date | null
  sla_duration_hours: number | null
  sla_warning_pct: number | null
  sla_business_hours_only: boolean
}): { status: 'ok' | 'warning' | 'breached' | null; aging_hours: number | null } {
  if (!row.entered_state_at || row.sla_duration_hours == null || row.sla_warning_pct == null) {
    return { status: null, aging_hours: null }
  }
  const now = new Date()
  const elapsed = row.sla_business_hours_only
    ? businessHoursElapsed(new Date(row.entered_state_at), now)
    : (now.getTime() - new Date(row.entered_state_at).getTime()) / (1000 * 60 * 60)
  const pctUsed = (elapsed / row.sla_duration_hours) * 100
  const status = pctUsed >= 100 ? 'breached' : pctUsed >= row.sla_warning_pct ? 'warning' : 'ok'
  return { status, aging_hours: Math.round(elapsed * 10) / 10 }
}

// Applies queue_id + scope (mine/unowned/claimed/all) to a fresh query builder.
// Shared by the stats/availableValues queries (scope-filtered, pre-column-filter —
// see fetchQueueItems' computeStats(scoped)/computeAvailableValues(scoped) convention
// in queues.ts) and as the seed for the column-filtered `base` used for total/rows.
function applyScope(
  qb: Knex.QueryBuilder,
  queueId: string,
  user: User,
  scope: QueueScope
): Knex.QueryBuilder {
  qb.where('qi.queue_id', queueId)
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

export async function fetchMaterializedQueueItems(
  queueId: string,
  user: User,
  scope: QueueScope,
  options: { sort?: string; filters?: Record<string, unknown>; page?: number; limit?: number } = {}
): Promise<{
  items: QueueItem[]
  stats: QueueStats
  availableValues: { collection: string[]; state: string[] }
  truncated: boolean
  total: number
}> {
  const filters = options.filters ?? {}

  // scopeBase = queue_id + scope only (no column filters) — feeds stats and
  // availableValues, matching fetchQueueItems' computeStats(scoped)/
  // computeAvailableValues(scoped) which are computed on the scope-filtered set
  // BEFORE column filters, so the stat strip and filter dropdown options never
  // shrink as a viewer narrows the table via column filters.
  const scopeBase = applyScope(db('nivaro_queue_items as qi'), queueId, user, scope)

  // base = scopeBase + column filters — feeds total count and the paginated rows.
  // sla_status/aging_hours filters and an owners sort are intentionally NOT
  // handled here — requiresLiveResolveFallback() is responsible for routing
  // those requests around this function entirely, so in practice this function
  // should never receive them, but the code must not silently pretend to
  // support them either.
  const base = scopeBase.clone()
  if (filters.collection) base.where('qi.collection', filters.collection as string)
  if (filters.state) base.where('qi.state', filters.state as string)
  if (filters.label)
    base.whereRaw('LOWER(qi.label) LIKE ?', [`%${String(filters.label).toLowerCase()}%`])
  if (filters.owners) {
    base.whereRaw('LOWER(qi.owner_names) LIKE ?', [`%${String(filters.owners).toLowerCase()}%`])
  }
  if (filters.at_risk) base.where('qi.at_risk', filters.at_risk === 'yes')

  const countRow = (await base.clone().count('* as n').first()) as { n: number }
  const total = Number(countRow.n)

  const sort = options.sort ?? ''
  const desc = sort.startsWith('-')
  const sortKey = desc ? sort.slice(1) : sort
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
  } else {
    // MSSQL requires ORDER BY when OFFSET/FETCH is present but no real sort was
    // requested — same fallback used in services/items.ts.
    base.orderByRaw('(SELECT NULL)')
  }

  const page = options.page ?? 1
  const limit = options.limit ?? total
  const rows = (await base
    .clone()
    .select(
      'qi.id',
      'qi.collection',
      'qi.item_id',
      'qi.label',
      'qi.state',
      'qi.state_color',
      'qi.entered_state_at',
      'qi.sla_duration_hours',
      'qi.sla_warning_pct',
      'qi.sla_business_hours_only',
      'qi.at_risk',
      'qi.at_risk_color',
      'qi.claimed_by',
      'qi.extra',
      'qi.url'
    )
    .offset((page - 1) * limit)
    .limit(limit)) as Array<{
    id: number
    collection: string
    item_id: string
    label: string
    state: string | null
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
  }>

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

  const items: QueueItem[] = rows.map((r) => {
    const sla = computeSla(r)
    return {
      collection: r.collection,
      item_id: r.item_id,
      label: r.label,
      state: r.state,
      state_color: r.state_color,
      owners: ownersByQueueItemId.get(r.id) ?? [],
      sla_status: sla.status,
      at_risk: !!r.at_risk,
      aging_hours: sla.aging_hours,
      claimed_by: r.claimed_by
        ? { id: r.claimed_by, name: claimantNameById.get(r.claimed_by) ?? '' }
        : null,
      extra: r.extra ? JSON.parse(r.extra) : {},
      url: r.url
    }
  })

  // Stats and availableValues are computed on scopeBase (scope-filtered, no column
  // filters) — see the comment on scopeBase above.
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

  return {
    items,
    stats: { total: statsTotal, by_state, unowned: Number(unownedRow.n) },
    availableValues: {
      collection: collectionsRow.map((r) => r.collection).sort(),
      state: statesRow.map((r) => r.state).sort()
    },
    truncated: false,
    total
  }
}
