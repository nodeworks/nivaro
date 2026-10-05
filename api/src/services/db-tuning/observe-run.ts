import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { type JobRunHandle, startJobRun } from '../job-runs.js'
import { OBSERVER_TIMEOUT_MS, withTimeout } from './deadline.js'
import { closeUnseen, fingerprintOf, ledgerDecision, touchSeen, upsertProposal } from './ledger.js'
import { loadIndexCreateEvidence, observeIndexCreate } from './observers/index-create.js'
import { loadIndexDropEvidence, observeIndexDrop } from './observers/index-drop.js'
import {
  buildProcCandidate,
  loadProcEvidence,
  mechanicalProcRewrite,
  type ProcEvidence,
  selectProcCandidates
} from './observers/proc-rewrite.js'
import { loadQueryCacheEvidence, observeQueryCache } from './observers/query-cache.js'
import { runExtensionObservers } from './observers/registry.js'
import { loadRollupEvidence, observeRollupStore } from './observers/rollup-store.js'
import { prove } from './proof.js'
import { aiBudgetAllows, aiRewriteCandidate } from './rewrites/ai.js'
import { readTuningSettings } from './settings.js'
import { bodyHash, provability } from './twin.js'
import type { Candidate } from './types.js'

/**
 * The nightly observe run (#996): every observer reads its evidence, candidates are deduped by
 * fingerprint, quiet ones (dismissed or rolled back lately, or already in flight) are left
 * alone, and the biggest estimates are proved and written to the ledger — passed as
 * `proposed`, failed as `rejected_by_proof` with the proof kept. Nothing here applies a change.
 *
 * The counts reconcile: candidates = duplicates + quiet + below_floor + carried_over + proved
 * (a dry run proves nothing; its by_kind holds what it would have proved).
 */

export interface ObserveReport {
  skipped?: string
  candidates: number
  duplicates: number
  below_floor: number
  proved: number
  proposed: number
  rejected: number
  /** Proofs that errored on a standing proposal, which stays as it was. */
  kept: number
  quiet: number
  carried_over: number
  closed_unseen: number
  by_kind: Record<string, number>
  ms: number
}

export const OBSERVE_JOB_ID = 'db-tuning-observe'
export const PROOF_BUDGET = 20
export const AI_BUDGET = 5
export const WALL_MS = 60 * 60_000
const CLOSE_UNSEEN_DAYS = 14
/** A running row older than this is a dead process's (the wall is 60 minutes), not a live run. */
const IN_FLIGHT_FRESH_MS = 70 * 60_000

/**
 * Observe runs in flight anywhere on this database: `running` job rows of the observe job (the
 * CronManager's row for a tick or a Background Jobs run-now, or the row a manual run opens)
 * started in the last 70 minutes. The per-process flag cannot see another replica or a dev
 * process on the shared database. Unreadable → 0 (the per-process flag still holds).
 */
