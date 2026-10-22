import { config } from '../../config.js'
import { errorText } from '../../lib/db-refusal.js'
import { currentTenantKey } from '../tenant-rooms.js'
import {
  type DrillResult,
  type DrillRunRow,
  isDrillRunning,
  listDrillRuns,
  readBackupHistory
} from './drill.js'
import { type DrillDigest, judgeRecovery, type RecoveryRow, type RecoveryTone } from './judge.js'
import { type NewestBackups, newestBackups, scratchNameRefusal } from './plan.js'
import {
  type EffectiveRecovery,
  effectiveRecovery,
  getRecoverySettings,
  scratchNameFor
} from './settings.js'

/**
 * Everything the RPO / RTO panel (#2802) and the telemetry AI tool show, in one read: the stated
 * targets, the newest database backups (msdb), the newest uploads backup (the monitoring store's
 * efp_backup_last_success_timestamp_seconds{part=~"uploads.*"}), the restore drill's newest
 * results (nivaro_job_runs), the chaos recovery feed — and one judged row per question. Each
 * source is read on its own; one failing never blanks the others. msdb + chaos are cached 60 s.
 */

export interface RecoveryStatus {
  tone: RecoveryTone
  rows: RecoveryRow[]
  targets: { rpo_minutes: number; rto_minutes: number; source: EffectiveRecovery['targets_source'] }
  runbook_url: string | null
  runbook_source: 'env' | 'setting' | null
  database: string
  db_backups: { newest: NewestBackups | null; error: string | null }
  uploads: { age_s: number | null; part: string | null; error: string | null }
  drill: {
    enabled: boolean
    enabled_source: 'env' | 'setting'
    cloud: boolean
    scratch_db: string
    scratch_source: 'env' | 'setting' | 'default'
    scratch_refusal: string | null
    schedule: string
    running: { since: string; phase: string | null } | null
    queued: boolean
    last: DrillResult | null
    last_passed: DrillResult | null
    history: Array<{
      id: number
      status: string
      started_at: string
      finished_at: string | null
      trigger: string | null
      verdict: string | null
      reason: string | null
      restore_ms: number | null
      backup_age_s: number | null
    }>
    error: string | null
    settings: EffectiveRecovery['restore_drill']
  }
  chaos: {
    runs: number
    ttr_median_s: number | null
    ttr_p90_s: number | null
    ttd_median_s: number | null
    not_recovered: number
    window_days: number
  } | null
  chaos_error: string | null
  computed_at: string
}

export const DRILL_SCHEDULE = '30 2 * * *'

const slow = new Map<
  string,
  {
    at: number
    db: RecoveryStatus['db_backups']
    chaos: RecoveryStatus['chaos']
    chaosError: string | null
  }
>()

/** Manual runs waiting for the heavy slot on this process (cleared when the run row exists). */
const queued = new Map<string, number>()
export function markDrillQueued(on: boolean): void {
  if (on) queued.set(currentTenantKey(), Date.now())
  else queued.delete(currentTenantKey())
}

export function resetRecoveryStatusForTests(): void {
  slow.clear()
  queued.clear()
}

async function dbBackups(): Promise<RecoveryStatus['db_backups']> {
  if (config.DB_CLIENT !== 'mssql')
    return { newest: null, error: 'backup history needs SQL Server' }
  try {
    const h = await readBackupHistory(config.DB_DATABASE)
    return { newest: newestBackups(h.sets, h.families), error: null }
  } catch (err) {
    return { newest: null, error: errorText(err, 300) }
  }
}

async function chaosFeed(): Promise<{ chaos: RecoveryStatus['chaos']; error: string | null }> {
  try {
    const [{ listRuns }, { figuresFor }, { buildTrends }, { claimStatuses }, { listFaults }] =
      await Promise.all([
        import('../chaos/runs.js'),
        import('../chaos/report-data.js'),
        import('../chaos/trends.js'),
        import('../chaos/claims.js'),
        import('../chaos/catalog.js')
      ])
    const runs = await listRuns({ limit: 500 })
    const figures = await figuresFor(runs.filter((r) => r.verdict && r.fault_key))
    const t = buildTrends({
      runs,
      figures,
      claims: claimStatuses(runs),
      catalog: listFaults(),
      months: 1
    })
    return { chaos: t.recovery, error: null }
  } catch (err) {
    return { chaos: null, error: errorText(err, 200) }
  }
}

async function uploadsAge(): Promise<RecoveryStatus['uploads']> {
  try {
    const { telemetryStatus } = await import('../telemetry-status.js')
    const s = await telemetryStatus()
    if (!s.settings.store.configured)
      return { age_s: null, part: null, error: 'the telemetry store is not configured' }
    if (s.stack.backups.error) return { age_s: null, part: null, error: s.stack.backups.error }
    const ups = s.stack.backups.items.filter((b) => /^uploads/i.test(b.part))
    if (!ups.length) return { age_s: null, part: null, error: null }
    const newest = ups.reduce((a, b) => (a.age_s <= b.age_s ? a : b))
    return { age_s: newest.age_s, part: newest.part, error: null }
  } catch (err) {
    return { age_s: null, part: null, error: errorText(err, 200) }
  }
}

