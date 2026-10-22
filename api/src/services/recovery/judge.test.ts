import { describe, expect, it } from 'vitest'
import { type JudgeInput, judgeRecovery } from './judge.js'
import {
  effectiveRecovery,
  mergeRecoveryPatch,
  normalizeRecoverySettings,
  RECOVERY_DEFAULTS,
  RecoverySettingsError,
  scratchNameFor
} from './settings.js'
import { judgeSmoke } from './smoke.js'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

function input(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    now: NOW,
    rpo_minutes: 24 * 60,
    rto_minutes: 4 * 60,
    db: {
      newest: {
        full: { finish_utc: hoursAgo(10), device: 'disk file' },
        diff: null,
        log: { finish_utc: hoursAgo(1), device: 'disk file' }
      },
      error: null
    },
    uploads: { age_s: 5 * 3600, part: 'uploads', error: null },
    drill: {
      enabled: true,
      last: {
        verdict: 'passed',
        reason: 'ok',
        finished_at: hoursAgo(9),
        restore_ms: 20 * 60_000,
        backup_age_s: 3600
      },
      last_passed: {
        verdict: 'passed',
        reason: 'ok',
        finished_at: hoursAgo(9),
        restore_ms: 20 * 60_000,
        backup_age_s: 3600
      },
      running_since: null
    },
    chaos: {
      runs: 6,
      ttr_median_s: 30,
      ttr_p90_s: 80,
      ttd_median_s: 12,
      not_recovered: 0,
      window_days: 90
    },
    chaos_error: null,
    ...over
  }
}

const row = (i: JudgeInput, key: string) => judgeRecovery(i).rows.find((r) => r.key === key)!

