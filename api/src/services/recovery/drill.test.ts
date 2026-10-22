import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The restore drill runner against a fake SQL Server: every batch the drill sends is logged and
 * answered by pattern, so the order (claim → FILELISTONLY → RESTORE → smoke → DROP), the refusals
 * and the cleanup rules are proven without touching a real server. Ownership comes from an
 * in-memory ledger over the real ownsFrom().
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

const { runRestoreDrill, notTakenGuard, ownsFrom, localToUtc } = await import('./drill.js')
type DrillResult = Awaited<ReturnType<typeof runRestoreDrill>>
type DrillLedger = import('./drill.js').DrillLedger
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

/** In-memory ledger, newest first. `prior` = earlier runs' claims on a name. */
function memLedger(
  prior: Array<{ scratch: string; dropped: boolean | null }> = [],
  opts: { claimFails?: boolean } = {}
): DrillLedger & { results: Array<DrillResult | null> } {
  const results = prior.map(
    (p) =>
      ({
        kind: 'restore-drill',
        claim: { scratch_db: p.scratch, run_id: 1, claimed_at: '2026-10-21T06:00:00.000Z' },
        dropped: p.dropped
      }) as DrillResult
  ) as Array<DrillResult | null>
  return {
    results,
    claim: async (r) => {
      if (opts.claimFails) throw new Error('job run 7 was not updated')
      results.unshift(r) // the live object: its `dropped` updates as the run goes
    },
    owns: async (s) => ownsFrom(results, s)
  }
}

interface World {
  msdbError?: Error
  canCreate?: number
  fileListError?: Error
  free?: number
  existing?: { state: string; marker: boolean } | null
  restoreError?: Error
  /** The failed RESTORE leaves a RESTORING copy behind. */
  restoreLeaves?: boolean
  propertyError?: Error
  dropError?: Error
  copyTables?: Record<string, number>
  withDiff?: boolean
}