const digest = (r: DrillResult | null, finishedAt: string | null): DrillDigest | null =>
  r
    ? {
        verdict: r.verdict,
        reason: r.reason,
        finished_at: r.finished_at ?? finishedAt,
        restore_ms: r.restore_ms,
        backup_age_s: r.backup_age_s
      }
    : null

export async function recoveryStatus(
  opts: { fresh?: boolean; now?: number } = {}
): Promise<RecoveryStatus> {
  const now = opts.now ?? Date.now()
  const eff = effectiveRecovery(await getRecoverySettings())
  const tenant = currentTenantKey()
  let s = slow.get(tenant)
  if (!s || opts.fresh || now - s.at > 60_000) {
    const [db, chaos] = await Promise.all([dbBackups(), chaosFeed()])
    s = { at: now, db, chaos: chaos.chaos, chaosError: chaos.error }
    slow.set(tenant, s)
  }
  const uploads = await uploadsAge()

  let runs: DrillRunRow[] = []
  let drillError: string | null = null
  try {
    runs = await listDrillRuns(15)
  } catch (err) {
    drillError = errorText(err, 200)
  }
  const done = runs.filter((r) => r.status !== 'running' && r.result && r.result.mode === 'run')
  const judged = done.filter((r) => r.result!.verdict !== 'skipped')
  const last = judged[0] ?? null
  const lastPassed = judged.find((r) => r.result!.verdict === 'passed') ?? null
  const live = runs.find(
    (r) => r.status === 'running' && now - Date.parse(r.started_at) < 4 * 3_600_000
  )
  const queuedAt = queued.get(tenant)
  if (queuedAt && (live || now - queuedAt > 3 * 3_600_000)) queued.delete(tenant)
  const scratch = scratchNameFor(eff.restore_drill, config.DB_DATABASE)

  const { rows, tone } = judgeRecovery({
    now,
    rpo_minutes: eff.targets.rpo_minutes,
    rto_minutes: eff.targets.rto_minutes,
    db: s.db,
    uploads,
    drill: {
      enabled: eff.drill_enabled,
      last: digest(last?.result ?? null, last?.finished_at ?? null),
      last_passed: digest(lastPassed?.result ?? null, lastPassed?.finished_at ?? null),
      running_since: live?.started_at ?? null
    },
    chaos: s.chaos,
    chaos_error: s.chaosError
  })

  return {
    tone,
    rows,
    targets: { ...eff.targets, source: eff.targets_source },
    runbook_url: eff.runbook_url,
    runbook_source: eff.runbook_source,
    database: config.DB_DATABASE,
    db_backups: s.db,
    uploads,
    drill: {
      enabled: eff.drill_enabled,
      enabled_source: eff.drill_enabled_source,
      cloud: eff.cloud,
      scratch_db: scratch,
      scratch_source: process.env.RESTORE_DRILL_DB?.trim()
        ? 'env'
        : eff.restore_drill.scratch_db
          ? 'setting'
          : 'default',
      scratch_refusal: scratchNameRefusal(scratch, [config.DB_DATABASE]),
      schedule: DRILL_SCHEDULE,
      running: live
        ? { since: live.started_at, phase: live.result?.phase ?? null }
        : isDrillRunning()
          ? { since: new Date(now).toISOString(), phase: null }
          : null,
      queued: !live && queued.has(tenant),
      last: last?.result ?? null,
      last_passed: lastPassed?.result ?? null,
      history: runs.map((r) => ({
        id: r.id,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        trigger: r.trigger,
        verdict: r.result?.verdict ?? null,
        reason: r.result?.reason ?? r.error,
        restore_ms: r.result?.restore_ms ?? null,
        backup_age_s: r.result?.backup_age_s ?? null
      })),
      error: drillError,
      settings: eff.restore_drill
    },
    chaos: s.chaos,
    chaos_error: s.chaosError,
    computed_at: new Date(now).toISOString()
  }
}

/** The AI tool's view: judged rows plus the facts behind them, no settings detail. */
export async function recoveryForAi() {
  const s = await recoveryStatus()
  return {
    verdict: s.tone,
    targets: { rpo_minutes: s.targets.rpo_minutes, rto_minutes: s.targets.rto_minutes },
    rows: s.rows.map((r) => ({
      question: r.label,
      status: r.tone,
      value: r.value,
      reason: r.reason
    })),
    database_backups: s.db_backups,
    uploads_backup: s.uploads,
    restore_drill: {
      enabled: s.drill.enabled,
      running: s.drill.running,
      last: s.drill.last
        ? {
            verdict: s.drill.last.verdict,
            reason: s.drill.last.reason,
            finished_at: s.drill.last.finished_at,
            restore_ms: s.drill.last.restore_ms,
            backup_age_s: s.drill.last.backup_age_s,
            smoke_failures: s.drill.last.smoke?.failures ?? []
          }
        : null,
      recent: s.drill.history.slice(0, 7).map((h) => ({
        started_at: h.started_at,
        verdict: h.verdict ?? h.status,
        restore_ms: h.restore_ms
      }))
    },
    chaos_recovery: s.chaos,
    runbook_url: s.runbook_url
  }
}
