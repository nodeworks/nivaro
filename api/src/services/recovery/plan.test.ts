import { describe, expect, it } from 'vitest'
import {
  type BackupSetRow,
  fileListSql,
  joinServerPath,
  type MediaFamilyRow,
  newestBackups,
  planMoves,
  planRestore,
  qi,
  qs,
  restoreSql,
  scratchNameRefusal,
  validTableRef
} from './plan.js'

let seq = 0
function set(type: string, finish: string, extra: Partial<BackupSetRow> = {}): BackupSetRow {
  seq += 1
  return {
    backup_set_id: seq,
    media_set_id: extra.media_set_id ?? seq,
    position: 1,
    type,
    start_utc: finish,
    finish_utc: finish,
    checkpoint_lsn: `${seq}000`,
    database_backup_lsn: null,
    is_copy_only: false,
    is_damaged: false,
    has_backup_checksums: true,
    backup_size: 1e9,
    compressed_backup_size: 4e8,
    ...extra
  }
}
const disk = (media: number, path: string, n = 1, mirror = 0): MediaFamilyRow => ({
  media_set_id: media,
  family_sequence_number: n,
  physical_device_name: path,
  device_type: 2,
  mirror
})

describe('scratchNameRefusal', () => {
  it('requires the drill prefix and plain characters', () => {
    expect(
      scratchNameRefusal('nivaro_restore_drill_EFP_Development', ['EFP_Development'])
    ).toBeNull()
    expect(scratchNameRefusal('restore_copy', [])).toMatch(/must start with nivaro_restore_drill_/)
    expect(scratchNameRefusal('nivaro_restore_drill_x]; DROP DATABASE EFP --', [])).toMatch(
      /letters, digits and underscores/
    )
    expect(scratchNameRefusal('nivaro_restore_drill_', [])).toMatch(/must start/)
    expect(scratchNameRefusal('', [])).toBe('no scratch database name')
  })
  it('never targets the live database or a protected one', () => {
    for (const name of [
      'EFP',
      'efp_development',
      'EFP_Staging',
      'master',
      'msdb',
      'tempdb',
      'model'
    ])
      expect(scratchNameRefusal(name, [])).not.toBeNull()
    expect(scratchNameRefusal('NIVARO_RESTORE_DRILL_live', [])).toMatch(/must start/) // exact prefix
    expect(scratchNameRefusal('nivaro_restore_drill_live', ['NIVARO_RESTORE_DRILL_LIVE'])).toMatch(
      /own database/
    )
  })
})

describe('quoting', () => {
  it('brackets identifiers and doubles quotes in literals', () => {
    expect(qi('a]b')).toBe('[a]]b]')
    expect(qs("O'Brien")).toBe("N'O''Brien'")
    expect(qs('what?')).toBe("N'what?'")
  })
  it('accepts only plain table references', () => {
    expect(validTableRef('workflows')).toBe(true)
    expect(validTableRef('dbo.workflows')).toBe(true)
    expect(validTableRef('a.b.c')).toBe(false)
    expect(validTableRef('x; drop')).toBe(false)
    expect(validTableRef('[x]')).toBe(false)
  })
})