export async function observeRunsInFlight(): Promise<number> {
  try {
    const row = (await db('nivaro_job_runs')
      .where({ job_id: OBSERVE_JOB_ID, status: 'running' })
      .where('started_at', '>', new Date(Date.now() - IN_FLIGHT_FRESH_MS))
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

/** Tenants with a run in flight on this process (self-hosted: the one key ''). */
const running = new Set<string>()
const tenantKey = (): string => getTenantId() ?? ''
export const isObserveRunning = (): boolean => running.has(tenantKey())

/** Total order: biggest estimate first, then kind, target, change_key — the chosen set is stable. */
function byEstimate(a: Candidate, b: Candidate): number {
  if (a.estimate_ms_per_day !== b.estimate_ms_per_day)
    return b.estimate_ms_per_day - a.estimate_ms_per_day
  for (const k of ['kind', 'target', 'change_key'] as const)
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  return 0
}

/** Biggest estimates first, up to `budget`; a proc rewrite's estimate is a lower bound, so the floor never drops one. */
export function selectForProof(
  cands: Candidate[],
  budget: number,
  floor: number
): { chosen: Candidate[]; carried: number; below_floor: number } {
  const eligible = cands.filter((c) => c.kind === 'proc_rewrite' || c.estimate_ms_per_day >= floor)
  const sorted = [...eligible].sort(byEstimate)
  return {
    chosen: sorted.slice(0, budget),
    carried: Math.max(0, sorted.length - budget),
    below_floor: cands.length - eligible.length
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function procCandidates(
  ev: ProcEvidence,
  aiAllowed: boolean,
  remaining: () => number
): Promise<Candidate[]> {
  const out: Candidate[] = []
  let aiUsed = 0
  for (const sel of selectProcCandidates(ev)) {
    let rewritten = mechanicalProcRewrite(sel.body)
    if (!rewritten && aiAllowed && aiUsed < AI_BUDGET && remaining() > 0) {
      aiUsed++
      const ai = await aiRewriteCandidate({
        proc: sel.proc,
        body: sel.body,
        planOps: sel.planOps,
        hotLines: sel.planOps.slice(0, 10)
      })
      if (ai) rewritten = { ...ai, applied: ['ai'] }
    }
    if (!rewritten) continue
    if (bodyHash(rewritten.body) === bodyHash(sel.body)) continue
    // the proof refuses these too; no point spending a proof slot on one
    if (provability(sel.proc, rewritten.body)) continue
    out.push(buildProcCandidate(sel, rewritten))
  }
  return out
}

/**
 * Every observer, core then extensions. Each evidence read gets at most 10 minutes of what the
 * wall budget leaves; one that throws or runs out of time is logged and the rest still run.
 */
async function gatherCandidates(aiAllowed: boolean, remaining: () => number): Promise<Candidate[]> {
  const out: Candidate[] = []
  const slot = () => Math.min(OBSERVER_TIMEOUT_MS, remaining())
  const timed = <T>(label: string, load: () => Promise<T>): Promise<T> => {
    const ms = slot()
    return ms > 0
      ? withTimeout(load(), ms, `${label} evidence`)
      : Promise.reject(new Error("the run's time budget is spent"))
  }
  const safe = async (label: string, fn: () => Promise<Candidate[]>) => {
    try {
      out.push(...(await fn()))
    } catch (err) {
      console.warn(`[db-tuning] ${label} observer failed: ${errText(err)}`)
    }
  }
  await safe('index_create', async () =>
    observeIndexCreate(await timed('index_create', loadIndexCreateEvidence))
  )
  await safe('index_drop', async () =>
    observeIndexDrop(await timed('index_drop', loadIndexDropEvidence))
  )
  await safe('rollup_store', async () =>
    observeRollupStore(await timed('rollup_store', loadRollupEvidence))
  )
  await safe('query_cache', async () =>
    observeQueryCache(await timed('query_cache', loadQueryCacheEvidence))
  )
  await safe('proc_rewrite', async () =>
    procCandidates(await timed('proc_rewrite', loadProcEvidence), aiAllowed, remaining)
  )
  await safe('extensions', () => runExtensionObservers(slot))
  return out
}

/** The CronManager's own row for a scheduled run, so proposals name the run that found them. */
async function cronRunId(): Promise<number | null> {
  try {
    const row = (await db('nivaro_job_runs')
      .where({ job_id: OBSERVE_JOB_ID, status: 'running' })
      .orderBy('id', 'desc')
      .first('id')) as { id: number } | undefined
    return row ? Number(row.id) : null
  } catch {
    return null
  }
}

/**
 * `schedule` = called from the cron entry (its tick or its Background Jobs run-now): the
 * CronManager owns the job-run row and the ticks gate. Any other trigger opens its own
 * `tuning` run. A dry run reads the evidence and reports what it would prove; it proves,
 * writes and records nothing.
 */
export async function runObserve(
  opts: { dryRun?: boolean; trigger?: 'schedule' | 'run-now'; userId?: string | null } = {}
): Promise<ObserveReport> {
  const t0 = Date.now()
  const remaining = () => t0 + WALL_MS - Date.now()
  const empty: ObserveReport = {
    candidates: 0,
    duplicates: 0,
    below_floor: 0,
    proved: 0,
    proposed: 0,
    rejected: 0,
    kept: 0,
    quiet: 0,
    carried_over: 0,
    closed_unseen: 0,
    by_kind: {},
    ms: 0
  }
  const dryRun = Boolean(opts.dryRun)
  const tenant = tenantKey()
  const settings = await readTuningSettings()
  if (!settings.enabled) return { ...empty, skipped: 'disabled' }
  if (!dryRun && running.has(tenant)) return { ...empty, skipped: 'already running' }
  if (!dryRun) running.add(tenant)
  let run: JobRunHandle | null = null
  try {
    // a scheduled run's own cron row is already running; anything beyond it is another run
    const own = opts.trigger === 'schedule' ? 1 : 0
    if (!dryRun && (await observeRunsInFlight()) > own) return { ...empty, skipped: 'running' }
    if (!dryRun && opts.trigger !== 'schedule')
      run = await startJobRun('tuning', OBSERVE_JOB_ID, {
        label: 'Database tuning — observe',
        triggeredBy: opts.userId ?? null,
        trigger: opts.trigger ?? 'manual'
      })
    const runId = dryRun ? null : (run?.id ?? (await cronRunId()))
    const aiAllowed =
      !dryRun && settings.ai_rewrites && (await aiBudgetAllows(settings.ai_daily_budget_usd))
    const cands = await gatherCandidates(aiAllowed, remaining)
    // one candidate per fingerprint; quiet and in-flight ones never take a proof slot
    const seen = new Set<string>()
    const fresh: Candidate[] = []
    let duplicates = 0
    let quiet = 0
    for (const c of cands) {
      const fp = fingerprintOf(c)
      if (seen.has(fp)) {
        duplicates++
        continue
      }
      seen.add(fp)
      if ((await ledgerDecision(fp)) === 'quiet') {
        quiet++
        continue
      }
      fresh.push(c)
    }
    const { chosen, carried, below_floor } = selectForProof(
      fresh,
      PROOF_BUDGET,
      settings.min_estimate_ms_per_day
    )
    const report: ObserveReport = {
      ...empty,
      candidates: cands.length,
      duplicates,
      below_floor,
      quiet,
      carried_over: carried
    }
    for (const c of chosen) {
      // past the wall budget the rest carry to tomorrow night
      if (remaining() <= 0) {
        report.carried_over++
        continue
      }
      report.by_kind[c.kind] = (report.by_kind[c.kind] ?? 0) + 1
      if (dryRun) continue
      const proof = await prove(c, { procTimeoutMs: settings.proc_timeout_minutes * 60_000 })
      report.proved++
      if (c.kind === 'proc_rewrite' && proof.passed) {
        // the measured saving replaces the lower bound the selection used
        const before = Number(proof.before.median_ms ?? 0)
        const after = Number(proof.after.median_ms ?? 0)
        const perDay = Number((c.evidence as { runs_per_day?: number }).runs_per_day ?? 0)
        c.estimate_ms_per_day = Math.round(Math.max(0, before - after) * perDay)
      }
      // a failed proof (rows_diff included) is kept as rejected_by_proof, with the proof
      const r = await upsertProposal(c, proof, runId)
      run?.progress({ proved: report.proved, total: chosen.length, current: c.target })
      if (r.action === 'quiet') report.quiet++
      else if (r.action === 'kept') report.kept++
      else if (proof.passed) report.proposed++
      else report.rejected++
    }
    if (!dryRun) {
      // carried-over and unproved candidates were still seen tonight: their rows stay open
      await touchSeen([...seen])
      report.closed_unseen = await closeUnseen(CLOSE_UNSEEN_DAYS)
    }
    report.ms = Date.now() - t0
    await run?.complete(observeSummary(report))
    return report
  } catch (err) {
    await run?.fail(err)
    throw err
  } finally {
    if (!dryRun) running.delete(tenant)
  }
}

export function observeSummary(r: ObserveReport): string {
  if (r.skipped) return `skipped: ${r.skipped}`
  return `${r.proposed} proposed, ${r.rejected} rejected by proof, ${r.kept} kept after a proof error, ${r.quiet} quiet, ${r.carried_over} carried, ${r.closed_unseen} closed unseen`
}
