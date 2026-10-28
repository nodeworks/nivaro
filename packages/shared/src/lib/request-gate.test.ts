import { executeCustomQuery, type NivaroClient, readItem, readItems, readMany } from '@nivaro/sdk'
import { describe, expect, it, vi } from 'vitest'

describe('withGetCoalescing and cancellable reads (Command._signal, 2026-10-28)', () => {
  // How shared builds a cancellable command (ReportView): inline, no SDK helper import.
  const withSignal = <C extends object>(c: C, signal?: AbortSignal): C =>
    signal ? { ...c, _signal: signal } : c
  function counting() {
    const calls: unknown[] = []
    const client = {
      request: vi.fn(async (c: unknown) => {
        calls.push(c)
        return { data: [] }
      })
    } as unknown as NivaroClient
    return { client, calls }
  }

  it('never shares a read that carries its own AbortSignal', async () => {
    const { client, calls } = counting()
    const c = withGetCoalescing(client)
    const plain = readItems('regions', { limit: 5 })
    await Promise.all([
      c.request(withSignal(plain, new AbortController().signal)),
      c.request(withSignal(plain, new AbortController().signal))
    ])
    expect(calls.length).toBe(2)
  })

  // execute is a POST, so it takes the wrapper's write path: the field must survive it.
  it('passes the signal through on the write path (POST custom-query execute)', async () => {
    const { client, calls } = counting()
    const c = withGetCoalescing(client)
    const ac = new AbortController()
    await c.request(withSignal(executeCustomQuery('rpt-x', { a: 1 }), ac.signal))
    expect((calls[0] as { _signal?: AbortSignal })._signal).toBe(ac.signal)
  })

  it('leaves a command without a signal unchanged', () => {
    const plain = readItems('regions', { limit: 5 })
    expect(withSignal(plain, undefined)).toBe(plain)
  })
})

import {
  batchableRead,
  createGatedClient,
  forgetSettledReads,
  mayJoinInflight,
  RECORD_JOIN_MS,
  releaseGatedReads,
  releaseGatedReadsOnSharedFetch,
  SETTLED_READ_MS,
  withGetCoalescing
} from './request-gate'

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

describe('createGatedClient shared-cache release', () => {
  const fakeClient = () => {
    const calls: string[] = []
    const client = {
      request: vi.fn(async (c: { _path?: string }) => {
        calls.push(c._path ?? '')
        return { ok: c._path }
      })
    } as unknown as NivaroClient
    return { client, calls }
  }
  const read = (path: string) => ({ _method: 'GET', _path: path }) as never

  it('a closed gate holds reads until releaseGatedReads, then stays closed', async () => {
    const { client, calls } = fakeClient()
    const gated = createGatedClient(client, { open: false })
    const held = gated.request(read('/field-config/inventory_request'))
    await Promise.resolve()
    expect(calls).toEqual([])
    releaseGatedReads()
    await expect(held).resolves.toEqual({ ok: '/field-config/inventory_request' })
    expect(gated.open).toBe(false)
    const later = gated.request(read('/collections/inventory_request'))
    await Promise.resolve()
    expect(calls).toEqual(['/field-config/inventory_request'])
    gated.setOpen(true)
    await later
    expect(calls).toHaveLength(2)
  })

  it('an observer joining a fetching query releases held reads; idle queries do not', async () => {
    const { client, calls } = fakeClient()
    const gated = createGatedClient(client, { open: false })
    let listener:
      | ((e: { type: string; query: { state: { fetchStatus?: string } } }) => void)
      | null = null
    const cache = {
      subscribe: (l: typeof listener) => {
        listener = l
        return () => {}
      }
    }
    releaseGatedReadsOnSharedFetch(cache as never)
    const held = gated.request(read('/collection-layouts/active'))
    listener!({ type: 'observerAdded', query: { state: { fetchStatus: 'idle' } } })
    await Promise.resolve()
    expect(calls).toEqual([])
    listener!({ type: 'observerAdded', query: { state: { fetchStatus: 'fetching' } } })
    await held
    expect(calls).toEqual(['/collection-layouts/active'])
  })
})

