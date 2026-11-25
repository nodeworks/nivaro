import { describe, expect, it } from 'vitest'
import {
  backupChecklist,
  backupsToDelete,
  parseLastBackups
} from '../../../services/hub/data/backup.js'
import { isProductionEnv } from '../../../services/hub/data/env-db.js'
import { parseFilesStatus, setName } from '../../../services/hub/data/files-backup.js'
import {
  backupFileName,
  backupSql,
  isCompressionRefusal,
  isScratchName,
  isServerFolder,
  mapLoginSql,
  movesOverTarget,
  restoreOverSql,
  restoreScratchSql,
  scratchName
} from '../../../services/hub/data/mssql-sql.js'
import {
  checkFilesTarget,
  checkSchedule,
  emptyPolicy,
  isDue,
  isHostFolder,
  validatePolicy
} from '../../../services/hub/data/policy.js'
import {
  refreshRefusals,
  rollbackRefusal,
  trustedKeeps
} from '../../../services/hub/data/refresh.js'
import { setStep } from '../../../services/hub/data/runs.js'
import type { DataRun } from '../../../services/hub/data/types.js'

// Hub data care (migration 569): the pure pieces — SQL Server statement text, policy rules,
// refresh refusals, keep-entry trust and retention.

describe('SQL Server text', () => {
  it('names scratch databases by run and recognises only those', () => {
    expect(scratchName('d', 12)).toBe('nivaro_hub_scratch_d12')
    expect(isScratchName('nivaro_hub_scratch_r7')).toBe(true)
    expect(isScratchName('nivaro_hub_scratch_x7')).toBe(false)
    expect(isScratchName('EFP')).toBe(false)
    expect(() => scratchName('d', 0)).toThrow()
  })

  it('accepts server folders and refuses quotes, .. and relative paths', () => {
    expect(isServerFolder('F:\\SQLBackups')).toBe(true)
    expect(isServerFolder('\\\\backup01\\sql\\hub')).toBe(true)
    expect(isServerFolder('/var/opt/mssql/backup')).toBe(true)
    expect(isServerFolder("F:\\x'; DROP DATABASE x --")).toBe(false)
    expect(isServerFolder('F:\\a\\..\\b')).toBe(false)
    expect(isServerFolder('backups')).toBe(false)
    expect(isServerFolder(' F:\\x')).toBe(false)
  })

  it('makes safe backup file names', () => {
    const n = backupFileName({
      app: 'efp',
      env: 'prod-1',
      label: 'backup',
      runId: 9,
      at: new Date('2026-11-24T10:11:12Z')
    })
    expect(n).toBe('nivaro_hub_efp_prod_1_backup_20261124101112_9.bak')
  })

  it('backs up copy-only with checksums, compression optional', () => {
    const s = backupSql('EFP_Staging', 'F:\\b\\x.bak', { compression: true })
    expect(s).toContain("BACKUP DATABASE [EFP_Staging] TO DISK = N'F:\\b\\x.bak'")
    expect(s).toContain('COPY_ONLY')
    expect(s).toContain('CHECKSUM')
    expect(s).toContain('COMPRESSION')
    expect(backupSql('a', 'b', { compression: false })).not.toContain('COMPRESSION')
    expect(
      isCompressionRefusal('BACKUP DATABASE WITH COMPRESSION is not supported on Express Edition')
    ).toBe(true)
    expect(isCompressionRefusal('Cannot open backup device')).toBe(false)
  })

  it('maps the source backup onto the target’s own files, data on data and log on log', () => {
    const moves = movesOverTarget(
      [
        { logical: 'EFP', physical: 'D:\\data\\EFP.mdf', type: 'D' },
        { logical: 'EFP_2', physical: 'D:\\data\\EFP_2.ndf', type: 'D' },
        { logical: 'EFP_log', physical: 'L:\\log\\EFP_log.ldf', type: 'L' }
      ],
      [
        { logical: 'Stg', physical: 'D:\\data\\Stg.mdf', type_id: 0 },
        { logical: 'Stg_log', physical: 'L:\\log\\Stg_log.ldf', type_id: 1 }
      ],
      'k1'
    )
    expect(moves[0].physical).toBe('D:\\data\\Stg.mdf')
    expect(moves[1].physical).toBe('D:\\data\\EFP_2_k1_1.ndf')
    expect(moves[2].physical).toBe('L:\\log\\Stg_log.ldf')
    const sql = restoreOverSql('EFP_Staging', 'F:\\x.bak', moves)
    expect(sql).toContain('REPLACE')
    expect(sql).toContain('NEW_BROKER')
    expect(sql).toMatch(/SINGLE_USER WITH ROLLBACK IMMEDIATE; RESTORE DATABASE \[EFP_Staging\]/)
    expect(sql.trim().endsWith('SET MULTI_USER;')).toBe(true)
  })

  it('never restores a scratch copy with REPLACE', () => {
    const s = restoreScratchSql('nivaro_hub_scratch_d1', 'F:\\x.bak', [])
    expect(s).not.toContain('REPLACE')
    expect(restoreScratchSql('nivaro_hub_scratch_d1', 'F:\\x.bak', [], false)).not.toContain(
      'CHECKSUM'
    )
  })

  it('re-points the app login and leaves the session on master', () => {
    const s = mapLoginSql('EFP_Staging', "efp]'x")
    expect(s).toContain("[efp]]'x]")
    expect(s).toContain("N'efp]''x'")
    expect(s.trim().endsWith('USE master;')).toBe(true)
  })
})

