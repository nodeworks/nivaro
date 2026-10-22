import { describe, expect, it, vi } from 'vitest'
import {
  type PreMigrationDeps,
  snapshotBeforeMigrationsWith
} from '../../../services/pre-migration-snapshot.js'

function deps(over: Partial<PreMigrationDeps> = {}): PreMigrationDeps & { logs: string[] } {
  const logs: string[] = []
  return {
    listPending: async () => ['499_x.ts', '500_y.ts'],
    hasSnapshotTable: async () => true,
    recentExists: async () => false,
    take: vi.fn(async () => ({ id: 42 })),
    log: (m) => logs.push(m),
    timeoutMs: 1000,
    logs,
    ...over
  }
}

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

  it('takes nothing when another replica stored one moments ago', async () => {
    const d = deps({ recentExists: async () => true })
    expect(await snapshotBeforeMigrationsWith(d)).toBe('recent')
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

  it('gives up at the time box and aborts the snapshot so it can never land late', async () => {
    let signal: AbortSignal | null = null
    const d = deps({
      timeoutMs: 20,
      take: (_p, s) => {
        signal = s
        return new Promise(() => {})
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