describe('withGetCoalescing in-flight joins (stale record after a save)', () => {
  const get = (path: string) => ({ _method: 'GET', _path: path }) as Cmd

  it('mayJoinInflight: same moment joins; a later record read or another write epoch does not', () => {
    const rec = get('/items/workflows/1')
    const meta = get('/collections/workflows')
    expect(mayJoinInflight(rec, { at: 1000, epoch: 3 }, 1000 + RECORD_JOIN_MS - 1, 3)).toBe(true)
    expect(mayJoinInflight(rec, { at: 1000, epoch: 3 }, 1000 + RECORD_JOIN_MS, 3)).toBe(false)
    expect(mayJoinInflight(meta, { at: 1000, epoch: 3 }, 9000, 3)).toBe(true)
    expect(mayJoinInflight(meta, { at: 1000, epoch: 3 }, 1000, 4)).toBe(false)
  })

  it('same-tick reads of one record still share one request', async () => {
    const { client, calls } = fakeClient(() => ({ data: { id: 1, description: 'A' } }))
    const c = withGetCoalescing(client)
    const [a, b] = await Promise.all([
      c.request(get('/items/workflows/1') as never),
      c.request(get('/items/workflows/1') as never)
    ])
    expect(calls).toHaveLength(1)
    expect(a).toEqual(b)
  })

  it('a read asked after a save never joins a read sent before it (refused join)', async () => {
    let row = { id: 1, description: 'A' }
    let release: (() => void) | null = null
    const calls: Cmd[] = []
    const client = {
      request: vi.fn((cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._method === 'PATCH') {
          row = { ...row, ...(cmd._body as object) }
          return Promise.resolve({ data: row })
        }
        const snapshot = { ...row }
        // The first read is slow: it was sent before the save and answers the old row.
        if (calls.filter((x) => x._method === 'GET').length === 1)
          return new Promise((r) => {
            release = () => r({ data: snapshot })
          })
        return Promise.resolve({ data: snapshot })
      })
    } as unknown as NivaroClient
    const c = withGetCoalescing(client)
    const early = c.request(get('/items/workflows/1') as never)
    await c.request({
      _method: 'PATCH',
      _path: '/items/workflows/1',
      _body: { description: 'A b3' }
    } as never)
    const after = c.request(get('/items/workflows/1') as never)
    ;(release as unknown as () => void)()
    expect(((await early) as { data: { description: string } }).data.description).toBe('A')
    expect(((await after) as { data: { description: string } }).data.description).toBe('A b3')
    expect(calls.filter((x) => x._method === 'GET')).toHaveLength(2)
  })

  it('a record refetch asked later (live event, no local write) goes to the server', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      let release: (() => void) | null = null
      const { client, calls } = fakeClient(() => {
        n++
        if (n === 1)
          return new Promise((r) => {
            release = () => r({ data: { id: 1, description: 'A' } })
          })
        return { data: { id: 1, description: 'A b3' } }
      })
      const c = withGetCoalescing(client)
      const early = c.request(get('/items/workflows/1') as never)
      vi.advanceTimersByTime(RECORD_JOIN_MS + 1)
      const after = c.request(get('/items/workflows/1') as never)
      ;(release as unknown as () => void)()
      await early
      expect(((await after) as { data: { description: string } }).data.description).toBe('A b3')
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('withGetCoalescing speed kept (no regression from the write epoch)', () => {
  const get = (path: string) => ({ _method: 'GET', _path: path }) as Cmd

  it('N identical reads fired together on a load collapse into ONE request (config and record)', async () => {
    for (const path of ['/field-config/workflows', '/items/workflows/1', '/items/workflows']) {
      const { client, calls } = fakeClient(() => ({ data: [{ id: 1 }] }))
      const c = withGetCoalescing(client)
      const all = await Promise.all(Array.from({ length: 8 }, () => c.request(get(path) as never)))
      expect(calls).toHaveLength(1)
      expect(new Set(all.map((a) => JSON.stringify(a))).size).toBe(1)
    }
  })

  it('settled config reads are reused for SETTLED_READ_MS with no write, and a write ends it', async () => {
    forgetSettledReads()
    const { client, calls } = fakeClient(() => ({ data: [{ field: 'x' }] }))
    const c = withGetCoalescing(client)
    await c.request(get('/field-config/workflows') as never)
    await c.request(get('/field-config/workflows') as never)
    expect(calls).toHaveLength(1)
    await c.request({ _method: 'PATCH', _path: '/field-config/workflows/x', _body: {} } as never)
    await c.request(get('/field-config/workflows') as never)
    expect(calls.filter((x) => x._method === 'GET')).toHaveLength(2)
    expect(SETTLED_READ_MS).toBe(3000)
  })

  it('a record write splits only reads straddling it: reads fired together after it still collapse', async () => {
    const { client, calls } = fakeClient(() => ({ data: [] }))
    const c = withGetCoalescing(client)
    await c.request({ _method: 'PATCH', _path: '/items/vendors/9', _body: { a: 1 } } as never)
    await Promise.all(Array.from({ length: 5 }, () => c.request(get('/items/zones') as never)))
    expect(calls.filter((x) => x._method === 'GET')).toHaveLength(1)
  })
})
