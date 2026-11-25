import { readBackupHistory } from '../../recovery/drill.js'
import { planRestore } from '../../recovery/plan.js'
import { judgeSmoke, KEY_TABLES } from '../../recovery/smoke.js'
import {
  envData,
  errText,
  type ServerOpener,
  type SqlExec,
  serverAccessOf,
  withServerExec
} from './env-db.js'
import { checkdbSql, headerSql, scratchName } from './mssql-sql.js'
import { readPolicy } from './policy.js'
import { type RunnerDeps, startDataRun } from './runner.js'
import { keptArtifacts } from './runs.js'
import { countTables, dropScratch, ledgerOf, restoreScratch } from './scratch.js'
import { DataError } from './types.js'

/**
 * Hub data care — the restore drill: "a backup that has never been restored is not a backup".
 *
 *  1. pick the newest backup: the Hub's own newest kept backup file of the environment, else the
 *     newest full backup msdb lists on a disk path (a backup agent's virtual device is not
 *     restorable by path: the drill says so, as the Telemetry drill does)
 *  2. restore it into this run's scratch database on the same server (never REPLACE, never the
 *     live database), timed: the measured time-to-restore
 *  3. the app's database checks on the copy: it opens, every key table that exists live exists
 *     and is non-empty where live is non-empty (recovery/smoke.ts judgeSmoke), the migration
 *     ledger is there, and optionally DBCC CHECKDB (PHYSICAL_ONLY)
 *  4. drop the scratch copy — always, in the runner's cleanup
 *
 * The app's process checks (preflight, readiness) against a copy are the move rehearsal's job;
 * a drill proves the backup restores and the restored database is the app's.
 */

export const DRILL_STEPS = [
  { key: 'pick', label: 'Pick the newest backup' },
  { key: 'restore', label: 'Restore it into a scratch database' },
  { key: 'checks', label: 'Check the restored copy' },
  { key: 'checkdb', label: 'Consistency check (DBCC CHECKDB)' },
  { key: 'drop', label: 'Drop the scratch copy' }
] as const

export interface DrillDeps extends RunnerDeps {
  opener?: ServerOpener
}

/** The newest backup file to drill: the Hub's own (still readable), else msdb's newest on disk. */
export async function pickDrillBackup(
  exec: SqlExec,
  envId: number,
  database: string
): Promise<{
  file: string
  from: 'hub' | 'msdb'
  finished_at: string | null
  checksums: boolean
}> {
  const kept = await keptArtifacts(envId, 'db_backup')
  for (const r of [...kept].reverse()) {
    const file = typeof r.artifact?.file === 'string' ? r.artifact.file : null
    if (!file) continue
    try {
      await exec(headerSql(file))
      return {
        file,
        from: 'hub',
        finished_at: (r.artifact?.finished_at as string | null) ?? r.finished_at,
        checksums: true
      }
    } catch {
      // gone or unreadable: try an older one, then msdb
    }
  }
  const history = await readBackupHistory(database, (sql) => exec(sql))
  const plan = planRestore(history.sets, history.families)
  if (!plan.ok || !plan.full)
    throw new DataError(
      'NO_BACKUP',
      plan.message || 'No backup of this database can be restored by path.'
    )
  if (plan.full.devices.length !== 1)
    throw new DataError(
      'NO_BACKUP',
      'The newest full backup is striped over several files: the Hub drills single-file backups.'
    )
  return {
    file: plan.full.devices[0],
    from: 'msdb',
    finished_at: plan.full.finish_utc,
    checksums: plan.full.has_checksums
  }
}

export async function startRestoreDrill(
  envId: number,
  o: { by: string | null; via?: 'person' | 'schedule' },
  deps: DrillDeps = {}
): Promise<number> {
  const data = await envData(envId)
  const access = serverAccessOf(data)
  const policy = await readPolicy(envId)
  const opener = deps.opener ?? withServerExec
  let scratch = ''
  return startDataRun({
    kind: 'restore_drill',
    environmentId: envId,
    envIds: [envId],
    steps: DRILL_STEPS,
    by: o.by,
    via: o.via,
    deps,
    body: (ctx) =>
      opener(access, async (exec) => {
        scratch = scratchName('d', ctx.id)
        const box: { picked: Awaited<ReturnType<typeof pickDrillBackup>> | null } = { picked: null }
        await ctx.step('pick', async () => {
          const p = await pickDrillBackup(exec, envId, access.database)
          box.picked = p
          return `${p.from === 'hub' ? 'Hub backup' : 'Server backup'} ${p.file}${p.finished_at ? ` taken ${p.finished_at}` : ''}.`
        })
        const chosen = box.picked
        if (!chosen) throw new DataError('NO_BACKUP', 'No backup was picked.')
        let restoreMs = 0
        await ctx.step('restore', async () => {
          restoreMs = (await restoreScratch(exec, scratch, chosen.file, ctx.id, chosen.checksums))
            .ms
          return `Restored into ${scratch} in ${Math.round(restoreMs / 1000)} s.`
        })
        let smoke: ReturnType<typeof judgeSmoke> | null = null
        let ledger: Awaited<ReturnType<typeof ledgerOf>> = null
        await ctx.step('checks', async () => {
          const [live, restored] = await Promise.all([
            countTables(exec, access.database, KEY_TABLES),
            countTables(exec, scratch, KEY_TABLES)
          ])
          smoke = judgeSmoke({ opened: true, live, restored, checksums: [] })
          ledger = await ledgerOf(exec, scratch)
          if (!ledger || ledger.count === 0)
            throw new DataError(
              'NO_BACKUP',
              'The restored copy has no migration ledger: it is not this app’s database.'
            )
          const s = smoke as ReturnType<typeof judgeSmoke>
          if (!s.passed) throw new DataError('NO_BACKUP', s.summary)
          return `${s.summary} Ledger: ${ledger.count} migrations (newest ${ledger.latest}).`
        })
        let checkdb: { ok: boolean; ms: number; error: string | null } | null = null
        await ctx.step('checkdb', async () => {
          if (!policy.drill_checkdb) return { skipped: true, note: 'Off on the policy.' }
          const t0 = Date.now()
          try {
            await exec(checkdbSql(scratch))
            checkdb = { ok: true, ms: Date.now() - t0, error: null }
            return 'No consistency errors.'
          } catch (err) {
            checkdb = { ok: false, ms: Date.now() - t0, error: errText(err).slice(0, 300) }
            throw new DataError('NO_BACKUP', `DBCC CHECKDB found problems: ${checkdb.error}`)
          }
        })
        await ctx.step('drop', async () => {
          const r = await dropScratch(exec, scratch, ctx.id)
          return r === 'dropped' ? `${scratch} dropped.` : `${scratch}: ${r}.`
        })
        return {
          result: {
            backup: chosen,
            scratch,
            restore_ms: restoreMs,
            backup_age_s: chosen.finished_at
              ? Math.round((Date.now() - Date.parse(chosen.finished_at)) / 1000)
              : null,
            smoke,
            ledger,
            checkdb
          }
        }
      }),
    // The copy goes whatever happened (a failed check, a lost connection).
    cleanup: async (ctx) => {
      if (!scratch) return
      await opener(access, async (exec) => {
        const r = await dropScratch(exec, scratch, ctx.id)
        if (r === 'dropped') ctx.log(`hub data drill: ${scratch} dropped in cleanup`)
      }).catch(() => undefined)
    }
  })
}
