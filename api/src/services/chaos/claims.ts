import { listFaults } from './catalog.js'
import type { ChaosRun } from './runs.js'

/**
 * The resilience claims registry (#2830): every sentence Nivaro says about how it degrades, the
 * faults whose drills prove it, and how long a proof stays fresh. A claim's status is the newest
 * finished run of any proving fault — the faults named here plus every catalog fault whose
 * `claim_keys` lists the claim (so a fault cluster links a new fault by its claim key alone).
 *
 *   proven  newest run held, inside max_age_days
 *   broke   newest run broke or auto-aborted (the hypothesis did not hold)
 *   stale   newest run held, but longer ago than max_age_days
 *   never   no finished run yet (`provable: false` when no catalog fault proves it at all)
 *
 * Keys are stable ids (`<area>.<claim>`) shared with the catalog's `claim_keys`, the presets
 * library (#2855) and the "what if X died?" assistant tool (#2860).
 */

export interface Claim {
  key: string
  statement: string
  area: string
  /** Fault keys whose runs prove this claim (catalog `claim_keys` add to it). */
  proving: string[]
  max_age_days: number
  /** Where the behaviour lives, for whoever has to fix a broken claim. */
  source?: string
}

export type ClaimStatus = 'proven' | 'broke' | 'stale' | 'never'

export interface ClaimView extends Claim {
  /** Every fault key that proves it, merged with the catalog. */
  faults: string[]
  /** At least one of those faults is in this instance's catalog. */
  provable: boolean
  status: ClaimStatus
  last_run: {
    id: string
    fault_key: string | null
    kind: ChaosRun['kind']
    verdict: ChaosRun['verdict']
    at: string
    age_days: number
  } | null
}

const DEFAULT_MAX_AGE_DAYS = 30
const claims = new Map<string, Claim>()

export function registerClaim(c: Omit<Claim, 'max_age_days'> & { max_age_days?: number }): Claim {
  const claim: Claim = {
    ...c,
    proving: [...new Set(c.proving)],
    max_age_days: Math.max(1, c.max_age_days ?? DEFAULT_MAX_AGE_DAYS)
  }
  claims.set(claim.key, claim)
  return claim
}

export function listClaims(): Claim[] {
  return [...claims.values()]
}

export function getClaim(key: string): Claim | null {
  return claims.get(key) ?? null
}

/** Fault keys proving a claim: its own list plus catalog faults naming it. */
export function provingFaults(claim: Claim, catalog = listFaults()): string[] {
  const out = new Set(claim.proving)
  for (const f of catalog) if (f.claim_keys.includes(claim.key)) out.add(f.key)
  return [...out]
}

/** A run that can speak for a claim: finished, with a verdict. */
export function isVerdictRun(run: ChaosRun): boolean {
  return (
    !!run.verdict && !!run.fault_key && ['completed', 'stopped', 'aborted'].includes(run.status)
  )
}

export const runTime = (run: ChaosRun): number =>
  new Date(run.ended_at ?? run.started_at ?? run.created_at).getTime()

/** Status of every claim from a list of runs (any order). */
export function claimStatuses(
  runs: ChaosRun[],
  opts: { now?: number; catalog?: ReturnType<typeof listFaults> } = {}
): ClaimView[] {
  const now = opts.now ?? Date.now()
  const catalog = opts.catalog ?? listFaults()
  const inCatalog = new Set(catalog.map((f) => f.key))
  const newest = new Map<string, ChaosRun>()
  for (const run of runs) {
    if (!isVerdictRun(run)) continue
    const key = run.fault_key as string
    const seen = newest.get(key)
    if (!seen || runTime(run) > runTime(seen)) newest.set(key, run)
  }
  return listClaims().map((claim) => {
    const faults = provingFaults(claim, catalog)
    let last: ChaosRun | null = null
    for (const k of faults) {
      const r = newest.get(k)
      if (r && (!last || runTime(r) > runTime(last))) last = r
    }
    const provable = faults.some((k) => inCatalog.has(k))
    if (!last) return { ...claim, faults, provable, status: 'never', last_run: null }
    const age_days = Math.max(0, (now - runTime(last)) / 86_400_000)
    const status: ClaimStatus =
      last.verdict === 'held' ? (age_days > claim.max_age_days ? 'stale' : 'proven') : 'broke'
    return {
      ...claim,
      faults,
      provable,
      status,
      last_run: {
        id: last.id,
        fault_key: last.fault_key,
        kind: last.kind,
        verdict: last.verdict,
        at: new Date(runTime(last)).toISOString(),
        age_days: Math.round(age_days * 10) / 10
      }
    }
  })
}

/** The readiness verdict (#2830): warn on a stale or broken claim; never-proven ones are listed. */
export function claimsReadiness(views: ClaimView[]): {
  status: 'pass' | 'warn' | 'skip'
  detail: string
  blockers?: string[]
} {
  if (!views.length) return { status: 'skip', detail: 'No resilience claims are registered.' }
  const broke = views.filter((v) => v.status === 'broke')
  const stale = views.filter((v) => v.status === 'stale')
  const never = views.filter((v) => v.status === 'never')
  const proven = views.filter((v) => v.status === 'proven')
  const tail = never.length ? ` ${never.length} never proven yet.` : ''
  if (!broke.length && !stale.length)
    return {
      status: 'pass',
      detail: `${proven.length} of ${views.length} claim(s) proven within their window.${tail}`
    }
  return {
    status: 'warn',
    detail: `${broke.length} claim(s) whose last drill broke, ${stale.length} not proven within their window.${tail}`,
    blockers: [
      ...broke.map((v) => `${v.statement} — last drill ${v.last_run?.verdict ?? 'broke'}`),
      ...stale.map(
        (v) =>
          `${v.statement} — last proven ${Math.round(v.last_run?.age_days ?? 0)} days ago (limit ${v.max_age_days})`
      )
    ].slice(0, 30)
  }
}

