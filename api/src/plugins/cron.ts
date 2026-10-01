import { Cron } from 'croner'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type { Redis } from 'ioredis'
import { newChainId, startChain } from '../services/chain.js'
import { INSTANCE_ID } from '../services/instance-roster.js'
import { startJobRun } from '../services/job-runs.js'
import { runAsTrafficSource, type TrafficSource } from '../services/traffic-source.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Whether scheduled jobs fire on the clock in THIS process.
 *
 * A development process shares its database with a deployed instance (the
 * dev laptop and staging both point at one database), so every clock-driven
 * job — digests, escalations, partner polls, the import worker, scheduled
 * flows — would run twice and mail people twice. Development processes
 * therefore keep their schedules registered (the roster, dry runs and
 * run-now all still work) but never tick; deployed instances tick.
 *
 * CRON_TICKS=on|off overrides either way (a self-hosted developer with their
 * own database sets `on`; a throwaway production-mode boot sets `off`).
 */
export function cronTicksEnabled(): boolean {
  const raw = (process.env.CRON_TICKS ?? '').trim().toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(raw)) return true
  if (['off', 'false', '0', 'no'].includes(raw)) return false
  return process.env.NODE_ENV !== 'development'
}

export interface CronEntry {
  id: string
  /** The EFFECTIVE schedule (override when one is set). */
  expression: string
  /** The schedule the code registered — what revert restores. */
  defaultExpression: string
  /** True when an admin override is in force. */
  overridden: boolean
  extensionId?: string
  nextRun: Date | null
  /** #136 — heavy jobs serialize through one global slot. */
  heavy?: boolean
  /** #305 — declared re-run safety, shown beside the run-now button. */
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  /** Plain-language purpose — what the job does and what it touches. */
  description?: string
  /** #504 — a job that no-ops behind a deployment flag, and whether that flag currently lets it run. */
  gate?: { flag: string; enabled: boolean }
  /** #198 — a paused cron's ticks return immediately. */
  paused?: boolean
  /** #32 — the job registered a dry-run handler (report, no writes). */
  supports_dry_run?: boolean
  /** #54 — chained: runs right after this job completes instead of on its
   *  own schedule (the schedule stays registered as the revert target). */
  after?: string | null
  /** Records only failed ticks (see ScheduleOpts.quiet). */
  quiet?: boolean
  /** #831 — the IANA zone the expression is evaluated in. */
  timezone?: string
  /** Where that zone came from: an admin override, the job's own code, the
   *  instance setting (nivaro_settings.sla_timezone) or the container. */
  timezone_source?: 'override' | 'job' | 'instance' | 'container'
}

type CronFn = () => void | Promise<void>

interface InternalEntry extends CronEntry {
  fn: CronFn
  job: Cron
  catchUpHours?: number
  scheduleOpts?: ScheduleOpts
  dryRun?: () => Promise<unknown>
}

export interface ScheduleOpts {
  extensionId?: string
  watchdogMs?: number
  catchUpHours?: number
  heavy?: boolean
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  /** Plain-language purpose, shown on the Background Jobs page. */
  description?: string
  /** #32 — what a tick WOULD do, with nothing written: returns a report
   *  (string or JSON) the Background Jobs page shows. Optional. */
  dryRun?: () => Promise<unknown>
  /** A high-frequency job (seconds apart) whose ticks mostly find nothing to
   *  do: only FAILED ticks are recorded in nivaro_job_runs, so it neither
   *  floods the run history nor reads as missed. */
  quiet?: boolean
  /** #831 — pin this job to a zone (e.g. 'UTC' for jobs that must follow UTC
   *  days). Absent = the instance time zone. */
  timezone?: string
}

/** A usable IANA zone name, or null. */
export function validTimeZone(z: unknown): string | null {
  const v = typeof z === 'string' ? z.trim() : ''
  if (!v) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return v
  } catch {
    return null
  }
}

/** The zone this process's clock reads in when nothing else is set. */
export function containerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Throws with croner's own message when the expression is not valid. */
export function assertCronExpression(expression: string): void {
  const probe = new Cron(expression, { paused: true })
  probe.stop()
}

/** The next N fire times of an expression, for admin previews. */
export function previewCronRuns(expression: string, count = 5, timezone?: string): Date[] {
  const probe = new Cron(expression, {
    paused: true,
    timezone: validTimeZone(timezone) ?? undefined
  })
  const runs = probe.nextRuns(count)
  probe.stop()
  return runs
}

