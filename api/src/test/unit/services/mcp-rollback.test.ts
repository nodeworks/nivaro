import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny knex stand-in: builder calls are recorded; awaiting / first() asks `answer`.
type Q = { table: string; calls: Array<[string, unknown[]]> }
let answer: (q: Q, kind: 'first' | 'rows') => unknown = () => []
const has = (q: Q, method: string, ...args: unknown[]) =>
  q.calls.some(
    ([m, a]) => m === method && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x))
  )
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
        if (prop === 'catch') return () => proxy
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
  db: Object.assign((t: string) => builder(t), {
    transaction: vi.fn(async (fn: (trx: unknown) => unknown) => fn((t: string) => builder(t)))
  })
}))
vi.mock('../../../services/mcp-attribution.js', () => ({
  hasAttributionColumns: vi.fn(async () => true)
}))
const h = vi.hoisted(() => ({
  updateOne: vi.fn(async (..._a: unknown[]) => ({})),
  deleteOne: vi.fn(async (..._a: unknown[]) => ({})),
  logActivity: vi.fn(async (..._a: unknown[]) => 1),
  restoreTrashRow: vi.fn(async (..._a: unknown[]) => ({ item_id: '4' })),
  getUser: vi.fn(async (id: string) => ({ id, status: 'active' }))
}))
vi.mock('../../../services/items.js', () => ({ updateOne: h.updateOne, deleteOne: h.deleteOne }))
vi.mock('../../../services/activity.js', () => ({ logActivity: h.logActivity }))
vi.mock('../../../services/trash.js', () => ({ restoreTrashRow: h.restoreTrashRow }))
vi.mock('../../../services/users.js', () => ({ getUser: h.getUser }))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))

const { applyRollback, parseWindow, planRollback, RollbackError } = await import(
  '../../../services/mcp-rollback.js'
)

const CONN = 'k7'
const OWNER = 'a1b2c3d4-0000-4000-8000-000000000001'
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002'
const T = (m: number) => new Date(Date.parse('2026-10-29T10:00:00Z') + m * 60_000)

// The agent's writes in the window: created #1, edited #2 twice, edited #3 (someone else
// changed it later), deleted #4 (in the trash), edited a config table, posted a comment.
const agentRows = [
  { id: 10, action: 'create', collection: 'work_orders', item: '1', user: OWNER, timestamp: T(1) },
  { id: 11, action: 'update', collection: 'work_orders', item: '2', user: OWNER, timestamp: T(2) },
  { id: 12, action: 'update', collection: 'work_orders', item: '2', user: OWNER, timestamp: T(3) },
  { id: 13, action: 'update', collection: 'work_orders', item: '3', user: OWNER, timestamp: T(4) },
  { id: 14, action: 'delete', collection: 'work_orders', item: '4', user: OWNER, timestamp: T(5) },
  {
    id: 15,
    action: 'update',
    collection: 'nivaro_fields',
    item: 'x',
    user: OWNER,
    timestamp: T(6)
  },
  {
    id: 16,
    action: 'create',
    collection: 'nivaro_comments',
    item: 'CM1',
    user: OWNER,
    timestamp: T(7)
  }
]
const history = [
  ...agentRows.slice(0, 5).map((r) => ({ ...r, mcp_conn: CONN })),
  {
    id: 20,
    action: 'update',
    collection: 'work_orders',
    item: '3',
    user: OTHER,
    timestamp: T(9),
    mcp_conn: null
  }
]

function scenario() {
  answer = (q, kind) => {
    if (q.table === 'nivaro_activity') {
      if (has(q, 'where', 'mcp_conn', CONN)) return agentRows
      return history
    }
    if (q.table === 'nivaro_revisions') {
      if (kind === 'first') {
        // The version before the agent's first change of #2.
        if (has(q, 'where', { collection: 'work_orders', item: '2' }))
          return { data: JSON.stringify({ id: 2, status: 'open', title: 'Pump', updated_at: 'x' }) }
        return undefined
      }
      return [
        {
          id: 101,
          activity: 11,
          item: '2',
          delta: JSON.stringify({ status: 'done', updated_at: 'y' })
        },
        { id: 102, activity: 12, item: '2', delta: JSON.stringify({ title: 'Pump 2' }) },
        { id: 103, activity: 13, item: '3', delta: JSON.stringify({ status: 'done' }) }
      ]
    }
    if (q.table === 'nivaro_trash') return kind === 'first' ? { id: 77 } : []
    if (q.table === 'nivaro_collections')
      return [{ collection: 'work_orders', display_name: 'Work orders' }]
    if (q.table === 'nivaro_comment_versions') return kind === 'first' ? { v: 2 } : []
    if (q.table === 'nivaro_comments' && kind === 'first')
      return { id: 'CM1', text: 'hi', collection: 'work_orders', item: '9', deleted_at: null }
    if (q.table === 'nivaro_comments')
      return [
        {
          id: 'CM1',
          collection: 'work_orders',
          item: '9',
          user: OWNER.toUpperCase(),
          deleted_at: null,
          created_at: T(7)
        }
      ]
    if (q.table === 'nivaro_users')
      return [
        { id: OWNER, first_name: 'Sam', last_name: 'Reed', email: null },
        { id: OTHER, first_name: 'Priya', last_name: 'N', email: null }
      ]
    return []
  }
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockClear()
  scenario()
})

