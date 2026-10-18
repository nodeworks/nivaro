import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  maxVersion: null as number | null,
  inserted: [] as Record<string, unknown>[],
  retention: undefined as number | null | undefined,
  deletedWhere: null as unknown[] | null,
  deleteCount: 3,
  row: null as Record<string, unknown> | null,
  locked: false,
  committed: [] as Record<string, unknown>[],
  rolledBack: false
}))

vi.mock('../db/index.js', () => ({
  db: Object.assign(
    (table: string) => mockTable(table),
    {
      // a transaction buffers inserts; they only land if the callback resolves
      transaction: async (fn: (trx: unknown) => Promise<unknown>) => {
        const buffered: Record<string, unknown>[] = []
        const trx = (table: string) => mockTable(table, buffered)
        try {
          const out = await fn(trx)
          state.committed.push(...buffered)
          return out
        } catch (e) {
          state.rolledBack = true
          throw e
        }
      }
    }
  )
}))

function mockTable(table: string, sink?: Record<string, unknown>[]): any {
  {
    if (table === 'chat_messages') {
      const q: any = {
        where: () => q,
        forUpdate: () => {
          state.locked = true
          return q
        },
        first: async () => state.row
      }
      return q
    }
    if (table === 'nivaro_settings') {
      const q: any = {
        where: () => q,
        first: async () =>
          state.retention === undefined ? null : { chat_history_retention_days: state.retention }
      }
      return q
    }
    const q: any = {
      where: (...args: unknown[]) => {
        state.deletedWhere = args
        return q
      },
      max: () => q,
      first: async () => ({ v: state.maxVersion }),
      insert: async (row: Record<string, unknown>) => {
        if (sink) sink.push(row)
        else state.inserted.push(row)
      },
      del: async () => state.deleteCount
    }
    return q
  }
}

vi.mock('../config.js', () => ({ config: { NODE_ENV: 'test' } }))

import { changeChatMessage, pruneChatMessageHistory, recordMessageVersion } from './chat-send.js'

beforeEach(() => {
  state.maxVersion = null
  state.inserted = []
  state.retention = undefined
  state.deletedWhere = null
  state.row = null
  state.locked = false
  state.committed = []
  state.rolledBack = false
})

describe('recordMessageVersion', () => {
  it('starts at version 1 and stores the pre-change text, reason and actor', async () => {
    await recordMessageVersion({ id: 7, message: 'hello', attachments: '[{"id":1}]' }, 'edit', 'U1')
    expect(state.inserted[0]).toMatchObject({
      message_id: 7,
      version: 1,
      text: 'hello',
      attachments: '[{"id":1}]',
      changed_by: 'U1',
      reason: 'edit'
    })
  })

  it('increments past the highest existing version', async () => {
    state.maxVersion = 2
    await recordMessageVersion({ id: 7, message: 'x', attachments: null }, 'delete', 'ADMIN')
    expect(state.inserted[0]).toMatchObject({
      version: 3,
      attachments: null,
      reason: 'delete',
      changed_by: 'ADMIN'
    })
  })
})

describe('pruneChatMessageHistory', () => {
  it('uses 90 days when the setting is NULL', async () => {
    state.retention = null
    expect(await pruneChatMessageHistory()).toBe(3)
    const [col, op, cutoff] = state.deletedWhere as [string, string, Date]
    expect([col, op]).toEqual(['changed_at', '<'])
    const days = (Date.now() - cutoff.getTime()) / 86_400_000
    expect(days).toBeGreaterThan(89.99)
    expect(days).toBeLessThan(90.01)
  })

  it('keeps everything when the setting is 0', async () => {
    state.retention = 0
    expect(await pruneChatMessageHistory()).toBe(0)
    expect(state.deletedWhere).toBeNull()
  })

  it('honors a custom window', async () => {
    state.retention = 7
    await pruneChatMessageHistory()
    const cutoff = (state.deletedWhere as [string, string, Date])[2]
    expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(7)
  })
})

describe('changeChatMessage', () => {
  it('locks the row and versions the stored text, not a stale copy', async () => {
    state.row = { id: 7, message: 'current', attachments: null, deleted_at: null }
    state.maxVersion = 1
    const ok = await changeChatMessage(7, 'edit', 'U1', async () => true)
    expect(ok).toBe(true)
    expect(state.locked).toBe(true)
    expect(state.committed[0]).toMatchObject({ version: 2, text: 'current', reason: 'edit' })
  })

  it('does not version an edit of a message deleted meanwhile', async () => {
    state.row = { id: 7, message: '', deleted_at: new Date() }
    const apply = vi.fn(async () => true)
    expect(await changeChatMessage(7, 'edit', 'U1', apply)).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    expect(state.committed).toEqual([])
  })

  it('skips the version when deleting an already-deleted message', async () => {
    state.row = { id: 7, message: '', deleted_at: new Date() }
    await changeChatMessage(7, 'delete', 'U1', async () => true)
    expect(state.committed).toEqual([])
  })

  it('rolls back the version when the update fails', async () => {
    state.row = { id: 7, message: 'current', attachments: null, deleted_at: null }
    await expect(
      changeChatMessage(7, 'delete', 'U1', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(state.rolledBack).toBe(true)
    expect(state.committed).toEqual([])
  })
})
