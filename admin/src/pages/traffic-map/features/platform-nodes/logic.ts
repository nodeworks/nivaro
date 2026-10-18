// Traffic Map platform nodes — the figures the server returns and the pure helpers the panels,
// badges and nodes share (tested in platform-nodes.test.ts).

// ── GET /traffic-map/platform-nodes ───────────────────────────────────────────
export type QueueId = 'import' | 'outbox' | 'webhooks' | 'flows'
export type Level = 'ok' | 'warn' | 'error'

export interface QueueFigures {
  id: QueueId
  label: string
  link: string
  depth: number
  oldest_age_s: number | null
  drain_per_min: number | null
  eta_s: number | null
  retrying: number
  trend: 'growing' | 'draining' | 'flat'
  level: Level
  reason: string | null
}
export interface BulkRun {
  id: number
  job: string
  label: string
  collection: string | null
  started_at: string
  by: string | null
  done: number
  failed: number
  total: number | null
  per_s: number | null
  pct: number | null
}
export interface TuningProposalLite {
  id: string
  kind: string
  target: string
  title: string
  saving_ms_per_day: number
  risk: string
  entity: string | null
  table: string | null
}
export interface TuningFigures {
  total: number
  saving_ms_per_day: number
  proposals: TuningProposalLite[]
  by_entity: Record<string, { count: number; saving_ms_per_day: number; id: string }>
}
export interface MissedCron {
  id: string
  expected_at: string
  last_run_at: string | null
  grace_min: number
}
export interface CronMissReport {
  ticking: boolean
  ready: boolean
  misses: MissedCron[]
}
export interface PlatformNodes {
  at: number
  work_queues: QueueFigures[]
  bulk_runs: BulkRun[]
  tuning: TuningFigures | null
  cron_misses: CronMissReport | null
}

// ── GET /traffic-map/db-lens/server (and the `db-server` tap) ─────────────────
export interface DbServerSample {
  at: number
  available: boolean
  error?: string
  cpu: { sql_pct: number; other_pct: number; series: number[] } | null
  waits: Record<'data_io' | 'log_io' | 'other_io' | 'locks' | 'signal' | 'total', number> | null
  memory: {
    grants_held: number
    grants_waiting: number
    granted_mb: number
    requested_mb: number
    max_wait_ms: number
    sql_used_mb: number | null
    machine_total_mb: number | null
    machine_free_mb: number | null
  } | null
  tempdb: {
    total_mb: number
    user_mb: number
    internal_mb: number
    version_mb: number
    free_mb: number
    used_pct: number
  } | null
  level: Level
  reasons: string[]
}

// ── the `storage` tap snapshot ────────────────────────────────────────────────
export type StorageOp = 'read' | 'write' | 'delete' | 'check' | 'list'
export interface StorageOpFigures {
  n: number
  failed: number
  missing: number
  slow: number
  bytes: number
  p50_ms: number
  p95_ms: number
}
export interface StorageDriverFigures {
  label: string
  ops: Partial<Record<StorageOp, StorageOpFigures>>
  max_ms: number
  last_failure: { at: number; op: StorageOp; reason: string } | null
}
export interface StorageSnapshot {
  slow_ms: number
  drivers: Record<string, StorageDriverFigures>
}

// ── GET /traffic-map/health → heap ────────────────────────────────────────────
export interface HeapTrend {
  points: number
  span_s: number
  slope_mb_per_min: number
  r2: number
  growing: boolean
  minutes_to_limit: number | null
}
export interface HeapSummary {
  after_gc_mb: number | null
  used_mb: number
  rss_mb: number
  limit_mb: number | null
  series: number[]
  trend: HeapTrend
}

// ── node ids ──────────────────────────────────────────────────────────────────
export const QUEUE_PREFIX = 'queue:'
export const BULK_PREFIX = 'bulk:'
export const STORAGE_PREFIX = 'storage:'
export const queueNodeId = (id: QueueId): string => `${QUEUE_PREFIX}${id}`
export const bulkNodeId = (id: number): string => `${BULK_PREFIX}${id}`
export const isQueueNode = (id: string): boolean => id.startsWith(QUEUE_PREFIX)
export const isBulkNode = (id: string): boolean => id.startsWith(BULK_PREFIX)
export const isStorageNode = (id: string): boolean => id.startsWith(STORAGE_PREFIX)

/** The queue behind a `queue:<id>` node id. */
export function queueOf(d: PlatformNodes | null, nodeId: string): QueueFigures | null {
  if (!isQueueNode(nodeId)) return null
  return d?.work_queues.find((q) => q.id === nodeId.slice(QUEUE_PREFIX.length)) ?? null
}
/** The run behind a `bulk:<runId>` node id. */
export function bulkOf(d: PlatformNodes | null, nodeId: string): BulkRun | null {
  if (!isBulkNode(nodeId)) return null
  const id = Number(nodeId.slice(BULK_PREFIX.length))
  return d?.bulk_runs.find((r) => r.id === id) ?? null
}

/** A queue is drawn as a node when something waits or it moved work lately. */
export function queueVisible(q: QueueFigures): boolean {
  return q.depth > 0 || (q.drain_per_min ?? 0) > 0
}
/** Node ids to draw: visible queues, then running bulk actions. */
export function platformDownIds(d: PlatformNodes | null): string[] {
  if (!d) return []
  return [
    ...d.work_queues.filter(queueVisible).map((q) => queueNodeId(q.id)),
    ...d.bulk_runs.map((r) => bulkNodeId(r.id))
  ]
}