describe('parseWindow', () => {
  it('validates the window and caps it', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    expect(parseWindow('2026-10-29T10:00:00Z', undefined, now).to.toISOString()).toBe(
      '2026-10-29T12:00:00.000Z'
    )
    expect(() => parseWindow('nope', undefined, now)).toThrow(/from must be/)
    expect(() => parseWindow('2026-10-29T11:00:00Z', '2026-10-29T10:00:00Z', now)).toThrow(
      /end after/
    )
    expect(() => parseWindow('2026-01-01T00:00:00Z', undefined, now)).toThrow(/at most 90 days/)
  })
})

describe('planRollback', () => {
  it('plans per record and leaves alone what someone else changed since', async () => {
    const { plan } = await planRollback({ conn: CONN, from: T(0), to: T(8) })
    expect(plan.owner).toEqual({ id: OWNER, name: 'Sam Reed' })
    expect(plan.system_writes).toBe(1)
    expect(plan.actions.map((a) => [a.kind, a.item, a.fields])).toEqual([
      ['delete_created', '1', []],
      ['restore_values', '2', ['status', 'title']],
      ['restore_deleted', '4', []],
      ['remove_comment', '9', []]
    ])
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        item: '3',
        reason: 'Changed since by someone else',
        by: 'Priya N'
      })
    ])
    // Field names only, never values.
    expect(JSON.stringify(plan)).not.toContain('Pump')
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses an invalid connection', async () => {
    await expect(planRollback({ conn: 'nope', from: T(0), to: T(8) })).rejects.toBeInstanceOf(
      RollbackError
    )
  })
})

describe('applyRollback', () => {
  const caller = { id: OWNER } as never
  const req = { workspaceId: undefined } as never

  it('refuses a stale preview with the fresh plan', async () => {
    const err = await applyRollback({
      caller,
      callerIsAdmin: false,
      req,
      conn: CONN,
      from: T(0),
      to: T(8),
      ownerId: OWNER,
      planHash: '0'.repeat(32)
    }).catch((e) => e)
    expect(err.statusCode).toBe(409)
    expect(err.plan.actions).toHaveLength(4)
    expect(h.updateOne).not.toHaveBeenCalled()
  })

  it('undoes through the items service as the person, newest first, and logs it', async () => {
    const { plan } = await planRollback({ conn: CONN, from: T(0), to: T(8), ownerId: OWNER })
    h.deleteOne.mockClear()
    const res = await applyRollback({
      caller,
      callerIsAdmin: false,
      req,
      conn: CONN,
      from: T(0),
      to: T(8),
      ownerId: OWNER,
      planHash: plan.plan_hash
    })
    expect(res).toMatchObject({ done: 4, skipped: 1, acted_as: 'owner', failed: [] })
    expect(h.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete', collection: 'nivaro_comments', item: 'CM1' })
    )
    expect(h.restoreTrashRow).toHaveBeenCalledWith(caller, 77, req)
    expect(h.updateOne).toHaveBeenCalledWith(
      caller,
      'work_orders',
      '2',
      { status: 'open', title: 'Pump' },
      req,
      undefined
    )
    expect(h.deleteOne).toHaveBeenCalledWith(caller, 'work_orders', '1', req, undefined)
    expect(h.logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp-rollback' }))
  })

  it('an administrator acts as the person, and is refused someone else’s as a non-admin', async () => {
    const { plan } = await planRollback({ conn: CONN, from: T(0), to: T(8) })
    const admin = { id: 'ffffffff-0000-4000-8000-000000000009' } as never
    const res = await applyRollback({
      caller: admin,
      callerIsAdmin: true,
      req,
      conn: CONN,
      from: T(0),
      to: T(8),
      planHash: plan.plan_hash
    })
    expect(res.acted_as).toBe('owner')
    expect(h.getUser).toHaveBeenCalledWith(OWNER)
    // Not the admin's request: the person's writes carry no admin request object.
    expect(h.deleteOne.mock.calls[0][3]).toBeUndefined()
    await expect(
      applyRollback({
        caller: admin,
        callerIsAdmin: false,
        req,
        conn: CONN,
        from: T(0),
        to: T(8),
        planHash: plan.plan_hash
      })
    ).rejects.toThrow(/not yours/)
  })
})
