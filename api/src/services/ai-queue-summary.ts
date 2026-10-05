import { db } from '../db/index.js'
import type { User } from '../types.js'
import { fetchQueueItems, type QueueItem, type QueueRow, type QueueStats } from './queues.js'
import { isAdminRole } from './user-scopes.js'

/**
 * Ask AI over a queue (#1276): one `queue_summary` tool call answers "what
 * is stuck in this queue and why" — totals, the by-state breakdown, the
 * SLA breaches, the oldest records, the unowned ones and the at-risk rules
 * firing most, each record named by its friendly id with a link.
 *
 * Everything runs AS THE ASKER through `fetchQueueItems`, so queue
 * visibility (owner / shared / role), RBAC, row filters and User Scopes all
 * narrow the figures exactly as the queue page does for that person. The
 * pure shaping (`shapeQueueSummary`) is separated from the reads so it can
 * be unit-tested over fixture rows.
 */

export const QUEUE_SUMMARY_LIST_LIMIT = 10
export const QUEUE_SUMMARY_MAX_LIST_LIMIT = 25
export const QUEUE_SUMMARY_REASON_LIMIT = 5
export const QUEUE_CATALOGUE_LIMIT = 40

export interface QueueSummaryRecord {
  /** The record's friendly id (human id when the collection declares one). */
  label: string
  /** The queue's own row label when it differs from the friendly id. */
  title?: string
  collection: string
  id: string
  state: string | null
  aging_hours: number | null
  url: string
}

export interface QueueSummary {
  queue: { id: string; name: string; url: string; sources: string[] }
  stats: {
    total: number
    unowned: number
    sla_warning: number
    sla_breached: number
    at_risk: number
    by_state: Array<{ key: string; label: string; count: number }>
  }
  oldest: QueueSummaryRecord[]
  breached: Array<QueueSummaryRecord & { hours_over: number | null; owners: string[] }>
  unowned: QueueSummaryRecord[]
  at_risk_reasons: Array<{ rule: string; count: number }>
  /** The queue hit its row safety limit — the lists may miss records, the
   *  totals are still exact. */
  truncated: boolean
  /** Each list holds at most this many records. */
  list_limit: number
}

export interface ShapeOptions {
  /** State key → label (the pipeline's own wording). */
  stateLabels?: Record<string, string>
  /** `<collection>:<id>` → friendly id. */
  friendlyIds?: Record<string, string>
  /** `<collection>:<id>` → hours past the SLA (breached rows only). */
  hoursOver?: Record<string, number>
  listLimit?: number
  truncated?: boolean
}

export interface QueueSummaryTarget {
  id: string
  name: string
  sources: string[]
}

const itemKey = (it: Pick<QueueItem, 'collection' | 'item_id'>) => `${it.collection}:${it.item_id}`