/** Tests only. */
export function _resetClaimsForTests(): void {
  claims.clear()
  seedClaims()
}

// ─── The claims Nivaro makes today ─────────────────────────────────────────────
// Fault keys not in the catalog yet are the names the fault clusters register (SEAM.md §4);
// a claim whose faults are all missing reads "no drill proves this yet".

function seedClaims(): void {
  registerClaim({
    key: 'redis.fails_open',
    area: 'redis',
    statement:
      'When Redis is unreachable, requests keep answering, signed-in sessions hold and caches miss instead of erroring.',
    proving: ['redis_pause', 'redis_latency', 'redis_readonly', 'redis_key_loss', 'redis_evict'],
    source: 'plugins/redis.ts, services/read-gate.ts'
  })
  registerClaim({
    key: 'mail.fails_clean',
    area: 'mail',
    statement:
      'When the mail server is down, sending is a no-op that fails cleanly: nothing crashes and nobody waits on SMTP.',
    proving: ['mail_down'],
    source: 'services/mail.ts'
  })
  registerClaim({
    key: 'readgate.fails_open',
    area: 'database',
    statement:
      'The heavy-read gate fails open: a queued read proceeds after its maximum wait instead of hanging.',
    proving: ['db_latency', 'pool_hold'],
    source: 'services/read-gate.ts (HEAVY_READ_MAX_WAIT_MS)'
  })
  registerClaim({
    key: 'sockets.reconnect_catchup',
    area: 'sockets',
    statement:
      'Sockets reconnect and catch up after drops, delays or a replica cut off from pub/sub — nothing lost or doubled.',
    proving: ['socket_drill', 'redis_partition'],
    source: 'services/socket-chaos.ts, realtime event stream'
  })
  registerClaim({
    key: 'cron.lease_pause',
    area: 'redis',
    statement:
      'Scheduled jobs pause without the leader lease and never run twice at once when the lease moves.',
    proving: ['cron_lease_split', 'redis_pause'],
    source: 'plugins/cron.ts'
  })
  registerClaim({
    key: 'pools.isolated',
    area: 'database',
    statement:
      'The two connection pools are isolated: background work starving its pool leaves requests fine, and the reverse.',
    proving: ['pool_hold'],
    source: 'db/pool-context.ts (#1321)'
  })
  registerClaim({
    key: 'db.transient_retry',
    area: 'database',
    statement:
      'Slow or failing database statements surface as clear errors or retries (deadlock victims are retried), never a hung page.',
    proving: ['db_latency', 'db_errors'],
    source: 'db/index.ts'
  })
  registerClaim({
    key: 'partners.breaker_retry',
    area: 'partners',
    statement:
      'A partner API that is slow, failing or rate-limiting is retried with backoff and reported, never silently treated as success.',
    proving: ['partner_faults'],
    source: 'services/external-apis.ts'
  })
  registerClaim({
    key: 'files.share_503',
    area: 'files',
    statement:
      'When the file share is gone or full, file routes answer 503 with a clear message and the rest of the app keeps working.',
    proving: ['storage_faults'],
    source: 'services/files.ts'
  })
  registerClaim({
    key: 'ai.unavailable_503',
    area: 'ai',
    statement:
      'When the AI gateway fails, AI features answer 503 with a clear message (or fall back to another model) and nothing else breaks.',
    proving: ['ai_gateway_fault'],
    source: 'services/ai-client.ts'
  })
  registerClaim({
    key: 'signin.idp_down_sessions_hold',
    area: 'sign-in',
    statement:
      'When the sign-in provider is down, people already signed in keep working and the sign-in page shows a clear error, not a loop.',
    proving: ['oidc_down'],
    source: 'auth/oidc.ts'
  })
  registerClaim({
    key: 'process.loop_block_drained',
    area: 'process',
    statement:
      'A blocked event loop on one replica is noticed and drained: its health check fails and traffic moves to the others.',
    proving: ['event_loop_block'],
    source: 'event-loop watchdog'
  })
  registerClaim({
    key: 'process.heap_guard',
    area: 'process',
    statement:
      'Memory pressure on a replica is caught by the heap guard before the process is killed for running out of memory.',
    proving: ['memory_pressure'],
    source: 'heap guard'
  })
  registerClaim({
    key: 'process.clock_skew_safe',
    area: 'process',
    statement:
      'A replica whose clock drifts does not expire sessions early, double-run schedules or break SLA timers.',
    proving: ['clock_skew'],
    source: 'services/chaos/clock.ts (appNow)'
  })
  registerClaim({
    key: 'graph.fails_clean',
    area: 'partners',
    statement:
      'When Microsoft Graph is down or slow, directory lookups fail with a clear message and sign-in and saves keep working.',
    proving: ['graph_down'],
    source: 'services/microsoft.ts'
  })
  registerClaim({
    key: 'http.slow_honest',
    area: 'http',
    statement:
      'Slow answers stay honest: loading states show, the latency is visible on the Traffic Map, nothing times out silently.',
    proving: ['slow_requests'],
    source: 'server.ts'
  })
}

seedClaims()
