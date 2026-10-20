import { describe, expect, it, vi } from 'vitest'

// #1224 — extra-column paths of one resolve share their reads, and answer
// exactly what each path answered on its own.
const TABLES: Record<string, Array<Record<string, unknown>>> = {
  articles: [
    { id: '1', name: 'One', status: 'open' },
    { id: '2', name: 'Two', status: null }
  ],
  lines: [
    { id: '1-a', article: '1', sku: 'S1a' },
    { id: '1-b', article: '1', sku: null },
    { id: '2-a', article: '2', sku: 'S2a' }
  ]
}
const selects: Array<{ table: string; by: string; cols: string[] }> = []
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    let cols: string[] = []
    let by = 'id'
    let vals: string[] = []
    const chain = {
      whereIn: (c: string, v: string[]) => {
        by = c
        vals = v.map(String)
        return chain
      },
      select: (c: string[]) => {
        cols = c
        selects.push({ table, by, cols })
        return chain
      },
      // biome-ignore lint/suspicious/noThenProperty: thenable stands in for the knex builder
      then: (resolve: (v: unknown) => void) =>
        resolve(
          (TABLES[table] ?? [])
            .filter((r) => vals.includes(String(r[by])))
            .map((r) =>
              cols.includes('*') ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c]]))
            )
        )
    }
    return chain
  })
}))
const RELATIONS = [
  {
    id: 1,
    many_collection: 'lines',
    many_field: 'article',
    one_collection: 'articles',
    one_field: 'lines',
    junction_field: null
  }
]
const getRelations = vi.fn(async () => RELATIONS)
vi.mock('../../../services/collections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/collections.js')>()),
  getRelations: (...a: unknown[]) => getRelations(...(a as [])),
  getCollection: vi.fn(async () => undefined)
}))

import { newPathReadBatch, resolveExtraPathValues } from '../../../services/queues.js'
import type { CMSRelation } from '../../../types.js'

async function resolveAll(paths: string[], shared: boolean) {
  const cache = new Map<string, CMSRelation[]>()
  const batch = shared ? newPathReadBatch() : undefined
  const maps = await Promise.all(
    paths.map((p) => resolveExtraPathValues('articles', ['1', '2'], p, cache, null, batch))
  )
  return maps.map((m) => [...m.entries()].sort())
}

describe('extra-column paths with a shared batch', () => {
  it('reads plain columns of the same rows in ONE select', async () => {
    const paths = ['name', 'status', 'id']
    selects.length = 0
    getRelations.mockClear()
    const unbatched = await resolveAll(paths, false)
    expect(selects).toHaveLength(3)
    expect(getRelations).toHaveBeenCalledTimes(3)

    selects.length = 0
    getRelations.mockClear()
    const batched = await resolveAll(paths, true)
    expect(selects).toEqual([{ table: 'articles', by: 'id', cols: ['id', 'name', 'status'] }])
    expect(getRelations).toHaveBeenCalledTimes(1)

    expect(batched).toEqual(unbatched)
    expect(batched[1]).toEqual([
      ['1', { value: 'open', ids: [] }],
      ['2', { value: '', ids: [] }]
    ])
  })

  it('reads a plain column one o2m hop down by the parents, once for every such path', async () => {
    const paths = ['lines.sku', 'lines.id']
    selects.length = 0
    const unbatched = await resolveAll(paths, false)
    // per path: the hop, then the children again by id
    expect(selects.filter((s) => s.table === 'lines')).toHaveLength(4)

    selects.length = 0
    const batched = await resolveAll(paths, true)
    expect(selects).toEqual([
      { table: 'lines', by: 'article', cols: ['article', 'id'] },
      { table: 'lines', by: 'article', cols: ['article', 'id', 'sku'] }
    ])
    expect(batched).toEqual(unbatched)
    expect(batched[0]).toEqual([
      ['1', { value: 'S1a', ids: ['1-a', '1-b'] }],
      ['2', { value: 'S2a', ids: ['2-a'] }]
    ])
  })
})