describe('planRestore', () => {
  it('says so when msdb has no full backup', () => {
    const p = planRestore([set('L', '2026-10-22T01:00:00.000Z')], [])
    expect(p.ok).toBe(false)
    expect(p.refusal).toBe('no_backup')
  })

  it('restores the newest full plus the differential taken on top of it', () => {
    const old = set('D', '2026-10-15T02:00:00.000Z')
    const full = set('D', '2026-10-20T02:00:00.000Z', { checkpoint_lsn: '777' })
    const strayDiff = set('I', '2026-10-21T02:00:00.000Z', { database_backup_lsn: '999' })
    const diff = set('I', '2026-10-21T01:00:00.000Z', { database_backup_lsn: '777' })
    const log1 = set('L', '2026-10-21T01:30:00.000Z')
    const log0 = set('L', '2026-10-21T00:30:00.000Z')
    const fams = [old, full, strayDiff, diff, log1, log0].map((r) =>
      disk(r.media_set_id, `D:\\bak\\${r.backup_set_id}.bak`)
    )
    const p = planRestore([log1, old, diff, strayDiff, full, log0], fams)
    expect(p.ok).toBe(true)
    expect(p.full?.backup_set_id).toBe(full.backup_set_id)
    expect(p.diff?.backup_set_id).toBe(diff.backup_set_id) // the stray (other base) is ignored
    expect(p.point_utc).toBe(diff.finish_utc)
    expect(p.logs_after).toBe(1)
    expect(p.notes.join(' ')).toMatch(/1 log backup after that point is not applied/)
  })

  it('skips a damaged newest full and says so', () => {
    const good = set('D', '2026-10-19T02:00:00.000Z')
    const bad = set('D', '2026-10-20T02:00:00.000Z', { is_damaged: true })
    const p = planRestore(
      [bad, good],
      [disk(good.media_set_id, 'D:\\a.bak'), disk(bad.media_set_id, 'D:\\b.bak')]
    )
    expect(p.full?.backup_set_id).toBe(good.backup_set_id)
    expect(p.notes[0]).toMatch(/marked damaged/)
  })

  it('reports a backup-agent (virtual device) backup as not restorable by path', () => {
    const full = set('D', '2026-10-20T02:00:00.000Z')
    const p = planRestore(
      [full],
      [{ ...disk(full.media_set_id, '{4F2A1C9E-1D3B-4C5A-9E8F-0A1B2C3D4E5F}'), device_type: 7 }]
    )
    expect(p.ok).toBe(false)
    expect(p.refusal).toBe('not_restorable_by_path')
    expect(p.message).toMatch(
      /^Backup not restorable by path: .*backup agent \(virtual device\).*no full backup on disk/
    )
  })

  it('restores the newest disk full when the newest full went to a backup agent', () => {
    const copy = set('D', '2026-10-22T04:19:10.000Z', { is_copy_only: true })
    const agent = set('D', '2026-10-22T04:30:00.000Z')
    const p = planRestore(
      [agent, copy],
      [
        { ...disk(agent.media_set_id, '{06DC6FC3-FC8E-4270-8FD2-CCF91A926B26}'), device_type: 7 },
        disk(copy.media_set_id, 'E:\\copy\\EFP.bak')
      ]
    )
    expect(p.ok).toBe(true)
    expect(p.full?.backup_set_id).toBe(copy.backup_set_id)
    expect(p.full?.copy_only).toBe(true)
    expect(p.message).toBe('Restores the newest full backup on disk.')
    expect(p.notes[0]).toMatch(
      /backup agent \(virtual device\); the newest full backup on disk \(2026-10-22 04:19 UTC\) is restored instead/
    )
  })

  it('treats a GUID "disk" name (some agents report device_type 2) as not a path', () => {
    const full = set('D', '2026-10-20T02:00:00.000Z')
    const p = planRestore([full], [disk(full.media_set_id, '5f1d0c2a-0b7e-4c3e-9d1a-2b3c4d5e6f70')])
    expect(p.refusal).toBe('not_restorable_by_path')
  })

  it('keeps striped families in order and ignores mirrors', () => {
    const full = set('D', '2026-10-20T02:00:00.000Z', { position: 3 })
    const m = full.media_set_id
    const p = planRestore(
      [full],
      [
        disk(m, '\\\\nas\\b\\2.bak', 2),
        disk(m, '\\\\nas\\b\\1.bak', 1),
        disk(m, 'E:\\mirror.bak', 1, 1)
      ]
    )
    expect(p.full?.devices).toEqual(['\\\\nas\\b\\1.bak', '\\\\nas\\b\\2.bak'])
    expect(fileListSql(p.full!)).toBe(
      "RESTORE FILELISTONLY FROM DISK = N'\\\\nas\\b\\1.bak', DISK = N'\\\\nas\\b\\2.bak' WITH FILE = 3"
    )
  })

  it('restores the full only when the differential is on a virtual device', () => {
    const full = set('D', '2026-10-20T02:00:00.000Z', { checkpoint_lsn: '5' })
    const diff = set('I', '2026-10-21T02:00:00.000Z', { database_backup_lsn: '5' })
    const p = planRestore(
      [full, diff],
      [disk(full.media_set_id, 'D:\\f.bak'), { ...disk(diff.media_set_id, 'x'), device_type: 7 }]
    )
    expect(p.ok).toBe(true)
    expect(p.diff).toBeNull()
    expect(p.notes.join(' ')).toMatch(/only the full backup is restored/)
  })
})

