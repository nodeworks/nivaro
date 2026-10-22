import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The restore drill runner against a fake SQL Server: every batch the drill sends is logged and
 * answered by pattern, so the order (FILELISTONLY → RESTORE → smoke → DROP), the refusals and
 * the always-drop rule are proven without touching a real server.
 */

vi.mock('../../config.js', () => ({
  config: { DB_DATABASE: 'EFP_Development', DB_CLIENT: 'mssql' }
}))

type Handler = (sql: string) => unknown[] | Promise<unknown[]>
const fake = { log: [] as string[], handler: (() => []) as Handler }

vi.mock('../run-long.js', () => ({
  runLongSql: async (sql: string) => {
    fake.log.push(sql)
    return fake.handler(sql)
  },
  withLongConnection: async (
    fn: (c: { run: (s: string) => Promise<unknown[]>; discard: () => void }) => unknown
  ) =>
    fn({
      run: async (sql: string) => {
        fake.log.push(sql)
        return fake.handler(sql)
      },
      discard: () => {}
    })
}))

const { runRestoreDrill, notTakenGuard } = await import('./drill.js')
const { effectiveRecovery, RECOVERY_DEFAULTS } = await import('./settings.js')

const SCRATCH = 'nivaro_restore_drill_EFP_Development'
const settings = (over: Record<string, unknown> = {}) =>
  effectiveRecovery(
    {
      ...RECOVERY_DEFAULTS,
      restore_drill: { ...RECOVERY_DEFAULTS.restore_drill, enabled: true, ...over }
    },
    {}
  )

interface World {
  msdbError?: Error
  canCreate?: number
  fileListError?: Error
  free?: number
  existing?: { state: string; marker: boolean; restoredFrom?: string } | null
  restoreError?: Error
  copyTables?: Record<string, number>
  withDiff?: boolean
}