function titleCase(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function clampLimit(n: number | undefined): number {
  if (!Number.isFinite(n)) return QUEUE_SUMMARY_LIST_LIMIT
  return Math.max(1, Math.min(QUEUE_SUMMARY_MAX_LIST_LIMIT, Math.floor(n as number)))
}

/** Pure: QueueItem[] + QueueStats → the summary object. Never reads. */
export function shapeQueueSummary(
  items: QueueItem[],
  stats: QueueStats,
  queue: QueueSummaryTarget,
  opts: ShapeOptions = {}
): QueueSummary {
  const limit = clampLimit(opts.listLimit)
  const stateLabel = (key: string | null): string | null => {
    if (!key) return null
    return opts.stateLabels?.[key] ?? titleCase(key)
  }
  const record = (it: QueueItem): QueueSummaryRecord => {
    const friendly = opts.friendlyIds?.[itemKey(it)]
    const label = friendly ?? it.label
    const out: QueueSummaryRecord = {
      label,
      collection: it.collection,
      id: String(it.item_id),
      state: stateLabel(it.state),
      aging_hours: it.aging_hours == null ? null : Math.round(it.aging_hours * 10) / 10,
      url: it.url
    }
    if (it.label && it.label !== label) out.title = it.label
    return out
  }
  const byAgeDesc = (a: QueueItem, b: QueueItem) => (b.aging_hours ?? -1) - (a.aging_hours ?? -1)

  const by_state = Object.entries(stats.by_state ?? {})
    .map(([key, count]) => ({ key, label: stateLabel(key) ?? key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))

  const oldest = items
    .filter((it) => it.aging_hours != null)
    .sort(byAgeDesc)
    .slice(0, limit)
    .map(record)

  const breached = items
    .filter((it) => it.sla_status === 'breached')
    .map((it) => ({ it, over: opts.hoursOver?.[itemKey(it)] ?? null }))
    .sort((a, b) => (b.over ?? -1) - (a.over ?? -1) || byAgeDesc(a.it, b.it))
    .slice(0, limit)
    .map(({ it, over }) => ({
      ...record(it),
      hours_over: over == null ? null : Math.round(over * 10) / 10,
      owners: it.owners.map((o) => o.name)
    }))

  const unowned = items
    .filter((it) => it.owners.length === 0)
    .sort(byAgeDesc)
    .slice(0, limit)
    .map(record)

  const reasonCounts = new Map<string, number>()
  for (const it of items) {
    if (!it.at_risk) continue
    const rule = it.at_risk_rule?.name?.trim() || 'Unnamed rule'
    reasonCounts.set(rule, (reasonCounts.get(rule) ?? 0) + 1)
  }
  const at_risk_reasons = [...reasonCounts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
    .slice(0, QUEUE_SUMMARY_REASON_LIMIT)

  return {
    queue: { id: queue.id, name: queue.name, url: `/queues/${queue.id}`, sources: queue.sources },
    stats: {
      total: stats.total,
      unowned: stats.unowned,
      sla_warning: stats.sla_warning,
      sla_breached: stats.sla_breached,
      at_risk: stats.at_risk,
      by_state
    },
    oldest,
    breached,
    unowned,
    at_risk_reasons,
    truncated: !!opts.truncated,
    list_limit: limit
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────

type ReadableQueue = Pick<QueueRow, 'id' | 'name' | 'owner' | 'is_shared' | 'role_id'>

/** The queues this user may read — the GET /queues list's rule (admin, owner,
 *  or shared with everyone / with their role), active queues only. */
export async function readableQueues(user: User): Promise<ReadableQueue[]> {
  const admin = await isAdminRole(user.role)
  const rows = (await db('nivaro_queues')
    .where({ is_active: true })
    .orderBy('name')
    .select('id', 'name', 'owner', 'is_shared', 'role_id')
    .catch(() => [])) as ReadableQueue[]
  if (admin) return rows
  const role = user.role ?? null
  return rows.filter(
    (q) =>
      q.owner === user.id ||
      (!!q.is_shared && (q.role_id === null || (role !== null && q.role_id === role)))
  )
}

async function sourceCollectionsFor(queueIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (queueIds.length === 0) return out
  const rows = (await db('nivaro_queue_sources')
    .whereIn('queue_id', queueIds)
    .whereNotNull('collection')
    .orderBy('sort')
    .select('queue_id', 'collection')
    .catch(() => [])) as Array<{ queue_id: string; collection: string }>
  for (const r of rows) {
    const k = String(r.queue_id).toUpperCase()
    const list = out.get(k) ?? []
    if (!list.includes(r.collection)) list.push(r.collection)
    out.set(k, list)
  }
  return out
}

/** The 'Queues you may ask about' lines for the system prompt. */
export async function queueCatalogue(user: User): Promise<string[]> {
  const queues = await readableQueues(user)
  const shown = queues.slice(0, QUEUE_CATALOGUE_LIMIT)
  const sources = await sourceCollectionsFor(shown.map((q) => q.id))
  // Names are data typed by whoever owns the queue: one line each, no control
  // characters, capped — they must read as a catalogue entry, never as a rule.
  const clean = (v: unknown, max: number) =>
    String(v ?? '')
      .replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  const lines = shown.map((q) => {
    const cols = (sources.get(String(q.id).toUpperCase()) ?? []).map((c) => clean(c, 60))
    return `- ${q.id}: "${clean(q.name, 80)}"${cols.length ? ` — ${cols.join(', ')}` : ''}`
  })
  if (queues.length > QUEUE_CATALOGUE_LIMIT) lines.push('- … and more; ask by name.')
  return lines
}

export interface QueueRef {
  id?: string
  name?: string
}

/** Exact id, else a case-insensitive name match among readable queues. An
 *  ambiguous name is an error naming the candidates so the model can ask
 *  again with the id. */
export async function resolveQueueRef(user: User, ref: QueueRef): Promise<ReadableQueue> {
  const queues = await readableQueues(user)
  const id = ref.id?.trim()
  if (id) {
    const hit = queues.find((q) => String(q.id).toUpperCase() === id.toUpperCase())
    if (hit) return hit
    throw new Error(
      `No queue "${id}" that you can read — only the queues listed under "Queues you may ask about" can be summarised.`
    )
  }
  const name = ref.name?.trim()
  if (!name) throw new Error('queue_id or queue_name is required')
  const lower = name.toLowerCase()
  const exact = queues.filter((q) => q.name.trim().toLowerCase() === lower)
  const pool = exact.length ? exact : queues.filter((q) => q.name.toLowerCase().includes(lower))
  if (pool.length === 1) return pool[0]
  if (pool.length === 0) {
    throw new Error(
      `No queue named "${name}" that you can read — only the queues listed under "Queues you may ask about" can be summarised.`
    )
  }
  const candidates = pool
    .slice(0, 8)
    .map((q) => `${q.name} (${q.id})`)
    .join('; ')
  throw new Error(`Several queues match "${name}": ${candidates}. Call again with queue_id.`)
}

async function stateLabelsFor(collections: string[]): Promise<Record<string, string>> {
  if (collections.length === 0) return {}
  const rows = (await db('nivaro_workflow_bindings as b')
    .join('nivaro_workflow_states as s', 's.template', 'b.template')
    .whereIn('b.collection', collections)
    .select('s.key', 's.label')
    .catch(() => [])) as Array<{ key: string; label: string }>
  const out: Record<string, string> = {}
  for (const r of rows) if (r.key && r.label && !out[r.key]) out[r.key] = r.label
  return out
}

/** Hours past the SLA for breached rows — one batched status read per
 *  collection over only the rows that will be listed. */
async function hoursOverFor(items: QueueItem[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (items.length === 0) return out
  let computeStatusBatch: typeof import('../routes/sla.js').computeStatusBatch
  try {
    ;({ computeStatusBatch } = await import('../routes/sla.js'))
  } catch {
    return out
  }
  const byCollection = new Map<string, string[]>()
  for (const it of items) {
    const list = byCollection.get(it.collection) ?? []
    list.push(String(it.item_id))
    byCollection.set(it.collection, list)
  }
  for (const [collection, ids] of byCollection) {
    const entries = await computeStatusBatch(collection, ids).catch(
      () => ({}) as Awaited<ReturnType<typeof computeStatusBatch>>
    )
    for (const id of ids) {
      const e = entries[id]
      if (!e || e.duration_hours == null) continue
      const over = e.elapsed_hours - e.duration_hours
      if (over > 0) out[`${collection}:${id}`] = over
    }
  }
  return out
}

async function friendlyIdsFor(items: QueueItem[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (items.length === 0) return out
  let resolveFriendlyIds: typeof import('./workflow-transitions.js').resolveFriendlyIds
  try {
    ;({ resolveFriendlyIds } = await import('./workflow-transitions.js'))
  } catch {
    return out
  }
  const byCollection = new Map<string, string[]>()
  for (const it of items) {
    if (it.collection === 'tasks') continue
    const list = byCollection.get(it.collection) ?? []
    list.push(String(it.item_id))
    byCollection.set(it.collection, list)
  }
  for (const [collection, ids] of byCollection) {
    const map = await resolveFriendlyIds(collection, ids).catch(() => new Map<string, string>())
    for (const [id, friendly] of map) out[`${collection}:${id}`] = friendly
  }
  return out
}

/**
 * The tool body: resolve the queue, read its WHOLE set as the asker (scope
 * 'all', no paging — the kanban's read), then shape. Friendly ids and SLA
 * overruns are resolved only for the records the lists actually name.
 */
export async function summarizeQueue(
  user: User,
  ref: QueueRef,
  opts: { limit?: number } = {}
): Promise<QueueSummary> {
  const queue = await resolveQueueRef(user, ref)
  const sources = (await sourceCollectionsFor([queue.id])).get(String(queue.id).toUpperCase()) ?? []
  const target: QueueSummaryTarget = { id: String(queue.id), name: queue.name, sources }
  const result = await fetchQueueItems(String(queue.id), user, 'all', {})
  const stateLabels = await stateLabelsFor(sources)
  const limit = clampLimit(opts.limit)

  // First pass names the records; the second carries their friendly ids and
  // SLA overruns, which are only worth reading for the listed rows.
  const first = shapeQueueSummary(result.items, result.stats, target, {
    stateLabels,
    listLimit: limit,
    truncated: result.truncated
  })
  const byKey = new Map(result.items.map((it) => [itemKey(it), it]))
  const listed = new Map<string, QueueItem>()
  for (const r of [...first.oldest, ...first.breached, ...first.unowned]) {
    const it = byKey.get(`${r.collection}:${r.id}`)
    if (it) listed.set(itemKey(it), it)
  }
  // Breached rows are ordered by overrun, so every breached row competing for
  // a slot needs its figure — bounded to the oldest few times the limit.
  const breachedPool = result.items
    .filter((it) => it.sla_status === 'breached')
    .sort((a, b) => (b.aging_hours ?? -1) - (a.aging_hours ?? -1))
    .slice(0, limit * 3)
  const [friendlyIds, hoursOver] = await Promise.all([
    friendlyIdsFor([...listed.values(), ...breachedPool]),
    hoursOverFor(breachedPool)
  ])
  return shapeQueueSummary(result.items, result.stats, target, {
    stateLabels,
    friendlyIds,
    hoursOver,
    listLimit: limit,
    truncated: result.truncated
  })
}
