import { describe, expect, it, vi } from 'vitest'
import {
  type PreMigrationDeps,
  snapshotBeforeMigrationsWith
} from '../../../services/pre-migration-snapshot.js'

function deps(over: Partial<PreMigrationDeps> = {}): PreMigrationDeps & { logs: string[] } {
  const logs: string[] = []
  const base: PreMigrationDeps = {
    listPending: async () => ['499_x.ts', '500_y.ts'],
    hasSnapshotTable: async () => true,
    withLock: async (fn) => fn(),
    recentExists: async () => false,
    take: vi.fn(async () => ({ id: 42 })),
    log: (m) => logs.push(m),
    timeoutMs: 1000
  }
  return { ...base, ...over, logs }
}

const never = <T>() => new Promise<T>(() => {})

describe('snapshotBeforeMigrationsWith', () => {
  it('stores a restore point naming the pending migrations', async () => {
    const d = deps()
    expect(await snapshotBeforeMigrationsWith(d)).toBe('stored')
    expect(d.take).toHaveBeenCalledWith(['499_x.ts', '500_y.ts'], expect.any(AbortSignal))
    expect(d.logs[0]).toMatch(/restore point #42 before 2 migrations/)
  })

  it('takes nothing when no migration is pending', async () => {
    const d = deps({ listPending: async () => [] })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('none-pending')
    expect(d.take).not.toHaveBeenCalled()
  })

  it('takes nothing when the snapshot table does not exist yet', async () => {
    const d = deps({ hasSnapshotTable: async () => false })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('no-table')
    expect(d.take).not.toHaveBeenCalled()
  })

  it('one replica snapshots: a held lock means another replica is on it', async () => {
    const d = deps({ withLock: async () => 'busy' })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('busy')
    expect(d.take).not.toHaveBeenCalled()
  })

  it('checks for a recent restore point INSIDE the lock, and skips when one exists', async () => {
    const order: string[] = []
    const d = deps({
      withLock: async (fn) => {
        order.push('lock')
        const r = await fn()
        order.push('unlock')
        return r
      },
      recentExists: async () => {
        order.push('recent?')
        return true
      }
    })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('recent')
    expect(order).toEqual(['lock', 'recent?', 'unlock'])
    expect(d.take).not.toHaveBeenCalled()
  })

  it('lets boot continue when the snapshot throws', async () => {
    const d = deps({
      take: async () => {
        throw new Error('Invalid object name nivaro_settings')
      }
    })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('failed')
    expect(d.logs[0]).toMatch(/no pre-migration restore point — Invalid object name/)
  })

  it('lets boot continue when listing pending migrations throws', async () => {
    const d = deps({
      listPending: async () => {
        throw new Error('ledger unreadable')
      }
    })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('failed')
  })

  it('time-boxes the whole step, not just the snapshot (a hung ledger read)', async () => {
    const d = deps({ timeoutMs: 20, listPending: () => never<string[]>() })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('timeout')
    expect(d.take).not.toHaveBeenCalled()
  })

  it('time-boxes a hung lock wait too', async () => {
    const d = deps({ timeoutMs: 20, withLock: () => never() })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('timeout')
  })

  it('gives up at the time box and aborts the snapshot so it can never land late', async () => {
    let signal: AbortSignal | null = null
    const d = deps({
      timeoutMs: 20,
      take: (_p, s) => {
        signal = s
        return never()
      }
    })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('timeout')
    expect((signal as AbortSignal | null)?.aborted).toBe(true)
  })

  it('is off when the time box is 0', async () => {
    const d = deps({ timeoutMs: 0 })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('off')
    expect(d.take).not.toHaveBeenCalled()
  })
})
