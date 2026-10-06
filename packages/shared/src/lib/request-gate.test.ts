import { type NivaroClient, readItem, readItems, readMany } from '@nivaro/sdk'
import { describe, expect, it, vi } from 'vitest'
import { batchableRead, withGetCoalescing } from './request-gate'

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

function fakeClient(answer: (c: Cmd) => unknown) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (c: Cmd) => {
      calls.push(c)
      const r = answer(c)
      if (r instanceof Error) throw r
      return r
    })
  } as unknown as NivaroClient
  return { client, calls }
}

describe('readMany (SDK command)', () => {
  it('posts every read to /items/batch-read in the GET route string form', () => {
    const c = readMany([
      {
        collection: 'regions',
        query: { fields: ['id', 'name'], filter: { id: { _gt: 1 } }, limit: 5 }
      },
      { key: 'one', collection: 'vendors', id: 7, query: { fields: ['id'], limit: 3 } }
    ]) as unknown as Cmd
    expect(c._method).toBe('POST')
    expect(c._path).toBe('/items/batch-read')
    expect(c._body).toEqual({
      reads: [
        {
          collection: 'regions',
          query: { fields: 'id,name', filter: { id: { _gt: 1 } }, limit: 5 }
        },
        // A single-record read only carries its fields.
        { key: 'one', collection: 'vendors', id: 7, query: { fields: 'id' } }
      ]
    })
  })
})

describe('batchableRead', () => {
  it('accepts list and single record reads', () => {
    expect(batchableRead(readItems('regions', { limit: 2 }))).toEqual({
      collection: 'regions',
      query: { limit: 2 }
    })
    expect(batchableRead(readItem('regions', 4))).toEqual({
      collection: 'regions',
      id: '4',
      query: {}
    })
  })

  it('refuses writes, sub-routes and query keys the batch does not know', () => {
    expect(batchableRead({ _method: 'POST', _path: '/items/regions' })).toBeNull()
    expect(batchableRead({ _method: 'GET', _path: '/items/regions/aggregate' })).toBeNull()
    expect(batchableRead({ _method: 'GET', _path: '/items/regions/4/resolve-paths' })).toBeNull()
    expect(batchableRead({ _method: 'GET', _path: '/collections/regions' })).toBeNull()
    expect(
      batchableRead({ _method: 'GET', _path: '/items/regions', _params: { picker: '1' } })
    ).toBeNull()
  })
})

describe('withGetCoalescing batchReads', () => {
  it('is off by default', async () => {
    const { client, calls } = fakeClient(() => ({ data: [] }))
    const c = withGetCoalescing(client)
    await Promise.all([c.request(readItems('a')), c.request(readItems('b'))])
    expect(calls.map((x) => `${x._method} ${x._path}`)).toEqual(['GET /items/a', 'GET /items/b'])
  })

  it('sends same-tick reads as one batch and answers each in its GET shape', async () => {
    const { client, calls } = fakeClient((c) => {
      if (c._path === '/items/batch-read')
        return {
          results: [
            { key: '0', status: 200, data: [{ id: 1 }], meta: { total: 9 } },
            { key: '1', status: 200, data: { id: 4 } }
          ]
        }
      throw new Error(`unexpected ${c._path}`)
    })
    const c = withGetCoalescing(client, { batchReads: true })
    const [list, one] = await Promise.all([
      c.request(readItems('regions', { limit: 1 })),
      c.request(readItem('vendors', 4))
    ])
    expect(calls).toHaveLength(1)
    expect(list).toEqual({ data: [{ id: 1 }], total: 9 })
    expect(one).toEqual({ data: { id: 4 } })
  })

  it('re-sends a read the batch refused, on its own', async () => {
    const { client, calls } = fakeClient((c) => {
      if (c._path === '/items/batch-read')
        return {
          results: [
            { key: '0', status: 200, data: [] },
            { key: '1', status: 404, error: 'Not found' }
          ]
        }
      return new Error('Not found')
    })
    const c = withGetCoalescing(client, { batchReads: true })
    const results = await Promise.allSettled([
      c.request(readItems('regions')),
      c.request(readItem('regions', 999))
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect(calls.map((x) => `${x._method} ${x._path}`)).toEqual([
      'POST /items/batch-read',
      'GET /items/regions/999'
    ])
  })

  it('falls back to individual reads when the batch itself fails', async () => {
    const { client, calls } = fakeClient((c) =>
      c._path === '/items/batch-read' ? new Error('404') : { data: c._path }
    )
    const c = withGetCoalescing(client, { batchReads: true })
    const [a, b] = await Promise.all([c.request(readItems('a')), c.request(readItems('b'))])
    expect(a).toEqual({ data: '/items/a' })
    expect(b).toEqual({ data: '/items/b' })
    expect(calls).toHaveLength(3)
  })

  it('a lone read skips the batch', async () => {
    const { client, calls } = fakeClient(() => ({ data: [] }))
    const c = withGetCoalescing(client, { batchReads: true })
    await c.request(readItems('a'))
    expect(calls.map((x) => x._path)).toEqual(['/items/a'])
  })
})
