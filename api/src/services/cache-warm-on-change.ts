/**
 * Change-driven cache warm (realtime program 2026-11-14, item 25).
 *
 * The usage-ranked warm (cache-warm.ts) runs at boot and 06:30. Between those,
 * a cached custom query or widget kept serving what it computed until its TTL
 * ran out (12 h for the spend reports), however much the data under it changed;
 * the next viewer either read old numbers or, after a refresh, waited for the
 * procedure. This module closes that gap:
 *
 *   1. HEAR. Every change the API tells open pages about reaches the in-process
 *      record-change notices (record-change-notices.ts): items-service writes,
 *      pipeline moves (`$state`), imports, and raw writes announced by
 *      procedures (raw-write-announcer.ts). Each change is announced ONCE, in
 *      the process that made it, so one replica handles it.
 *   2. COALESCE. Changed collections collect for DEBOUNCE_MS; a 500-row import is
 *      one flush, not 500.
 *   3. MARK. Each cached query that reads a changed collection (liveReadSources:
 *      declared freshness sources, else the tables its SQL and the procedures it
 *      EXECs name) gets a stale mark (custom-query-cache.ts customQueryStaleKey):
 *      every cache hit older than the mark says `stale` and names the collection.
 *   4. RECOMPUTE. The most-viewed entries of those queries — the usage-ranked
 *      unrestricted execute runs, then widget renders and scoped execute calls
 *      AS one recent viewer per scope signature (cache-warm-viewers.ts) — are
 *      recomputed in the background: background pool, heavy-read gate, the
 *      request's own single-flight key (a viewer missing meanwhile joins the
 *      run). At most once per widget (or per query's execute entries) every
 *      COOLDOWN_MS across all replicas (Redis NX); a change inside the cooldown
 *      is recomputed when it ends (trailing edge), so the last change always
 *      lands. An entry already computed after the change is left alone.
 *
 * WHAT IS PLANNED. The target list (cache-warm.ts selectChangeWarmTargets) and
 * the collection → queries index are built by ONE replica every PLAN_TTL_MS
 * (a 7-day request-log scan) and shared through Redis.
 *
 * NEVER: in cloud mode (a timer has no tenant context, and viewer warms are
 * never run there), without Redis (nothing to warm into), on `nivaro_*` /
 * `directus_*` collections, or for record aspects other than `$state`
 * (comments, tasks, locks change no reported data).
 *
 * The 24-hour counts behind Database → Caches live in hourly Redis hashes
 * (STATS_PREFIX), shared by every replica.
 */
import { AsyncResource } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { cacheSetting } from './cache-config.js'
import type { ViewerQueryDef, ViewerTarget, ViewerWarmSummary } from './cache-warm-viewers.js'
import {
  CUSTOM_QUERY_STALE_MARK_TTL_S,
  customQueryStaleKey,
  customQueryStaleMarkValue
} from './custom-query-cache.js'
import { isMultiTenant } from './deployment-mode.js'
import { onRecordChangeNotice, type RecordChangeNotice } from './record-change-notices.js'

/** Changes collect this long before a flush. */
export const CHANGE_WARM_DEBOUNCE_MS = 5_000
/** At most one recompute per unit (widget, or a query's execute entries) this often. */
export const CHANGE_WARM_COOLDOWN_MS = 120_000
/** Entries recomputed per unit: its most-viewed signatures / param sets. */
export const CHANGE_WARM_PER_UNIT = 4
/** Units in the plan (most used first). */
export const CHANGE_WARM_MAX_UNITS = 60
/** Units started per run; the rest wait for the next pump. */
export const CHANGE_WARM_UNITS_PER_RUN = 8
/** Time budget of one run; one query never runs longer than this either. */
export const CHANGE_WARM_RUN_BUDGET_MS = 90_000
export const CHANGE_WARM_QUERY_TIMEOUT_MS = 90_000
/** How long a plan is reused. */
export const CHANGE_WARM_PLAN_TTL_MS = 30 * 60_000
/** A flush with no plan yet (another replica builds it) retries after this. */
const PLAN_RETRY_MS = 15_000
const PLAN_RETRIES = 8
const PLAN_KEY = 'nvr:warm:chg:plan'
const PLAN_LOCK = 'nvr:warm:chg:plan:lock'
const COOLDOWN_PREFIX = 'nvr:warm:chg:cd:'
export const STATS_PREFIX = 'nvr:warm:chg:stats:'
const STATS_TTL_S = 26 * 3600
const MAX_QUERIES_INDEXED = 400

