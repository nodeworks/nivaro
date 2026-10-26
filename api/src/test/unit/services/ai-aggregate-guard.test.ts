import { beforeEach, describe, expect, it, vi } from 'vitest'

const perms = {
  scoped: {} as Record<string, boolean>,
  fields: {} as Record<string, string[] | null>,
  rowFilter: {} as Record<string, unknown>,
  read: {} as Record<string, boolean>
}
vi.mock('../../../services/permissions.js', () => ({
  getAllowedFields: async (_u: unknown, _a: string, c: string) => perms.fields[c] ?? null,
  getRowFilter: async (_u: unknown, _a: string, c: string) => perms.rowFilter[c] ?? null,
  can: async (_u: unknown, _a: string, c: string) => perms.read[c] !== false
}))

vi.mock('../../../services/user-scopes.js', () => ({
  getUserScopeEnforcement: async (_u: unknown, c: string) =>
    perms.scoped[c]
      ? { filters: [{ hops: [], ids: [1] }], deny: false }
      : { filters: [], deny: false }
}))

const { readableFieldSet, assertFilterReadable, FieldAccessError } = await import(
  '../../../services/ai-aggregate-guard.js'
)

const user = { id: 'U', role: 'R' } as never
const all = new Set(['id', 'name', 'salary', 'manager'])
const links = async (c: string) => ({
  m2o: c === 'employees' ? [{ field: 'manager', collection: 'people' }] : []
})

describe('aggregate field guard', () => {
  beforeEach(() => {
    perms.fields = {}
    perms.rowFilter = {}
    perms.read = {}
    perms.scoped = {}
  })

  it('narrows the field set to the role policy (null and * = all)', async () => {
    expect((await readableFieldSet(user, 'employees', all)).size).toBe(4)
    perms.fields.employees = ['*']
    expect((await readableFieldSet(user, 'employees', all)).size).toBe(4)
    perms.fields.employees = ['id', 'name', 'manager']
    const v = await readableFieldSet(user, 'employees', all)
    expect(v.has('salary')).toBe(false)
    expect(v.has('name')).toBe(true)
  })

  it('refuses a filter on a hidden field', async () => {
    await expect(
      assertFilterReadable(user, 'employees', [['salary']], new Set(['salary']), links)
    ).rejects.toBeInstanceOf(FieldAccessError)
    await expect(
      assertFilterReadable(user, 'employees', [['name']], new Set(['salary']), links)
    ).resolves.toBeUndefined()
  })

  it('checks the related collection for dotted paths', async () => {
    perms.fields.people = ['id', 'name']
    await expect(
      assertFilterReadable(user, 'employees', [['manager', 'salary']], new Set(), links)
    ).rejects.toThrow(/salary/)
    await expect(
      assertFilterReadable(user, 'employees', [['manager', 'name']], new Set(), links)
    ).resolves.toBeUndefined()
  })

  it('refuses unverifiable hops: to-many aliases, unreadable or row-filtered relateds', async () => {
    await expect(
      assertFilterReadable(user, 'employees', [['reports', 'name']], new Set(), links)
    ).rejects.toBeInstanceOf(FieldAccessError)
    perms.read.people = false
    await expect(
      assertFilterReadable(user, 'employees', [['manager', 'name']], new Set(), links)
    ).rejects.toBeInstanceOf(FieldAccessError)
    perms.read.people = true
    perms.rowFilter.people = [{}]
    await expect(
      assertFilterReadable(user, 'employees', [['manager', 'name']], new Set(), links)
    ).rejects.toThrow(/row-filtered/)
  })

  it('refuses a hop into a collection the caller is scoped on', async () => {
    perms.scoped.people = true
    await expect(
      assertFilterReadable(user, 'employees', [['manager', 'name']], new Set(), links)
    ).rejects.toThrow(/scopes/)
  })

  describe('to-many hops (toMany: the aggregate tool, army v3 round 2)', () => {
    const zoneLinks = async (c: string) =>
      c === 'workflows'
        ? {
            m2o: [{ field: 'vendor', collection: 'vendors' }],
            aliases: [
              { field: 'divisions', collection: 'workflows_divisions', junction: 'divisions_id' },
              { field: 'lines', collection: 'workflow_lines', junction: null }
            ]
          }
        : c === 'workflows_divisions'
          ? { m2o: [{ field: 'divisions_id', collection: 'divisions' }] }
          : { m2o: [] }
    const walk = (paths: string[][], toMany = true) =>
      assertFilterReadable(user, 'workflows', paths, new Set(), zoneLinks, { toMany })

    it('allows M2M (junction → target), O2M and bare-alias paths the caller may read', async () => {
      await expect(
        walk([['divisions', 'short_name'], ['divisions'], ['lines', 'amount']])
      ).resolves.toBeUndefined()
    })

    it('without toMany a to-many hop is still refused', async () => {
      await expect(walk([['divisions', 'short_name']], false)).rejects.toThrow(
        /only links to a single record/
      )
    })

    it('refuses when the junction, the target or the child is not readable', async () => {
      perms.read.workflows_divisions = false
      await expect(walk([['divisions', 'short_name']])).rejects.toThrow(/workflows_divisions/)
      // A bare alias leaf reads the junction too — refused whatever toMany says.
      await expect(walk([['divisions']], false)).rejects.toThrow(/workflows_divisions/)
      perms.read.workflows_divisions = true
      perms.fields.divisions = ['id', 'name']
      await expect(walk([['divisions', 'short_name']])).rejects.toThrow(/short_name/)
      perms.fields.workflow_lines = ['id']
      await expect(walk([['lines', 'amount']])).rejects.toThrow(/amount/)
    })

    it('refuses a to-many hop into a row-filtered or scoped collection', async () => {
      perms.scoped.divisions = true
      await expect(walk([['divisions', 'short_name']])).rejects.toThrow(/scopes/)
      perms.scoped.divisions = false
      perms.rowFilter.workflows_divisions = [{}]
      await expect(walk([['divisions']])).rejects.toThrow(/row-filtered/)
    })

    it('refuses a path through something that is not a link', async () => {
      await expect(walk([['is_on_hold', 'x']])).rejects.toThrow(/not a link/)
    })
  })
})