// Cron watchdog (#93): a tick still running when its budget expires raises a
// deduped issue naming the job — a hung cron otherwise reads as "everything is
// fine" while its work silently stops happening. Overlap skips (croner's
// protect) were silent for the same reason; they raise the same way.
const WATCHDOG_DEFAULT_MS = 15 * 60 * 1000

function raiseCronIssue(message: string, severity: 'medium' | 'high'): void {
  void import('../services/error-tracking.js')
    .then(({ trackError }) =>
      trackError({ source: 'server', route: 'cron/watchdog', message, severity })
    )
    .catch(() => {})
}

/** #75 — the knex pool's occupancy; null when the driver exposes no pool. */
async function poolOccupancy(): Promise<{ used: number; max: number; pending: number } | null> {
  try {
    const { db } = await import('../db/index.js')
    const pool = (
      db.client as {
        pool?: { numUsed: () => number; numPendingAcquires: () => number; max?: number }
      }
    ).pool
    if (!pool) return null
    return { used: pool.numUsed(), max: pool.max ?? 10, pending: pool.numPendingAcquires() }
  } catch {
    return null
  }
}

const HOT_POOL_RATIO = 0.8
const YIELD_STEP_MS = 5_000
const YIELD_MAX_MS = 10 * 60_000

/** Wait while the pool is hot (≥ 80% checked out, or acquires queued) —
 *  bounded, so a permanently busy instance still runs its heavy jobs. */
async function waitForPoolHeadroom(): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < YIELD_MAX_MS) {
    const p = await poolOccupancy()
    if (!p) return
    const hot = p.pending > 0 || p.used / Math.max(1, p.max) >= HOT_POOL_RATIO
    if (!hot) return
    await sleep(YIELD_STEP_MS)
  }
}

// ── Scheduler leader lease (#1080) ───────────────────────────────────────────
//
// With more than one API replica ticking, every scheduled job would run once
// per replica: digests mailed twice, partner polls doubled, nightly procs
// racing each other. Only the process holding the lease fires on the clock.
//
// The lease is a Redis key holding this process's instance id, set with NX
// and a 30s expiry, renewed every 10s with compare-and-pexpire and released
// with compare-and-del on shutdown — a process can only ever renew or release
// its OWN lease. It fails CLOSED: this process stops believing it leads a
// couple of seconds before the key could expire, so a Redis outage ends its
// ticks before anyone else could take over, never after.
//
// A per-tick run lock (`nvr:cron:run:<id>:<fire time>`) backs it up: during a
// start-first deploy the outgoing and incoming worker can briefly overlap, and
// the run lock makes one scheduled fire run exactly once even then.
//
// Run-now needs no lease: it is an explicit request, recorded on the job run.

const LEASE_KEY = 'nvr:cron:leader'
const LEASE_MS = 30_000
const RENEW_MS = 10_000
/** Stop believing we lead this long before the key could expire. */
const LEASE_MARGIN_MS = 2_000
const RUN_LOCK_MS = 10 * 60_000

const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export interface LeaderStatus {
  /** Coordination is on (a Redis client is attached and ticks are enabled). */
  coordinated: boolean
  instance: string
  is_leader: boolean
  /** The instance id holding the lease, as last read (null = nobody). */
  holder: string | null
  held_until: string | null
}

export class CronLeader {
  private redis: Redis | null = null
  /** Read-only handle: a process that does not compete can still say who leads. */
  private observer: Redis | null = null
  private heldUntil = 0
  private holder: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(readonly instanceId: string = INSTANCE_ID) {}

  get active(): boolean {
    return this.redis !== null
  }

  /** Attach Redis for reading the holder without competing. */
  observe(redis: Redis): void {
    this.observer = redis
  }

  /** The instance id holding the lease right now (null = nobody / unknown). */
  async currentHolder(): Promise<string | null> {
    const r = this.redis ?? this.observer
    if (!r) return null
    try {
      return await r.get(LEASE_KEY)
    } catch {
      return this.holder
    }
  }

  start(redis: Redis): void {
    this.redis = redis
    this.observer = redis
    void this.renew()
    if (!this.timer) {
      this.timer = setInterval(() => void this.renew(), RENEW_MS)
      this.timer.unref()
    }
  }