// ─── pure parts ─────────────────────────────────────────────────────────────

/** Does this notice change data a report can read? */
export function noticeChangesData(n: RecordChangeNotice): boolean {
  const c = String(n.collection ?? '')
  if (!c || /^(nivaro_|directus_)/i.test(c)) return false
  if (n.action || n.source === 'raw' || n.source === 'import') return true
  return (n.changed_fields ?? []).includes('$state')
}

export interface ChangeWarmUnit {
  /** `w:<widget id>` or `q:<slug>`. */
  unit: string
  slug: string
  /** Most used first, at most CHANGE_WARM_PER_UNIT. */
  targets: ViewerTarget[]
  hits: number
}

export interface ChangeWarmPlan {
  built_at: number
  units: ChangeWarmUnit[]
  /** Lower-case collection → slugs of cached queries that read it. */
  reads: Record<string, string[]>
}

export function unitOf(t: ViewerTarget): string {
  return t.surface === 'widget' && t.widgetId ? `w:${t.widgetId}` : `q:${t.slug}`
}

/**
 * Targets (most used first) grouped into units, each keeping its first `perUnit`.
 * Only what people actually opened in the usage window: a Warm daily query nobody
 * viewed is the 06:00 run's job, never re-run on every change.
 */
export function groupUnits(
  targets: ViewerTarget[],
  perUnit = CHANGE_WARM_PER_UNIT,
  maxUnits = CHANGE_WARM_MAX_UNITS
): ChangeWarmUnit[] {
  const byUnit = new Map<string, ChangeWarmUnit>()
  for (const t of targets) {
    if (!((Number(t.groupHits) || 0) > 0)) continue
    const id = unitOf(t)
    let u = byUnit.get(id)
    if (!u) {
      u = { unit: id, slug: t.slug, targets: [], hits: 0 }
      byUnit.set(id, u)
    }
    u.hits = Math.max(u.hits, Number(t.groupHits) || 0)
    if (u.targets.length < perUnit) u.targets.push(t)
  }
  return [...byUnit.values()]
    .sort((a, b) => b.hits - a.hits || a.unit.localeCompare(b.unit))
    .slice(0, maxUnits)
}

/** Collection → slugs, from each cached query's read collections. */
export function indexReads(
  entries: Array<{ slug: string; tables: string[] }>
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const e of entries) {
    for (const t of e.tables) {
      const k = t.toLowerCase()
      const list = out[k] ?? []
      if (!list.includes(e.slug)) list.push(e.slug)
      out[k] = list
    }
  }
  return out
}

/** UTC hour bucket of the stats hashes. */
export function statsBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '')
}

export interface ChangeWarmStats {
  window_hours: number
  /** Data changes heard (notices). */
  changes: number
  /** Flushes: coalesced bursts of changes. */
  flushes: number
  /** Queries marked stale. */
  marked: number
  /** Unit recomputes (a widget's or a query's entries, recomputed together). */
  recomputes: number
  /** Entries recomputed; `cached` written, `joined` shared with a viewer's own run. */
  warmed: number
  cached: number
  joined: number
  /** Entries left alone: already newer than the change, not cached, budget spent. */
  skipped: number
  failed: number
  /** Recomputes held for the cooldown, then run when it ended. */
  deferred: number
  last_at: string | null
  by_query: Array<{ slug: string; warmed: number }>
}

const COUNTERS = [
  'changes',
  'flushes',
  'marked',
  'recomputes',
  'warmed',
  'cached',
  'joined',
  'skipped',
  'failed',
  'deferred'
] as const

