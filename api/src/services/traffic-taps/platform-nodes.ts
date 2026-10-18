// api/src/services/traffic-taps/platform-nodes.ts
/**
 * Back-office figures the Traffic Map draws as nodes and badges, read from the tables that
 * already hold them — no new counters on any request path, so nothing costs anything while
 * nobody watches the map (the page polls GET /traffic-map/platform-nodes only while it is open):
 *
 *   #2157 work queues      staged import queue, extension event outbox, webhook retries and flow
 *                          runs still going — depth, age of the oldest item, drain rate, and
 *                          whether the backlog is growing
 *   #2271 bulk action runs running bulk job runs: records per second, refusals, who started them
 *   #2199 tuning proposals pending database tuning proposals, by the entity they would speed up
 *   #2267 missed runs      the cron miss detector's verdict (services/cron-misses.ts)
 *
 * Each figure is cached MEMO_MS in the tap state (the store, so a tenant never reads another's)
 * and single-flighted, so many open maps cost one read per window. Every read degrades on its
 * own: a missing table or column leaves that part out, never the whole answer.
 */
import { db } from '../../db/index.js'
import { type CronMissReport, currentMissedCrons } from '../cron-misses.js'
import { tapState } from '../traffic-taps.js'

export const PLATFORM_TAP = 'platform-nodes'
/** Cache lifetime of the queue / bulk figures (≥ 10 s by design). */
export const MEMO_MS = 10_000
const TUNING_MEMO_MS = 30_000
const CRON_MEMO_MS = 30_000
const DRAIN_WINDOW_MIN = 15
const RUNNING_STALE_H = 24
const DEPTH_HISTORY = 40

// ── shared helpers ────────────────────────────────────────────────────────────

const iso = (v: unknown): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const ms = (v: unknown): number | null => {
  const t = v ? new Date(v as string | Date).getTime() : Number.NaN
  return Number.isFinite(t) ? t : null
}
const num = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const r1 = (v: number) => Math.round(v * 10) / 10

interface Memo {
  at: number
  value?: unknown
  inflight?: Promise<unknown>
}
const memos = (): Map<string, Memo> => tapState(PLATFORM_TAP, () => new Map<string, Memo>())

/** Cached + single-flight: the same read is shared for `ttl` ms. */
async function memo<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const m = memos()
  const hit = m.get(key)
  if (hit && Date.now() - hit.at < ttl && hit.value !== undefined) return hit.value as T
  if (hit?.inflight) return (await hit.inflight) as T
  const entry: Memo = hit ?? { at: 0 }
  entry.inflight = fn()
    .then((v) => {
      entry.value = v
      entry.at = Date.now()
      return v
    })
    .finally(() => {
      entry.inflight = undefined
    })
  m.set(key, entry)
  return (await entry.inflight) as T
}

/** Run one read; a throw (missing table, permissions) is an absent answer. */
async function soft<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

// ── #2157 work queues ─────────────────────────────────────────────────────────

export type QueueId = 'import' | 'outbox' | 'webhooks' | 'flows'
export type QueueLevel = 'ok' | 'warn' | 'error'
export type QueueTrend = 'growing' | 'draining' | 'flat'

export const QUEUE_LABELS: Record<QueueId, string> = {
  import: 'Staged import queue',
  outbox: 'Event outbox',
  webhooks: 'Webhook retries',
  flows: 'Flow runs in progress'
}
/** Where the page links to for each queue. */
export const QUEUE_LINKS: Record<QueueId, string> = {
  import: '/imports',
  outbox: '/dead-letters',
  webhooks: '/webhooks',
  flows: '/flows'
}

/** What one queue's tables say right now (before the arithmetic). */
export interface QueueRaw {
  depth: number
  /** Epoch ms of the oldest waiting item; null = none waiting. */
  oldest_at: number | null
  /** Items that left the queue (done or failed for good) in the last DRAIN_WINDOW_MIN minutes. */
  finished: number
  /** Waiting items that already failed an attempt and wait to be tried again. */
  retrying?: number
}