  isLeader(now = Date.now()): boolean {
    return this.heldUntil > now
  }

  /** One renew-or-acquire round. Exposed for tests. */
  async renew(): Promise<void> {
    const r = this.redis
    if (!r) return
    const began = Date.now()
    try {
      if (this.isLeader(began)) {
        const ok = await r.eval(RENEW_LUA, 1, LEASE_KEY, this.instanceId, String(LEASE_MS))
        if (Number(ok) === 1) {
          this.heldUntil = began + LEASE_MS - LEASE_MARGIN_MS
        } else {
          this.heldUntil = 0
          console.warn(`[cron] scheduler lease lost by ${this.instanceId} — ticks stop here`)
        }
      }
      if (!this.isLeader()) {
        const res = await r.set(LEASE_KEY, this.instanceId, 'PX', LEASE_MS, 'NX')
        if (res === 'OK') {
          this.heldUntil = began + LEASE_MS - LEASE_MARGIN_MS
          console.log(
            `[cron] scheduler lease taken by ${this.instanceId} — scheduled jobs tick here`
          )
        }
      }
      this.holder = await r.get(LEASE_KEY)
    } catch {
      // Redis unreachable: keep whatever is left of the current lease (it
      // lapses on its own before the key can), never extend it.
    }
  }

  /** Release the lease if we hold it — the next replica takes over at once. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const r = this.redis
    const held = this.isLeader()
    this.heldUntil = 0
    if (!r || !held) return
    try {
      await r.eval(RELEASE_LUA, 1, LEASE_KEY, this.instanceId)
    } catch {
      /* the key expires on its own */
    }
  }

  /**
   * Claim one scheduled fire. True = run it. Keyed on the fire time, so two
   * processes that both believe they lead (a start-first overlap) still run a
   * given fire once. Fails closed on a Redis error.
   */
  async claimRun(id: string, fireTime: Date): Promise<boolean> {
    const r = this.redis
    if (!r) return true
    try {
      const res = await r.set(
        `nvr:cron:run:${id}:${fireTime.toISOString()}`,
        this.instanceId,
        'PX',
        RUN_LOCK_MS,
        'NX'
      )
      return res === 'OK'
    } catch {
      return false
    }
  }

  status(): LeaderStatus {
    return {
      coordinated: this.active,
      instance: this.instanceId,
      is_leader: this.active ? this.isLeader() : true,
      holder: this.active ? this.holder : this.instanceId,
      held_until: this.isLeader() ? new Date(this.heldUntil).toISOString() : null
    }
  }
}

/** The scheduled time a tick belongs to: the newest fire at or before now.
 *  Croner hands the callback the actual start time, which differs between
 *  processes by milliseconds; the scheduled time does not. */
export function scheduledFireTime(job: Cron, now = new Date()): Date {
  try {
    const prev = job.previousRuns(1, new Date(now.getTime() + 1000))[0]
    if (prev && now.getTime() - prev.getTime() < 60_000) return prev
  } catch {
    /* fall through */
  }
  return new Date(Math.round(now.getTime() / 1000) * 1000)
}

export class CronManager {
  private entries = new Map<string, InternalEntry>()
  private runningSince = new Map<string, number>()
  /** Paused cron ids (#198) — hydrated from settings at boot, edited via /cron routes. */
  private pausedIds = new Set<string>()
  /** Schedule overrides (cron id → expression) — hydrated from settings BEFORE
   *  extensions register, so a job scheduled later still gets its override. */
  private overrides = new Map<string, string>()
  /** Heavy-job serialization (#136): heavy ticks run one at a time, queued in
   *  arrival order — nightly procs/sweeps/backfills stop piling onto the pool. */
  private heavyChain: Promise<void> = Promise.resolve()
  /** #831 — the instance time zone (nivaro_settings.sla_timezone); null = the
   *  container's clock. Hydrated at boot before anything schedules. */
  private instanceTz: string | null = null
  /** #831 — admin per-job zone overrides (cron id → IANA zone). */
  private tzOverrides = new Map<string, string>()
  /** #1080 — the scheduler lease. Inactive (every tick allowed) until a Redis
   *  client is attached, so tests and single-process tools keep working. */
  readonly leader = new CronLeader()

