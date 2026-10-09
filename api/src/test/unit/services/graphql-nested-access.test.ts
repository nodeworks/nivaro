import { beforeEach, describe, expect, it, vi } from 'vitest'

const perms = {
  can: vi.fn(),
  getRowFilter: vi.fn(),
  getAllowedFields: vi.fn(),
  applyRowFilter: vi.fn()
}
const scopes = { getUserScopeEnforcement: vi.fn(), applyScopeEnforcement: vi.fn() }

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => ({
    __table: table,
    select() {
      return this
    }
  })
  return { db }
})
vi.mock('../../../services/permissions.js', () => perms)
vi.mock('../../../services/user-scopes.js', () => scopes)
const hv = vi.hoisted(() => ({ whereNotHelpVideoFile: vi.fn() }))
vi.mock('../../../services/help-video-files.js', () => ({
  isFilesCollection: (c: string) => /^(nivaro|directus)_files$/i.test(c),
  whereNotHelpVideoFile: hv.whereNotHelpVideoFile
}))

const { applyNestedGate, narrowNestedRow, nestedGate } = await import(
  '../../../services/graphql-nested-access.js'
)

const user = { id: 'u1', role: 'r1' } as never
const NONE = { filters: [], deny: false }

function fakeQuery() {
  const calls: unknown[][] = []
  return { calls, whereIn: (...a: unknown[]) => calls.push(a) }
}

describe('nested GraphQL read gates', () => {
  beforeEach(() => {
    for (const f of [...Object.values(perms), ...Object.values(scopes)]) f.mockReset()
    perms.can.mockResolvedValue(true)
    perms.getRowFilter.mockResolvedValue(null)
    perms.getAllowedFields.mockResolvedValue(null)
    scopes.getUserScopeEnforcement.mockResolvedValue(NONE)
  })

  it('denies without a caller', async () => {
    const gate = await nestedGate({}, 'orders')
    expect(gate.allowed).toBe(false)
  })

  it('is open for an admin and asks nothing', async () => {
    const gate = await nestedGate({ user, isAdmin: true }, 'orders')
    expect(gate.open).toBe(true)
    expect(perms.can).not.toHaveBeenCalled()
  })

  it('still narrows an admin-owned key that carries scope restrictions', async () => {
    scopes.getUserScopeEnforcement.mockResolvedValue({
      filters: [{ hops: [], ids: [1] }],
      deny: false
    })
    const keyUser = { id: 'u1', role: 'r1', api_key_scope_restrictions: [{ values: [1] }] }
    const gate = await nestedGate({ user: keyUser as never, isAdmin: true }, 'orders')
    expect(gate.open).toBe(false)
    const q = fakeQuery()
    expect(applyNestedGate(q as never, 'orders', gate, keyUser as never)).toBe(true)
    expect(q.calls).toHaveLength(1)
    expect(scopes.applyScopeEnforcement).toHaveBeenCalled()
  })

  it('denies a collection the role cannot read', async () => {
    perms.can.mockResolvedValue(false)
    const gate = await nestedGate({ user }, 'orders')
    expect(gate.allowed).toBe(false)
    expect(applyNestedGate(fakeQuery() as never, 'orders', gate, user)).toBe(false)
  })

  it('denies system tables to non-admins, except files', async () => {
    expect((await nestedGate({ user }, 'nivaro_users')).allowed).toBe(false)
    expect((await nestedGate({ user }, 'nivaro_files')).open).toBe(true)
    expect(perms.can).not.toHaveBeenCalled()
  })

  it('applies a row filter as a subquery on the related table', async () => {
    perms.getRowFilter.mockResolvedValue([{ field: 'owner', op: 'eq', value: '$CURRENT_USER' }])
    const gate = await nestedGate({ user }, 'orders')
    const q = fakeQuery()
    expect(applyNestedGate(q as never, 'orders', gate, user)).toBe(true)
    expect(q.calls[0][0]).toBe('orders.id')
    expect((q.calls[0][1] as { __table: string }).__table).toBe('orders')
    expect(perms.applyRowFilter).toHaveBeenCalledTimes(1)
  })

  it('answers nothing under a strict scope denial', async () => {
    scopes.getUserScopeEnforcement.mockResolvedValue({ filters: [], deny: true })
    const gate = await nestedGate({ user }, 'orders')
    expect(applyNestedGate(fakeQuery() as never, 'orders', gate, user)).toBe(false)
  })

  it('narrows fields to the policy list, keeping id', async () => {
    perms.getAllowedFields.mockResolvedValue(['name'])
    const gate = await nestedGate({ user }, 'orders')
    expect(narrowNestedRow({ id: 1, name: 'a', secret: 'x', __junction_id: 4 }, gate)).toEqual({
      id: 1,
      name: 'a',
      __junction_id: 4
    })
  })

  it('compiles once per request and collection', async () => {
    const ctx = { user }
    await Promise.all([nestedGate(ctx, 'orders'), nestedGate(ctx, 'orders')])
    await nestedGate(ctx, 'orders')
    expect(perms.can).toHaveBeenCalledTimes(1)
    await nestedGate({ user }, 'orders')
    expect(perms.can).toHaveBeenCalledTimes(2)
  })

  it('fails closed when a gate cannot be compiled', async () => {
    perms.can.mockRejectedValue(new Error('db down'))
    expect((await nestedGate({ user }, 'orders')).allowed).toBe(false)
  })

  it('never returns a help-video file as a nested file row, even through an open gate', async () => {
    hv.whereNotHelpVideoFile.mockReset()
    const gate = await nestedGate({ user, isAdmin: true }, 'nivaro_files')
    expect(gate.open).toBe(true)
    const q = fakeQuery()
    expect(applyNestedGate(q as never, 'nivaro_files', gate, user)).toBe(true)
    expect(hv.whereNotHelpVideoFile).toHaveBeenCalledWith(q, 'nivaro_files.id')
    applyNestedGate(
      fakeQuery() as never,
      'orders',
      await nestedGate({ user, isAdmin: true }, 'orders'),
      user
    )
    expect(hv.whereNotHelpVideoFile).toHaveBeenCalledTimes(1)
  })
})
