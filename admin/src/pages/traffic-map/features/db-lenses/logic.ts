/**
 * Pure helpers for the database lenses (#1169 #1170 #1171 #1174 #1176). No React, no fetches —
 * the components and canvas layers call these, and the unit tests pin them.
 */
import type { SparkMarker } from '../../registry/sparkMarkers'

export const NEAR_TIMEOUT_TAP = 'near-timeout'
export const DB_BLOCKING_TAP = 'db-blocking'
export const DB_TIME_TAP = 'db-time'
export const METADATA_CACHE_TAP = 'metadata-cache'

// ── #1169 near timeout ───────────────────────────────────────────────────────
export interface Budgets {
  db_ms: number
  proxy_ms: number
  near_share: number
}
export interface NearTimeoutRecent {
  at: string
  route: string
  caller: string
  ms: number
  stmt_ms: number
  budget: 'db' | 'proxy'
  used_pct: number
  over: boolean
  sql: string | null
}
export interface NearTimeoutEntity {
  n: number
  over: number
  near_db: number
  over_db: number
  near_proxy: number
  over_proxy: number
  worst_pct: number
  recent: NearTimeoutRecent[]
  budgets?: Budgets
}

/** The badge an entity earns: past a budget = error, near = warn; null when neither. */
export function nearTimeoutBadge(
  n: number,
  over: number
): { text: string; tone: 'warn' | 'error' } | null {
  if (over > 0) return { text: `${over} timed out`, tone: 'error' }
  if (n > 0) return { text: `${n} near timeout`, tone: 'warn' }
  return null
}

/** "12.4 s of 15 s (83%)" for one recent request's headline budget. */
export function budgetLine(r: NearTimeoutRecent, b: Budgets): string {
  const of = r.budget === 'db' ? b.db_ms : b.proxy_ms
  const used = r.budget === 'db' ? r.stmt_ms : r.ms
  const what = r.budget === 'db' ? 'longest statement' : 'whole request'
  return `${what} ${secs(used)} of ${secs(of)} (${r.used_pct}%)`
}

export function secs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`
}

// ── #1170 blocking chains ────────────────────────────────────────────────────
export interface Party {
  session: number
  kind: 'request' | 'background' | 'outside'
  entity: string | null
  label: string
  caller: string | null
  sql: string | null
  idle: boolean
}
export interface BlockingChain {
  waiter: Party
  blocker: Party
  head: Party
  wait_ms: number
  wait_type: string | null
}
export interface BlockingSample {
  at: number
  available: boolean
  error?: string
  blocked: number
  chains: BlockingChain[]
}

/** One drawn edge: from the waiting entity (or the database node) to the one holding it up. */
export interface BlockEdge {
  from: string
  /** An entity key, or `db` when the blocker is not a request on the map. */
  to: string
  wait_ms: number
  /** Short label for the edge ("waits 4.2 s on SSMS"). */
  label: string
}

/**
 * Edges for the canvas: each chain whose waiter is a request on the map draws from that entity to
 * the blocker's entity, or to the database node (`db`) when the blocker is background work or
 * another program. Waits between the same pair fold into one edge (the longest wait). A waiter
 * that is not a request has no node to start from and is left to the inspector.
 */
export function blockingEdges(sample: BlockingSample | null): BlockEdge[] {
  if (!sample?.chains?.length) return []
  const by = new Map<string, BlockEdge>()
  for (const c of sample.chains) {
    const from = c.waiter.entity
    if (!from) continue
    // the blocker's entity (the same one = two requests of one entity), else the database node
    const to = c.blocker.entity ?? 'db'
    const k = `${from}→${to}`
    const who = c.blocker.entity ? '' : ` on ${shortParty(c.blocker)}`
    const e = by.get(k)
    if (!e || c.wait_ms > e.wait_ms)
      by.set(k, { from, to, wait_ms: c.wait_ms, label: `waits ${secs(c.wait_ms)}${who}` })
  }
  return [...by.values()].sort((a, b) => b.wait_ms - a.wait_ms)
}

/** A party in a few words (for edge labels and lists). */
export function shortParty(p: Party): string {
  if (p.kind === 'request') return p.entity ?? p.label
  if (p.kind === 'background') return 'background work'
  return p.label.length > 28 ? `${p.label.slice(0, 27)}…` : p.label
}

/** Entities a sample involves (waiters, blockers, heads) — the inspector filters by these. */
export function involvedEntities(sample: BlockingSample | null): Set<string> {
  const out = new Set<string>()
  for (const c of sample?.chains ?? [])
    for (const p of [c.waiter, c.blocker, c.head]) if (p.entity) out.add(p.entity)
  return out
}

// ── #1171 deadlocks ──────────────────────────────────────────────────────────
export interface DeadlockParty {
  spid: number | null
  entity: string | null
  label: string
  sql: string | null
  victim: boolean
}
export interface DeadlockEvent {
  at: number
  objects: string[]
  parties: DeadlockParty[]
  label: string
}

/** Sparkline markers for deadlock events (`kind: 'deadlock'`). */
export function deadlockMarkers(events: DeadlockEvent[]): SparkMarker[] {
  return events
    .filter((e) => Number.isFinite(e.at))
    .map((e) => ({ kind: 'deadlock' as const, at: e.at, label: e.label }))
}

// ── #1174 DB time split ──────────────────────────────────────────────────────
export const DB_TIME_ORDER = ['people', 'integrations', 'cron', 'import', 'flow', 'other'] as const
export type DbTimeCategory = (typeof DB_TIME_ORDER)[number]
export const DB_TIME_LABEL: Record<DbTimeCategory, string> = {
  people: 'People',
  integrations: 'Integrations',
  cron: 'Cron jobs',
  import: 'Imports',
  flow: 'Flows',
  other: 'Other background'
}
export interface DbTimeSplit {
  window_s: number
  total_ms: number
  ms: Record<DbTimeCategory, number>
  share: Record<DbTimeCategory, number>
  interactive: number
  background: number
  heaviest_cron: { id: string; ms: number } | null
  suggestion?: {
    job: string
    zone: string
    fires_at: number[]
    current_load: number
    quiet_hour: number
    quiet_load: number
    move: boolean
    reason: string
  } | null
}

/** Percent with no decimals, "<1%" for a non-zero sliver. */
export function pct(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const p = share * 100
  return p < 1 ? '<1%' : `${Math.round(p)}%`
}

/** Segments for the stacked bar, biggest categories keep their order (people first). */
export function splitSegments(
  s: Pick<DbTimeSplit, 'share'> | null
): Array<{ key: DbTimeCategory; share: number }> {
  if (!s) return []
  return DB_TIME_ORDER.map((key) => ({ key, share: s.share[key] ?? 0 })).filter((x) => x.share > 0)
}

export function hourLabel(h: number): string {
  return `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`
}

// ── #1176 metadata cache ─────────────────────────────────────────────────────
export interface MetadataCacheFigures {
  window_s: number
  enabled: boolean
  hits: number
  misses: number
  shared: number
  clears: number
  hit_rate: number | null
  entries: number
  ttl_ms: number
  series: Array<number | null>
  epoch: { seen: number | null; last_moved_at: string | null; last_statement: string | null }
}

/** The hit-rate series as sparkline points (gaps read as the previous value, none = 0). */
export function hitRateSeries(series: Array<number | null>): number[] {
  let last = 0
  return series.map((v) => {
    if (v == null) return last
    last = v
    return v
  })
}