// ── wording ───────────────────────────────────────────────────────────────────
/** "40 s", "12 min", "3 h 05 min", "2 d". */
export function fmtAge(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—'
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86_400) {
    const h = Math.floor(s / 3600)
    return `${h} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`
  }
  return `${Math.round(s / 86_400)} d`
}

export function fmtRate(n: number | null | undefined, unit: string): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 100 ? Math.round(n) : n}/${unit}`
}

/** Saved milliseconds per day as "about 2.4 min a day". */
export function fmtSaving(msPerDay: number): string {
  if (!Number.isFinite(msPerDay) || msPerDay <= 0) return 'a small saving'
  const s = msPerDay / 1000
  if (s < 90) return `about ${Math.max(1, Math.round(s))} s a day`
  if (s < 5400) return `about ${(s / 60).toFixed(s < 600 ? 1 : 0)} min a day`
  return `about ${(s / 3600).toFixed(1)} h a day`
}

/** The text of a queue node's badge. */
export function queueBadgeText(q: QueueFigures): string {
  if (q.depth === 0) return 'drained'
  const base = `${q.depth.toLocaleString()} waiting`
  if (q.trend === 'growing') return `${base} · growing`
  if (q.oldest_age_s != null && q.oldest_age_s >= 60) return `${base} · ${fmtAge(q.oldest_age_s)}`
  return base
}
export function queueTone(level: Level): 'warn' | 'error' | 'info' {
  return level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
}

/** Memory warning: "Growing 2.1 MB/min — about 3 h to the limit". Null when steady. */
export function heapWarning(t: HeapTrend | null | undefined): string | null {
  if (!t?.growing) return null
  const rate = `${t.slope_mb_per_min} MB/min`
  const left =
    t.minutes_to_limit != null
      ? ` — about ${t.minutes_to_limit >= 120 ? `${Math.round(t.minutes_to_limit / 60)} h` : `${t.minutes_to_limit} min`} to the limit`
      : ''
  return `Growing ${rate}${left}`
}

/** `cron:<job>` → the job id the miss detector names. */
export function cronJobOf(nodeId: string): string | null {
  return nodeId.startsWith('cron:') ? nodeId.slice(5) : null
}
/** The detector's miss for a job node, when it raised one. */
export function missFor(d: PlatformNodes | null, nodeId: string): MissedCron | null {
  const job = cronJobOf(nodeId)
  if (!job || !d?.cron_misses?.ticking) return null
  return d.cron_misses.misses.find((m) => m.id === job) ?? null
}

/** Pending proposals for an entity node (`items/<collection>`, `queries/<slug>`). */
export function tuningFor(d: PlatformNodes | null, entityKey: string) {
  return d?.tuning?.by_entity[entityKey] ?? null
}
/** Pending proposals that concern one of these tables (the statement shape's tables). */
export function tuningForTables(d: PlatformNodes | null, tables: string[]): TuningProposalLite[] {
  if (!d?.tuning || !tables.length) return []
  const set = new Set(
    tables.map((t) =>
      t
        .replace(/^\[?dbo\]?\./i, '')
        .replace(/[[\]]/g, '')
        .toLowerCase()
    )
  )
  return d.tuning.proposals.filter((p) => p.table && set.has(p.table.toLowerCase()))
}

/** The overall level of a storage driver for its node badge (mirrors the server's rule). */
export function storageLevel(d: Pick<StorageDriverFigures, 'ops'>): Level {
  let failed = 0
  let slow = 0
  let n = 0
  for (const o of Object.values(d.ops)) {
    if (!o) continue
    failed += o.failed
    slow += o.slow
    n += o.n
  }
  if (failed > 0) return 'error'
  return n > 0 && slow / n >= 0.1 ? 'warn' : 'ok'
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

export function fmtMb(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Is a staged import slower only because its file is bigger? Compares rows per second of the
 *  run against the median of the earlier ones; < 0 means slower. Pure. */
export function importSizeVerdict(
  runs: Array<{ bytes: number | null; rows: number | null; seconds: number | null }>
): { text: string; bigger: boolean } | null {
  const [cur, ...rest] = runs
  if (!cur?.bytes || !cur.seconds) return null
  const prev = rest.filter((r) => r.bytes && r.seconds)
  if (prev.length < 2) return null
  const rate = (r: { bytes: number | null; seconds: number | null }) =>
    (r.bytes as number) / (r.seconds as number)
  const sorted = prev.map(rate).sort((a, b) => a - b)
  const medianRate = sorted[Math.floor(sorted.length / 2)]
  const sizes = prev.map((r) => r.bytes as number).sort((a, b) => a - b)
  const medianSize = sizes[Math.floor(sizes.length / 2)]
  const sizeRatio = cur.bytes / medianSize
  const rateRatio = rate(cur) / medianRate
  if (sizeRatio >= 1.5 && rateRatio >= 0.7)
    return {
      text: `The file is ${sizeRatio.toFixed(1)}x the usual size, and it loaded at about the usual speed — a bigger file, not a slower import.`,
      bigger: true
    }
  if (rateRatio < 0.7)
    return {
      text: `Loaded at ${Math.round(rateRatio * 100)}% of the usual speed for its size — slower than the file explains.`,
      bigger: false
    }
  return null
}