describe('newestBackups', () => {
  it('reads the newest of each kind with its device', () => {
    const f = set('D', '2026-10-20T02:00:00.000Z')
    const l = set('L', '2026-10-22T01:45:00.000Z')
    const n = newestBackups(
      [f, l],
      [disk(f.media_set_id, 'D:\\f.bak'), { ...disk(l.media_set_id, 'g'), device_type: 7 }]
    )
    expect(n.full).toEqual({ finish_utc: f.finish_utc, device: 'disk file' })
    expect(n.diff).toBeNull()
    expect(n.log).toEqual({ finish_utc: l.finish_utc, device: 'backup agent (virtual device)' })
  })
})

describe('RESTORE text', () => {
  const files = [
    { LogicalName: 'EFP', PhysicalName: 'D:\\data\\EFP.mdf', Type: 'D', FileId: 1, Size: 5e9 },
    {
      LogicalName: "EFP_2'nd",
      PhysicalName: 'D:\\data\\EFP2.ndf',
      Type: 'D',
      FileId: 3,
      Size: 1e9
    },
    { LogicalName: 'EFP_log', PhysicalName: 'L:\\log\\EFP.ldf', Type: 'L', FileId: 2, Size: 2e9 }
  ]

  it('moves every file to a unique name in the target folders', () => {
    const moves = planMoves(
      files,
      'nivaro_restore_drill_x',
      'D:\\data\\',
      'L:\\log',
      '20261022023000'
    )
    expect(moves.map((m) => m.physical)).toEqual([
      'D:\\data\\nivaro_restore_drill_x_20261022023000_1.mdf',
      'D:\\data\\nivaro_restore_drill_x_20261022023000_3.ndf',
      'L:\\log\\nivaro_restore_drill_x_20261022023000_2.ldf'
    ])
    expect(joinServerPath('/var/opt/mssql/data/', 'a.mdf')).toBe('/var/opt/mssql/data/a.mdf')
  })

  it('builds the full step WITH MOVE … NORECOVERY and the diff step WITH RECOVERY, never REPLACE', () => {
    const moves = planMoves(files, 'nivaro_restore_drill_x', 'D:\\d', 'L:\\l', '1')
    const full = {
      backup_set_id: 1,
      type: 'D' as const,
      finish_utc: '',
      position: 2,
      devices: ["\\\\nas\\it's\\f.bak"],
      device_type: 2,
      has_checksums: true,
      copy_only: false,
      size_bytes: 1
    }
    const sql = restoreSql('nivaro_restore_drill_x', full, moves, { recovery: false })
    expect(sql).toBe(
      "RESTORE DATABASE [nivaro_restore_drill_x] FROM DISK = N'\\\\nas\\it''s\\f.bak' WITH FILE = 2, " +
        "MOVE N'EFP' TO N'D:\\d\\nivaro_restore_drill_x_1_1.mdf', MOVE N'EFP_2''nd' TO N'D:\\d\\nivaro_restore_drill_x_1_3.ndf', " +
        "MOVE N'EFP_log' TO N'L:\\l\\nivaro_restore_drill_x_1_2.ldf', CHECKSUM, NORECOVERY, STATS = 10"
    )
    const diff = { ...full, type: 'I' as const, has_checksums: false }
    const d = restoreSql('nivaro_restore_drill_x', diff, moves, { recovery: true })
    expect(d).not.toMatch(/MOVE/)
    expect(d).toMatch(/RECOVERY, NEW_BROKER, STATS = 10$/)
    expect(`${sql} ${d}`).not.toMatch(/REPLACE/)
  })
})
