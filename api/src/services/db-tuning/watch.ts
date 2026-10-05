import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { cacheStats } from '../query-cache-stats.js'
import { computeRollupTotal, parseRollupFormula } from '../rollups.js'
import { procedureStats, statementsTouching } from './dmv.js'
import { getProposal, listProposals, updateProposal } from './ledger.js'
import { readTuningSettings, type TuningSettings } from './settings.js'
import { proveProcedureRewrite } from './twin.js'
import type { ProofResult, ProposalRow, WatchSample } from './types.js'

/**
 * The post-apply watch. Apply stores `captureBaseline` just before the change runs; the hourly
 * watcher samples `measure` against it, rolls a regression back and finishes a change whose
 * window passed. It also ends a claim whose apply or rollback died with its process.
 */

const T = 'nivaro_tuning_proposals'
/** Fewer judged samples than this never regress (one bad hour is not a regression). */
export const MIN_SAMPLES = 20
/** The trailing samples a regression is judged over (a day of hourly ticks). */
export const JUDGE_WINDOW = 24
const SAMPLE_CAP = 400
/** A claim older than this whose job run is over belongs to an apply/rollback that died. */
export const STUCK_CLAIM_MS = 30 * 60_000
/** The hour (UTC) the watcher re-diffs one parameter set of each watched rewrite. */
const RECHECK_UTC_HOUR = 7

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The one metric each kind is judged by (lower is better); null when nothing measures it —
 *  including when a read throws. */
export async function measure(row: ProposalRow): Promise<number | null> {
  try {
    return await measureKind(row)
  } catch {
    return null
  }
}