describe('policy', () => {
  it('accepts 5-field schedules an hour or more apart', () => {
    expect(checkSchedule('0 2 * * *', 'x')).toBe('0 2 * * *')
    expect(() => checkSchedule('*/5 * * * *', 'x')).toThrow(/an hour apart/)
    expect(() => checkSchedule('0 0 2 * * *', 'x')).toThrow(/5-field/)
    expect(() => checkSchedule('nonsense', 'x')).toThrow()
  })

  it('is due once the next time after the last run has passed', () => {
    const anchor = new Date('2026-11-24T00:00:00Z')
    expect(isDue('0 2 * * *', null, anchor, new Date('2026-11-24T01:59:00Z'))).toBe(false)
    expect(isDue('0 2 * * *', null, anchor, new Date('2026-11-24T02:00:30Z'))).toBe(true)
    expect(
      isDue('0 2 * * *', new Date('2026-11-24T02:00:10Z'), anchor, new Date('2026-11-24T05:00:00Z'))
    ).toBe(false)
    expect(isDue(null, null, anchor, new Date())).toBe(false)
  })

  it('checks files targets', () => {
    expect(checkFilesTarget({ kind: 'dir', path: '/backups/hub' })).toEqual({
      kind: 'dir',
      path: '/backups/hub'
    })
    expect(() => checkFilesTarget({ kind: 'dir', path: '../x' })).toThrow()
    expect(isHostFolder('/a/../b')).toBe(false)
    expect(
      checkFilesTarget({
        kind: 's3',
        bucket: 'my-bucket',
        prefix: '/hub/',
        endpoint: 'https://s3.example.com/'
      })
    ).toEqual({
      kind: 's3',
      bucket: 'my-bucket',
      prefix: 'hub',
      region: null,
      endpoint: 'https://s3.example.com'
    })
    expect(() => checkFilesTarget({ kind: 's3', bucket: 'x', endpoint: 'http://s3' })).toThrow()
  })

  it('needs a schedule when on, a target for files, and the S3 key for an S3 target', () => {
    const base = emptyPolicy(1)
    expect(() => validatePolicy({ db_enabled: true }, base)).toThrow(/schedule/)
    expect(() =>
      validatePolicy({ files_enabled: true, files_schedule: '0 3 * * *' }, base)
    ).toThrow(/target/)
    expect(() =>
      validatePolicy(
        {
          files_enabled: true,
          files_schedule: '0 3 * * *',
          files_target: { kind: 's3', bucket: 'bkt' }
        },
        base
      )
    ).toThrow(/key/)
    const p = validatePolicy(
      { db_enabled: true, db_schedule: '0 1 * * *', db_keep_count: '5' },
      base
    )
    expect(p.db_keep_count).toBe(5)
    expect(p.db_verify).toBe(true)
    expect(() => validatePolicy({ db_path: "C:\\x'" }, base)).toThrow(/folder/)
  })
})

