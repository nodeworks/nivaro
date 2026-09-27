import knexFactory from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const knex = knexFactory({ client: 'mssql' })
const perms = {
  getRowFilter: vi.fn(),
  applyRowFilter: vi.fn((q: { where: (c: string, v: unknown) => void }) => q.where('owner', 'u1'))
}
const scopes = {
  getUserScopeEnforcement: vi.fn(),
  applyScopeEnforcement: vi.fn(
    (q: { whereIn: (c: string, v: unknown[]) => void }, c: string, e: { filters: unknown[] }) => {
      if (e.filters.length) q.whereIn(`${c}.zone`, [4])
    }
  )
}

vi.mock('../../../db/index.js', () => ({
  db: Object.assign((t: string) => knex(t), { raw: knex.raw.bind(knex) })
}))
vi.mock('../../../services/permissions.js', () => perms)
vi.mock('../../../services/user-scopes.js', () => scopes)

const { applyQueueGate, applyQueueGatesToCache, queueGateFor } = await import(
  '../../../services/queue-access.js'
)
const user = { id: 'u1', role: 'r1' } as never
const NONE = { filters: [], deny: false }

describe('queue row access', () => {
  beforeEach(() => {
    perms.getRowFilter.mockReset().mockResolvedValue(null)
    scopes.getUserScopeEnforcement.mockReset().mockResolvedValue(NONE)
  })

  it('compiles no gate when nothing applies', async () => {
    expect(await queueGateFor(user, 'orders')).toBeNull()
  })

  it('compiles a gate from a row filter or a scope', async () => {
    perms.getRowFilter.mockResolvedValue([{ field: 'owner', op: 'eq', value: '$CURRENT_USER' }])
    expect((await queueGateFor(user, 'orders'))?.rowFilter).toBeTruthy()
    perms.getRowFilter.mockResolvedValue(null)
    scopes.getUserScopeEnforcement.mockResolvedValue({ filters: [{ hops: [], ids: [4] }], deny: false })
    expect((await queueGateFor(user, 'orders'))?.scopes.filters).toHaveLength(1)
  })

  it('narrows the source query, or empties it under a strict denial', () => {
    const q = knex('orders').select('id')
    applyQueueGate(
      q,
      { collection: 'orders', deny: false, rowFilter: [{}], scopes: { filters: [{}], deny: false } } as never,
      user
    )
    expect(q.toSQL().sql).toContain('[owner] = ?')
    expect(q.toSQL().sql).toContain('[orders].[zone] in (?)')
    const denied = knex('orders').select('id')
    applyQueueGate(denied, { collection: 'orders', deny: true, rowFilter: null, scopes: NONE }, user)
    expect(denied.toSQL().sql).toContain('1 = 0')
  })

  it('leaves a query alone without a gate', () => {
    const q = knex('orders').select('id')
    applyQueueGate(q, null, user)
    expect(q.toSQL().sql).toBe('select [id] from [orders]')
  })

  it('narrows cached rows per collection and leaves other collections alone', () => {
    const qb = knex('nivaro_queue_items as qi').where('qi.queue_id', 'q1')
    applyQueueGatesToCache(
      qb,
      [
        { collection: 'orders', deny: false, rowFilter: null, scopes: { filters: [{}], deny: false } },
        { collection: 'invoices', deny: true, rowFilter: null, scopes: { filters: [], deny: true } }
      ] as never,
      user
    )
    const { sql, bindings } = qb.toSQL()
    expect(sql).toContain(
      '(not [qi].[collection] = ? or [qi].[item_id] in (select CAST([orders].[id] AS NVARCHAR(255)) from [orders] where [orders].[zone] in (?)))'
    )
    expect(sql).toContain('not [qi].[collection] = ?')
    expect(bindings).toEqual(['q1', 'orders', 4, 'invoices'])
  })
})