export interface QueueFigures {
  id: QueueId
  label: string
  link: string
  depth: number
  oldest_age_s: number | null
  /** Items leaving per minute over the last 15 minutes; null when nothing has left. */
  drain_per_min: number | null
  /** Seconds to empty at the current drain; null when it is not draining or is empty. */
  eta_s: number | null
  retrying: number
  trend: QueueTrend
  level: QueueLevel
  /** Why the level is not ok, in plain words. */
  reason: string | null
}

/** Oldest-item ages that turn a queue amber / red. */
export const QUEUE_AGE = { warn_s: 300, error_s: 1800 }

/**
 * Depth history → is the backlog growing or draining? Compares the newest reading with the
 * oldest one inside the last `spanMs`; a change under max(3, 20%) is flat. Pure.
 */
export function depthTrend(
  history: Array<{ at: number; depth: number }>,
  now = Date.now(),
  spanMs = 600_000
): QueueTrend {
  const recent = history.filter((h) => now - h.at <= spanMs)
  if (recent.length < 2) return 'flat'
  const first = recent[0].depth
  const last = recent[recent.length - 1].depth
  const delta = last - first
  const need = Math.max(3, Math.round(Math.max(first, last) * 0.2))
  if (delta >= need) return 'growing'
  if (-delta >= need) return 'draining'
  return 'flat'
}

/** The arithmetic of one queue: age, drain rate, time to empty, level. Pure. */
export function queueFigures(
  id: QueueId,
  raw: QueueRaw,
  trend: QueueTrend,
  now = Date.now()
): QueueFigures {
  const depth = Math.max(0, Math.round(raw.depth))
  const age =
    depth > 0 && raw.oldest_at != null
      ? Math.max(0, Math.round((now - raw.oldest_at) / 1000))
      : null
  const drain = raw.finished > 0 ? r1(raw.finished / DRAIN_WINDOW_MIN) : null
  const eta = depth > 0 && drain ? Math.round((depth / drain) * 60) : null
  let level: QueueLevel = 'ok'
  let reason: string | null = null
  if (depth > 0) {
    if (age != null && age >= QUEUE_AGE.error_s) {
      level = 'error'
      reason = 'The oldest item has been waiting over 30 minutes'
    } else if (!drain && age != null && age >= QUEUE_AGE.warn_s) {
      level = 'error'
      reason = 'Nothing has left the queue in 15 minutes'
    } else if (age != null && age >= QUEUE_AGE.warn_s) {
      level = 'warn'
      reason = 'The oldest item has been waiting over 5 minutes'
    } else if (trend === 'growing') {
      level = 'warn'
      reason = 'The backlog is growing'
    }
  }
  return {
    id,
    label: QUEUE_LABELS[id],
    link: QUEUE_LINKS[id],
    depth,
    oldest_age_s: age,
    drain_per_min: drain,
    eta_s: eta,
    retrying: raw.retrying ?? 0,
    trend,
    level,
    reason
  }
}

const sinceMin = (min: number) => new Date(Date.now() - min * 60_000)

async function importRaw(): Promise<QueueRaw | undefined> {
  return soft(async () => {
    const [waiting, done] = await Promise.all([
      db('nivaro_import_queue')
        .where('status', 'queued')
        .count({ n: '*' })
        .min({ oldest: 'created_at' })
        .first(),
      db('nivaro_import_queue')
        .whereIn('status', ['completed', 'error', 'canceled'])
        .where('finished_at', '>=', sinceMin(DRAIN_WINDOW_MIN))
        .count({ n: '*' })
        .first()
    ])
    return {
      depth: num((waiting as { n?: unknown })?.n),
      oldest_at: ms((waiting as { oldest?: unknown })?.oldest),
      finished: num((done as { n?: unknown })?.n)
    }
  })
}

