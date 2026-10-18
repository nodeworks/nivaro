import type { NivaroClient } from '@nivaro/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get, patch, post } from './commands'
import {
  batchableCollectionMeta,
  COLLECTION_BATCH_LIMIT,
  createGatedClient,
  forgetSettledReads,
  isSettledRead,
  SETTLED_READ_MS,
  withGetCoalescing
} from './request-gate'

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

function fakeClient(answer: (c: Cmd) => unknown) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (c: Cmd) => {
      calls.push(c)
      const r = await answer(c)
      if (r instanceof Error) throw r
      return r
    })
  } as unknown as NivaroClient
  return { client, calls }
}

const wire = (calls: Cmd[]) =>
  calls.map((c) => {
    const qs = c._params
      ? new URLSearchParams(
          Object.entries(c._params)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return `${c._method} ${c._path}${qs ? `?${qs}` : ''}`
  })

const meta = (name: string) => ({ collection: name, fields: [{ field: 'id' }], relations: [] })

/** A server that knows the batch: answers the names it has, lists the rest missing. */
function batchServer(known: string[], opts: { failing?: string[] } = {}) {
  return (c: Cmd) => {
    if (c._path === '/collections' && c._params?.names) {
      const names = String(c._params.names).split(',')
      const data: Record<string, unknown> = {}
      const missing: string[] = []
      const errors: Record<string, string> = {}
      for (const n of names) {
        if (opts.failing?.includes(n)) errors[n] = 'Internal Server Error'
        else if (known.includes(n)) data[n] = meta(n)
        else missing.push(n)
      }
      return { data, missing, errors }
    }
    const m = /^\/collections\/(.+)$/.exec(c._path)
    if (m) {
      if (opts.failing?.includes(m[1])) return Object.assign(new Error('boom'), { status: 500 })
      return known.includes(m[1])
        ? { data: meta(m[1]) }
        : Object.assign(new Error('Not found'), { status: 404 })
    }
    return { data: c._path }
  }
}

afterEach(() => {
  vi.useRealTimers()
  forgetSettledReads()
})

describe('batchableCollectionMeta', () => {
  it('takes plain metadata reads only', () => {
    expect(batchableCollectionMeta(get('/collections/org_codes'))).toBe('org_codes')
    expect(batchableCollectionMeta(get('/collections/org_codes', {}))).toBe('org_codes')
    expect(batchableCollectionMeta(get('/collections/org_codes', { x: undefined }))).toBe(
      'org_codes'
    )
    expect(batchableCollectionMeta(get('/collections/org_codes', { tables_only: 'true' }))).toBe(
      null
    )
    expect(batchableCollectionMeta(get('/collections/org_codes/fields'))).toBe(null)
    expect(batchableCollectionMeta(get('/collections'))).toBe(null)
    expect(batchableCollectionMeta(patch('/collections/org_codes', {}))).toBe(null)
    expect(batchableCollectionMeta(get('/collections/a.b'))).toBe(null)
  })
})

describe('collection metadata loader', () => {
  it('coalesces names asked within the window into ONE request and answers each its own shape', async () => {
    const { client, calls } = fakeClient(batchServer(['workflows', 'org_codes', 'nivaro_users']))
    const c = withGetCoalescing(client)
    const [a, b, d] = await Promise.all([
      c.request(get('/collections/workflows')),
      c.request(get('/collections/org_codes')),
      // Asked a few ms later — still inside the window.
      new Promise((r) => setTimeout(r, 3)).then(() => c.request(get('/collections/nivaro_users')))
    ])
    expect(wire(calls)).toEqual(['GET /collections?names=workflows%2Corg_codes%2Cnivaro_users'])
    expect(a).toEqual({ data: meta('workflows') })
    expect(b).toEqual({ data: meta('org_codes') })
    expect(d).toEqual({ data: meta('nivaro_users') })
  })

  it('the same name asked twice rides once and both callers get their own copy', async () => {
    const { client, calls } = fakeClient(batchServer(['a', 'b']))
    const c = withGetCoalescing(client)
    const [x, y] = await Promise.all([
      c.request(get<{ data: { fields: unknown[] } }>('/collections/a')),
      c.request(get<{ data: { fields: unknown[] } }>('/collections/a')),
      c.request(get('/collections/b'))
    ])
    expect(calls).toHaveLength(1)
    expect(x).toEqual(y)
    x.data.fields.push('mutated')
    expect(y.data.fields).toHaveLength(1)
  })

  it('a lone name goes as the plain single read', async () => {
    const { client, calls } = fakeClient(batchServer(['a']))
    const c = withGetCoalescing(client)
    expect(await c.request(get('/collections/a'))).toEqual({ data: meta('a') })
    expect(wire(calls)).toEqual(['GET /collections/a'])
  })

  it('isolates errors: a missing name rejects 404, a failed name is re-sent alone, the rest resolve', async () => {
    const { client, calls } = fakeClient(batchServer(['ok'], { failing: ['bad'] }))
    const c = withGetCoalescing(client)
    const [ok, gone, bad] = await Promise.allSettled([
      c.request(get('/collections/ok')),
      c.request(get('/collections/gone')),
      c.request(get('/collections/bad'))
    ])
    expect(ok).toEqual({ status: 'fulfilled', value: { data: meta('ok') } })
    expect(gone.status).toBe('rejected')
    expect((gone as PromiseRejectedResult).reason.status).toBe(404)
    expect(bad.status).toBe('rejected')
    expect((bad as PromiseRejectedResult).reason.status).toBe(500)
    expect(wire(calls)).toEqual([
      'GET /collections?names=ok%2Cgone%2Cbad',
      // Only the name the server failed on goes again — on its own.
      'GET /collections/bad'
    ])
  })

  it('a batch that fails as a whole falls back to single reads', async () => {
    const server = batchServer(['a', 'b'])
    const { client, calls } = fakeClient((c) =>
      c._path === '/collections' ? new Error('network') : server(c)
    )
    const c = withGetCoalescing(client)
    const res = await Promise.all([
      c.request(get('/collections/a')),
      c.request(get('/collections/b'))
    ])
    expect(res).toEqual([{ data: meta('a') }, { data: meta('b') }])
    expect(wire(calls)).toEqual([
      'GET /collections?names=a%2Cb',
      'GET /collections/a',
      'GET /collections/b'
    ])
  })

  it('an older server (list route answers an array) switches the loader off for good', async () => {
    const server = batchServer(['a', 'b', 'c', 'd'])
    const { client, calls } = fakeClient((c) =>
      c._path === '/collections' ? { data: [{ collection: 'a' }] } : server(c)
    )
    const c = withGetCoalescing(client)
    await Promise.all([c.request(get('/collections/a')), c.request(get('/collections/b'))])
    calls.length = 0
    await Promise.all([c.request(get('/collections/c')), c.request(get('/collections/d'))])
    expect(wire(calls)).toEqual(['GET /collections/c', 'GET /collections/d'])
  })

  it(`chunks at ${COLLECTION_BATCH_LIMIT} names per request`, async () => {
    const names = Array.from({ length: COLLECTION_BATCH_LIMIT + 5 }, (_, i) => `c${i}`)
    const { client, calls } = fakeClient(batchServer(names))
    const c = withGetCoalescing(client)
    const res = await Promise.all(names.map((n) => c.request(get(`/collections/${n}`))))
    expect(calls).toHaveLength(2)
    expect(String(calls[0]._params?.names).split(',')).toHaveLength(COLLECTION_BATCH_LIMIT)
    expect(String(calls[1]._params?.names).split(',')).toHaveLength(5)
    expect(res[names.length - 1]).toEqual({ data: meta(names[names.length - 1]) })
  })

  it('batchCollections: false opts out', async () => {
    const { client, calls } = fakeClient(batchServer(['a', 'b']))
    const c = withGetCoalescing(client, { batchCollections: false })
    await Promise.all([c.request(get('/collections/a')), c.request(get('/collections/b'))])
    expect(wire(calls)).toEqual(['GET /collections/a', 'GET /collections/b'])
  })

  it('works behind a gated client (record tabs): queued names batch once the gate opens', async () => {
    const { client, calls } = fakeClient(batchServer(['a', 'b']))
    const base = withGetCoalescing(client)
    const gated = createGatedClient(base, { open: false })
    const p = Promise.all([
      gated.request(get('/collections/a')),
      gated.request(get('/collections/b'))
    ])
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(0)
    gated.setOpen(true)
    expect(await p).toEqual([{ data: meta('a') }, { data: meta('b') }])
    expect(wire(calls)).toEqual(['GET /collections?names=a%2Cb'])
  })
})

describe('request keys', () => {
  it('{} / undefined / number-vs-string / key order are the same in-flight request', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { client, calls } = fakeClient(async () => {
      await gate
      return { data: [] }
    })
    const c = withGetCoalescing(client, { batchCollections: false })
    const all = Promise.all([
      c.request(get('/items/x/1', { fields: 'id', limit: 5 })),
      c.request(get('/items/x/1', { limit: '5', fields: 'id', search: undefined })),
      c.request(get('/field-config/workflows', {})),
      c.request(get('/field-config/workflows')),
      c.request(get('/field-config/workflows', { layout_id: 7 })),
      c.request(get('/field-config/workflows', { layout_id: '7' }))
    ])
    release()
    await all
    expect(wire(calls)).toEqual([
      'GET /items/x/1?fields=id&limit=5',
      'GET /field-config/workflows',
      'GET /field-config/workflows?layout_id=7'
    ])
  })
})

