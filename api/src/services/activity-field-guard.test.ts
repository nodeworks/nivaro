import { describe, expect, it, vi } from 'vitest'
import type { User } from '../types.js'
import { fieldFilterVerdict, guardFieldFilter } from './activity-field-guard.js'

/** The field-changed filter must never tell a non-admin which entries changed a field they cannot read. */

const pat = { id: 'p', role: 'r' } as unknown as User
const deps = (byCollection: Record<string, string[] | null>) => ({
  allowedFields: vi.fn(async (_u: User, c: string) => (c in byCollection ? byCollection[c] : []))
})

describe('fieldFilterVerdict', () => {
  it('keeps a field only when readable in every scoped collection', () => {
    const v = fieldFilterVerdict(
      ['status', 'budget'],
      ['invoices', 'orders'],
      new Map([
        ['invoices', ['status', 'budget']],
        ['orders', ['status']]
      ])
    )
    expect(v).toEqual({ ok: ['status'], unreadable: ['budget'], needsCollection: false })
    expect(fieldFilterVerdict(['x'], ['a'], new Map([['a', null]])).ok).toEqual(['x'])
    expect(fieldFilterVerdict(['x'], ['a'], new Map([['a', ['*']]])).ok).toEqual(['x'])
    expect(fieldFilterVerdict(['x'], [], new Map()).needsCollection).toBe(true)
  })
})

describe('guardFieldFilter', () => {
  it('refuses a non-admin an unreadable field', async () => {
    const g = await guardFieldFilter(
      pat,
      false,
      { collections: ['invoices'], fields: ['budget'] },
      'refuse',
      deps({ invoices: ['status'] })
    )
    expect(g.refusal).toMatchObject({ status: 403, code: 'FIELD_NOT_READABLE' })
  })

  it('needs a collection for a non-admin; an admin needs nothing', async () => {
    const d = deps({})
    const g = await guardFieldFilter(pat, false, { fields: ['status'] }, 'refuse', d)
    expect(g.refusal?.code).toBe('FIELD_FILTER_NEEDS_COLLECTION')
    const a = await guardFieldFilter(pat, true, { fields: ['budget'] }, 'refuse', d)
    expect(a.refusal).toBeNull()
    expect(d.allowedFields).not.toHaveBeenCalled()
  })

  it('lets a readable field through, and drops unreadable ones from stored filters', async () => {
    const ok = await guardFieldFilter(
      pat,
      false,
      { collections: ['invoices'], fields: ['status'] },
      'refuse',
      deps({ invoices: ['status'] })
    )
    expect(ok.refusal).toBeNull()
    const dropped = await guardFieldFilter(
      pat,
      false,
      { collections: ['invoices'], fields: ['status', 'budget'], range: 'today' },
      'drop',
      deps({ invoices: ['status'] })
    )
    expect(dropped.filters).toEqual({
      collections: ['invoices'],
      fields: ['status'],
      range: 'today'
    })
    const none = await guardFieldFilter(pat, false, { fields: ['budget'] }, 'drop', deps({}))
    expect(none.filters).toEqual({})
  })
})
