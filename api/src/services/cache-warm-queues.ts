/**
 * Cache warm, queue phase: the first page of the most-used queue worklists.
 *
 * Staging 0.2.70, efp-new home dashboard right after a deploy: the three
 * GET /api/queues/:id/items calls took 5.1–5.4 s cold and 0.67–1.4 s warm.
 * A live queue read resolves every matched record (ids, instances, SLA,
 * owners, labels, extra columns) before it pages in memory, so the cold cost
 * is the SQL Server buffer pool + plan cache behind those statements plus a
 * few per-process caches (predictive-SLA percentiles, owner groups, metadata).
 *
 * NOTHING IS STORED. There is no queue result cache: a warm run computes the
 * worklist and drops it. What it leaves behind is what the viewer's own
 * request would leave — pages in the buffer pool, plans in the plan cache,
 * and the in-process caches the read path fills under their OWN keys (owner
 * groups by state, collection metadata by table, percentiles by state). So no
 * entry can be computed as one person and served to another: nothing the warm
 * computes is ever served.
 *
 * READ-ONLY. fetchQueueItems can write once: a live read matching more than
 * PROMOTION_THRESHOLD rows enqueues the materialization backfill. The warm
 * passes `readOnly: true`, which skips exactly that (the rows are identical;
 * the viewer's own first read still promotes, as before). The route's other
 * side effects are not on this path: the warm calls the service, never the
 * HTTP route, so no nivaro_api_logs row (which would feed the next warm's
 * ranking), no last_access touch, no empty-queue explanation. Claims, labels,
 * unseen marks and SLA are reads.
 *
 * WHO + WHAT. GET /api/queues/:id/items requests of the last 7 days
 * (nivaro_api_logs path + query + user, development instances excluded),
 * FIRST PAGES only (no page, or page=1), active accounts only. People are
 * grouped per queue by ACCESS SIGNATURE — administrator, else role + the
 * restrict-mode User Scopes (cache-warm-viewers scopeSignature) — because a live read's cost is
 * the viewer's access (can() per role, the role's row filter, their scopes),
 * not their scope tab, sort or filters (applied in memory after the resolve).
 * One run per (queue, signature): that group's most-used request shape,
 * replayed through the route's own parser (parseQueueItemsQuery), AS the
 * group member who sent it most — after the route's own queue gate
 * (canUserReadQueue). Most-used first, capped, inside the warm's budget.
 *
 * HOW. Each source read takes its own heavy-read slot (the request path's
 * per-source gate), counted against 'cache-warm', never the viewer's share;
 * runs are serial. The budget aborts any slot wait still pending; a running
 * statement ends on its own request timeout.
 */
import { CACHE_WARM_MAX_VIEWERS, type WarmViewer } from './cache-warm-viewers.js'
import type { ParsedQueueItemsQuery } from './queues.js'

/** (queue, signature) runs per warm. */
export const CACHE_WARM_MAX_QUEUE_RUNS = 12
/** One run's share of the budget at most. */
export const CACHE_WARM_QUEUE_RUN_MS = 60_000
const MASKED = '••••••'
const ITEMS_PATH = /^\/api\/queues\/([0-9a-fA-F-]{36})\/items$/

export interface QueueUsageLogRow {
  path: string
  query: string | null
  user: string | null
  n: number | string
}

export interface QueueUsageRow {
  queueId: string
  /** The request's query string, as logged ('' = none). */
  query: string
  user: string
  n: number
}

export interface QueueWarmTarget {
  queueId: string
  query: string
  parsed: ParsedQueueItemsQuery
  as: WarmViewer
  signature: string
  /** First-page requests by the group in the window — the order. */
  hits: number
  /** People in the group. */
  members: number
}

export interface QueueWarmSummary {
  targets: number
  warmed: number
  skipped: number
  failed: number
  signatures: number
  budgetSpent: boolean
}

export interface QueuePhaseDeps {
  /** First-page usage per person; null when the log could not be read. */
  loadUsage: (since: Date) => Promise<QueueUsageRow[] | null>
  /** Active accounts only, with role, admin flag and scope signature. */
  loadViewers: (ids: string[]) => Promise<WarmViewer[]>
  /** Run one target; 'skipped' when the person or queue is gone or not readable. */
  run: (t: QueueWarmTarget, signal: AbortSignal) => Promise<'ok' | 'skipped'>
}