/** Sum hourly hashes (HGETALL replies) into one 24-hour figure. */
export function sumStats(
  buckets: Array<Record<string, string> | null>,
  windowHours = 24
): ChangeWarmStats {
  const s: ChangeWarmStats = {
    window_hours: windowHours,
    changes: 0,
    flushes: 0,
    marked: 0,
    recomputes: 0,
    warmed: 0,
    cached: 0,
    joined: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    last_at: null,
    by_query: []
  }
  const bySlug = new Map<string, number>()
  for (const b of buckets) {
    if (!b) continue
    for (const [k, v] of Object.entries(b)) {
      if (k === 'last_at') {
        const at = Number(v)
        if (Number.isFinite(at) && at > 0) {
          const iso = new Date(at).toISOString()
          if (!s.last_at || iso > s.last_at) s.last_at = iso
        }
      } else if (k.startsWith('q:')) {
        bySlug.set(k.slice(2), (bySlug.get(k.slice(2)) ?? 0) + (Number(v) || 0))
      } else if ((COUNTERS as readonly string[]).includes(k)) {
        ;(s as unknown as Record<string, number>)[k] += Number(v) || 0
      }
    }
  }
  s.by_query = [...bySlug]
    .map(([slug, warmed]) => ({ slug, warmed }))
    .sort((a, b) => b.warmed - a.warmed || a.slug.localeCompare(b.slug))
    .slice(0, 10)
  return s
}

// ─── the scheduler ──────────────────────────────────────────────────────────

/** The Redis calls this module makes (ioredis shapes). */
export interface ChangeWarmRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  del(...keys: string[]): Promise<number>
  pttl(key: string): Promise<number>
  hincrby(key: string, field: string, n: number): Promise<number>
  hset(key: string, field: string, value: string | number): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
}

export interface ChangeWarmDeps {
  now: () => number
  /** Whether warms run at all right now (switch, cloud, Redis). */
  enabled: () => boolean
  /** Build the plan (the expensive part: the request-log scan). */
  buildPlan: () => Promise<ChangeWarmPlan>
  /** Current query definitions (the runner re-checks enabled / ttl / access). */
  loadQueries: () => Promise<ViewerQueryDef[]>
  /** Recompute one unit's targets; entries newer than `changedAt` are left alone. */
  runUnit: (
    targets: ViewerTarget[],
    queries: ViewerQueryDef[],
    o: { changedAt: number; deadline: number }
  ) => Promise<ViewerWarmSummary>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
}

interface Pending {
  unit: ChangeWarmUnit
  changedAt: number
  /** Not before this (cooldown). */
  notBefore: number
  deferred: boolean
}

export class ChangeWarmScheduler {
  private dirty = new Map<string, { collection: string; at: number }>()
  private heard = 0
  private planRetries = 0
  private flushTimer: unknown = null
  private pumpTimer: unknown = null
  private pumpAt = 0
  private pending = new Map<string, Pending>()
  private running = false
  private stopped = false
  private memo: { at: number; plan: ChangeWarmPlan } | null = null
  private readonly holder = randomUUID().slice(0, 8)

  constructor(
    private readonly redis: ChangeWarmRedis,
    private readonly deps: ChangeWarmDeps
  ) {}

  /** A record-change notice. Cheap: a map write and at most one timer. */
  note(n: RecordChangeNotice): void {
    if (this.stopped || !noticeChangesData(n) || !this.deps.enabled()) return
    const k = n.collection.toLowerCase()
    const at = this.deps.now()
    const cur = this.dirty.get(k)
    this.dirty.set(k, { collection: n.collection, at: Math.max(cur?.at ?? 0, at) })
    this.heard++
    if (!this.flushTimer)
      this.flushTimer = this.deps.setTimer(() => {
        this.flushTimer = null
        void this.flush().catch(() => undefined)
      }, CHANGE_WARM_DEBOUNCE_MS)
  }

