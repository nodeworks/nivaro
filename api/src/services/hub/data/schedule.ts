import { db } from '../../../db/index.js'
import { deploymentClient } from '../shared/deployment-client.js'
import { getShared } from '../shared/store.js'
import { startDbBackup } from './backup.js'
import { startRestoreDrill } from './drill.js'
import { envData, type ServerOpener, serverAccessOf, withServerExec } from './env-db.js'
import { startFilesBackup } from './files-backup.js'
import { isDue, listPolicies } from './policy.js'
import { expireRefresh } from './refresh.js'
import { createRun, expiredRollbacks, lastStarted, patchRun, staleRuns } from './runs.js'
import { dropScratch } from './scratch.js'
import type { BackupPolicy, DataRun, DataRunKind } from './types.js'

/**
 * Hub data care — the Hub's job `hub-data-tick` (every 5 minutes, one leader, cronTicksEnabled):
 *
 *  1. heal: a run whose heartbeat stopped (its process went away) — a refresh or a rollback
 *     becomes `interrupted` (Resume continues it, the rollback point is still there); a backup,
 *     drill or rehearsal becomes `failed`, and a drill's or rehearsal's scratch copy is dropped
 *     and a rehearsal's temporary app taken off its deployment's list
 *  2. expire: a refresh whose rollback window ended loses its rollback point and keep set
 *  3. schedule: every policy's database backup, files backup and restore drill that is due
 *     starts (DATA_BUSY = another run holds the environment: it starts on a later tick)
 */

export const DATA_TICK_JOB = 'hub-data-tick'
export const DATA_TICK_CRON = '*/5 * * * *'

export interface TickDeps {
  opener?: ServerOpener
  now?: () => Date
  start?: Partial<
    Record<'db_backup' | 'files_backup' | 'restore_drill', (envId: number) => Promise<number>>
  >
}

export interface TickReport {
  healed: number[]
  expired: number[]
  started: Array<{ env: number; kind: DataRunKind; run: number }>
  skipped: Array<{ env: number; kind: DataRunKind; why: string }>
}

async function healOne(run: DataRun, opener: ServerOpener): Promise<void> {
  if (run.kind === 'refresh' || run.kind === 'refresh_rollback') {
    await patchRun(run.id, {
      status: 'interrupted',
      error: 'The Hub process running this stopped: Resume continues it, or roll back.'
    })
    return
  }
  await patchRun(run.id, {
    status: 'failed',
    error: 'The Hub process running this stopped before it finished.',
    finished: true
  })
  const scratch =
    (run.result?.scratch as string | undefined) ?? (run.artifact?.scratch as string | undefined)
  if (run.kind === 'rehearsal' && run.artifact?.listed === true) {
    await patchRun(run.id, { artifact: { ...run.artifact, listed: false } })
    const shared = await getShared(Number(run.artifact.shared_id)).catch(() => null)
    if (shared)
      await deploymentClient(shared)
        .refresh()
        .catch(() => undefined)
  }
  if ((run.kind === 'restore_drill' || run.kind === 'rehearsal') && scratch) {
    try {
      const access = serverAccessOf(await envData(run.environment_id))
      await opener(access, (exec) => dropScratch(exec, scratch, run.id))
    } catch {
      // the next drill of this run id never comes; a DBA sees the marked copy by its name
    }
  }
}

const SCHEDULED: ReadonlyArray<{
  kind: 'db_backup' | 'files_backup' | 'restore_drill'
  on: (p: BackupPolicy) => boolean
  schedule: (p: BackupPolicy) => string | null
}> = [
  { kind: 'db_backup', on: (p) => p.db_enabled, schedule: (p) => p.db_schedule },
  { kind: 'files_backup', on: (p) => p.files_enabled, schedule: (p) => p.files_schedule },
  { kind: 'restore_drill', on: (p) => p.drill_enabled, schedule: (p) => p.drill_schedule }
]

export async function dataTick(deps: TickDeps = {}): Promise<TickReport> {
  const now = (deps.now ?? (() => new Date()))()
  const opener = deps.opener ?? withServerExec
  const report: TickReport = { healed: [], expired: [], started: [], skipped: [] }
  for (const run of await staleRuns(now)) {
    await healOne(run, opener).catch(() => undefined)
    report.healed.push(run.id)
  }
  for (const run of await expiredRollbacks(now)) {
    await expireRefresh(run, { opener }).catch(() => undefined)
    report.expired.push(run.id)
  }
  const starters = {
    db_backup: (id: number) => startDbBackup(id, { by: null, via: 'schedule' }),
    files_backup: (id: number) => startFilesBackup(id, { by: null, via: 'schedule' }),
    restore_drill: (id: number) => startRestoreDrill(id, { by: null, via: 'schedule' }),
    ...deps.start
  }
  const live = new Set(
    (
      (await db('nivaro_hub_environments').whereNot({ status: 'archived' }).pluck('id')) as Array<
        number | string
      >
    ).map(Number)
  )
  for (const p of await listPolicies()) {
    if (!live.has(p.environment_id)) continue
    const anchor = p.updated_at ? new Date(p.updated_at) : now
    for (const s of SCHEDULED) {
      if (!s.on(p)) continue
      const last = await lastStarted(p.environment_id, s.kind)
      if (!isDue(s.schedule(p), last, anchor, now)) continue
      try {
        const run = await starters[s.kind](p.environment_id)
        report.started.push({ env: p.environment_id, kind: s.kind, run })
      } catch (err) {
        const code = String((err as { code?: unknown })?.code ?? 'FAILED')
        report.skipped.push({ env: p.environment_id, kind: s.kind, why: code })
        // Busy: the next tick tries again. Anything else (no login, not SQL Server, no target)
        // is recorded as a refused run, so the schedule waits for its next time and people
        // see why.
        if (code !== 'DATA_BUSY' && code !== 'LOCK_UNAVAILABLE') {
          const id = await createRun({
            kind: s.kind,
            environmentId: p.environment_id,
            steps: [],
            via: 'schedule',
            status: 'refused'
          }).catch(() => null)
          if (id)
            await patchRun(id, { error: String((err as Error)?.message ?? err) }).catch(
              () => undefined
            )
        }
      }
    }
  }
  return report
}
