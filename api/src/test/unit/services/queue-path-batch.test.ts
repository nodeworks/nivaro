import { describe, expect, it, vi } from 'vitest'
import { type BatchRow, PathReadBatch } from '../../../services/queue-path-batch.js'
import type { CMSRelation } from '../../../types.js'

const rel = (id: number): CMSRelation => ({ id, many_collection: 'a' }) as unknown as CMSRelation

function rowsFor(ids: string[], columns: string[]): BatchRow[] {
  return ids.map((id) => {
    const row: BatchRow = { id }
    for (const c of columns) row[c] = `${c}-${id}`
    return row
  })
}

describe('PathReadBatch.rows', () => {
  it('folds same-tick requests for one collection and id list into one select', async () => {
    const fetchRows = vi.fn(async (_c: string, ids: string[], cols: string[]) => rowsFor(ids, cols))
    const batch = new PathReadBatch(fetchRows, vi.fn())
    const ids = ['1', '2']
    const [a, b, c] = await Promise.all([
      batch.rows('workflows', ids, ['name']),
      batch.rows('workflows', [...ids], ['status', 'name']),
      batch.rows('workflows', ids, [])
    ])
    expect(fetchRows).toHaveBeenCalledTimes(1)
    expect(fetchRows).toHaveBeenCalledWith('workflows', ids, ['name', 'status'], 'id')
    expect(a).toBe(b)
    expect(c).toBe(a)
    expect(a[1]).toEqual({ id: '2', name: 'name-2', status: 'status-2' })
    expect(batch.rowStatements).toBe(1)
  })

  it('never asks for id twice (tedious turns a repeated column into an array)', async () => {
    const fetchRows = vi.fn(async (_c: string, ids: string[], cols: string[]) => rowsFor(ids, cols))
    const batch = new PathReadBatch(fetchRows, vi.fn())
    await batch.rows('workflows', ['1'], ['id', 'name'])
    expect(fetchRows).toHaveBeenCalledWith('workflows', ['1'], ['name'], 'id')
  })

  it('reads by another key column (children by parent) and keeps it apart from id reads', async () => {
    const fetchRows = vi.fn(async (_c: string, ids: string[], cols: string[]) => rowsFor(ids, cols))
    const batch = new PathReadBatch(fetchRows, vi.fn())
    await Promise.all([
      batch.rows('lines', ['1'], ['qty'], 'order_id'),
      batch.rows('lines', ['1'], ['order_id', 'sku'], 'order_id'),
      batch.rows('lines', ['1'], ['qty'])
    ])
    expect(fetchRows).toHaveBeenCalledTimes(2)
    expect(fetchRows).toHaveBeenCalledWith('lines', ['1'], ['qty', 'sku'], 'order_id')
    expect(fetchRows).toHaveBeenCalledWith('lines', ['1'], ['qty'], 'id')
  })

  it('keeps different id lists and collections apart', async () => {
    const fetchRows = vi.fn(async (_c: string, ids: string[], cols: string[]) => rowsFor(ids, cols))
    const batch = new PathReadBatch(fetchRows, vi.fn())
    await Promise.all([
      batch.rows('workflows', ['1'], ['name']),
      batch.rows('workflows', ['2'], ['name']),
      batch.rows('projects', ['1'], ['name'])
    ])
    expect(fetchRows).toHaveBeenCalledTimes(3)
  })

  it('a request after the flush gets its own select', async () => {
    const fetchRows = vi.fn(async (_c: string, ids: string[], cols: string[]) => rowsFor(ids, cols))
    const batch = new PathReadBatch(fetchRows, vi.fn())
    await batch.rows('workflows', ['1'], ['name'])
    await batch.rows('workflows', ['1'], ['status'])
    expect(fetchRows).toHaveBeenCalledTimes(2)
    expect(fetchRows).toHaveBeenLastCalledWith('workflows', ['1'], ['status'], 'id')
  })

  it('when the shared select fails, each request falls back to its own — only the bad one fails', async () => {
    const fetchRows = vi.fn(async (_c: string, ids: string[], cols: string[]) => {
      if (cols.includes('gone')) throw new Error('Invalid column name gone')
      return rowsFor(ids, cols)
    })
    const batch = new PathReadBatch(fetchRows, vi.fn())
    const [good, bad] = await Promise.allSettled([
      batch.rows('workflows', ['1'], ['name']),
      batch.rows('workflows', ['1'], ['gone'])
    ])
    expect(good).toEqual({ status: 'fulfilled', value: [{ id: '1', name: 'name-1' }] })
    expect(bad.status).toBe('rejected')
    // shared attempt + one solo retry per request
    expect(fetchRows).toHaveBeenCalledTimes(3)
  })
})

describe('PathReadBatch.relations', () => {
  it('shares one in-flight lookup per collection and fills the caller cache', async () => {
    let release: (r: CMSRelation[]) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<CMSRelation[]>((resolve) => {
          release = resolve
        })
    )
    const batch = new PathReadBatch(vi.fn(), load)
    const cache = new Map<string, CMSRelation[]>()
    const p1 = batch.relations('workflows', cache)
    const p2 = batch.relations('workflows', cache)
    release([rel(1)])
    expect(await p1).toEqual([rel(1)])
    expect(await p2).toEqual([rel(1)])
    expect(load).toHaveBeenCalledTimes(1)
    expect(cache.get('workflows')).toEqual([rel(1)])
    // now served from the cache
    await batch.relations('workflows', cache)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not remember a failed lookup', async () => {
    const load = vi
      .fn<(c: string) => Promise<CMSRelation[]>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([rel(2)])
    const batch = new PathReadBatch(vi.fn(), load)
    const cache = new Map<string, CMSRelation[]>()
    await expect(batch.relations('workflows', cache)).rejects.toThrow('timeout')
    expect(await batch.relations('workflows', cache)).toEqual([rel(2)])
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('PathReadBatch.once', () => {
  it('runs an identical statement once per batch', async () => {
    const batch = new PathReadBatch(vi.fn(), vi.fn())
    const run = vi.fn(async () => [{ id: 1 }])
    const [a, b] = await Promise.all([batch.once('k', run), batch.once('k', run)])
    expect(a).toBe(b)
    expect(run).toHaveBeenCalledTimes(1)
    await batch.once('other', run)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