  /** Mark the queries that read the changed collections and queue their units. */
  async flush(): Promise<void> {
    if (this.stopped || this.dirty.size === 0) return
    const plan = await this.getPlan()
    if (!plan) {
      // Another replica is building the plan: keep the changes and try again soon.
      if (++this.planRetries <= PLAN_RETRIES && !this.flushTimer)
        this.flushTimer = this.deps.setTimer(() => {
          this.flushTimer = null
          void this.flush().catch(() => undefined)
        }, PLAN_RETRY_MS)
      else if (this.planRetries > PLAN_RETRIES) {
        this.dirty.clear()
        this.heard = 0
        this.planRetries = 0
      }
      return
    }
    this.planRetries = 0
    const dirty = [...this.dirty.values()]
    const heard = this.heard
    this.dirty.clear()
    this.heard = 0

    // slug → newest change (and its collection)
    const marks = new Map<string, { at: number; collection: string }>()
    for (const d of dirty) {
      for (const slug of plan.reads[d.collection.toLowerCase()] ?? []) {
        const cur = marks.get(slug)
        if (!cur || d.at > cur.at) marks.set(slug, { at: d.at, collection: d.collection })
      }
    }
    await Promise.all(
      [...marks].map(([slug, m]) =>
        this.redis
          .setex(
            customQueryStaleKey(slug),
            CUSTOM_QUERY_STALE_MARK_TTL_S,
            customQueryStaleMarkValue(m.at, m.collection)
          )
          .catch(() => undefined)
      )
    )
    const now = this.deps.now()
    for (const u of plan.units) {
      const m = marks.get(u.slug)
      if (!m) continue
      const cur = this.pending.get(u.unit)
      this.pending.set(u.unit, {
        unit: u,
        changedAt: Math.max(cur?.changedAt ?? 0, m.at),
        notBefore: cur?.notBefore ?? now,
        deferred: cur?.deferred ?? false
      })
    }
    await this.count({ changes: heard, flushes: 1, marked: marks.size })
    this.schedulePump(0)
  }

  private schedulePump(delayMs: number): void {
    if (this.stopped) return
    const at = this.deps.now() + Math.max(0, delayMs)
    if (this.pumpTimer && this.pumpAt <= at) return
    if (this.pumpTimer) this.deps.clearTimer(this.pumpTimer)
    this.pumpAt = at
    this.pumpTimer = this.deps.setTimer(
      () => {
        this.pumpTimer = null
        void this.pump().catch(() => undefined)
      },
      Math.max(0, delayMs)
    )
  }

  /** Run the units that are due (one run at a time per process). */
  async pump(): Promise<void> {
    if (this.stopped || this.running || this.pending.size === 0) return
    if (!this.deps.enabled()) {
      this.pending.clear()
      return
    }
    this.running = true
    try {
      const now = this.deps.now()
      const due = [...this.pending.values()]
        .filter((p) => p.notBefore <= now)
        .sort((a, b) => b.unit.hits - a.unit.hits || a.unit.unit.localeCompare(b.unit.unit))
      const start: Pending[] = []
      for (const p of due) {
        if (start.length >= CHANGE_WARM_UNITS_PER_RUN) break
        // One recompute per unit per cooldown across every replica.
        const took = await this.redis
          .set(`${COOLDOWN_PREFIX}${p.unit.unit}`, this.holder, 'PX', CHANGE_WARM_COOLDOWN_MS, 'NX')
          .catch(() => null)
        if (took === 'OK') {
          start.push(p)
          continue
        }
        const left = await this.redis.pttl(`${COOLDOWN_PREFIX}${p.unit.unit}`).catch(() => -2)
        // Trailing edge: run once the cooldown ends (a vanished key: try again at once).
        p.notBefore = now + (left > 0 ? left : 1_000)
        if (!p.deferred) {
          p.deferred = true
          await this.count({ deferred: 1 })
        }
      }
      if (start.length > 0) {
        for (const p of start) this.pending.delete(p.unit.unit)
        const queries = await this.deps.loadQueries().catch(() => [] as ViewerQueryDef[])
        const deadline = this.deps.now() + CHANGE_WARM_RUN_BUDGET_MS
        for (const p of start) {
          if (this.stopped) break
          const sum = await this.deps
            .runUnit(p.unit.targets, queries, { changedAt: p.changedAt, deadline })
            .catch(() => null)
          await this.count(
            sum
              ? {
                  recomputes: 1,
                  warmed: sum.warmed,
                  cached: sum.cached,
                  joined: sum.joined,
                  skipped: sum.skipped,
                  failed: sum.failed,
                  [`q:${p.unit.slug}`]: sum.warmed
                }
              : { recomputes: 1, failed: p.unit.targets.length },
            true
          )
        }
      }
    } finally {
      this.running = false
    }
    // Anything left: at the earliest notBefore (or at once when more are due now).
    if (this.pending.size > 0) {
      const next = Math.min(...[...this.pending.values()].map((p) => p.notBefore))
      this.schedulePump(Math.max(250, next - this.deps.now()))
    }
  }

