import { describe, expect, it, vi } from 'vitest'

const can = vi.fn()
const getRowFilter = vi.fn()
const applyRowFilter = vi.fn()
vi.mock('./permissions.js', () => ({ can, getRowFilter, applyRowFilter }))

const { readFilterFor } = await import('./extension-access.js')

describe('readFilterFor — the role half of an extension raw-SQL read', () => {
  it('no user or no read of the collection: not allowed', async () => {
    expect((await readFilterFor(null, 'workflows')).allowed).toBe(false)
    can.mockResolvedValueOnce(false)
    expect((await readFilterFor({ id: 'u1', role: 'r' }, 'workflows')).allowed).toBe(false)
  })

  it('a role without a row filter reads everything, nothing applied', async () => {
    can.mockResolvedValueOnce(true)
    getRowFilter.mockResolvedValueOnce(null)
    const r = await readFilterFor({ id: 'u1', role: 'r' }, 'workflows')
    expect(r.allowed).toBe(true)
    r.apply({} as never, 'w')
    expect(applyRowFilter).not.toHaveBeenCalled()
  })

  it('a row filter is applied with every field qualified by the alias', async () => {
    can.mockResolvedValueOnce(true)
    getRowFilter.mockResolvedValueOnce([{ field: 'division', op: 'eq', value: 3 }])
    const user = { id: 'u1', role: 'r' }
    const r = await readFilterFor(user, 'workflows')
    const qb = {} as never
    r.apply(qb, 'w')
    expect(applyRowFilter).toHaveBeenCalledWith(
      qb,
      [{ field: 'w.division', op: 'eq', value: 3 }],
      user
    )
  })
})
