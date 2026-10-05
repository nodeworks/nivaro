import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { type ReadinessResult, registerReadinessCheck } from '../readiness.js'
import { listProposals } from './ledger.js'
import { readTuningSettings } from './settings.js'
import { stuckClaims } from './watch.js'

/**
 * Readiness `db-tuning`: the loop is running and nothing it touched is waiting on a person.
 * Fails on a leftover `<proc>__tune` twin older than a day (a proof died and the boot sweep
 * could not drop it); warns on a stale observe run, a change watched past its window (the
 * watch is not ticking), a dead claim, or a failed apply/rollback.
 */

/** observe-run's OBSERVE_JOB_ID (the cron id) — not imported: that module loads every observer. */
const OBSERVE_JOB_ID = 'db-tuning-observe'
const OBSERVE_STALE_MS = 48 * 3_600_000
const WATCH_OVERDUE_MS = 86_400_000
const TWIN_STALE_MINUTES = 24 * 60
const MAX_BLOCKERS = 20

async function staleTwins(): Promise<string[]> {
  if (!isMssql(db)) return []
  // `_` is a LIKE wildcard: bracket it, as the boot sweep does. modify_date is server-local.
  const rows = (await db.raw(
    `SELECT p.name FROM sys.procedures p
     WHERE p.name LIKE '%[_][_]tune' AND p.is_ms_shipped = 0
       AND SCHEMA_NAME(p.schema_id) = 'dbo'
       AND p.modify_date < DATEADD(minute, -${TWIN_STALE_MINUTES}, GETDATE())`
  )) as unknown
  return (Array.isArray(rows) ? (rows as Array<{ name: string }>) : []).map((r) => r.name)
}

async function lastObserveAt(): Promise<number | null> {
  const row = (await db('nivaro_job_runs')
    .where({ job_id: OBSERVE_JOB_ID, status: 'completed' })
    .orderBy('started_at', 'desc')
    .first('started_at')) as { started_at: Date | string | null } | undefined
  const at = row?.started_at ? new Date(row.started_at).getTime() : Number.NaN
  return Number.isFinite(at) ? at : null
}

export async function tuningReadiness(now = Date.now()): Promise<ReadinessResult> {
  const settings = await readTuningSettings()
  if (!settings.enabled) return { status: 'pass', detail: 'Database tuning is off' }
  try {
    return await judgeTuning(now)
  } catch (err) {
    // a read the check cannot make (a denied catalog view, a missing table) is a warning
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'warn', detail: `Database tuning check could not run: ${msg}` }
  }
}

async function judgeTuning(now: number): Promise<ReadinessResult> {
  const fails = (await staleTwins()).map(
    (name) =>
      `Leftover twin procedure ${name} is more than a day old — a proof died before dropping it; drop it`
  )
  const warns: string[] = []
  const last = await lastObserveAt()
  if (last == null) warns.push('The nightly observe run (db-tuning-observe) has not run yet')
  else if (now - last > OBSERVE_STALE_MS)
    warns.push(
      `The nightly observe run (db-tuning-observe) last finished ${Math.floor((now - last) / 3_600_000)} h ago`
    )
  const watching = await listProposals({ status: ['watching'] })
  for (const r of watching)
    if (r.watch_until && now - new Date(r.watch_until).getTime() > WATCH_OVERDUE_MS)
      warns.push(
        `${r.title} is still watching a day past its window (${r.watch_until.slice(0, 10)}) — is db-tuning-watch ticking?`
      )
  for (const { row, job } of await stuckClaims(now))
    warns.push(`${row.title}: the ${job} did not finish (process restart?)`)
  for (const r of await listProposals({ status: ['failed'] }))
    warns.push(`${r.title} failed: ${r.rollback_reason ?? 'no reason recorded'}`)

  const blockers = [...fails, ...warns]
  if (!blockers.length)
    return { status: 'pass', detail: `${watching.length} change(s) under watch` }
  const more = blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''
  return {
    status: fails.length ? 'fail' : 'warn',
    detail: `${blockers[0]}${more}`,
    blockers: blockers.slice(0, MAX_BLOCKERS)
  }
}

export function registerTuningReadiness(): void {
  registerReadinessCheck({
    id: 'db-tuning',
    label: 'Database tuning changes are healthy',
    group: 'Operations',
    description:
      'Passes while database tuning is off. Fails on a leftover <proc>__tune twin procedure older than a day. Warns when the nightly observe run is older than 48 h, a change is still watching a day past its window, an apply or rollback died mid-run, or a change failed to apply or roll back — each needs a person.',
    run: () => tuningReadiness()
  })
}