  /** Start competing for the scheduler lease. Only a process whose ticks are
   *  enabled competes — a replica with ticks off must never hold it, or the
   *  worker would never fire. */
  startLeaderElection(redis: Redis): void {
    this.leader.observe(redis)
    if (!cronTicksEnabled()) return
    this.leader.start(redis)
  }
  /** Lease status with the holder read fresh — for the admin surfaces. A
   *  replica with ticks off never competes but still names who leads. */
  async schedulerStatus(): Promise<
    LeaderStatus & { ticks_enabled: boolean; development: boolean }
  > {
    const st = this.leader.status()
    const ticks = cronTicksEnabled()
    const holder = await this.leader.currentHolder()
    return {
      ...st,
      is_leader: ticks && this.mayTick(),
      holder: holder ?? (st.coordinated ? null : ticks ? st.instance : null),
      ticks_enabled: ticks,
      development: process.env.NODE_ENV === 'development'
    }
  }
  /** May this process fire scheduled ticks right now? */
  mayTick(): boolean {
    if (!cronTicksEnabled()) return false
    return this.leader.active ? this.leader.isLeader() : true
  }

  /** Evaluate every job in `tz` (null = container) — re-creates each job
   *  whose effective zone changes. */
  setInstanceTimezone(tz: string | null): void {
    const next = validTimeZone(tz)
    if (next === this.instanceTz) return
    this.instanceTz = next
    for (const id of [...this.entries.keys()]) this.rebuild(id)
  }
  getInstanceTimezone(): string | null {
    return this.instanceTz
  }
  /** Replace the per-job zone overrides (hydrated with cron_overrides). */
  setTimezoneOverrides(map: Record<string, string>): void {
    const next = new Map<string, string>()
    for (const [id, tz] of Object.entries(map)) {
      const v = validTimeZone(tz)
      if (v) next.set(id, v)
    }
    this.tzOverrides = next
    for (const id of [...this.entries.keys()]) this.rebuild(id)
  }
  /** Pin one job to a zone live (null = back to its default). */
  setTimezone(id: string, tz: string | null): void {
    const v = validTimeZone(tz)
    if (tz && !v) throw new Error(`Unknown time zone: ${tz}`)
    if (v) this.tzOverrides.set(id, v)
    else this.tzOverrides.delete(id)
    this.rebuild(id)
  }
  private zoneFor(
    id: string,
    opts?: ScheduleOpts
  ): { tz: string | undefined; source: NonNullable<CronEntry['timezone_source']> } {
    const o = this.tzOverrides.get(id)
    if (o) return { tz: o, source: 'override' }
    const j = validTimeZone(opts?.timezone)
    if (j) return { tz: j, source: 'job' }
    if (this.instanceTz) return { tz: this.instanceTz, source: 'instance' }
    return { tz: undefined, source: 'container' }
  }

  setPaused(ids: string[]): void {
    this.pausedIds = new Set(ids)
  }
  pause(id: string): void {
    this.pausedIds.add(id)
  }
  resume(id: string): void {
    this.pausedIds.delete(id)
  }
  isPaused(id: string): boolean {
    return this.pausedIds.has(id)
  }