async function outboxRaw(): Promise<QueueRaw | undefined> {
  return soft(async () => {
    const [waiting, retrying, done] = await Promise.all([
      db('nivaro_outbox')
        .where('status', 'pending')
        .count({ n: '*' })
        .min({ oldest: 'created_at' })
        .first(),
      db('nivaro_outbox')
        .where('status', 'pending')
        .where('attempts', '>', 0)
        .count({ n: '*' })
        .first(),
      db('nivaro_outbox')
        .where('status', 'delivered')
        .where('delivered_at', '>=', sinceMin(DRAIN_WINDOW_MIN))
        .count({ n: '*' })
        .first()
    ])
    return {
      depth: num((waiting as { n?: unknown })?.n),
      oldest_at: ms((waiting as { oldest?: unknown })?.oldest),
      finished: num((done as { n?: unknown })?.n),
      retrying: num((retrying as { n?: unknown })?.n)
    }
  })
}

async function webhooksRaw(): Promise<QueueRaw | undefined> {
  return soft(async () => {
    // Failed deliveries of the last day whose webhook has not delivered successfully since —
    // the same set the dead letter node lists, counted not listed.
    const [waiting, done] = await Promise.all([
      db('nivaro_webhook_deliveries as d')
        .where('d.success', false)
        .where('d.created_at', '>=', new Date(Date.now() - 24 * 3600_000))
        .whereNotExists(
          db('nivaro_webhook_deliveries as s')
            .whereRaw('s.webhook = d.webhook')
            .where('s.success', true)
            .whereRaw('s.id > d.id')
            .select(db.raw('1'))
        )
        .count({ n: '*' })
        .min({ oldest: 'd.created_at' })
        .first(),
      // a retry (attempt 2+) that went through
      db('nivaro_webhook_deliveries')
        .where('success', true)
        .where('attempt', '>', 1)
        .where('created_at', '>=', sinceMin(DRAIN_WINDOW_MIN))
        .count({ n: '*' })
        .first()
    ])
    return {
      depth: num((waiting as { n?: unknown })?.n),
      oldest_at: ms((waiting as { oldest?: unknown })?.oldest),
      finished: num((done as { n?: unknown })?.n)
    }
  })
}

async function flowsRaw(): Promise<QueueRaw | undefined> {
  return soft(async () => {
    const [running, done] = await Promise.all([
      db('nivaro_flow_runs')
        .where('status', 'running')
        .where('started_at', '>=', new Date(Date.now() - RUNNING_STALE_H * 3600_000))
        .count({ n: '*' })
        .min({ oldest: 'started_at' })
        .first(),
      db('nivaro_flow_runs')
        .whereNot('status', 'running')
        .where('completed_at', '>=', sinceMin(DRAIN_WINDOW_MIN))
        .count({ n: '*' })
        .first()
    ])
    return {
      depth: num((running as { n?: unknown })?.n),
      oldest_at: ms((running as { oldest?: unknown })?.oldest),
      finished: num((done as { n?: unknown })?.n)
    }
  })
}

const QUEUE_READS: Record<QueueId, () => Promise<QueueRaw | undefined>> = {
  import: importRaw,
  outbox: outboxRaw,
  webhooks: webhooksRaw,
  flows: flowsRaw
}

/** Depth readings per queue (this store), for the growing / draining verdict. */
const depthHistory = (): Map<QueueId, Array<{ at: number; depth: number }>> =>
  tapState(`${PLATFORM_TAP}:depth`, () => new Map())

export async function workQueues(): Promise<QueueFigures[]> {
  return memo('queues', MEMO_MS, async () => {
    const now = Date.now()
    const ids = Object.keys(QUEUE_READS) as QueueId[]
    const raws = await Promise.all(ids.map((id) => QUEUE_READS[id]()))
    const hist = depthHistory()
    const out: QueueFigures[] = []
    ids.forEach((id, i) => {
      const raw = raws[i]
      if (!raw) return // the table is not there
      const list = hist.get(id) ?? []
      list.push({ at: now, depth: raw.depth })
      while (list.length > DEPTH_HISTORY) list.shift()
      hist.set(id, list)
      out.push(queueFigures(id, raw, depthTrend(list, now), now))
    })
    return out
  })
}

