import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny knex stand-in: every builder call is recorded; `first()` / awaiting asks `answer`.
type Q = { table: string; calls: Array<[string, unknown[]]> }
let answer: (q: Q, kind: 'first' | 'rows') => unknown = () => undefined
function builder(table: string) {
  const q: Q = { table, calls: [] }
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'first')
          return (...a: unknown[]) => {
            q.calls.push(['first', a])
            return Promise.resolve(answer(q, 'first'))
          }
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(answer(q, 'rows')).then(res, rej)
        return (...a: unknown[]) => {
          q.calls.push([prop, a])
          return proxy
        }
      }
    }
  )
  return proxy
}
vi.mock('../../../db/index.js', () => ({
  db: Object.assign((t: string) => builder(t), { raw: (s: string) => s })
}))
vi.mock('../../../services/chain-columns.js', () => ({ hasChainColumns: vi.fn(async () => true) }))
vi.mock('../../../services/mcp-calls.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/mcp-calls.js')>()),
  hasMcpLogColumns: vi.fn(async () => true)
}))
const { updateOne, deleteOne, logActivity } = vi.hoisted(() => ({
  updateOne: vi.fn(async (..._a: unknown[]) => ({})),
  deleteOne: vi.fn(async (..._a: unknown[]) => ({})),
  logActivity: vi.fn(async (..._a: unknown[]) => 1)
}))
vi.mock('../../../services/items.js', () => ({ updateOne, deleteOne }))
vi.mock('../../../services/activity.js', () => ({ logActivity }))

const { foldStats, recordOfPaths, undoAgentWrite, AgentUndoError } = await import(
  '../../../services/mcp-activity.js'
)

const NOW = Date.parse('2026-10-21T12:00:00Z')

describe('foldStats', () => {
  it('folds grouped log rows into per-connection stats with a dense day axis', () => {
    const rows = [
      {
        mcp_conn: 'K1',
        mcp_tool: 'read_items',
        mcp_outcome: 'ok',
        day: '2026-10-21',
        n: 5,
        b: 500,
        last_at: '2026-10-21T10:00:00Z'
      },
      {
        mcp_conn: 'k1',
        mcp_tool: 'read_items',
        mcp_outcome: 'refused',
        day: '2026-10-20',
        n: 1,
        b: 40,
        last_at: '2026-10-20T09:00:00Z'
      },
      {
        mcp_conn: 'k1',
        mcp_tool: 'update_item',
        mcp_outcome: 'error',
        day: '2026-10-21',
        n: 2,
        b: null,
        last_at: '2026-10-21T11:00:00Z'
      }
    ]
    const s = foldStats(rows, NOW, 3).get('k1')!
    expect(s).toMatchObject({ calls: 8, errors: 2, refused: 1, bytes: 540 })
    expect(s.last_call_at).toBe('2026-10-21T11:00:00.000Z')
    expect(s.days.map((d) => [d.day, d.calls])).toEqual([
      ['2026-10-19', 0],
      ['2026-10-20', 1],
      ['2026-10-21', 7]
    ])
    expect(s.top_tools[0]).toEqual({ tool: 'read_items', calls: 6, errors: 0, refused: 1 })
  })
})

describe('recordOfPaths', () => {
  it('names the record a tool read, skipping system tables', () => {
    expect(recordOfPaths(['/api/collections', '/api/items/projects/42'])).toEqual({
      collection: 'projects',
      id: '42'
    })
    expect(recordOfPaths(['/api/items/nivaro_users/1', '/api/items/tasks'])).toEqual({
      collection: 'tasks',
      id: ''
    })
    expect(recordOfPaths(['/api/auth/me'])).toBeNull()
  })
})

describe('undoAgentWrite', () => {
  const user = { id: 'U1' } as never
  const base = {
    act: { id: 7, action: 'update', collection: 'projects', item: '42', chain_id: 'C1' } as unknown,
    byAgent: { id: 99 } as unknown,
    already: undefined as unknown,
    rev: { id: 10, delta: '{"name":"B","budget":5}' } as unknown,
    newest: { id: 10 } as unknown,
    prev: { data: '{"id":42,"name":"A","budget":3}' } as unknown
  }
  let fx = { ...base }
  beforeEach(() => {
    fx = { ...base }
    updateOne.mockClear()
    deleteOne.mockClear()
    logActivity.mockClear()
    answer = (q) => {
      const has = (m: string) => q.calls.some(([c]) => c === m)
      const whereArg = q.calls.find(([c]) => c === 'where')?.[1][0] as Record<string, unknown>
      if (q.table === 'nivaro_activity')
        return whereArg?.action === 'mcp-undo' ? fx.already : fx.act
      if (q.table === 'nivaro_api_logs') return fx.byAgent
      if (q.table === 'nivaro_revisions') {
        if (has('max')) return fx.newest
        if (whereArg && 'activity' in whereArg) return fx.rev
        return fx.prev
      }
      return undefined
    }
  })

  it('puts back the previous values of the fields the agent changed, as the person', async () => {
    const r = await undoAgentWrite(user, 7)
    expect(r).toEqual({ collection: 'projects', item: '42', action: 'update' })
    expect(updateOne).toHaveBeenCalledWith(
      user,
      'projects',
      '42',
      { name: 'A', budget: 3 },
      undefined
    )
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mcp-undo', comment: 'activity:7' })
    )
  })

  it('deletes a record the agent created', async () => {
    fx.act = { ...(base.act as object), action: 'create' }
    const r = await undoAgentWrite(user, 7)
    expect(r.action).toBe('delete')
    expect(deleteOne).toHaveBeenCalledWith(user, 'projects', '42', undefined)
  })

  it('refuses once the record changed after the agent', async () => {
    fx.newest = { id: 11 }
    await expect(undoAgentWrite(user, 7)).rejects.toMatchObject({ statusCode: 409 })
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('refuses a change no agent of this person made', async () => {
    fx.byAgent = undefined
    await expect(undoAgentWrite(user, 7)).rejects.toBeInstanceOf(AgentUndoError)
    await expect(undoAgentWrite(user, 7)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses a delete and a second undo', async () => {
    fx.act = { ...(base.act as object), action: 'delete' }
    await expect(undoAgentWrite(user, 7)).rejects.toMatchObject({ statusCode: 409 })
    fx.act = base.act
    fx.already = { id: 1 }
    await expect(undoAgentWrite(user, 7)).rejects.toThrow(/already undone/)
  })
})