function world(w: World = {}): Handler {
  let exists = w.existing ?? null
  return (sql) => {
    if (/FROM msdb\.dbo\.backupset bs WHERE/.test(sql)) {
      if (w.msdbError) throw w.msdbError
      // msdb shape: server-local text + time_zone in 15-minute units (-16 = UTC-4, EDT)
      const rows: unknown[] = [
        {
          backup_set_id: 10,
          media_set_id: 10,
          position: 1,
          type: 'D',
          start_local: '2026-10-21T02:00:00',
          finish_local: '2026-10-21T02:30:00',
          tz: -16,
          server_offset_min: 240,
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
          finish_local: '2026-10-22T02:30:00',
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
    if (/^IF DB_ID\(N'nivaro_restore_drill_EFP_Development'\) IS NOT NULL THROW/.test(sql)) {
      if (exists) throw new Error('nivaro-restore-drill: scratch name taken')
    }
    if (/RESTORE DATABASE/.test(sql)) {
      if (w.restoreError) {
        if (w.restoreLeaves) exists = { state: 'RESTORING', marker: false }
        throw w.restoreError
      }
      exists = { state: 'ONLINE', marker: false }
      return []
    }
    if (/sp_addextendedproperty/.test(sql)) {
      if (w.propertyError) throw w.propertyError
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
      if (w.dropError) throw w.dropError
      exists = null
      return []
    }
    return []
  }
}

const sent = (re: RegExp) => fake.log.filter((s) => re.test(s))
const indexOf = (re: RegExp) => fake.log.findIndex((s) => re.test(s))
const run = (ledger: DrillLedger = memLedger(), over: Record<string, unknown> = {}) =>
  runRestoreDrill({ dryRun: false, settings: settings(over), ledger })

beforeEach(() => {
  fake.log = []
  delete process.env.RESTORE_DRILL_DB
})
afterEach(() => {
  delete process.env.RESTORE_DRILL_DB
})

describe('localToUtc (msdb times)', () => {
  it('converts server-local text with time_zone in 15-minute units (real dev row)', () => {
    // EFP_Development, read-only on 2026-10-22: finish_local 2026-10-22T00:06:24, time_zone -16,
    // server UTC − local = 240 min (EDT). The only time_zone value on that server in 400 days: -16.
    expect(localToUtc('2026-10-22T00:06:24', -16, 240)).toBe('2026-10-22T04:06:24.000Z')
    expect(localToUtc('2026-10-22T00:06:24.500', -16, 240)).toBe('2026-10-22T04:06:24.500Z')
    expect(localToUtc('2026-01-15T00:00:00', -20, 300)).toBe('2026-01-15T05:00:00.000Z')
    expect(localToUtc('2026-10-22T00:00:00', 22, 0)).toBe('2026-10-21T18:30:00.000Z') // UTC+5:30
  })
  it('falls back to the server offset for time_zone 127 (unknown) or junk', () => {
    expect(localToUtc('2026-10-22T00:06:24', 127, 240)).toBe('2026-10-22T04:06:24.000Z')
    expect(localToUtc('2026-10-22T00:06:24', null, 240)).toBe('2026-10-22T04:06:24.000Z')
    expect(localToUtc('2026-10-22T00:06:24', 127, null)).toBe('2026-10-22T00:06:24.000Z')
    expect(localToUtc('not a date', -16, 240)).toBe('not a date')
    expect(localToUtc(null, -16, 240)).toBe('')
  })
})

describe('ownsFrom', () => {
  const r = (scratch: string, dropped: boolean | null) =>
    ({ claim: { scratch_db: scratch, run_id: 1, claimed_at: '' }, dropped }) as DrillResult
  it('the newest claim on the name decides: ours until that run confirmed the drop', () => {
    expect(ownsFrom([], SCRATCH)).toBe(false)
    expect(ownsFrom([r(SCRATCH, null)], SCRATCH)).toBe(true)
    expect(ownsFrom([r(SCRATCH, false)], SCRATCH)).toBe(true)
    expect(ownsFrom([r(SCRATCH, true), r(SCRATCH, null)], SCRATCH)).toBe(false)
    expect(ownsFrom([r('nivaro_restore_drill_other', null)], SCRATCH)).toBe(false)
    expect(ownsFrom([null, r(SCRATCH.toUpperCase(), null)], SCRATCH)).toBe(true)
  })
})

describe('runRestoreDrill', () => {
  it('claims, restores full + differential, smoke-checks, measures and drops the copy', async () => {
    fake.handler = world({ withDiff: true })
    const phases: string[] = []
    const ledger = memLedger()
    const r = await runRestoreDrill({
      dryRun: false,
      settings: settings(),
      ledger,
      onPhase: (x) => void phases.push(x.phase ?? '')
    })
    expect(r.verdict).toBe('passed')
    expect(r.claim?.scratch_db).toBe(SCRATCH)
    expect(ledger.results[0]).toBe(r) // claimed before restoring
    expect(r.plan?.diff?.backup_set_id).toBe(11)
    expect(r.plan?.point_utc).toBe('2026-10-22T06:30:00.000Z')
    expect(r.backup_age_s).toBeGreaterThan(0)
    expect(r.restore_ms).not.toBeNull()
    expect(r.marked).toBe(true)
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
    // the ledger now says the name is free (this run confirmed the drop)
    expect(await ledger.owns(SCRATCH)).toBe(false)
  })

  it('never restores without a recorded ownership claim', async () => {
    fake.handler = world()
    const r = await run(memLedger([], { claimFails: true }))
    expect(r.verdict).toBe('blocked')
    expect(r.reason).toMatch(/Could not record the drill's ownership claim .*job run 7/)
    expect(sent(/RESTORE DATABASE|DROP DATABASE/)).toEqual([])
    // no ledger at all (a dry-run ledger) refuses the same way
    fake.log = []
    const r2 = await runRestoreDrill({ dryRun: false, settings: settings() })
    expect(r2.verdict).toBe('blocked')
    expect(sent(/RESTORE DATABASE/)).toEqual([])
  })

  it('fails on a smoke failure and still drops the copy', async () => {
    fake.handler = world({ copyTables: { nivaro_collections: 40, nivaro_activity: 0 } })
    const r = await run()
    expect(r.verdict).toBe('failed')
    expect(r.smoke?.failures).toEqual([
      'nivaro_fields is missing from the restored copy',
      'nivaro_activity is empty in the restored copy but holds 7 rows live'
    ])
    expect(sent(/DROP DATABASE/)).toHaveLength(1)
  })

  it('a failed RESTORE drops what it left behind, and sends no DROP when nothing exists', async () => {
    fake.handler = world({
      restoreError: new Error('The media family on device is incorrectly formed'),
      restoreLeaves: true
    })
    let r = await run()
    expect(r.verdict).toBe('failed')
    expect(r.reason).toMatch(/RESTORE of the full backup failed: The media family/)
    expect(r.dropped).toBe(true)
    expect(sent(/DROP DATABASE/)).toHaveLength(1)

    fake.log = []
    fake.handler = world({
      restoreError: new Error('The media family on device is incorrectly formed')
    })
    r = await run()
    expect(r.verdict).toBe('failed')
    expect(r.dropped).toBeNull()
    expect(sent(/DROP DATABASE|SINGLE_USER/)).toEqual([])
  })

  it('refuses a database under the scratch name that no run claimed: ONLINE, marked or RESTORING', async () => {
    for (const existing of [
      { state: 'ONLINE', marker: false },
      { state: 'ONLINE', marker: true }, // the property alone is never proof
      { state: 'RESTORING', marker: false }
    ]) {
      fake.log = []
      fake.handler = world({ existing })
      const r = await run()
      expect(r.verdict).toBe('blocked')
      expect(r.reason).toMatch(/already exists and no drill run recorded creating it/)
      expect(sent(/RESTORE DATABASE|DROP DATABASE|SINGLE_USER/)).toEqual([])
    }
    // a name an earlier run already confirmed dropped is someone else's now
    fake.log = []
    fake.handler = world({ existing: { state: 'RESTORING', marker: false } })
    const r = await run(memLedger([{ scratch: SCRATCH, dropped: true }]))
    expect(r.verdict).toBe('blocked')
  })

  it('drops its own leftover (an earlier run claimed it, never confirmed the drop) first', async () => {
    for (const existing of [
      { state: 'ONLINE', marker: true },
      { state: 'ONLINE', marker: false },
      { state: 'RESTORING', marker: false }
    ]) {
      fake.log = []
      fake.handler = world({ existing })
      const r = await run(memLedger([{ scratch: SCRATCH, dropped: null }]))
      expect(r).toMatchObject({ verdict: 'passed', leftover_dropped: true })
      expect(indexOf(/DROP DATABASE/)).toBeLessThan(indexOf(/RESTORE DATABASE/))
    }
  })

  it('fails loudly when the copy cannot be marked, and drops it (ours by the claim)', async () => {
    fake.handler = world({ propertyError: new Error('permission denied in database') })
    const r = await run()
    expect(r.verdict).toBe('failed')
    expect(r.marked).toBe(false)
    expect(r.reason).toMatch(/could not be marked as the drill's \(permission denied/)
    expect(r.dropped).toBe(true)
    expect(sent(/sys\.partitions/)).toEqual([]) // stopped before the smoke
  })

  it('a copy that cannot be dropped turns a passed drill into failed', async () => {
    fake.handler = world({ dropError: new Error('Cannot drop database because it is in use') })
    const r = await run()
    expect(r.verdict).toBe('failed')
    expect(r.dropped).toBe(false)
    expect(r.reason).toMatch(/is still on the server: it could not be dropped \(Cannot drop/)
  })

  it('stops before restoring when the name is taken between the check and the RESTORE', async () => {
    const base = world()
    let checked = false
    fake.handler = (sql) => {
      if (/AS state WHERE DB_ID/.test(sql)) {
        if (checked) return [{ state: 'ONLINE' }] // someone else's database now holds the name
        checked = true
        return []
      }
      if (checked && /^IF DB_ID/.test(sql))
        throw new Error('nivaro-restore-drill: scratch name taken')
      return base(sql)
    }
    const r = await run()
    expect(r.verdict).toBe('blocked')
    expect(r.reason).toMatch(/appeared while the drill was checking/)
    expect(sent(/DROP DATABASE|SINGLE_USER/)).toEqual([])
  })

  it('records the readable reasons it cannot run: msdb, rights, path, disk', async () => {
    fake.handler = world({
      msdbError: new Error("The SELECT permission was denied on the object 'backupset'")
    })
    let r = await run()
    expect(r).toMatchObject({ verdict: 'blocked' })
    expect(r.reason).toMatch(
      /Cannot read the backup history in msdb .*SELECT permission was denied/
    )

    fake.log = []
    fake.handler = world({ canCreate: 0 })
    r = await run()
    expect(r.reason).toMatch(/lacks CREATE ANY DATABASE/)
    expect(sent(/FILELISTONLY/)).toEqual([])

    fake.handler = world({
      fileListError: new Error(
        "Cannot open backup device '\\\\nas\\sql\\EFP_10.bak'. Operating system error 5(Access is denied.)."
      )
    })
    r = await run()
    expect(r.reason).toMatch(
      /^Backup not restorable by path: the SQL Server cannot open \\\\nas\\sql\\EFP_10\.bak/
    )

    fake.log = []
    fake.handler = world({ free: 2e9 })
    r = await run()
    expect(r.reason).toMatch(/Not enough disk/)
    expect(sent(/RESTORE DATABASE/)).toEqual([])
  })

  it('dry run reads msdb and FILELISTONLY only, and never claims', async () => {
    fake.handler = world({ withDiff: true })
    const ledger = memLedger()
    const r = await runRestoreDrill({
      dryRun: true,
      settings: settings({ enabled: false }),
      ledger
    })
    expect(r.verdict).toBe('ready')
    expect(r.mode).toBe('dry_run')
    expect(r.reason).toMatch(/^Ready: would restore the full backup of .* and the differential of /)
    expect(ledger.results).toEqual([])
    expect(sent(/RESTORE FILELISTONLY/)).toHaveLength(1)
    expect(
      sent(/RESTORE DATABASE|DROP DATABASE|ALTER DATABASE|sp_addextendedproperty|sys\.partitions/)
    ).toEqual([])
  })

  it('sends nothing when off, or when the scratch name is refused', async () => {
    fake.handler = world()
    let r = await run(memLedger(), { enabled: false })
    expect(r.verdict).toBe('skipped')
    process.env.RESTORE_DRILL_DB = 'EFP_Staging'
    r = await run()
    expect(r.verdict).toBe('blocked')
    expect(r.reason).toMatch(/Scratch database refused/)
    expect(fake.log).toEqual([])
  })
})