/** Is a queue worth a node on the map? Something waiting, or it moved work in the last 15 min. */
export function queueVisible(q: Pick<QueueFigures, 'depth' | 'drain_per_min'>): boolean {
  return q.depth > 0 || (q.drain_per_min ?? 0) > 0
}

// ── #2271 bulk action runs ────────────────────────────────────────────────────

export interface BulkRun {
  id: number
  /** `bulk:<collection>` / `import-revert:<run>` — the job id. */
  job: string
  /** What the run is doing, in a few words. */
  label: string
  collection: string | null
  started_at: string
  /** Name (or email) of who started it; null = started by the system. */
  by: string | null
  done: number
  failed: number
  total: number | null
  per_s: number | null
  /** Share done (0–100) when the total is known. */
  pct: number | null
}

/** One running job-run row → the node's figures. Pure. */
export function bulkRunFigures(
  row: {
    id: unknown
    job_id: unknown
    label?: unknown
    started_at: unknown
    progress?: unknown
    first_name?: unknown
    last_name?: unknown
    email?: unknown
  },
  now = Date.now()
): BulkRun {
  let p: Record<string, unknown> = {}
  if (row.progress) {
    try {
      const parsed = typeof row.progress === 'string' ? JSON.parse(row.progress) : row.progress
      if (parsed && typeof parsed === 'object') p = parsed as Record<string, unknown>
    } catch {
      p = {}
    }
  }
  const started = ms(row.started_at) ?? now
  const done = num(p.done ?? p.processed ?? p.ok)
  const failed = num(p.failed ?? p.refused)
  const total = p.total != null && num(p.total) > 0 ? num(p.total) : null
  const elapsed = Math.max(0, (now - started) / 1000)
  const job = String(row.job_id ?? '')
  const collection = job.startsWith('bulk:') ? job.slice(5) : null
  const name = [row.first_name, row.last_name]
    .filter((x) => typeof x === 'string' && x.trim())
    .join(' ')
    .trim()
  return {
    id: num(row.id),
    job,
    label: String(row.label ?? job).slice(0, 120),
    collection,
    started_at: iso(row.started_at) ?? new Date(started).toISOString(),
    by: name || (typeof row.email === 'string' && row.email ? row.email : null),
    done,
    failed,
    total,
    per_s: elapsed >= 1 && done + failed > 0 ? r1((done + failed) / elapsed) : null,
    pct: total ? Math.min(100, Math.round(((done + failed) / total) * 100)) : null
  }
}

export async function bulkRuns(): Promise<BulkRun[]> {
  return memo('bulk', MEMO_MS, async () => {
    const rows = await soft(async () =>
      db('nivaro_job_runs as r')
        .leftJoin('nivaro_users as u', 'u.id', 'r.triggered_by')
        .where('r.kind', 'bulk')
        .where('r.status', 'running')
        .where('r.started_at', '>=', new Date(Date.now() - RUNNING_STALE_H * 3600_000))
        .orderBy('r.id', 'desc')
        .limit(12)
        .select(
          'r.id',
          'r.job_id',
          'r.label',
          'r.started_at',
          'r.progress',
          'u.first_name',
          'u.last_name',
          'u.email'
        )
    )
    const now = Date.now()
    return ((rows ?? []) as Array<Record<string, unknown>>).map((r) =>
      bulkRunFigures(r as Parameters<typeof bulkRunFigures>[0], now)
    )
  })
}

// ── #2199 tuning proposals on nodes ───────────────────────────────────────────

export interface TuningProposalLite {
  id: string
  kind: string
  target: string
  title: string
  saving_ms_per_day: number
  risk: string
  /** `<lane>/<entity>` of the collection or query it would speed up; null = none (a procedure). */
  entity: string | null
  /** The physical table it concerns (index and rollup proposals), for statement shapes. */
  table: string | null
}
export interface TuningFigures {
  total: number
  saving_ms_per_day: number
  proposals: TuningProposalLite[]
  /** Entity key → what is pending for it. */
  by_entity: Record<string, { count: number; saving_ms_per_day: number; id: string }>
}