  /** Replace the override map and re-create every job whose effective
   *  schedule changed. Safe to call before or after jobs register. */
  setOverrides(map: Record<string, string>): void {
    const next = new Map<string, string>()
    for (const [id, expr] of Object.entries(map)) {
      try {
        assertCronExpression(expr)
        next.set(id, expr)
      } catch (err) {
        console.warn(`[cron] ignoring invalid override for "${id}": ${expr}`, err)
      }
    }
    this.overrides = next
    for (const id of [...this.entries.keys()]) this.rebuild(id)
  }
  getOverride(id: string): string | null {
    return this.overrides.get(id) ?? null
  }
  /** Override one job's schedule live. Throws on an invalid expression. */
  override(id: string, expression: string): void {
    assertCronExpression(expression)
    this.overrides.set(id, expression)
    this.rebuild(id)
  }
  /** Back to the schedule the code registered. */
  revert(id: string): void {
    this.overrides.delete(id)
    this.rebuild(id)
  }
  /** Re-create a job from its registered fn/opts under the current override. */
  private rebuild(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    const effective = this.overrides.get(id) ?? e.defaultExpression
    const zone = this.zoneFor(id, e.scheduleOpts).tz ?? containerTimeZone()
    if (effective === e.expression && zone === e.timezone) return
    const { fn, defaultExpression, scheduleOpts, catchUpHours, heavy, idempotent, description } = e
    this.schedule(id, defaultExpression, fn, {
      ...scheduleOpts,
      catchUpHours,
      heavy,
      idempotent,
      description
    })
  }
  /** Post-registration metadata (#136/#305) — one annotation block in
   *  server.ts marks heaviness and re-run safety without touching each
   *  schedule() call site. */
  annotate(
    id: string,
    meta: {
      heavy?: boolean
      idempotent?: 'safe' | 'unsafe' | 'unknown'
      description?: string
      gate?: { flag: string; enabled: boolean }
    }
  ): void {
    const e = this.entries.get(id)
    if (!e) return
    if (meta.heavy !== undefined) e.heavy = meta.heavy
    if (meta.idempotent) e.idempotent = meta.idempotent
    if (meta.description) e.description = meta.description
    if (meta.gate) e.gate = meta.gate
  }
  private runSerialized(heavy: boolean, work: () => Promise<void>): Promise<void> {
    if (!heavy) return work()
    // #75 — a heavy job yields to interactive traffic: while the connection
    // pool is hot it waits (5s steps, 10 min cap) before taking its turn.
    const yielding = async () => {
      await waitForPoolHeadroom()
      await work()
    }
    const next = this.heavyChain.then(yielding, yielding)
    this.heavyChain = next.catch(() => {})
    return next
  }

  // #54 — chains: childId → the job it runs after. Hydrated from
  // settings.cron_chains at boot (before schedules register) and edited live.
  private chains = new Map<string, string>()
  setChains(map: Record<string, string>): void {
    this.chains = new Map(Object.entries(map).filter(([k, v]) => k && v && k !== v))
  }
  getAfter(id: string): string | null {
    return this.chains.get(id) ?? null
  }
  /** Chain `id` after `afterId` (null = unchain). Refuses cycles. */
  setAfter(id: string, afterId: string | null): void {
    if (!afterId) {
      this.chains.delete(id)
      return
    }
    if (afterId === id) throw new Error('A job cannot run after itself')
    let cur: string | undefined = afterId
    const seen = new Set<string>([id])
    while (cur) {
      if (seen.has(cur)) throw new Error(`Chaining ${id} after ${afterId} would loop`)
      seen.add(cur)
      cur = this.chains.get(cur)
    }
    this.chains.set(id, afterId)
  }
  /** Jobs chained after `id`, in registration order. */
  chainedAfter(id: string): string[] {
    return [...this.entries.keys()].filter((k) => this.chains.get(k) === id)
  }
  private triggerChained(id: string): void {
    const kids = this.chainedAfter(id)
    if (kids.length === 0) return
    void (async () => {
      for (const kid of kids) {
        try {
          await this.runNow(kid, null)
        } catch (err) {
          console.error({ err, cronId: kid, after: id }, 'Chained cron job error')
        }
      }
    })()
  }

  /** #32 — run a job's dry-run handler; null when it has none. */
  async dryRun(id: string): Promise<{ supported: boolean; report: unknown }> {
    const e = this.entries.get(id)
    if (!e?.dryRun) return { supported: false, report: null }
    return { supported: true, report: await e.dryRun() }
  }

  /** #81 — when the schedule last SHOULD have fired (null for one-shot or
   *  unparseable expressions). Derived from the next two runs' spacing, so an
   *  irregular expression reads as its nearest regular period. */
  expectedPreviousRun(id: string, now = new Date()): Date | null {
    const e = this.entries.get(id)
    if (!e) return null
    try {
      const probe = new Cron(e.expression, { timezone: e.timezone })
      const n1 = probe.nextRun(now)
      const n2 = n1 ? probe.nextRun(n1) : null
      if (!n1 || !n2) return null
      const period = n2.getTime() - n1.getTime()
      if (period <= 0) return null
      return new Date(n1.getTime() - period)
    } catch {
      return null
    }
  }