  /** The plan: this process's copy, else the shared one, else build it (one replica at a time). */
  async getPlan(): Promise<ChangeWarmPlan | null> {
    const now = this.deps.now()
    if (this.memo && now - this.memo.at < CHANGE_WARM_PLAN_TTL_MS) return this.memo.plan
    const shared = await this.redis.get(PLAN_KEY).catch(() => null)
    if (shared) {
      try {
        const plan = JSON.parse(shared) as ChangeWarmPlan
        if (plan && Array.isArray(plan.units) && plan.reads) {
          this.memo = { at: Number(plan.built_at) || now, plan }
          if (now - this.memo.at < CHANGE_WARM_PLAN_TTL_MS) return plan
        }
      } catch {
        /* unreadable: rebuild */
      }
    }
    const took = await this.redis.set(PLAN_LOCK, this.holder, 'EX', 300, 'NX').catch(() => null)
    if (took !== 'OK') return this.memo?.plan ?? null
    try {
      const plan = await this.deps.buildPlan()
      this.memo = { at: plan.built_at, plan }
      await this.redis
        .setex(PLAN_KEY, Math.ceil(CHANGE_WARM_PLAN_TTL_MS / 1000), JSON.stringify(plan))
        .catch(() => undefined)
      return plan
    } catch {
      return this.memo?.plan ?? null
    } finally {
      await this.redis.del(PLAN_LOCK).catch(() => 0)
    }
  }

  private async count(fields: Record<string, number>, stamp = false): Promise<void> {
    const key = `${STATS_PREFIX}${statsBucket(this.deps.now())}`
    try {
      for (const [f, n] of Object.entries(fields)) if (n) await this.redis.hincrby(key, f, n)
      if (stamp) await this.redis.hset(key, 'last_at', this.deps.now())
      await this.redis.expire(key, STATS_TTL_S)
    } catch {
      /* counts never fail a warm */
    }
  }

  stop(): void {
    this.stopped = true
    if (this.flushTimer) this.deps.clearTimer(this.flushTimer)
    if (this.pumpTimer) this.deps.clearTimer(this.pumpTimer)
    this.flushTimer = null
    this.pumpTimer = null
    this.dirty.clear()
    this.pending.clear()
  }

  /** Tests: what is waiting. */
  snapshot(): {
    dirty: string[]
    pending: Array<{ unit: string; changedAt: number; notBefore: number }>
  } {
    return {
      dirty: [...this.dirty.keys()],
      pending: [...this.pending.values()].map((p) => ({
        unit: p.unit.unit,
        changedAt: p.changedAt,
        notBefore: p.notBefore
      }))
    }
  }
}

// ─── wiring ─────────────────────────────────────────────────────────────────

/** CACHE_WARM_ON_CHANGE (env wins), else the cache config; auto follows the warm's own Mode. */
export async function changeWarmAllowed(): Promise<boolean> {
  if (isMultiTenant()) return false
  const mode = cacheSetting('warm.on_change')
  if (mode === 'off') return false
  if (mode === 'on') return true
  const { cacheWarmAllowed } = await import('./cache-warm.js')
  return cacheWarmAllowed()
}

/** The sync form the hot path reads (the auto answer is refreshed every 15 s). */
let allowed = false
let allowedAt = 0
function allowedNow(): boolean {
  if (Date.now() - allowedAt > 15_000) {
    allowedAt = Date.now()
    void changeWarmAllowed()
      .then((v) => {
        allowed = v
      })
      .catch(() => {
        allowed = false
      })
  }
  return allowed
}

async function defaultBuildPlan(): Promise<ChangeWarmPlan> {
  const { runInBackgroundPool } = await import('../db/pool-context.js')
  return runInBackgroundPool(async () => {
    const { selectChangeWarmTargets } = await import('./cache-warm.js')
    const { liveReadSources } = await import('./query-freshness.js')
    const { queries, targets } = await selectChangeWarmTargets()
    const cached = queries
      .filter((q) => !!q.enabled && (Number(q.cache_ttl) || 0) > 0)
      .slice(0, MAX_QUERIES_INDEXED)
    const entries: Array<{ slug: string; tables: string[] }> = []
    for (const q of cached) {
      const src = await liveReadSources(q).catch(() => [])
      if (src.length) entries.push({ slug: q.slug, tables: src.map((s) => s.table) })
    }
    return { built_at: Date.now(), units: groupUnits(targets), reads: indexReads(entries) }
  })
}

