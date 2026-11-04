import { beforeEach, describe, expect, it, vi } from 'vitest'

const raw = vi.fn()
vi.mock('../../../db/index.js', () => ({ db: { raw: (...a: unknown[]) => raw(...a) } }))

import { deadlockReportSql, readDeadlockReports } from '../../../services/deadlock-reports.js'

describe('deadlock reports', () => {
  beforeEach(() => raw.mockReset())

  it('reads the system_health event file first', async () => {
    raw.mockResolvedValueOnce([{ occurred_at: '2026-11-04T17:10:03Z', graph: '<event/>' }])
    const rows = await readDeadlockReports({ limit: 20 })
    expect(rows).toHaveLength(1)
    expect(raw).toHaveBeenCalledTimes(1)
    expect(String(raw.mock.calls[0][0])).toContain('fn_xe_file_target_read_file')
  })

  it('falls back to the ring buffer when the file cannot be read', async () => {
    raw.mockRejectedValueOnce(new Error("Invalid column name 'timestamp_utc'"))
    raw.mockResolvedValueOnce([])
    await readDeadlockReports({ limit: 20 })
    expect(raw).toHaveBeenCalledTimes(2)
    expect(String(raw.mock.calls[1][0])).toContain("st.target_name = 'ring_buffer'")
  })

  it('throws the ring error when neither reads (no VIEW SERVER STATE)', async () => {
    raw.mockRejectedValueOnce(new Error('file denied'))
    raw.mockRejectedValueOnce(new Error('VIEW SERVER STATE permission was denied'))
    await expect(readDeadlockReports({ limit: 3 })).rejects.toThrow('VIEW SERVER STATE')
  })

  it('scopes both readers to this database only when asked', () => {
    const scoped = deadlockReportSql({ limit: 20, thisDatabase: true })
    for (const sql of [scoped.file, scoped.ring]) {
      expect(sql).toContain('DECLARE @db sysname = DB_NAME();')
      expect(sql).toContain('[@currentdbname = sql:variable("@db")]')
    }
    const wide = deadlockReportSql({ limit: 50 })
    expect(wide.file).not.toContain('currentdbname')
    expect(wide.ring).not.toContain('currentdbname')
  })

  it('binds the since filter and keeps it off the file reader', async () => {
    const since = new Date('2026-11-04T16:00:00Z')
    raw.mockResolvedValueOnce([])
    await readDeadlockReports({ limit: 3, since })
    expect(String(raw.mock.calls[0][0])).toContain('DATEADD(second, 0, timestamp_utc) >= ?')
    expect(raw.mock.calls[0][1]).toEqual([since])
  })

  it('clamps the row limit', () => {
    expect(deadlockReportSql({ limit: 5000 }).file).toContain('TOP 100 ')
    expect(deadlockReportSql({ limit: 0 }).file).toContain('TOP 1 ')
  })
})
