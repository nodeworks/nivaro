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

const { applyCacheVisibility, applyQueueGate, canUserReadQueue, idMatchesText, queueGateFor } =
  await import('../../../services/queue-access.js')
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
    scopes.getUserScopeEnforcement.mockResolvedValue({
      filters: [{ hops: [], ids: [4] }],
      deny: false
    })
    expect((await queueGateFor(user, 'orders'))?.scopes.filters).toHaveLength(1)
  })

  it('narrows the source query, or empties it under a strict denial', () => {
    const q = knex('orders').select('id')
    applyQueueGate(
      q,
      {
        collection: 'orders',
        deny: false,
        rowFilter: [{}],
        scopes: { filters: [{}], deny: false }
      } as never,
      user
    )
    expect(q.toSQL().sql).toContain('[owner] = ?')
    expect(q.toSQL().sql).toContain('[orders].[zone] in (?)')
    const denied = knex('orders').select('id')
    applyQueueGate(
      denied,
      { collection: 'orders', deny: true, rowFilter: null, scopes: NONE },
      user
    )
    expect(denied.toSQL().sql).toContain('1 = 0')
  })

  it('leaves a query alone without a gate', () => {
    const q = knex('orders').select('id')
    applyQueueGate(q, null, user)
    expect(q.toSQL().sql).toBe('select [id] from [orders]')
  })

  it('narrows cached rows per collection by the visible cache ids, other collections untouched', () => {
    const qb = knex('nivaro_queue_items as qi').where('qi.queue_id', 'q1')
    applyCacheVisibility(qb, [
      { collection: 'orders', ids: [3, 7] },
      { collection: 'invoices', deny: true }
    ])
    const { sql, bindings } = qb.toSQL()
    expect(sql).toContain(
      '(not [qi].[collection] = ? or qi.id IN (SELECT CAST([value] AS INT) FROM OPENJSON(?)))'
    )
    expect(sql).toContain('not [qi].[collection] = ?')
    // One parameter for the id list, however long — never one per id.
    expect(bindings).toEqual(['q1', 'orders', '[3,7]', 'invoices'])
    // No source table is read per query any more.
    expect(sql).not.toContain('[orders].[id]')
  })

  it("matches a cache row on the source key's own type, so the key index is used", () => {
    expect(idMatchesText('orders', 'qi.item_id', 'int').toSQL().sql).toBe(
      '[orders].[id] = TRY_CONVERT(int, qi.item_id)'
    )
    expect(idMatchesText('docs', 'qi.item_id', null).toSQL().sql).toBe(
      'CAST([docs].[id] AS NVARCHAR(255)) = qi.item_id'
    )
  })
})

describe('canUserReadQueue (the queue visibility gate, request or cache warm)', () => {
  const u = { id: 'u1', role: 'R1' }
  it('admins and owners always; others only a shared queue open to all or to their role', () => {
    expect(canUserReadQueue({ owner: 'x', is_shared: false, role_id: null }, u, true)).toBe(true)
    expect(canUserReadQueue({ owner: 'u1', is_shared: false, role_id: null }, u, false)).toBe(true)
    expect(canUserReadQueue({ owner: 'x', is_shared: false, role_id: null }, u, false)).toBe(false)
    expect(canUserReadQueue({ owner: 'x', is_shared: true, role_id: null }, u, false)).toBe(true)
    expect(canUserReadQueue({ owner: 'x', is_shared: true, role_id: 'R1' }, u, false)).toBe(true)
    expect(canUserReadQueue({ owner: 'x', is_shared: 1, role_id: 'R2' }, u, false)).toBe(false)
  })
})