async function defaultLoadQueries(): Promise<ViewerQueryDef[]> {
  const { runInBackgroundPool } = await import('../db/pool-context.js')
  const { db } = await import('../db/index.js')
  return runInBackgroundPool(
    async () =>
      (await db('nivaro_custom_queries')
        .where({ enabled: true })
        .where('cache_ttl', '>', 0)
        .select(
          'id',
          'slug',
          'enabled',
          'access',
          'params',
          'sql_text',
          'cache_ttl',
          'warm_daily',
          'scope_params'
        )) as ViewerQueryDef[]
  )
}

function defaultRunUnit(redis: ChangeWarmRedis): ChangeWarmDeps['runUnit'] {
  return async (targets, queries, o) => {
    const { runInBackgroundPool } = await import('../db/pool-context.js')
    const { runViewerTargets } = await import('./cache-warm-viewers.js')
    const { planChangeWarmTarget, changeWarmGate } = await import('./cache-warm.js')
    return runInBackgroundPool(() =>
      runViewerTargets(targets, queries, {
        deadline: o.deadline,
        deps: {
          plan: (t, q) => planChangeWarmTarget(t, q),
          gate: changeWarmGate,
          now: () => Date.now()
        },
        redis,
        concurrency: 1,
        // An entry computed after the change already holds it.
        freshMs: Math.max(0, Date.now() - o.changedAt),
        queryTimeoutMs: CHANGE_WARM_QUERY_TIMEOUT_MS
      })
    )
  }
}

let active: { scheduler: ChangeWarmScheduler; off: () => void } | null = null

/**
 * Start hearing record changes in this process. Idempotent; returns the stop
 * function. A no-op in cloud mode or without Redis.
 */
export function startChangeWarm(redis: ChangeWarmRedis | null | undefined): () => void {
  if (active) return stopChangeWarm
  if (!redis || isMultiTenant()) return () => undefined
  void changeWarmAllowed().then((v) => {
    allowed = v
    allowedAt = Date.now()
  })
  const scheduler = new ChangeWarmScheduler(redis, changeWarmDeps(redis))
  const off = onRecordChangeNotice((n) => scheduler.note(n))
  active = { scheduler, off }
  return stopChangeWarm
}

/** The real dependencies: the plan builder, the background-pool runner, boot-scoped timers. */
export function changeWarmDeps(redis: ChangeWarmRedis): ChangeWarmDeps {
  // Timers run in the context this was created in (boot), never in the request
  // whose write armed them: ALS stores (pool, trace, traffic source) do not leak in.
  const scope = new AsyncResource('cache-warm-on-change')
  return {
    now: () => Date.now(),
    enabled: allowedNow,
    buildPlan: defaultBuildPlan,
    loadQueries: defaultLoadQueries,
    runUnit: defaultRunUnit(redis),
    setTimer: (fn, ms) => {
      const h = setTimeout(() => scope.runInAsyncScope(fn), ms)
      h.unref?.()
      return h
    },
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout)
  }
}

export function stopChangeWarm(): void {
  if (!active) return
  active.off()
  active.scheduler.stop()
  active = null
}

/** The 24-hour figures for Database → Caches (every replica's runs). */
export async function changeWarmStats(
  redis: Pick<ChangeWarmRedis, 'hgetall'> | null | undefined,
  now = Date.now()
): Promise<ChangeWarmStats & { enabled: boolean; cloud: boolean }> {
  const enabled = await changeWarmAllowed().catch(() => false)
  const buckets: Array<Record<string, string> | null> = []
  if (redis) {
    const keys = Array.from(
      { length: 24 },
      (_, i) => `${STATS_PREFIX}${statsBucket(now - i * 3_600_000)}`
    )
    buckets.push(...(await Promise.all(keys.map((k) => redis.hgetall(k).catch(() => null)))))
  }
  return { ...sumStats(buckets), enabled: enabled && !!redis, cloud: isMultiTenant() }
}