async function measureKind(row: ProposalRow): Promise<number | null> {
  switch (row.kind) {
    case 'index_create':
    case 'index_drop': {
      const [table, col = ''] = row.target.split('.')
      const undo = row.undo.type === 'sql' ? (row.undo.statements[0] ?? '') : ''
      const column =
        row.kind === 'index_create' ? col.split(',')[0] : (undo.match(/\(\s*\[(\w+)\]/)?.[1] ?? col)
      const stmts = await statementsTouching(table, column, 5)
      if (!stmts.length) return null
      const total = stmts.reduce((a, s) => a + s.total_elapsed_ms, 0)
      const runs = stmts.reduce((a, s) => a + s.execution_count, 0)
      return runs ? total / runs : null
    }
    case 'proc_rewrite': {
      const st = (await procedureStats()).find((p) => p.name === row.target)
      return st ? st.avg_elapsed_ms : null
    }
    case 'rollup_store': {
      // drift: stored value vs recomputed over a 20-row sample → mismatches (0 is healthy)
      const [collection, field] = row.target.split('.')
      const f = (await db('nivaro_fields')
        .where({ collection, field })
        .first('computed_formula')) as { computed_formula: string | null } | undefined
      const cfg = parseRollupFormula(f?.computed_formula ?? null)
      if (!cfg) return null
      const rows = (await db(collection)
        .select('id', field)
        .orderBy('id', 'desc')
        .limit(20)) as Array<Record<string, unknown>>
      let drift = 0
      for (const r of rows) {
        const live = await computeRollupTotal(cfg, r.id, collection)
        if (Math.abs(Number(live ?? 0) - Number(r[field] ?? 0)) > 0.005) drift++
      }
      return drift
    }
    case 'query_cache': {
      const s = cacheStats().rows.find((r) => r.slug === row.target)
      return s?.avg_exec_ms ?? null
    }
  }
}

export async function captureBaseline(row: ProposalRow): Promise<Record<string, number | null>> {
  return { metric: await measure(row) }
}

/**
 * Pure: over the trailing 24 measured samples, at least 20 are worse than the baseline by more
 * than pct. A trailing window (not the whole history) so a regression that starts late in the
 * watch is still caught; one bad hour never is.
 */
export function judgeRegression(
  samples: WatchSample[],
  baseline: number | null,
  pct: number
): { regressed: boolean; reason: string } {
  const vals = samples
    .map((s) => s.value)
    .filter((v): v is number => v != null && Number.isFinite(v))
  if (baseline == null || baseline <= 0) return { regressed: false, reason: 'no baseline' }
  if (vals.length < MIN_SAMPLES)
    return { regressed: false, reason: `${vals.length} of ${MIN_SAMPLES} samples` }
  const limit = baseline * (1 + pct / 100)
  const window = vals.slice(-JUDGE_WINDOW)
  const bad = window.filter((v) => v > limit).length
  return {
    regressed: bad >= MIN_SAMPLES,
    reason: `${bad} of ${window.length} trailing samples above ${Math.round(limit)} (baseline ${Math.round(baseline)}, +${pct}%)`
  }
}

// ─── Stuck claims ───────────────────────────────────────────────────────────────────────

export interface ClaimRun {
  status: string
  started_at: Date | string | null
}

/**
 * Pure: an `applying` claim is stuck when its job run is over (a restart marks it interrupted)
 * and started more than 30 minutes ago. A claim with no run record (bookkeeping degraded) is
 * timed from when the watcher first saw it. A running run is never stuck: a long backfill or
 * index build is still working.
 */
export function isStuckClaim(
  run: ClaimRun | null,
  firstSeenAt: number | null,
  now: number
): boolean {
  if (run?.status === 'running') return false
  const started = run?.started_at ? new Date(run.started_at).getTime() : Number.NaN
  if (run && Number.isFinite(started)) return now - started > STUCK_CLAIM_MS
  return firstSeenAt != null && now - firstSeenAt > STUCK_CLAIM_MS
}

/** First sighting of a claim with no run record, by proposal id (this process). */
const runlessSince = new Map<string, number>()

export type ClaimJob = 'apply' | 'rollback' | 'apply or rollback'

/** One claim: a re-claim of the same row (a new run, or none) starts its own clock. */
const claimKey = (row: ProposalRow) => `${row.id}:${row.run_id ?? '-'}`

/** The `applying` rows whose apply or rollback is no longer running, with which one it was. */
export async function stuckClaims(
  now = Date.now()
): Promise<Array<{ row: ProposalRow; job: ClaimJob }>> {
  const rows = await listProposals({ status: ['applying'] })
  const claimed = new Set(rows.map(claimKey))
  for (const key of runlessSince.keys()) if (!claimed.has(key)) runlessSince.delete(key)
  const ids = rows.map((r) => r.run_id).filter((id): id is number => id != null)
  const runs = ids.length
    ? ((await db('nivaro_job_runs')
        .whereIn('id', ids)
        .select('id', 'job_id', 'status', 'started_at')) as Array<Record<string, unknown>>)
    : []
  const byId = new Map(runs.map((r) => [Number(r.id), r]))
  const out: Array<{ row: ProposalRow; job: ClaimJob }> = []
  for (const row of rows) {
    const run = row.run_id == null ? undefined : byId.get(row.run_id)
    const key = claimKey(row)
    if (!run && !runlessSince.has(key)) runlessSince.set(key, now)
    const claimRun = run
      ? { status: String(run.status), started_at: run.started_at as Date | string | null }
      : null
    if (!isStuckClaim(claimRun, runlessSince.get(key) ?? null, now)) continue
    const jobId = String(run?.job_id ?? '')
    const job: ClaimJob = !run
      ? 'apply or rollback'
      : jobId.startsWith('tuning:rollback:')
        ? 'rollback'
        : 'apply'
    out.push({ row, job })
  }
  return out
}

// ─── The hourly watch ───────────────────────────────────────────────────────────────────

export interface WatchReport {
  checked: number
  rolled_back: number
  finished: number
  /** Claims ended as failed because their apply/rollback died. */
  stuck: number
  dry_run: boolean
  /** One line per row the run acted on (or, dry, would act on). */
  actions: string[]
}

const NO_PROOF: ProofResult = {
  passed: true,
  method: 'usage-stats',
  before: {},
  after: {},
  detail: ''
}

/**
 * The nightly re-diff of a watched rewrite: the twin is the PREVIOUS body and "old" EXECs the
 * live procedure (the rewrite), one recorded parameter set per night in turn. The row diff is
 * symmetric, which is all it needs; the timing verdict is ignored (the old body is the slow one).
 */
async function recheckRewrite(
  row: ProposalRow,
  settings: TuningSettings,
  note: (line: string) => void
): Promise<string | null> {
  if (row.apply.type !== 'proc_body' || row.undo.type !== 'proc_body') return null
  const sets =
    (row.evidence.parameter_set_values as Array<Record<string, unknown>> | undefined) ?? []
  const index = sets.length ? Math.floor(Date.now() / 86_400_000) % sets.length : 0
  let error: string | null = null
  const re = await proveProcedureRewrite({
    proc: row.apply.proc,
    oldBody: row.apply.body,
    newBody: row.undo.body,
    paramSets: sets.length ? [sets[index]] : [],
    timeoutMs: settings.proc_timeout_minutes * 60_000
  }).catch((err: unknown) => {
    error = errText(err)
    return null
  })
  const diff = re?.rows_diff?.[0]
  if (diff)
    return `nightly re-check: parameter set #${index} differs from the previous body (+${diff.added.length} / −${diff.removed.length} rows)`
  // a re-check that judged nothing is said out loud, never read as a pass
  if (!re) note(`re-check could not run: ${row.title} — ${error ?? 'no result'}`)
  else if (re.method === 'refused') note(`re-check refused: ${row.title} — ${re.detail}`)
  else if (re.detail.startsWith('proof run failed'))
    note(`re-check could not run: ${row.title} — ${re.detail}`)
  return null
}

/** Why this row must roll back now, or null. */
async function regression(
  row: ProposalRow,
  value: number | null,
  samples: WatchSample[],
  settings: TuningSettings,
  opts: { dryRun: boolean; note: (line: string) => void }
): Promise<string | null> {
  // a stored rollup that disagrees with the live figure is wrong data, not slow data: at once
  if (row.kind === 'rollup_store' && value != null && value > 0)
    return `${value} sampled row(s) drifted from the live rollup`
  // the re-diff deploys a twin, so a dry run does not run it
  const recheck = new Date().getUTCHours() === RECHECK_UTC_HOUR
  if (row.kind === 'proc_rewrite' && !opts.dryRun && recheck) {
    const differs = await recheckRewrite(row, settings, opts.note)
    if (differs) return differs
  }
  const baseline = row.watch_baseline?.before?.metric ?? null
  const judged = judgeRegression(samples, baseline, settings.regression_pct)
  return judged.regressed ? `regressed: ${judged.reason}` : null
}

async function notifyApplier(
  app: FastifyInstance | null,
  row: ProposalRow,
  subject: string,
  message: string
): Promise<void> {
  if (!app || !row.applied_by) return
  try {
    const { notifyUser } = await import('../notification-channels.js')
    await notifyUser(app, row.applied_by, {
      subject: subject.slice(0, 200),
      message: message.slice(0, 1000),
      category: 'system',
      always_inbox: true,
      target: { kind: 'external', url: `/db-tuning?proposal=${row.id}` },
      source: { kind: 'db-tuning', label: 'Database tuning', id: row.id }
    })
  } catch {
    // the notice is decoration; the row and its activity entry carry the outcome
  }
}

const ROLLBACK_LABEL = {
  rolled_back: 'rolled back',
  failed: 'rollback failed',
  lost: 'rollback held by another claim'
} as const

/** Roll back as the system. A claim lost to an admin's click is theirs to finish. */
async function autoRollback(
  app: FastifyInstance | null,
  row: ProposalRow,
  reason: string
): Promise<'rolled_back' | 'failed' | 'lost'> {
  const { rollbackProposal } = await import('./apply.js')
  try {
    await rollbackProposal(row.id, { userId: null, reason, app })
  } catch (err) {
    const after = await getProposal(row.id).catch(() => null)
    if (after?.status !== 'failed') return 'lost'
    await notifyApplier(
      app,
      row,
      `Tuning change needs a person: ${row.title}`,
      `The watch tried to roll this change back (${reason}) and could not: ${errText(err)}. The row is failed; its undo is on the proposal.`
    )
    return 'failed'
  }
  await notifyApplier(
    app,
    row,
    `Tuning change rolled back: ${row.title}`,
    `The watch rolled this change back automatically — ${reason}.`
  )
  return 'rolled_back'
}

/**
 * Hourly: end dead claims, then sample every watching row, roll back on regression and finish
 * the ones past their window. Returns at once while database tuning is off. A dry run measures
 * and judges, and writes nothing.
 */
export async function runWatch(
  app: FastifyInstance | null,
  opts: { dryRun?: boolean } = {}
): Promise<WatchReport> {
  const dryRun = opts.dryRun === true
  const out: WatchReport = {
    checked: 0,
    rolled_back: 0,
    finished: 0,
    stuck: 0,
    dry_run: dryRun,
    actions: []
  }
  const settings = await readTuningSettings()
  if (!settings.enabled) return out

  // No undo here: the process that died may have run part of the change, and a person reads
  // the failed row (and its undo) before anything else runs.
  for (const { row, job } of await stuckClaims()) {
    const detail = `${job} did not finish (process restart?)`
    if (dryRun) {
      out.stuck++
      out.actions.push(`would mark failed: ${row.title} — ${detail}`)
      continue
    }
    const n = await db(T)
      .where({ id: row.id, status: 'applying', run_id: row.run_id })
      .update({ status: 'failed', rollback_reason: detail })
    if (!Number(n)) continue
    out.stuck++
    out.actions.push(`marked failed: ${row.title} — ${detail}`)
  }

  for (const row of await listProposals({ status: ['watching'] })) {
    out.checked++
    try {
      const value = await measure(row)
      const sample: WatchSample = { at: new Date().toISOString(), value }
      const samples = [...(row.proof?.watch ?? []), sample].slice(-SAMPLE_CAP)
      if (!dryRun)
        await updateProposal(row.id, { proof: { ...(row.proof ?? NO_PROOF), watch: samples } })
      const reason = await regression(row, value, samples, settings, {
        dryRun,
        note: (line) => out.actions.push(line)
      })
      if (reason) {
        if (dryRun) {
          out.rolled_back++
          out.actions.push(`would roll back: ${row.title} — ${reason}`)
          continue
        }
        const result = await autoRollback(app, row, reason)
        if (result === 'rolled_back') out.rolled_back++
        out.actions.push(`${ROLLBACK_LABEL[result]}: ${row.title} — ${reason}`)
        continue
      }
      if (!row.watch_until || new Date(row.watch_until).getTime() >= Date.now()) continue
      if (dryRun) {
        out.finished++
        out.actions.push(`would finish: ${row.title}`)
        continue
      }
      // only from watching: an admin's rollback may hold the row by now
      const n = await db(T).where({ id: row.id, status: 'watching' }).update({ status: 'applied' })
      if (Number(n)) {
        out.finished++
        out.actions.push(`finished: ${row.title}`)
      }
    } catch (err) {
      out.actions.push(`watch failed: ${row.title} — ${errText(err)}`)
    }
  }
  return out
}

export function watchSummary(r: WatchReport): string {
  const head = `${r.checked} checked, ${r.rolled_back} rolled back, ${r.finished} finished, ${r.stuck} stuck claim(s) failed`
  return r.actions.length ? `${head} — ${r.actions.slice(0, 10).join('; ')}` : head
}
