import { beforeEach, describe, expect, it, vi } from 'vitest'

// A run left `running` by an importer that died stops renewing its lease (updated_at). A drainer
// puts it back in the queue once and hands it off again; the second time it fails with a
// sentence. The update matches the lease it read, so two drainers never both act on one row.

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  pushed: [] as string[],
  attempts: new Map<string, number>(),
  afterSelect: null as null | (() => void)
}))

vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const where: Record<string, unknown> = {}
    const q: Record<string, unknown> = {
      where: (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') where[k] = v
        else Object.assign(where, k)
        return q
      },
      whereNull: (k: string) => {
        where[k] = null
        return q
      },
      select: async () => {
        const out =
          table === 'nivaro_import_queue'
            ? state.rows
                .filter((r) => !where.status || r.status === where.status)
                .map((r) => ({ ...r }))
            : []
        state.afterSelect?.()
        return out
      },
      update: async (patch: Record<string, unknown>) => {
        const row = state.rows.find(
          (r) =>
            r.id === where.id &&
            r.status === where.status &&
            (!('updated_at' in where) || r.updated_at === where.updated_at)
        )
        if (!row) return 0
        Object.assign(row, patch)
        state.updates.push({ id: where.id, ...patch })
        return 1
      }
    }
    return q
  }
  return { db: builder }
})
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/live-progress.js', () => ({
  emitImportProgress: vi.fn(),
  emitJobProgress: vi.fn()
}))
vi.mock('../../../services/traffic-taps/sources.js', () => ({ noteImportRun: vi.fn() }))

import { LEASE_FAIL_NOTE, LEASE_RETRY_NOTE } from '../../../services/import-handoff.js'
import { recoverLostRuns } from '../../../services/staged-import-worker.js'

const redis = {
  rpush: async (_k: string, v: string) => state.pushed.push(v),
  lrange: async () => [],
  lrem: async () => 0,
  llen: async () => 0,
  publish: async () => 1,
  set: async () => 'OK',
  get: async () => null,
  hget: async (_k: string, f: string) =>
    state.attempts.has(f) ? String(state.attempts.get(f)) : null,
  hincrby: async (_k: string, f: string, by: number) => {
    state.attempts.set(f, (state.attempts.get(f) ?? 0) + by)
    return state.attempts.get(f) as number
  },
  hdel: async (_k: string, f: string) => state.attempts.delete(f)
}
const app = { log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as never
const now = Date.parse('2026-11-17T12:00:00Z')

beforeEach(() => {
  state.updates.length = 0
  state.pushed.length = 0
  state.attempts.clear()
  state.afterSelect = null
  const stale = new Date(now - 11 * 60_000)
  state.rows = [
    { id: 5, status: 'running', import_key: 'invoices', started_at: stale, updated_at: stale },
    {
      id: 6,
      status: 'running',
      import_key: 'invoices',
      started_at: stale,
      updated_at: new Date(now - 20_000)
    }
  ]
})

describe('recoverLostRuns', () => {
  it('puts a run whose lease ran out back in the queue and hands it off again', async () => {
    const acted = await recoverLostRuns(app, redis as never, now)
    expect(acted).toEqual([{ id: 5, action: 'retry' }])
    expect(state.rows[0]).toMatchObject({ status: 'queued', logs: LEASE_RETRY_NOTE })
    expect(state.rows[1].status).toBe('running') // its lease is fresh
    expect(state.pushed.map((p) => JSON.parse(p).id)).toEqual([5])
    expect(state.attempts.get('5')).toBe(1)
  })

  it('the second time the run fails with a sentence', async () => {
    state.attempts.set('5', 1)
    const acted = await recoverLostRuns(app, redis as never, now)
    expect(acted).toEqual([{ id: 5, action: 'fail' }])
    expect(state.rows[0]).toMatchObject({ status: 'error', logs: LEASE_FAIL_NOTE })
    expect(state.pushed).toHaveLength(0)
  })

  it('a row another drainer recovered between the read and the write is left to it', async () => {
    state.afterSelect = () => {
      // the other drainer got there first: the row is queued again with a new lease
      Object.assign(state.rows[0], { status: 'queued', updated_at: new Date(now) })
    }
    expect(await recoverLostRuns(app, redis as never, now)).toEqual([])
    expect(state.pushed).toHaveLength(0)
    expect(state.attempts.size).toBe(0)
  })
})
