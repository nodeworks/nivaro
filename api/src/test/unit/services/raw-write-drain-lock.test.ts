import { beforeEach, describe, expect, it, vi } from 'vitest'

// EFP prod 2026-11-14..17: raw-write-announcements failed every morning at ~09:37 UTC. The inbox
// was EMPTY — the drain's DELETE … WITH (READPAST) sat in a Lock wait behind the daily
// replication snapshot (READPAST passes row locks, not a table lock) until the 15 s statement
// timeout. The drain now waits a few seconds at most, leaves the rows to the next tick, and the
// job succeeds.

const state = vi.hoisted(() => ({
  calls: [] as string[],
  answers: [] as Array<unknown[] | Error>
}))

vi.mock('../../../db/dialect.js', () => ({ isMssql: () => true }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../db/index.js', () => ({
  db: {
    raw: async (sql: string) => {
      state.calls.push(sql)
      const next = state.answers.shift() ?? []
      if (next instanceof Error) throw next
      return next
    }
  }
}))

import {
  DRAIN_LOCK_TIMEOUT_MS,
  drainBatchSql,
  drainRawWrites,
  isLockTimeout,
  rawWriteStats
} from '../../../services/raw-write-announcer.js'

const lockTimeout = () =>
  Object.assign(new Error('DELETE TOP … - Lock request time out period exceeded.'), {
    number: 1222
  })

beforeEach(() => {
  state.calls.length = 0
  state.answers.length = 0
})

describe('raw-write inbox drain under a held lock', () => {
  it('bounds its lock wait and restores the session setting on both paths', () => {
    const sql = drainBatchSql()
    expect(DRAIN_LOCK_TIMEOUT_MS).toBeLessThanOrEqual(5000)
    expect(sql).toMatch(new RegExp(`^SET LOCK_TIMEOUT ${DRAIN_LOCK_TIMEOUT_MS};`))
    expect(sql).toMatch(
      /DELETE TOP \(2000\) FROM nivaro_raw_writes WITH \(READPAST\)\s+OUTPUT DELETED\./
    )
    expect(sql).toMatch(
      /BEGIN CATCH\s+SET LOCK_TIMEOUT -1;\s+THROW;\s+END CATCH\s+SET LOCK_TIMEOUT -1;$/
    )
  })

  it('a lock timeout leaves the rows for the next tick and the job does not fail', async () => {
    const before = rawWriteStats().lockSkips
    state.answers.push(lockTimeout())
    await expect(drainRawWrites()).resolves.toEqual({ rows: 0, broadcasts: 0 })
    expect(state.calls).toHaveLength(1)
    expect(rawWriteStats().lockSkips).toBe(before + 1)
  })

  it('any other failure still fails the job', async () => {
    state.answers.push(new Error('Login failed for user'))
    await expect(drainRawWrites()).rejects.toThrow(/Login failed/)
  })

  it('recognises the timeout by number or by message', () => {
    expect(isLockTimeout(lockTimeout())).toBe(true)
    expect(isLockTimeout({ originalError: { info: { number: 1222 } } })).toBe(true)
    expect(isLockTimeout(new Error('Lock request time out period exceeded.'))).toBe(true)
    expect(isLockTimeout(new Error('Timeout: Request failed to complete in 15000ms'))).toBe(false)
  })
})