const SYSTEM_TABLE = /^(nivaro_|directus_|sys)/

/** The map entity and table a proposal's target names. Pure. */
export function tuningTarget(
  kind: string,
  target: string
): { entity: string | null; table: string | null } {
  const t = String(target ?? '')
  if (kind === 'query_cache') return { entity: t ? `queries/${t}` : null, table: null }
  if (kind === 'proc_rewrite') return { entity: null, table: null }
  // index_create / index_drop → `table.column|index`; rollup_store → `collection.field`
  const table = t.split('.')[0]
  if (!table) return { entity: null, table: null }
  return { entity: `${SYSTEM_TABLE.test(table) ? 'system' : 'items'}/${table}`, table }
}

/** Pending proposals folded per entity (best saving first). Pure. */
export function tuningFigures(
  rows: Array<{
    id: unknown
    kind: unknown
    target: unknown
    title?: unknown
    estimate_ms_per_day?: unknown
    risk?: unknown
  }>
): TuningFigures {
  const proposals: TuningProposalLite[] = rows.map((r) => {
    const where = tuningTarget(String(r.kind), String(r.target))
    return {
      id: String(r.id),
      kind: String(r.kind),
      target: String(r.target).slice(0, 200),
      title: String(r.title ?? '').slice(0, 200),
      saving_ms_per_day: num(r.estimate_ms_per_day),
      risk: String(r.risk ?? 'reversible'),
      ...where
    }
  })
  proposals.sort((a, b) => b.saving_ms_per_day - a.saving_ms_per_day)
  const by_entity: TuningFigures['by_entity'] = {}
  for (const p of proposals) {
    if (!p.entity) continue
    const e = by_entity[p.entity]
    if (e) {
      e.count++
      e.saving_ms_per_day += p.saving_ms_per_day
    } else by_entity[p.entity] = { count: 1, saving_ms_per_day: p.saving_ms_per_day, id: p.id }
  }
  return {
    total: proposals.length,
    saving_ms_per_day: proposals.reduce((a, p) => a + p.saving_ms_per_day, 0),
    proposals: proposals.slice(0, 100),
    by_entity
  }
}

export async function tuningProposals(): Promise<TuningFigures | undefined> {
  return memo('tuning', TUNING_MEMO_MS, async () => {
    const rows = await soft(async () =>
      db('nivaro_tuning_proposals')
        .where('status', 'proposed')
        .orderBy('estimate_ms_per_day', 'desc')
        .limit(200)
        .select('id', 'kind', 'target', 'title', 'estimate_ms_per_day', 'risk')
    )
    return rows ? tuningFigures(rows as Array<Record<string, unknown>> as never) : undefined
  })
}

// ── #2267 missed runs ─────────────────────────────────────────────────────────

export async function cronMisses(): Promise<CronMissReport | undefined> {
  return memo('cron', CRON_MEMO_MS, async () => soft(() => currentMissedCrons()))
}

// ── the one route payload ─────────────────────────────────────────────────────

export interface PlatformNodes {
  at: number
  work_queues: QueueFigures[]
  bulk_runs: BulkRun[]
  tuning: TuningFigures | null
  cron_misses: CronMissReport | null
}

export async function platformNodes(): Promise<PlatformNodes> {
  const [work_queues, bulk_runs, tuning, cron_misses] = await Promise.all([
    soft(workQueues),
    soft(bulkRuns),
    soft(tuningProposals),
    soft(cronMisses)
  ])
  return {
    at: Date.now(),
    work_queues: work_queues ?? [],
    bulk_runs: bulk_runs ?? [],
    tuning: tuning ?? null,
    cron_misses: cron_misses ?? null
  }
}
