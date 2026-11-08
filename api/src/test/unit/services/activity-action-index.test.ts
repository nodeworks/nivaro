import { describe, expect, it } from 'vitest'
import {
  ACTION_INDEX,
  createActionIndexSql,
  dropActionIndexSql,
  estimateBuildSeconds,
  supportsOnlineBuild
} from '../../../services/activity-action-index.js'

// Army 9 follow-up: `GET /api/activity?action=access-request` walked ~13M rows (15 s). The
// (action, timestamp DESC, id DESC) index is built off-hours by script, never by a migration
// (an offline build holds every activity write on SQL Server Standard).
describe('activity action index', () => {
  it('builds (action, timestamp DESC, id DESC) once, guarded, with a lock timeout', () => {
    const sql = createActionIndexSql({ online: false, lockTimeoutMs: 10_000 })
    expect(ACTION_INDEX).toBe('ix_nivaro_activity_action_timestamp')
    expect(sql).toContain('SET LOCK_TIMEOUT 10000;')
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('nivaro_activity') AND name = 'ix_nivaro_activity_action_timestamp')"
    )
    expect(sql).toContain('ON nivaro_activity ([action], [timestamp] DESC, [id] DESC)')
    expect(sql).toContain('WITH (SORT_IN_TEMPDB = ON);')
    expect(sql).not.toContain('ONLINE')
    expect(sql.trim().endsWith('SET LOCK_TIMEOUT -1;')).toBe(true)
  })

  it('builds online only where the edition can', () => {
    expect(createActionIndexSql({ online: true, lockTimeoutMs: 0 })).toContain(
      'WITH (SORT_IN_TEMPDB = ON, ONLINE = ON);'
    )
    expect(supportsOnlineBuild(2)).toBe(false) // Standard
    expect(supportsOnlineBuild(4)).toBe(false) // Express
    expect(supportsOnlineBuild(3)).toBe(true) // Enterprise / Developer
    expect(supportsOnlineBuild(5)).toBe(true) // Azure SQL Database
    expect(supportsOnlineBuild(8)).toBe(true) // Managed Instance
    expect(supportsOnlineBuild(null)).toBe(false)
  })

  it('drops it guarded', () => {
    expect(dropActionIndexSql()).toContain(
      'DROP INDEX ix_nivaro_activity_action_timestamp ON nivaro_activity;'
    )
    expect(dropActionIndexSql()).toMatch(/^IF EXISTS/)
  })

  it('estimates the build from the row count', () => {
    expect(estimateBuildSeconds(12_972_610)).toEqual({ low: 26, high: 39 })
    expect(estimateBuildSeconds(0)).toEqual({ low: 1, high: 1 })
  })
})