/** Usage rows for GET /api/queues/:id/items (anonymous rows dropped). */
export function queueUsageFromLog(rows: QueueUsageLogRow[]): QueueUsageRow[] {
  const out: QueueUsageRow[] = []
  for (const r of rows) {
    if (!r.user) continue
    const m = ITEMS_PATH.exec(r.path)
    if (!m) continue
    out.push({
      queueId: m[1].toUpperCase(),
      query: r.query ?? '',
      user: String(r.user),
      n: Number(r.n) || 0
    })
  }
  return out
}

/** A logged query string → the route's parsed options, or null (not a first page / unusable). */
export function firstPageRequest(
  query: string,
  parse: (q: Record<string, string>) => ParsedQueueItemsQuery | null
): ParsedQueueItemsQuery | null {
  if (query.includes(MASKED) || query.includes(encodeURIComponent(MASKED))) return null
  const params = new URLSearchParams(query)
  const q: Record<string, string> = {}
  // The route reads the first value of a repeated key (Fastify's querystring
  // keeps arrays; a repeated key is not a shape any client sends).
  for (const [k, v] of params) {
    if (k in q) return null
    q[k] = v
  }
  if (q.page !== undefined && q.page !== '1') return null
  return parse(q)
}

/** Access signature for a queue read: admin, else role + restrict scopes. */
export function queueAccessSignature(v: WarmViewer): string {
  if (v.isAdmin) return 'admin'
  return `role:${String(v.role ?? '').toLowerCase()}|${v.signature}`
}

/**
 * One target per (queue, access signature), most-used first: the group's
 * most-used first-page shape, as the member who sent that shape most.
 */
export function pickQueueWarmTargets(input: {
  usage: QueueUsageRow[]
  viewers: WarmViewer[]
  parse: (q: Record<string, string>) => ParsedQueueItemsQuery | null
  cap?: number
}): QueueWarmTarget[] {
  const cap = input.cap ?? CACHE_WARM_MAX_QUEUE_RUNS
  const byId = new Map(input.viewers.map((v) => [v.id.toLowerCase(), v]))
  const parsedByQuery = new Map<string, ParsedQueueItemsQuery | null>()
  interface Group {
    queueId: string
    signature: string
    hits: number
    people: Set<string>
    shapes: Map<string, { n: number; byUser: Map<string, number> }>
  }
  const groups = new Map<string, Group>()
  for (const u of input.usage) {
    const viewer = byId.get(u.user.toLowerCase())
    if (!viewer || u.n <= 0) continue
    if (!parsedByQuery.has(u.query)) {
      parsedByQuery.set(u.query, firstPageRequest(u.query, input.parse))
    }
    if (!parsedByQuery.get(u.query)) continue
    const signature = queueAccessSignature(viewer)
    const key = `${u.queueId}|${signature}`
    const g = groups.get(key) ?? {
      queueId: u.queueId,
      signature,
      hits: 0,
      people: new Set<string>(),
      shapes: new Map()
    }
    g.hits += u.n
    g.people.add(viewer.id)
    const shape = g.shapes.get(u.query) ?? { n: 0, byUser: new Map<string, number>() }
    shape.n += u.n
    shape.byUser.set(viewer.id, (shape.byUser.get(viewer.id) ?? 0) + u.n)
    g.shapes.set(u.query, shape)
    groups.set(key, g)
  }
  const ranked = [...groups.values()].sort(
    (a, b) =>
      b.hits - a.hits ||
      a.queueId.localeCompare(b.queueId) ||
      a.signature.localeCompare(b.signature)
  )
  const out: QueueWarmTarget[] = []
  for (const g of ranked.slice(0, cap)) {
    const [query, shape] = [...g.shapes].sort(
      (a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])
    )[0]
    const [userId] = [...shape.byUser].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    const as = byId.get(userId.toLowerCase())
    const parsed = parsedByQuery.get(query)
    if (!as || !parsed) continue
    out.push({
      queueId: g.queueId,
      query,
      parsed,
      as,
      signature: g.signature,
      hits: g.hits,
      members: g.people.size
    })
  }
  return out
}