describe('refresh rules', () => {
  const env = (
    id: number,
    key: string,
    position: number,
    app = 1,
    db: string | null = `db${id}`
  ) => ({
    env: {
      id,
      app_id: app,
      key,
      position,
      status: 'active',
      base_url: 'https://x.test',
      placement_id: null
    },
    app: { id: app, key: 'efp', name: 'EFP' },
    siblings: [
      { id: 1, key: 'development', position: 1 },
      { id: 2, key: 'staging', position: 2 },
      { id: 3, key: 'production', position: 3 }
    ],
    production: isProductionEnv({ id, key, position }, [
      { id: 1, key: 'development', position: 1 },
      { id: 2, key: 'staging', position: 2 },
      { id: 3, key: 'production', position: 3 }
    ]),
    database: db
      ? {
          id,
          engine: 'mssql',
          host: 'h',
          port: null,
          database_name: db,
          status: 'ready',
          server_id: 1
        }
      : null,
    server: null
  })

  it('knows production by key or by being last', () => {
    expect(isProductionEnv({ id: 1, key: 'live', position: 1 }, [])).toBe(true)
    expect(
      isProductionEnv({ id: 2, key: 'uat', position: 5 }, [{ id: 1, key: 'dev', position: 1 }])
    ).toBe(true)
    expect(
      isProductionEnv({ id: 1, key: 'dev', position: 1 }, [{ id: 2, key: 'uat', position: 5 }])
    ).toBe(false)
  })

  it('copies only down, never over production, never across apps', () => {
    expect(refreshRefusals(env(3, 'production', 3), env(2, 'staging', 2))).toEqual([])
    const up = refreshRefusals(env(2, 'staging', 2), env(3, 'production', 3)).map((c) => c.id)
    expect(up).toContain('production_target')
    expect(up).toContain('not_lower')
    expect(
      refreshRefusals(env(3, 'production', 3), env(2, 'staging', 2, 9)).map((c) => c.id)
    ).toContain('other_app')
    expect(
      refreshRefusals(env(3, 'production', 3, 1, 'X'), env(2, 'staging', 2, 1, 'x')).map(
        (c) => c.id
      )
    ).toContain('same_database')
  })

  it('trusts core entries as the Hub has them and leaves out app SQL and host steps', () => {
    const t = trustedKeeps([
      {
        id: 'core:settings',
        label: 'forged',
        table: 'nivaro_settings',
        kind: 'table',
        reason: 'x'
      },
      {
        id: 'ext:a',
        label: 'A',
        table: 'ext_a',
        kind: 'columns',
        key: ['name'],
        columns: ['url'],
        reason: 'r'
      },
      {
        id: 'ext:b',
        label: 'B',
        table: 'ext_b',
        kind: 'rows',
        key: ['id'],
        where: '1=1',
        reason: 'r'
      },
      { id: 'ext:c', label: 'C', table: 'ext_c', kind: 'delegate', handled_by: 'x', reason: 'r' },
      { id: 'ext:d', label: 'D', table: 'bad name', kind: 'table', reason: 'r' }
    ])
    const core = t.keeps.find((k) => k.id === 'core:settings')
    expect(core?.kind).toBe('columns')
    expect(t.keeps.some((k) => k.id === 'ext:a')).toBe(true)
    expect(t.left_out.map((l) => l.id).sort()).toEqual(['ext:b', 'ext:c', 'ext:d'])
    expect(t.keeps.some((k) => k.id === 'core:external-apis')).toBe(true)
  })

  it('rolls back only inside the window, once, after a restore', () => {
    const run = (o: Partial<DataRun>): DataRun =>
      ({
        kind: 'refresh',
        status: 'done',
        artifact: { rollback_file: 'F:\\r.bak', restored_at: '2026-11-24T00:00:00Z' },
        expires_at: '2026-11-25T00:00:00Z',
        ...o
      }) as DataRun
    const now = new Date('2026-11-24T12:00:00Z')
    expect(rollbackRefusal(run({}), now)).toBeNull()
    expect(rollbackRefusal(run({}), new Date('2026-11-26T00:00:00Z'))).toMatch(/ended/)
    expect(rollbackRefusal(run({ status: 'running' }), now)).toMatch(/running/)
    expect(rollbackRefusal(run({ artifact: { rollback_file: 'x' } }), now)).toMatch(
      /never replaced/
    )
    expect(
      rollbackRefusal(
        run({ artifact: { rollback_file: 'x', restored_at: 'y', rolled_back_at: 'z' } }),
        now
      )
    ).toMatch(/already/)
  })
})

