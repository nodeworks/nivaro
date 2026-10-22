import { describe, expect, it, vi } from 'vitest'
import { isMigrationLockedError, migrateFreeingStaleLock } from './migration-lock.js'

const locked = () =>
  Object.assign(new Error('Migration table is already locked'), { name: 'MigrationLocked' })

function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    }
  }
}

describe('migrateFreeingStaleLock (#2839)', () => {
  it('recognises knex lock errors by name and message', () => {
    expect(isMigrationLockedError(locked())).toBe(true)
    expect(isMigrationLockedError(new Error('Migration table is already locked'))).toBe(true)
    expect(isMigrationLockedError(new Error('boom'))).toBe(false)
  })

  it('runs straight through when nothing holds the lock', async () => {
    const forceFree = vi.fn()
    const r = await migrateFreeingStaleLock({
      latest: async () => 'ok',
      forceFree,
      budgetMs: 1000,
      log: () => {}
    })
    expect(r).toBe('ok')
    expect(forceFree).not.toHaveBeenCalled()
  })

  it('waits for a live holder and does not free a lock that clears in time', async () => {
    const c = clock()
    let calls = 0
    const forceFree = vi.fn()
    const r = await migrateFreeingStaleLock({
      latest: async () => {
        if (++calls < 3) throw locked()
        return 'ok'
      },
      forceFree,
      budgetMs: 60_000,
      ...c,
      log: () => {}
    })
    expect(r).toBe('ok')
    expect(calls).toBe(3)
    expect(forceFree).not.toHaveBeenCalled()
  })

  it('frees a lock held past MIGRATION_LOCK_STALE_MS, then migrates', async () => {
    const c = clock()
    let held = true
    const forceFree = vi.fn(async () => {
      held = false
    })
    const logs: string[] = []
    const r = await migrateFreeingStaleLock({
      latest: async () => {
        if (held) throw locked()
        return 'migrated'
      },
      forceFree,
      budgetMs: 20_000,
      ...c,
      log: (m) => logs.push(m)
    })
    expect(r).toBe('migrated')
    expect(forceFree).toHaveBeenCalledTimes(1)
    expect(c.now()).toBeGreaterThanOrEqual(20_000)
    expect(logs.at(-1)).toMatch(/Freeing the stale lock/)
  })

  it('rethrows other errors without freeing anything', async () => {
    const forceFree = vi.fn()
    await expect(
      migrateFreeingStaleLock({
        latest: async () => {
          throw new Error('syntax error')
        },
        forceFree,
        budgetMs: 0,
        log: () => {}
      })
    ).rejects.toThrow('syntax error')
    expect(forceFree).not.toHaveBeenCalled()
  })
})