describe('judgeRecovery', () => {
  it('is green when every source is inside its target', () => {
    const j = judgeRecovery(input())
    expect(j.tone).toBe('ok')
    expect(j.rows.map((r) => r.tone)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(row(input(), 'db_backup').reason).toMatch(
      /Newest log backup, to a disk file, 60 min ago, inside the 24 h RPO\. Newest full 10 h ago\./
    )
  })

  it('judges backup age against the RPO: amber up to 1.5×, red beyond, red when none', () => {
    const at = (h: number) =>
      row(
        input({
          db: {
            newest: {
              full: { finish_utc: hoursAgo(h), device: 'disk file' },
              diff: null,
              log: null
            },
            error: null
          }
        }),
        'db_backup'
      ).tone
    expect(at(23)).toBe('ok')
    expect(at(30)).toBe('warn')
    expect(at(40)).toBe('bad')
    expect(
      row(
        input({ db: { newest: { full: null, diff: null, log: null }, error: null } }),
        'db_backup'
      ).tone
    ).toBe('bad')
    const noFull = row(
      input({
        db: {
          newest: { full: null, diff: null, log: { finish_utc: hoursAgo(1), device: 'disk file' } },
          error: null
        }
      }),
      'db_backup'
    )
    expect(noFull.tone).toBe('bad')
    expect(noFull.reason).toMatch(/No full backup/)
    const err = row(input({ db: { newest: null, error: 'SELECT permission denied' } }), 'db_backup')
    expect(err.tone).toBe('warn')
    expect(err.reason).toMatch(/msdb: SELECT permission denied/)
  })

  it('says what to set up when the uploads backup is not reported', () => {
    const r = row(input({ uploads: { age_s: null, part: null, error: null } }), 'uploads_backup')
    expect(r.tone).toBe('warn')
    expect(r.reason).toMatch(/part="uploads"/)
  })

  it('reds a failed or never-run drill and ambers a blocked or stale one', () => {
    const never = row(
      input({ drill: { enabled: false, last: null, last_passed: null, running_since: null } }),
      'restore_drill'
    )
    expect(never.tone).toBe('bad')
    expect(never.reason).toMatch(/never been restored is not a backup.*RESTORE_DRILL=on/)
    const failed = input()
    failed.drill.last = {
      ...failed.drill.last!,
      verdict: 'failed',
      reason: 'nivaro_fields is missing'
    }
    expect(row(failed, 'restore_drill')).toMatchObject({ tone: 'bad', value: 'Failed' })
    const blocked = input()
    blocked.drill.last = {
      ...blocked.drill.last!,
      verdict: 'blocked',
      reason: 'Backup not restorable by path'
    }
    expect(row(blocked, 'restore_drill')).toMatchObject({ tone: 'warn', value: 'Could not run' })
    const stale = input()
    stale.drill.last = { ...stale.drill.last!, finished_at: hoursAgo(5 * 24) }
    expect(row(stale, 'restore_drill').tone).toBe('warn')
    stale.drill.last = { ...stale.drill.last!, finished_at: hoursAgo(10 * 24) }
    expect(row(stale, 'restore_drill').tone).toBe('bad')
  })

  it('judges the measured restore time against the RTO', () => {
    const at = (min: number) => {
      const i = input()
      i.drill.last_passed = { ...i.drill.last_passed!, restore_ms: min * 60_000 }
      return row(i, 'restore_time')
    }
    expect(at(60).tone).toBe('ok')
    expect(at(200).tone).toBe('warn')
    expect(at(300)).toMatchObject({ tone: 'bad', value: '5 h' })
    expect(
      row(
        input({ drill: { enabled: true, last: null, last_passed: null, running_since: null } }),
        'restore_time'
      ).tone
    ).toBe('warn')
  })

  it('reads chaos recovery: grey without drills, amber when one did not recover', () => {
    expect(row(input({ chaos: null }), 'chaos_recovery').tone).toBe('off')
    const i = input()
    i.chaos = { ...i.chaos!, not_recovered: 2 }
    expect(row(i, 'chaos_recovery').tone).toBe('warn')
    i.chaos = { ...i.chaos!, not_recovered: 0, ttr_p90_s: 5 * 3600 }
    expect(row(i, 'chaos_recovery').tone).toBe('bad')
    // grey rows never make the panel's verdict worse
    expect(judgeRecovery(input({ chaos: null })).tone).toBe('ok')
  })
})

describe('judgeSmoke', () => {
  const live = [
    { ref: 'nivaro_fields', exists: true, rows: 900 },
    { ref: 'nivaro_activity', exists: true, rows: 10 },
    { ref: 'workflows', exists: false, rows: null }
  ]
  it('passes an older copy whose counts differ, and ignores tables live does not have', () => {
    const s = judgeSmoke({
      opened: true,
      live,
      restored: [
        { ref: 'nivaro_fields', exists: true, rows: 880 },
        { ref: 'nivaro_activity', exists: true, rows: 10 }
      ],
      checksums: [{ ref: 'nivaro_roles', live: 1, restored: 2 }]
    })
    expect(s.passed).toBe(true)
    expect(s.tables.find((t) => t.ref === 'nivaro_fields')).toMatchObject({
      verdict: 'ok',
      changed: true
    })
    expect(s.tables.find((t) => t.ref === 'workflows')?.verdict).toBe('not_live')
    expect(s.checksums[0].match).toBe(false)
    expect(s.summary).toMatch(/all 2 key tables present \(1 with fewer or more rows/)
  })
  it('fails a missing or empty table and a copy that did not open', () => {
    const s = judgeSmoke({
      opened: true,
      live,
      restored: [{ ref: 'nivaro_activity', exists: true, rows: 0 }],
      checksums: []
    })
    expect(s.passed).toBe(false)
    expect(s.failures).toEqual([
      'nivaro_fields is missing from the restored copy',
      'nivaro_activity is empty in the restored copy but holds 10 rows live'
    ])
    const closed = judgeSmoke({
      opened: false,
      openError: 'state RESTORING',
      live,
      restored: [],
      checksums: []
    })
    expect(closed.passed).toBe(false)
    expect(closed.failures).toEqual(['The restored database did not open: state RESTORING'])
  })
})

describe('recovery settings', () => {
  it('normalizes stored JSON and drops bad values to defaults', () => {
    const s = normalizeRecoverySettings({
      restore_drill: {
        enabled: 'yes',
        scratch_db: 'EFP',
        business_tables: ['workflows', 'x;y'],
        max_restore_minutes: 2
      },
      targets: { rpo_minutes: 60, rto_minutes: -1 },
      runbook_url: 'javascript:alert(1)'
    })
    expect(s.restore_drill).toMatchObject({
      enabled: false,
      scratch_db: null,
      business_tables: ['workflows'],
      max_restore_minutes: 120
    })
    expect(s.targets).toEqual({ rpo_minutes: 60, rto_minutes: 240 })
    expect(s.runbook_url).toBeNull()
  })
  it('refuses more than 50 business tables instead of cutting the list', () => {
    const tables = Array.from({ length: 51 }, (_, i) => `t${i}`)
    expect(() =>
      mergeRecoveryPatch(RECOVERY_DEFAULTS, { restore_drill: { business_tables: tables } })
    ).toThrow(/business_tables holds 51 tables; at most 50/)
    expect(
      mergeRecoveryPatch(RECOVERY_DEFAULTS, {
        restore_drill: { business_tables: tables.slice(0, 50) }
      }).restore_drill.business_tables
    ).toHaveLength(50)
  })
  it('names every bad field in a PATCH', () => {
    expect(() =>
      mergeRecoveryPatch(RECOVERY_DEFAULTS, {
        restore_drill: { scratch_db: 'EFP_Staging', data_path: "D:\\x'; --", bogus: 1 },
        targets: { rpo_minutes: 0 }
      })
    ).toThrow(RecoverySettingsError)
    try {
      mergeRecoveryPatch(RECOVERY_DEFAULTS, { restore_drill: { scratch_db: 'EFP_Staging' } })
    } catch (e) {
      expect((e as Error).message).toMatch(/scratch_db: the scratch database name must start/)
    }
    const ok = mergeRecoveryPatch(RECOVERY_DEFAULTS, {
      restore_drill: { enabled: true, data_path: 'E:\\drill' },
      targets: { rpo_minutes: 60 }
    })
    expect(ok.restore_drill).toMatchObject({ enabled: true, data_path: 'E:\\drill' })
    expect(ok.targets).toEqual({ rpo_minutes: 60, rto_minutes: 240 })
  })
  it('applies the env layer and never enables the drill in cloud mode', () => {
    const on = {
      ...RECOVERY_DEFAULTS,
      restore_drill: { ...RECOVERY_DEFAULTS.restore_drill, enabled: true }
    }
    expect(effectiveRecovery(on, {}).drill_enabled).toBe(true)
    expect(effectiveRecovery(on, { RESTORE_DRILL: 'off' })).toMatchObject({
      drill_enabled: false,
      drill_enabled_source: 'env'
    })
    expect(effectiveRecovery(RECOVERY_DEFAULTS, { RESTORE_DRILL: 'on' }).drill_enabled).toBe(true)
    expect(
      effectiveRecovery(on, { RESTORE_DRILL: 'on', CLOUD_META_DB_URL: 'x' }).drill_enabled
    ).toBe(false)
    const e = effectiveRecovery(RECOVERY_DEFAULTS, {
      RECOVERY_RPO_MINUTES: '60',
      RECOVERY_RTO_MINUTES: 'abc',
      DR_RUNBOOK_URL: 'https://git.example/deploy/-/blob/main/docs/disaster-recovery.md'
    })
    expect(e.targets).toEqual({ rpo_minutes: 60, rto_minutes: 240 })
    expect(e.targets_source).toEqual({ rpo: 'env', rto: 'setting' })
    expect(e.runbook_source).toBe('env')
    expect(scratchNameFor(RECOVERY_DEFAULTS.restore_drill, 'EFP-Dev.1', {})).toBe(
      'nivaro_restore_drill_EFP_Dev_1'
    )
    expect(
      scratchNameFor(RECOVERY_DEFAULTS.restore_drill, 'x', {
        RESTORE_DRILL_DB: 'nivaro_restore_drill_n'
      })
    ).toBe('nivaro_restore_drill_n')
  })
})
