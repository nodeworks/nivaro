import { describe, expect, it } from 'vitest'
import { fuzzyStatement } from '../../../routes/global-search.js'
import { pickerTypoColumns, readTypoMatches } from '../../../services/picker-typo.js'
import type { ItemsQuery } from '../../../types.js'

// army 11 (deferred fix): a record picker searched "Kristna" and showed nothing, while
// global search finds Kristina. Pickers opt in with `typo=1`.
describe('pickerTypoColumns — what a picker typo pass may read', () => {
  const text = new Set(['name', 'first_name', 'last_name', 'email', 'invoice_id', 'static_token'])
  it('the display fields the picker asked for, top level, text, at most two', () => {
    expect(
      pickerTypoColumns({
        collection: 'vendors',
        fields: ['id', 'name', 'category.name', 'amount'],
        textColumns: text,
        allowed: null
      })
    ).toEqual(['name'])
  })
  it('falls back to the display template; never an unreadable or internal column', () => {
    expect(
      pickerTypoColumns({
        collection: 'invoices',
        template: '{{invoice_id}} {{name}}',
        textColumns: text,
        allowed: ['id', 'invoice_id'],
        internal: ['invoice_id']
      })
    ).toEqual([])
  })
  it('people pickers read name and email only, never a credential; other system tables none', () => {
    expect(
      pickerTypoColumns({
        collection: 'nivaro_users',
        fields: ['id', 'static_token', 'first_name', 'last_name', 'email'],
        textColumns: text,
        allowed: null
      })
    ).toEqual(['first_name', 'last_name'])
    expect(
      pickerTypoColumns({
        collection: 'nivaro_roles',
        fields: ['name'],
        textColumns: text,
        allowed: null
      })
    ).toEqual([])
  })
})

describe('fuzzyStatement top', () => {
  it('a picker keeps more candidates; the cap is bounded', () => {
    expect(
      fuzzyStatement([{ collection: 'v', cols: ['name'] }], 'kristna', false, 12)?.sql
    ).toContain('SELECT TOP 12')
    expect(
      fuzzyStatement([{ collection: 'v', cols: ['name'] }], 'kristna', false, 9999)?.sql
    ).toContain('SELECT TOP 50')
  })
})

describe('readTypoMatches — re-read as the caller, best first, flagged', () => {
  const query: ItemsQuery = {
    fields: ['id', 'first_name'],
    filter: { status: { _eq: 'active' } },
    search: 'Kristna',
    search_fields: ['first_name'],
    limit: 25,
    offset: 0
  }
  it('drops the search, ANDs the picker filter with the candidate ids', async () => {
    let asked: ItemsQuery | null = null
    const out = await readTypoMatches(query, ['7', '9'], ['first_name'], 'Kristna', async (q) => {
      asked = q
      return {
        data: [
          { id: 9, first_name: 'Kristen' },
          { id: 7, first_name: 'Kristina' }
        ],
        meta: { total: 2 }
      }
    })
    expect(asked).toEqual({
      fields: ['id', 'first_name'],
      filter: { _and: [{ status: { _eq: 'active' } }, { id: { _in: ['7', '9'] } }] },
      offset: 0,
      limit: 2
    })
    expect(out?.data.map((r) => r.first_name)).toEqual(['Kristina', 'Kristen'])
    expect(out?.data.every((r) => r.fuzzy === true)).toBe(true)
    expect(out?.meta).toMatchObject({ fuzzy: true, total: 2 })
  })
  it('rows the caller cannot read (filtered away) or that no longer look alike are gone', async () => {
    const out = await readTypoMatches(query, ['1'], ['first_name'], 'Kristna', async () => ({
      data: [{ id: 1, first_name: 'Bob' }]
    }))
    expect(out).toBeNull()
    expect(
      await readTypoMatches(query, [], ['first_name'], 'Kristna', async () => ({ data: [] }))
    ).toBeNull()
  })
})
