import { db } from '../../db/index.js'
import { type JobRunHandle, startJobRun } from '../job-runs.js'
import { closeUnseen, fingerprintOf, isQuiet, upsertProposal } from './ledger.js'
import { loadIndexCreateEvidence, observeIndexCreate } from './observers/index-create.js'
import { loadIndexDropEvidence, observeIndexDrop } from './observers/index-drop.js'
import {
  buildProcCandidate,
  loadProcEvidence,
  mechanicalProcRewrite,
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
 * fingerprint, quiet ones (dismissed or rolled back lately) are left alone, and the biggest
 * estimates are proved and written to the ledger — passed as `proposed`, failed as
 * `rejected_by_proof` with the proof kept. Nothing here applies a change.
 */

export interface ObserveReport {
  skipped?: string
  candidates: number
  proved: number
  proposed: number
  rejected: number
  quiet: number
  carried_over: number
  closed_unseen: number
  by_kind: Record<string, number>
  ms: number
}

export const OBSERVE_JOB_ID = 'db-tuning-observe'
export const PROOF_BUDGET = 20
export const AI_BUDGET = 5
const WALL_MS = 60 * 60_000
const CLOSE_UNSEEN_DAYS = 14
let running = false
export const isObserveRunning = (): boolean => running

/** Biggest estimates first, up to `budget`; a proc rewrite's estimate is a lower bound, so the floor never drops one. */
export function selectForProof(
  cands: Candidate[],
  budget: number,
  floor: number
): { chosen: Candidate[]; carried: number } {
  const eligible = cands.filter((c) => c.kind === 'proc_rewrite' || c.estimate_ms_per_day >= floor)
  const sorted = [...eligible].sort((a, b) => b.estimate_ms_per_day - a.estimate_ms_per_day)
  return { chosen: sorted.slice(0, budget), carried: Math.max(0, sorted.length - budget) }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function procCandidates(aiAllowed: boolean): Promise<Candidate[]> {
  const sels = selectProcCandidates(await loadProcEvidence())
  const out: Candidate[] = []
  let aiUsed = 0
  for (const sel of sels) {
    let rewritten = mechanicalProcRewrite(sel.body)
    if (!rewritten && aiAllowed && aiUsed < AI_BUDGET) {
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

/** Every observer, core then extensions; one that throws is logged and the rest still run. */
async function gatherCandidates(aiAllowed: boolean): Promise<Candidate[]> {
  const out: Candidate[] = []
  const safe = async (label: string, fn: () => Promise<Candidate[]>) => {
    try {
      out.push(...(await fn()))
    } catch (err) {
      console.warn(`[db-tuning] ${label} observer failed: ${errText(err)}`)
    }
  }
  await safe('index_create', async () => observeIndexCreate(await loadIndexCreateEvidence()))
  await safe('index_drop', async () => observeIndexDrop(await loadIndexDropEvidence()))
  await safe('rollup_store', async () => observeRollupStore(await loadRollupEvidence()))
  await safe('query_cache', async () => observeQueryCache(await loadQueryCacheEvidence()))
  await safe('proc_rewrite', () => procCandidates(aiAllowed))
  await safe('extensions', runExtensionObservers)
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
  const empty: ObserveReport = {
    candidates: 0,
    proved: 0,
    proposed: 0,
    rejected: 0,
    quiet: 0,
    carried_over: 0,
    closed_unseen: 0,
    by_kind: {},
    ms: 0
  }
  const dryRun = Boolean(opts.dryRun)
  const settings = await readTuningSettings()
  if (!settings.enabled) return { ...empty, skipped: 'disabled' }
  if (!dryRun && running) return { ...empty, skipped: 'already running' }
  if (!dryRun) running = true
  let run: JobRunHandle | null = null
  try {
    if (!dryRun && opts.trigger !== 'schedule')
      run = await startJobRun('tuning', OBSERVE_JOB_ID, {
        label: 'Database tuning — observe',
        triggeredBy: opts.userId ?? null,
        trigger: opts.trigger ?? 'manual'
      })
    const runId = dryRun ? null : (run?.id ?? (await cronRunId()))
    const aiAllowed =
      !dryRun && settings.ai_rewrites && (await aiBudgetAllows(settings.ai_daily_budget_usd))
    const cands = await gatherCandidates(aiAllowed)
    // one candidate per fingerprint; quiet ones never reach a proof
    const seen = new Set<string>()
    const fresh: Candidate[] = []
    let quiet = 0
    for (const c of cands) {
      const fp = fingerprintOf(c)
      if (seen.has(fp)) continue
      seen.add(fp)
      if (await isQuiet(fp)) {
        quiet++
        continue
      }
      fresh.push(c)
    }
    const { chosen, carried } = selectForProof(
      fresh,
      PROOF_BUDGET,
      settings.min_estimate_ms_per_day
    )
    const report: ObserveReport = {
      ...empty,
      candidates: cands.length,
      quiet,
      carried_over: carried
    }
    for (const c of chosen) {
      // past the wall budget the rest carry to tomorrow night
      if (Date.now() - t0 > WALL_MS) {
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
      else if (proof.passed) report.proposed++
      else report.rejected++
    }
    if (!dryRun) report.closed_unseen = await closeUnseen(CLOSE_UNSEEN_DAYS)
    report.ms = Date.now() - t0
    await run?.complete(observeSummary(report))
    return report
  } catch (err) {
    await run?.fail(err)
    throw err
  } finally {
    if (!dryRun) running = false
  }
}

export function observeSummary(r: ObserveReport): string {
  if (r.skipped) return `skipped: ${r.skipped}`
  return `${r.proposed} proposed, ${r.rejected} rejected by proof, ${r.quiet} quiet, ${r.carried_over} carried, ${r.closed_unseen} closed unseen`
}
