import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))

import { resolveLookupColumnValues, resolveRelatedLabels } from '../../../services/review-list.js'

// AA2: related records reached by a lookup or a label read as the viewer — only the ones they
// can read lend a value; system tables (people names on stamps) are not narrowed.

function tableDb(rows: Record<string, Array<Record<string, unknown>>>) {
  return vi.fn((table: string) => {
    const qb: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'orderBy', 'limit', 'orWhere', 'andWhere'])
      qb[m] = vi.fn(() => qb)
    qb.select = vi.fn(async () => rows[table] ?? [])
    return qb
  })
}

describe('related records as the viewer', () => {
  it('a lookup takes values only from matched rows the viewer can read', async () => {
    const db = tableDb({
      line_items: [
        { id: 1, purchase_order: 'PO1', line: 1, qty: 5 },
        { id: 2, purchase_order: 'PO1', line: 2, qty: 9 }
      ]
    })
    const related = vi.fn(
      async (_c: string, ids: string[]) => new Set(ids.filter((i) => i === '1'))
    )
    const { valueMaps } = await resolveLookupColumnValues(
      db as never,
      [
        {
          field: 'qty_col',
          lookup: {
            collection: 'line_items',
            field: 'qty',
            match: [
              { local: 'po', remote: 'purchase_order' },
              { local: 'ln', remote: 'line' }
            ]
          }
        }
      ],
      [
        { id: 'a', po: 'PO1', ln: 1 },
        { id: 'b', po: 'PO1', ln: 2 }
      ],
      { warn: vi.fn() },
      'review_list',
      related
    )
    const m = valueMaps.get('qty_col')
    expect(m?.get(JSON.stringify(['PO1', '1']))).toBe(5)
    expect(m?.has(JSON.stringify(['PO1', '2']))).toBe(false)
    expect(related).toHaveBeenCalledWith('line_items', ['1', '2'])
  })

  it('labels only the related records the viewer can read; people are not narrowed', async () => {
    const db = tableDb({
      zones: [
        { id: 1, name: 'North' },
        { id: 2, name: 'South' }
      ],
      nivaro_users: [{ id: 'u1', first_name: 'Kim' }]
    })
    const related = vi.fn(
      async (_c: string, ids: string[]) => new Set(ids.filter((i) => i === '1'))
    )
    const labels = await resolveRelatedLabels(db as never, 'zones', [1, 2], related)
    expect([...labels.keys()]).toEqual(['1'])
    const people = await resolveRelatedLabels(db as never, 'nivaro_users', ['u1'], related)
    expect(people.has('u1')).toBe(true)
    expect(related).toHaveBeenCalledTimes(1)
  })
})