  schedule(id: string, expression: string, fn: CronFn, opts?: ScheduleOpts): void {
    // Replace any existing job with the same id
    this.unschedule(id)

    // An admin override (settings.cron_overrides) wins over the registered
    // expression; the registered one is kept as the revert target.
    const effective = this.overrides.get(id) ?? expression
    const budget = opts?.watchdogMs ?? WATCHDOG_DEFAULT_MS
    const zone = this.zoneFor(id, opts)
    const job = new Cron(
      effective,
      {
        // #831 — evaluated in the instance zone, not the container's clock.
        timezone: zone.tz,
        // protect blocks the tick when the previous one is still running —
        // the callback form makes the skip VISIBLE instead of silent.
        protect: () => {
          const since = this.runningSince.get(id)
          const mins = since ? Math.round((Date.now() - since) / 60_000) : 0
          raiseCronIssue(
            `Cron "${id}" tick skipped — the previous tick has been running for ${mins} minute(s)`,
            'medium'
          )
        },
        catch: true
      },
      async (cronJob) => {
        // Paused (#198): the schedule stays registered (so resume needs no
        // deploy) but ticks return without running or recording anything.
        if (this.pausedIds.has(id)) return
        // Ticks off on this process (development by default, or CRON_TICKS=off):
        // schedules stay registered and run-now still works, but only the
        // deployed instance fires on the clock — see cronTicksEnabled().
        if (!cronTicksEnabled()) return
        // Chained (#54): this job runs after another one completes, not on
        // its own clock — the tick is a no-op while the chain stands.
        if (this.chains.has(id)) return
        // #1080 — only the process holding the scheduler lease fires, and a
        // given scheduled fire runs once even when two processes overlap.
        if (!this.mayTick()) return
        if (this.leader.active && !(await this.leader.claimRun(id, scheduledFireTime(cronJob))))
          return
        if (opts?.quiet) {
          const chainId = newChainId()
          try {
            await startChain(
              `cron:${id}`,
              () => runAsTrafficSource(cronTrafficSource(id), fn),
              chainId
            )
          } catch (err) {
            console.error({ err, cronId: id }, 'Cron job error')
            const run = await startJobRun('cron', id, { extensionId: opts?.extensionId, chainId })
            await run.fail(err)
          }
          return
        }
        // Every tick lands in nivaro_job_runs (best-effort) so the Background
        // Jobs console and per-extension health read one source of truth.
        await this.runSerialized(this.entries.get(id)?.heavy === true, async () => {
          // The run records the chain its tick starts (#707), so the console
          // can open "what it wrote" for exactly this run.
          const chainId = newChainId()
          const run = await startJobRun('cron', id, { extensionId: opts?.extensionId, chainId })
          this.runningSince.set(id, Date.now())
          const watchdog = setTimeout(() => {
            raiseCronIssue(
              `Cron "${id}" has been running for over ${Math.round(budget / 60_000)} minutes — likely hung (its work has stopped happening)`,
              'high'
            )
          }, budget)
          try {
            // Every tick is its own integration event chain.
            await startChain(
              `cron:${id}`,
              () => runAsTrafficSource(cronTrafficSource(id), fn),
              chainId
            )
            await run.complete()
            this.triggerChained(id)
          } catch (err) {
            console.error({ err, cronId: id }, 'Cron job error')
            await run.fail(err)
          } finally {
            clearTimeout(watchdog)
            this.runningSince.delete(id)
          }
        })
      }
    )

    const self = this
    this.entries.set(id, {
      id,
      expression: effective,
      defaultExpression: expression,
      overridden: effective !== expression,
      fn,
      scheduleOpts: opts,
      extensionId: opts?.extensionId,
      catchUpHours: opts?.catchUpHours,
      heavy: opts?.heavy,
      idempotent: opts?.idempotent ?? 'unknown',
      description: opts?.description,
      dryRun: opts?.dryRun,
      timezone: zone.tz ?? containerTimeZone(),
      timezone_source: zone.source,
      job,
      get nextRun() {
        return job.nextRun() ?? null
      },
      get paused() {
        return self.pausedIds.has(id)
      },
      get supports_dry_run() {
        return !!self.entries.get(id)?.dryRun
      },
      get after() {
        return self.chains.get(id) ?? null
      }
    })
  }

