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
})