describe('retention, sightings, files status', () => {
  it('keeps the newest backup always and deletes by count and age', () => {
    const now = new Date('2026-11-24T00:00:00Z')
    const kept = [1, 2, 3, 4].map((id) => ({
      id,
      started_at: new Date(now.getTime() - (5 - id) * 86_400_000).toISOString()
    }))
    expect(backupsToDelete(kept, { db_keep_count: 2, db_keep_days: null }, now)).toEqual([2, 1])
    expect(backupsToDelete(kept, { db_keep_count: null, db_keep_days: 2 }, now).sort()).toEqual([
      1, 2
    ])
    expect(backupsToDelete(kept.slice(0, 1), { db_keep_count: 1, db_keep_days: 1 }, now)).toEqual(
      []
    )
  })

  it('reads msdb last backups per type', () => {
    const r = parseLastBackups([
      { type: 'D', finish_local: '2026-11-24T01:00:00', server_offset_min: 300 },
      { type: 'L ', finish_local: '2026-11-24T02:00:00', server_offset_min: 300 }
    ])
    expect(r.full_at).toBe('2026-11-24T06:00:00.000Z')
    expect(r.diff_at).toBeNull()
    expect(r.log_at).toBe('2026-11-24T07:00:00.000Z')
  })

  it('writes a checklist per engine', () => {
    const lines = backupChecklist(
      {
        app: { id: 1, key: 'a', name: 'A' },
        env: {
          id: 1,
          app_id: 1,
          key: 'p',
          position: 1,
          status: 'active',
          base_url: '',
          placement_id: null
        },
        database: {
          id: 1,
          engine: 'pg',
          host: 'h',
          port: null,
          database_name: 'a',
          status: 'ready',
          server_id: null
        },
        server: null
      },
      { db_schedule: null, db_keep_days: null, db_keep_count: null }
    )
    expect(lines.find((l) => l.label === 'What the Hub reads')?.value).toMatch(/pg_stat_archiver/)
  })

  it('parses a files backup status and names sets', () => {
    expect(parseFilesStatus({ state: 'done', total: 3, copied: 3 })?.copied).toBe(3)
    expect(parseFilesStatus({ state: 'weird' })).toBeNull()
    expect(setName('EFP', 'Prod 1', 5)).toBe('nivaro-efp-prod-1-5')
  })

  it('marks a step with its duration', () => {
    const steps = setStep(
      setStep(
        [{ key: 'a', label: 'A', state: 'pending', started_at: null, ms: null, note: null }],
        'a',
        'running',
        null,
        1000
      ),
      'a',
      'done',
      'ok',
      3500
    )
    expect(steps[0]).toMatchObject({ state: 'done', ms: 2500, note: 'ok' })
  })
})
