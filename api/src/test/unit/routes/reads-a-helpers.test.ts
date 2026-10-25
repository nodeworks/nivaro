import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 2026-10-25 gates that live in small helpers: row-rule lookups as the caller,
// field-watch recipients, import-template visibility and attribute value types.

const state = vi.hoisted(() => ({
  canRead: true,
  visible: true,
  allowed: null as string[] | null,
  raw: [] as string[]
}))

vi.mock('../../../db/index.js', () => {
  const db: any = (table: string) => {
    state.raw.push(table)
    const b: any = {}
    for (const m of ['where', 'whereNull', 'whereNotNull', 'orderBy', 'select', 'distinct'])
      b[m] = () => b
    b.first = async () => ({ id: 1, secret: 'raw' })
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    b.then = (res: (v: unknown) => unknown) => Promise.resolve([{ v: 'raw' }]).then(res)
    return b
  }
  db.raw = () => ''
  return { db }
})
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => state.canRead),
  getAllowedFields: vi.fn(async () => state.allowed),
  isAdminRole: vi.fn(async (u: { role?: string }) => u.role === 'ADMIN')
}))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    state.visible ? { id, name: 'caller view' } : null
  ),
  readItems: vi.fn(async () => ({ data: state.visible ? [{ id: 7, name: 'caller view' }] : [] })),
  applyFieldRules: vi.fn(),
  updateOne: vi.fn()
}))
vi.mock('../../../services/socket-access.js', () => ({
  canSeeRecordRoom: vi.fn(async (u: { id: string }) => u.id !== 'HIDDEN')
}))

import { subscribersWhoMayRead } from '../../../hooks/field-watches.js'
import { attributeValueError } from '../../../routes/attributes.js'
import { CallerRuleLookupCache } from '../../../routes/field-rules.js'
import { templateVisibleTo } from '../../../routes/import-templates.js'

beforeEach(() => {
  state.canRead = true
  state.visible = true
  state.allowed = null
  state.raw = []
})

const caller = { user: { id: 'PAUL', role: 'R' }, workspaceId: null } as never

describe('row-rule lookups as the caller', () => {
  it('reads a related record through readOne, never raw', async () => {
    const cache = new CallerRuleLookupCache(caller)
    expect(await cache.record('vendors', 7)).toEqual({ id: '7', name: 'caller view' })
    expect(await cache.firstWhere('vendors', { code: 'A' })).toEqual({ id: 7, name: 'caller view' })
    expect(state.raw).toEqual([])
  })

  it('answers nothing for a hidden record, an unreadable collection or a system table', async () => {
    state.visible = false
    expect(await new CallerRuleLookupCache(caller).record('vendors', 7)).toBeUndefined()
    state.visible = true
    state.canRead = false
    expect(await new CallerRuleLookupCache(caller).record('vendors', 7)).toBeUndefined()
    state.canRead = true
    expect(await new CallerRuleLookupCache(caller).record('nivaro_users', 'x')).toBeUndefined()
    expect(
      (await new CallerRuleLookupCache(caller).distinctValues('vendors', 'static_token')).size
    ).toBe(0)
  })
})

describe('field-watch recipients', () => {
  it('keep only subscribers who can open the record and read the field', async () => {
    const subs = [
      { id: 'OPEN', role: 'R' },
      { id: 'HIDDEN', role: 'R' },
      { id: 'GONE', role: 'R', status: 'suspended' }
    ] as never[]
    expect(
      (await subscribersWhoMayRead(subs, 'workflows', '1', 'amount')).map((s: any) => s.id)
    ).toEqual(['OPEN'])
    state.allowed = ['id']
    expect(await subscribersWhoMayRead(subs, 'workflows', '1', 'amount')).toEqual([])
  })
})

describe('import template visibility', () => {
  const tpl = { is_active: true, is_shared: false, created_by: 'OWNER', role_id: null }
  it('refuses another person’s private or inactive template', () => {
    expect(templateVisibleTo(tpl, { user: { id: 'PAUL', role: 'R' } } as never)).toBe(false)
    expect(
      templateVisibleTo({ ...tpl, is_shared: true, is_active: false }, {
        user: { id: 'PAUL', role: 'R' }
      } as never)
    ).toBe(false)
  })
  it('allows the owner, a shared template for the role, and admins', () => {
    expect(templateVisibleTo(tpl, { user: { id: 'owner', role: 'R' } } as never)).toBe(true)
    expect(
      templateVisibleTo({ ...tpl, is_shared: true, role_id: 'R' }, {
        user: { id: 'PAUL', role: 'R' }
      } as never)
    ).toBe(true)
    expect(templateVisibleTo({ ...tpl, is_active: false }, { isAdmin: true } as never)).toBe(true)
  })
})

describe('attribute values', () => {
  it('refuse a value that does not fit the definition type', () => {
    expect(attributeValueError({ key: 'n', type: 'number' }, 'abc')).toMatch(/number/)
    expect(attributeValueError({ key: 's', type: 'select', options: '["a"]' }, 'b')).toMatch(
      /choices/
    )
    expect(attributeValueError({ key: 'o', type: 'text' }, { a: 1 })).toMatch(/single/)
  })
  it('accept values that fit, and a cleared value', () => {
    expect(attributeValueError({ key: 'n', type: 'number' }, '12.5')).toBeNull()
    expect(attributeValueError({ key: 'b', type: 'boolean' }, true)).toBeNull()
    expect(attributeValueError({ key: 'd', type: 'date' }, '2026-10-25')).toBeNull()
    expect(attributeValueError({ key: 'n', type: 'number' }, null)).toBeNull()
  })
})