/** Run the picked targets one at a time inside the deadline. Never throws. */
export async function runQueueTargets(
  targets: QueueWarmTarget[],
  opts: {
    deadline: number
    now: () => number
    run: QueuePhaseDeps['run']
    runMs?: number
  }
): Promise<QueueWarmSummary> {
  const summary: QueueWarmSummary = {
    targets: targets.length,
    warmed: 0,
    skipped: 0,
    failed: 0,
    signatures: new Set(targets.map((t) => t.signature)).size,
    budgetSpent: false
  }
  for (const t of targets) {
    const remaining = opts.deadline - opts.now()
    if (remaining <= 0) {
      summary.budgetSpent = true
      summary.skipped++
      continue
    }
    const ac = new AbortController()
    const timer = setTimeout(
      () => ac.abort(),
      Math.max(1, Math.min(opts.runMs ?? CACHE_WARM_QUEUE_RUN_MS, remaining))
    )
    timer.unref?.()
    try {
      const r = await opts.run(t, ac.signal)
      if (r === 'ok') summary.warmed++
      else summary.skipped++
    } catch {
      summary.failed++
      if (opts.now() >= opts.deadline) summary.budgetSpent = true
    } finally {
      clearTimeout(timer)
    }
  }
  return summary
}

/** What the queue phase would run. Never throws: an unreadable log = nothing. */
export async function selectQueueTargets(
  deps: Pick<QueuePhaseDeps, 'loadUsage' | 'loadViewers'>,
  since: Date,
  /** The route's parser — loaded only when there is usage (queues.js is a big graph). */
  loadParser: () => Promise<(q: Record<string, string>) => ParsedQueueItemsQuery | null>
): Promise<QueueWarmTarget[]> {
  const usage = await deps.loadUsage(since).catch(() => null)
  if (!usage?.length) return []
  const parse = await loadParser()
  // Most active people first, capped like the viewer phase.
  const perUser = new Map<string, number>()
  for (const u of usage) perUser.set(u.user, (perUser.get(u.user) ?? 0) + u.n)
  const users = [...perUser]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CACHE_WARM_MAX_VIEWERS)
    .map(([id]) => id)
  const viewers = await deps.loadViewers(users).catch(() => [] as WarmViewer[])
  return pickQueueWarmTargets({ usage, viewers, parse })
}

/**
 * The per-process caches a queue read pays for cold, on EVERY process
 * (warmMetadata — the replay above runs on one replica only): each source
 * collection's metadata (collection, fields, relations, physical columns —
 * 30 s caches, so this spares the first reads after a boot) and the
 * predictive-SLA percentiles (one aggregate over the whole workflow history,
 * ~3 s, kept 10 minutes stale-while-revalidate; only a cold process waits).
 * Owner groups have their own boot phase (#481). All reads.
 */
export async function warmQueueReadCaches(): Promise<number> {
  const { db } = await import('../db/index.js')
  const { getCollection, getFields, getPhysicalColumns, getRelations } = await import(
    './collections.js'
  )
  const rows = (await db('nivaro_queue_sources as s')
    .join('nivaro_queues as q', 'q.id', 's.queue_id')
    .whereNotNull('s.collection')
    .whereIn('s.type', ['collection', 'addendums'])
    .select('s.collection')) as Array<{ collection: string }>
  const collections = [...new Set(rows.map((r) => String(r.collection)))]
  for (const c of collections) {
    await Promise.all([
      getCollection(c).catch(() => null),
      getFields(c).catch(() => null),
      getRelations(c).catch(() => null),
      getPhysicalColumns(c).catch(() => null)
    ])
  }
  const { withReadGate } = await import('./read-gate.js')
  const { getStateDurationStats } = await import('./predictive-sla.js')
  await withReadGate('cache-warm', () => getStateDurationStats(), {
    label: 'cache-warm:predictive-sla'
  }).catch(() => null)
  return collections.length
}
