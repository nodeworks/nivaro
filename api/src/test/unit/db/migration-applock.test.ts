import { describe, expect, it, vi } from 'vitest'
import { type PinnedSession, underSessionAppLock } from '../../../db/migration-lock.js'

function fakeSession(lockResult: number, releaseFails = false) {
  const calls: Array<{ sql: string; timeoutMs?: number }> = []
  const session: PinnedSession & { discard: ReturnType<typeof vi.fn> } = {
    run: vi.fn(async (sql: string, timeoutMs?: number) => {
      calls.push({ sql, timeoutMs })
      if (sql.includes('sp_getapplock')) return [{ result: lockResult }]
      if (sql.includes('sp_releaseapplock') && releaseFails) throw new Error('not held')
      return []
    }) as PinnedSession['run'],
    discard: vi.fn()
  }
  return { session, calls }
}

describe('underSessionAppLock', () => {
  it('takes and releases the lock on the same pinned session around fn', async () => {
    const { session, calls } = fakeSession(0)
    const order: string[] = []
    const fn = vi.fn(async () => {
      order.push(`fn after ${calls.length} call(s)`)
      return 'migrated'
    })
    const out = await underSessionAppLock(
      session,
      { resource: 'nivaro_migrations', timeoutMs: 600_000 },
      fn
    )
    expect(out).toBe('migrated')
    expect(order).toEqual(['fn after 1 call(s)'])
    expect(calls[0].sql).toContain("sp_getapplock @Resource = N'nivaro_migrations'")
    expect(calls[0].sql).toContain('@LockTimeout = 600000')
    // The wait gets its own request timeout, longer than the lock wait (not tedious's 15 s).
    expect(calls[0].timeoutMs).toBe(630_000)
    expect(calls[1].sql).toContain("sp_releaseapplock @Resource = N'nivaro_migrations'")
    expect(session.discard).not.toHaveBeenCalled()
  })

  it('releases the lock when fn throws', async () => {
    const { session, calls } = fakeSession(1)
    await expect(
      underSessionAppLock(session, { resource: 'nivaro_migrations', timeoutMs: 1000 }, async () => {
        throw new Error('migration failed')
      })
    ).rejects.toThrow('migration failed')
    expect(calls.map((c) => c.sql.includes('sp_releaseapplock'))).toEqual([false, true])
  })

  it('closes the session when the release fails, so the lock cannot outlive the boot', async () => {
    const { session } = fakeSession(0, true)
    await underSessionAppLock(
      session,
      { resource: 'nivaro_migrations', timeoutMs: 1000 },
      async () => 1
    )
    expect(session.discard).toHaveBeenCalledOnce()
  })

  it('refuses to run fn when the lock is not granted', async () => {
    const { session, calls } = fakeSession(-1)
    const fn = vi.fn(async () => 1)
    await expect(
      underSessionAppLock(session, { resource: 'nivaro_migrations', timeoutMs: 5000 }, fn)
    ).rejects.toThrow(/Could not acquire the migration advisory lock within 5000ms/)
    expect(fn).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('rejects a resource name that is not a plain identifier', async () => {
    const { session } = fakeSession(0)
    await expect(
      underSessionAppLock(session, { resource: "x'; DROP TABLE y--", timeoutMs: 1 }, async () => 1)
    ).rejects.toThrow(/Invalid app lock resource/)
    expect(session.run).not.toHaveBeenCalled()
  })
})
