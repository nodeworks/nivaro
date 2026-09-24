import { afterEach, describe, expect, it, vi } from 'vitest'

const inserted: Record<string, unknown>[] = []
const rows: Record<string, unknown>[] = []
const orderedBy: string[] = []
let hasTable = true

vi.mock('../../../db/index.js', () => {
  const table = () => {
    const q: Record<string, unknown> = {}
    q.insert = vi.fn((row: Record<string, unknown>) => {
      inserted.push(row)
      return { returning: vi.fn().mockResolvedValue([{ id: 77 }]) }
    })
    q.where = vi.fn(() => q)
    q.whereIn = vi.fn(() => q)
    q.orderBy = vi.fn((col: string) => {
      orderedBy.push(col)
      return q
    })
    q.select = vi.fn(async () => rows)
    return q
  }
  const db = Object.assign(vi.fn(table), {
    schema: { hasTable: vi.fn(async () => hasTable) }
  })
  return { db }
})
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => undefined }))
vi.mock('../../../services/db-batch.js', () => ({
  selectInChunks: async (
    ids: string[],
    _size: number,
    fn: (chunk: string[]) => Promise<unknown[]>
  ) => fn(ids)
}))

import { currentChain } from '../../../services/chain.js'
import {
  beginChainRoot,
  chainIdsForRoots,
  resetChainRootsProbe
} from '../../../services/chain-roots.js'

afterEach(() => {
  inserted.length = 0
  rows.length = 0
  orderedBy.length = 0
  hasTable = true
  resetChainRootsProbe()
})

describe('beginChainRoot', () => {
  it('writes a root row and runs fn inside the new chain under root:<id>', async () => {
    const seen = await beginChainRoot({ source: 'efp-ops:mdsi', ref: '145266' }, async () =>
      currentChain()
    )
    expect(inserted[0]).toMatchObject({ source: 'efp-ops:mdsi', ref: '145266', replay_of: null })
    expect(seen?.chain_id).toBe(inserted[0].chain_id)
    expect(seen?.parent).toBe('root:77')
  })

  it('still runs fn in a fresh chain when the table is missing', async () => {
    hasTable = false
    const seen = await beginChainRoot({ source: 's', ref: 'r' }, async () => currentChain())
    expect(inserted).toHaveLength(0)
    expect(seen?.parent).toBe('root:s:r')
  })
})

describe('chainIdsForRoots', () => {
  it('maps refs to chain ids', async () => {
    rows.push({ ref: '1', chain_id: 'a' }, { ref: '2', chain_id: 'b' })
    const map = await chainIdsForRoots('efp-ops:mdsi', ['1', '2'])
    expect(map.get('1')).toBe('a')
    expect(map.get('2')).toBe('b')
    expect(orderedBy).toEqual(['id'])
  })

  it('keeps the oldest row when a ref maps to more than one chain', async () => {
    rows.push({ ref: '1', chain_id: 'first' }, { ref: '1', chain_id: 'later' })
    expect((await chainIdsForRoots('s', ['1'])).get('1')).toBe('first')
  })

  it('returns an empty map for no refs', async () => {
    expect((await chainIdsForRoots('x', [])).size).toBe(0)
  })
})