  /**
   * Run a scheduled job's handler immediately, out of band. Used by the admin
   * "run now" endpoint to re-run a failed nightly job (or to exercise one in a
   * test window) without waiting for its next tick. Errors propagate to the
   * caller so the endpoint can report them; the scheduled run is unaffected.
   */
  async runNow(id: string, triggeredBy?: string | null): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry) return false
    const chainId = newChainId()
    const run = await startJobRun('cron', id, {
      extensionId: entry.extensionId,
      triggeredBy: triggeredBy ?? null,
      chainId
    })
    try {
      // A NEW chain even when run-now comes from an HTTP request: the job's
      // writes are the cron's, not the admin click's (the click is recorded
      // on nivaro_job_runs.triggered_by).
      await startChain(
        `cron:${id}`,
        () => runAsTrafficSource(cronTrafficSource(id), entry.fn),
        chainId
      )
      await run.complete()
      this.triggerChained(id)
    } catch (err) {
      await run.fail(err)
      throw err
    }
    return true
  }

  /** Flag an already-registered job for boot catch-up (#328). */
  markCatchUp(id: string, hours: number): void {
    const entry = this.entries.get(id)
    if (entry) entry.catchUpHours = hours
  }

  /**
   * Missed-cron catch-up (#328): jobs flagged with catchUpHours run once on
   * boot when no completed run exists inside that window — a restart that
   * straddled 3am no longer silently skips a nightly. Only idempotent
   * detectors/cleanups should opt in.
   */
  async runCatchUps(): Promise<void> {
    // #1080 — catch-ups are scheduled work: only the lease holder runs them
    // (every replica booting would otherwise run every overdue nightly).
    if (!this.mayTick()) return
    const { db } = await import('../db/index.js')
    for (const entry of this.entries.values()) {
      const hours = entry.catchUpHours
      if (!hours) continue
      try {
        const recent = await db('nivaro_job_runs')
          .where({ job_id: entry.id, status: 'completed' })
          .where('started_at', '>=', new Date(Date.now() - hours * 3_600_000))
          .first('id')
        if (recent) continue
        console.log(`[cron] catch-up run for overdue job "${entry.id}"`)
        await this.runNow(entry.id, null)
      } catch (err) {
        console.warn(`[cron] catch-up for "${entry.id}" failed:`, err)
      }
    }
  }

  unschedule(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.job.stop()
    this.entries.delete(id)
  }

  unscheduleByExtension(extensionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.extensionId === extensionId) {
        entry.job.stop()
        this.entries.delete(id)
      }
    }
  }

  setExtensionEnabled(extensionId: string, enabled: boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.extensionId !== extensionId) continue
      if (enabled) {
        entry.job.resume()
      } else {
        entry.job.pause()
      }
    }
  }

  list(): CronEntry[] {
    return Array.from(this.entries.values()).map(
      ({
        id,
        expression,
        defaultExpression,
        overridden,
        extensionId,
        job,
        heavy,
        idempotent,
        description,
        gate,
        timezone,
        timezone_source
      }) => ({
        id,
        expression,
        defaultExpression,
        overridden,
        extensionId,
        nextRun: job.nextRun() ?? null,
        heavy,
        idempotent,
        description,
        gate,
        paused: this.pausedIds.has(id),
        // list() rebuilds entries — every annotate()/option field must be
        // copied here or the registry silently drops it (the first cron bug).
        supports_dry_run: !!this.entries.get(id)?.dryRun,
        after: this.chains.get(id) ?? null,
        quiet: this.entries.get(id)?.scheduleOpts?.quiet === true,
        timezone,
        timezone_source
      })
    )
  }

  stopAll(): void {
    for (const entry of this.entries.values()) {
      entry.job.stop()
    }
    this.entries.clear()
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    cron: CronManager
  }
}

export const cronPlugin = fp(async (app: FastifyInstance) => {
  const manager = new CronManager()

  app.decorate('cron', manager)

  // #1080 — compete for the scheduler lease when Redis is attached (it is
  // registered before this plugin). Release it on close so the next replica
  // takes over at once instead of waiting out the expiry.
  const redis = (app as unknown as { redis?: Redis }).redis
  if (redis) manager.startLeaderElection(redis)

  app.addHook('onClose', async () => {
    await manager.leader.stop()
    manager.stopAll()
  })

  app.log.info(
    cronTicksEnabled()
      ? 'Cron manager ready — scheduled jobs tick on this instance'
      : 'Cron manager ready — scheduled ticks OFF on this instance (development default; CRON_TICKS=on to enable). Run-now still works.'
  )
})

/** The Traffic Map source a job's run is attributed to (#1105): its writes and partner calls. */
function cronTrafficSource(id: string): TrafficSource {
  return { id: `cron:${id}`, label: id, kind: 'cron' }
}