describe('settled configuration reads', () => {
  it('settles metadata paths only — never record data', () => {
    expect(isSettledRead(get('/collections/workflows'))).toBe(true)
    expect(isSettledRead(get('/field-config/workflows', { layout_id: 3 }))).toBe(true)
    expect(isSettledRead(get('/collection-layouts', { collection: 'workflows' }))).toBe(true)
    expect(isSettledRead(get('/collection-layouts/active', { collection: 'workflows' }))).toBe(true)
    expect(isSettledRead(get('/chat/room-types'))).toBe(true)
    expect(isSettledRead(get('/items/workflows/5'))).toBe(false)
    expect(isSettledRead(get('/config-conformance/record/workflows/5'))).toBe(false)
    expect(isSettledRead(post('/collections/workflows', {}))).toBe(false)
  })

  it('a repeat after the first answered is served from the settled answer, not the wire', async () => {
    const { client, calls } = fakeClient((c) => ({ data: [{ field: c._path }] }))
    const c = withGetCoalescing(client)
    const first = await c.request(get<{ data: unknown[] }>('/field-config/workflows'))
    first.data.push('mutated by caller')
    const again = await c.request(get<{ data: unknown[] }>('/field-config/workflows', {}))
    expect(calls).toHaveLength(1)
    expect(again.data).toHaveLength(1)
  })

  it('record reads still go to the server every time', async () => {
    const { client, calls } = fakeClient(() => ({ data: { id: 1 } }))
    const c = withGetCoalescing(client)
    await c.request(get('/items/workflows/1'))
    await c.request(get('/items/workflows/1'))
    expect(calls).toHaveLength(2)
  })

  it(`expires after ${SETTLED_READ_MS} ms`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { client, calls } = fakeClient(() => ({ data: [] }))
    const c = withGetCoalescing(client)
    await c.request(get('/chat/room-types'))
    vi.setSystemTime(Date.now() + SETTLED_READ_MS + 1)
    await c.request(get('/chat/room-types'))
    expect(calls).toHaveLength(2)
  })

  it('a configuration write through the client drops settled answers', async () => {
    const { client, calls } = fakeClient(() => ({ data: [] }))
    const c = withGetCoalescing(client)
    await c.request(get('/field-config/workflows'))
    await c.request(patch('/field-config/workflows/name', { hidden: true }))
    await c.request(get('/field-config/workflows'))
    expect(wire(calls).filter((w) => w.startsWith('GET'))).toHaveLength(2)
  })

  it('record bookkeeping writes (touch, locks, record PATCH) keep them', async () => {
    const { client, calls } = fakeClient(() => ({ data: [] }))
    const c = withGetCoalescing(client)
    await c.request(get('/field-config/workflows'))
    await c.request(post('/record-views/workflows/5/touch', {}))
    await c.request(post('/item-locks/workflows/5', {}))
    await c.request(patch('/items/workflows/5', { name: 'x' }))
    await c.request(post('/field-config/workflows/evaluate-visibility', { values: {} }))
    await c.request(get('/field-config/workflows'))
    expect(wire(calls).filter((w) => w.startsWith('GET'))).toHaveLength(1)
  })

  it('forgetSettledReads() (a host write outside the SDK) drops them in every client', async () => {
    const { client, calls } = fakeClient(() => ({ data: [] }))
    const c1 = withGetCoalescing(client)
    const c2 = withGetCoalescing({ ...client, request: client.request } as NivaroClient)
    await c1.request(get('/collections/x'))
    await c2.request(get('/collections/x'))
    forgetSettledReads()
    await c1.request(get('/collections/x'))
    await c2.request(get('/collections/x'))
    expect(calls).toHaveLength(4)
  })

  it('an answer in flight across a write is not kept', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let n = 0
    const { client, calls } = fakeClient(async (c) => {
      if (c._method === 'GET' && n++ === 0) await gate
      return { data: [] }
    })
    const c = withGetCoalescing(client)
    const read = c.request(get('/collection-layouts', { collection: 'w' }))
    await c.request(patch('/collection-layouts/3', { name: 'renamed' }))
    release()
    await read
    await c.request(get('/collection-layouts', { collection: 'w' }))
    expect(wire(calls).filter((w) => w.startsWith('GET'))).toHaveLength(2)
  })
})

describe('review fixes (2026-10-18)', () => {
  it('never settles a layout picked from a record (collection-layouts/active?item=)', () => {
    expect(isSettledRead(get('/collection-layouts/active', { collection: 'w' }))).toBe(true)
    expect(isSettledRead(get('/collection-layouts/active', { collection: 'w', item: 5 }))).toBe(
      false
    )
  })

  it('a batch the server refuses with 429/5xx rejects its callers instead of fanning out', async () => {
    const busy = Object.assign(new Error('busy'), { status: 429 })
    const { client, calls } = fakeClient((c) => (c._path === '/collections' ? busy : { data: 1 }))
    const c = withGetCoalescing(client)
    const r = await Promise.allSettled([
      c.request(get('/collections/a')),
      c.request(get('/collections/b'))
    ])
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected'])
    expect(calls).toHaveLength(1)
  })
})