function world(w: World = {}): Handler {
  let exists = w.existing ?? null
  return (sql) => {
    if (/FROM msdb\.dbo\.backupset bs WHERE/.test(sql)) {
      if (w.msdbError) throw w.msdbError
      const rows: unknown[] = [
        {
          backup_set_id: 10,
          media_set_id: 10,
          position: 1,
          type: 'D',
          start_utc: '2026-10-21T06:00:00.000',
          finish_utc: '2026-10-21T06:30:00.000',
          checkpoint_lsn: '42000',
          database_backup_lsn: null,
          is_copy_only: false,
          is_damaged: false,
          has_backup_checksums: true,
          backup_size: 2e9,
          compressed_backup_size: 6e8
        }
      ]
      if (w.withDiff)
        rows.push({
          ...(rows[0] as object),
          backup_set_id: 11,
          media_set_id: 11,
          type: 'I',
          finish_utc: '2026-10-22T06:30:00.000',
          database_backup_lsn: '42000'
        })
      return rows
    }
    if (/backupmediafamily/.test(sql))
      return [10, 11].map((m) => ({
        media_set_id: m,
        family_sequence_number: 1,
        physical_device_name: `\\\\nas\\sql\\EFP_${m}.bak`,
        device_type: 2,
        mirror: 0
      }))
    if (/HAS_PERMS_BY_NAME/.test(sql))
      return [
        {
          can_create: w.canCreate ?? 1,
          data_path: 'D:\\Data\\',
          log_path: 'L:\\Logs\\',
          server: 'SQL01'
        }
      ]
    if (/RESTORE FILELISTONLY/.test(sql)) {
      if (w.fileListError) throw w.fileListError
      return [
        { LogicalName: 'EFP', PhysicalName: 'D:\\x.mdf', Type: 'D', FileId: 1, Size: 3e9 },
        { LogicalName: 'EFP_log', PhysicalName: 'L:\\x.ldf', Type: 'L', FileId: 2, Size: 1e9 }
      ]
    }
    if (/dm_os_volume_stats/.test(sql))
      return [
        { mount: 'D:\\', free: w.free ?? 500e9 },
        { mount: 'L:\\', free: w.free ?? 500e9 }
      ]
    if (/AS state WHERE DB_ID/.test(sql)) return exists ? [{ state: exists.state }] : []
    if (/extended_properties/.test(sql)) return exists?.marker ? [{ v: '2026-10-21' }] : []
    if (/restorehistory/.test(sql))
      return exists?.restoredFrom ? [{ src: exists.restoredFrom }] : []
    if (/^IF DB_ID\(N'nivaro_restore_drill_EFP_Development'\) IS NOT NULL THROW/.test(sql)) {
      if (exists) throw new Error('nivaro-restore-drill: scratch name taken')
    }
    if (/RESTORE DATABASE/.test(sql)) {
      if (w.restoreError) throw w.restoreError
      exists = { state: 'ONLINE', marker: false }
      return []
    }
    if (/sp_addextendedproperty/.test(sql)) {
      if (exists) exists.marker = true
      return []
    }
    if (/^SELECT CONVERT\(nvarchar\(60\), DATABASEPROPERTYEX/.test(sql))
      return [{ state: exists?.state ?? null }]
    if (/sys\.partitions/.test(sql)) {
      const copy = sql.includes(`[${SCRATCH}].sys.tables`)
      const tables: Record<string, number> = copy
        ? (w.copyTables ?? { nivaro_fields: 880, nivaro_collections: 40, nivaro_activity: 5 })
        : { nivaro_fields: 900, nivaro_collections: 41, nivaro_activity: 7 }
      return Object.entries(tables).map(([tbl, n]) => ({ sch: 'dbo', tbl, n }))
    }
    if (/CHECKSUM_AGG/.test(sql)) return [{ c: 12345 }]
    if (/DROP DATABASE/.test(sql)) {
      exists = null
      return []
    }
    return []
  }
}

const sent = (re: RegExp) => fake.log.filter((s) => re.test(s))
const indexOf = (re: RegExp) => fake.log.findIndex((s) => re.test(s))

beforeEach(() => {
  fake.log = []
  delete process.env.RESTORE_DRILL_DB
})
afterEach(() => {
  delete process.env.RESTORE_DRILL_DB
})

describe('runRestoreDrill', () => {
  it('restores full + differential, smoke-checks, measures and always drops the copy', async () => {
    fake.handler = world({ withDiff: true })
    const phases: string[] = []
    const r = await runRestoreDrill({
      dryRun: false,
      settings: settings(),
      onPhase: (x) => void phases.push(x.phase ?? '')
    })
    expect(r.verdict).toBe('passed')
    expect(r.plan?.diff?.backup_set_id).toBe(11)
    expect(r.backup_age_s).toBeGreaterThan(0)
    expect(r.restore_ms).not.toBeNull()
    expect(r.steps.map((s) => s.step)).toEqual(['full', 'diff'])
    expect(r.smoke?.passed).toBe(true)
    expect(r.dropped).toBe(true)
    expect(r.reason).toMatch(/^Restored the backup of 2026-10-22 06:30 UTC in /)
    // order: FILELISTONLY → guarded full (NORECOVERY) → diff (RECOVERY) → marker → smoke → drop
    const full = indexOf(/RESTORE DATABASE .* NORECOVERY/)
    expect(indexOf(/RESTORE FILELISTONLY/)).toBeLessThan(full)
    expect(fake.log[full].startsWith(notTakenGuard(SCRATCH))).toBe(true)
    expect(indexOf(/RESTORE DATABASE .* RECOVERY, NEW_BROKER/)).toBeGreaterThan(full)
    expect(indexOf(/sp_addextendedproperty/)).toBeGreaterThan(full)
    expect(indexOf(/DROP DATABASE \[nivaro_restore_drill_EFP_Development\]/)).toBe(
      fake.log.length - 1
    )
    expect(sent(/REPLACE/)).toEqual([])
    expect(sent(/SET SINGLE_USER WITH ROLLBACK IMMEDIATE/)).toHaveLength(1)
    expect(phases).toContain('restoring the differential')
  })

  it('fails on a smoke failure and still drops the copy', async () => {
    fake.handler = world({ copyTables: { nivaro_collections: 40, nivaro_activity: 0 } })
    const r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.verdict).toBe('failed')
    expect(r.smoke?.failures).toEqual([
      'nivaro_fields is missing from the restored copy',
      'nivaro_activity is empty in the restored copy but holds 7 rows live'
    ])
    expect(sent(/DROP DATABASE/)).toHaveLength(1)
  })

  it('fails a broken RESTORE and drops whatever it left behind', async () => {
    fake.handler = world({
      restoreError: new Error('The media family on device is incorrectly formed')
    })
    const r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.verdict).toBe('failed')
    expect(r.reason).toMatch(/RESTORE of the full backup failed: The media family/)
    expect(sent(/DROP DATABASE/)).toHaveLength(1)
  })

  it('refuses a database under the scratch name that it did not create — never drops it', async () => {
    fake.handler = world({ existing: { state: 'ONLINE', marker: false } })
    const r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.verdict).toBe('blocked')
    expect(r.reason).toMatch(/already exists and this drill did not create it/)
    expect(sent(/RESTORE DATABASE|DROP DATABASE|SINGLE_USER/)).toEqual([])
  })

  it('drops its own leftover (marked, or RESTORING from this database) before restoring', async () => {
    fake.handler = world({ existing: { state: 'ONLINE', marker: true } })
    let r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r).toMatchObject({ verdict: 'passed', leftover_dropped: true })
    expect(indexOf(/DROP DATABASE/)).toBeLessThan(indexOf(/RESTORE DATABASE/))
    fake.log = []
    fake.handler = world({
      existing: { state: 'RESTORING', marker: false, restoredFrom: 'EFP_Development' }
    })
    r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r).toMatchObject({ verdict: 'passed', leftover_dropped: true })
    fake.log = []
    fake.handler = world({
      existing: { state: 'RESTORING', marker: false, restoredFrom: 'Other_DB' }
    })
    r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.verdict).toBe('blocked')
  })

  it('stops before restoring when the name is taken between the check and the RESTORE', async () => {
    const base = world()
    let checked = false
    fake.handler = (sql) => {
      if (/AS state WHERE DB_ID/.test(sql)) {
        checked = true
        return []
      }
      if (checked && /^IF DB_ID/.test(sql))
        throw new Error('nivaro-restore-drill: scratch name taken')
      return base(sql)
    }
    const r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.verdict).toBe('blocked')
    expect(r.reason).toMatch(/appeared while the drill was checking/)
    expect(sent(/DROP DATABASE/)).toEqual([])
  })

  it('records the readable reasons it cannot run: msdb, rights, path, disk', async () => {
    fake.handler = world({
      msdbError: new Error("The SELECT permission was denied on the object 'backupset'")
    })
    let r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r).toMatchObject({ verdict: 'blocked' })
    expect(r.reason).toMatch(
      /Cannot read the backup history in msdb .*SELECT permission was denied/
    )

    fake.log = []
    fake.handler = world({ canCreate: 0 })
    r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.reason).toMatch(/lacks CREATE ANY DATABASE/)
    expect(sent(/FILELISTONLY/)).toEqual([])

    fake.handler = world({
      fileListError: new Error(
        "Cannot open backup device '\\\\nas\\sql\\EFP_10.bak'. Operating system error 5(Access is denied.)."
      )
    })
    r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.reason).toMatch(
      /^Backup not restorable by path: the SQL Server cannot open \\\\nas\\sql\\EFP_10\.bak/
    )

    fake.log = []
    fake.handler = world({ free: 2e9 })
    r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.reason).toMatch(/Not enough disk/)
    expect(sent(/RESTORE DATABASE/)).toEqual([])
  })

  it('dry run reads msdb and FILELISTONLY only', async () => {
    fake.handler = world({ withDiff: true })
    const r = await runRestoreDrill({ dryRun: true, settings: settings({ enabled: false }) })
    expect(r.verdict).toBe('ready')
    expect(r.mode).toBe('dry_run')
    expect(r.reason).toMatch(/^Ready: would restore the full backup of .* and the differential of /)
    expect(sent(/RESTORE FILELISTONLY/)).toHaveLength(1)
    expect(
      sent(/RESTORE DATABASE|DROP DATABASE|ALTER DATABASE|sp_addextendedproperty|sys\.partitions/)
    ).toEqual([])
  })

  it('sends nothing when off, or when the scratch name is refused', async () => {
    fake.handler = world()
    let r = await runRestoreDrill({ dryRun: false, settings: settings({ enabled: false }) })
    expect(r.verdict).toBe('skipped')
    process.env.RESTORE_DRILL_DB = 'EFP_Staging'
    r = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r.verdict).toBe('blocked')
    expect(r.reason).toMatch(/Scratch database refused/)
    expect(fake.log).toEqual([])
  })
})
