import type { NivaroClient } from '@nivaro/sdk'
import { isNivaroError } from '@nivaro/sdk'
import { describe, expect, it } from 'vitest'
import { BATCH_GET_LIMIT, BATCHABLE_GET, createGetBatcher, shareGetLoader } from './batch-gets'
import { batchableGet, movesWriteEpoch, withGetCoalescing } from './request-gate'

type Cmd = {
  _method: string
  _path: string
  _params?: Record<string, unknown>
  _body?: unknown
  _headers?: Record<string, string>
}

function fakeClient(answer: (c: Cmd) => unknown) {
  const calls: Cmd[] = []
  const client = {
    request: async (c: Cmd) => {
      calls.push(c)
      const r = answer(c)
      if (r instanceof Error) throw r
      return r
    }
  } as unknown as NivaroClient
  return { client, calls }
}

const get = (path: string, params?: Record<string, unknown>) =>
  ({ _method: 'GET', _path: path, ...(params ? { _params: params } : {}) }) as never

/** A server that answers each part with what its GET answers (path → body / status). */
function batchServer(single: (path: string) => { status: number; body?: unknown }) {
  return (c: Cmd) => {
    if (c._path !== '/batch-get') {
      const r = single(c._path)
      if (r.status >= 400) return Object.assign(new Error('refused'), { status: r.status })
      return r.body
    }
    const reads = (c._body as { reads: Array<{ key: string; path: string }> }).reads
    return {
      results: reads.map(({ key, path }) => {
        const r = single(path)
        return {
          key,
          status: r.status,
          ...(r.body !== undefined ? { body: r.body } : {}),
          request_id: `req-${key}`
        }
      })
    }
  }
}

const wire = (calls: Cmd[]) => calls.map((x) => `${x._method} ${x._path}`)

describe('batchableGet', () => {
  it('names the exact wire path (query string built as the SDK builds it)', () => {
    expect(batchableGet(get('/field-rules', { collection: 'workflows' }))).toBe(
      '/field-rules?collection=workflows'
    )
    expect(
      batchableGet(get('/collection-layouts/active', { collection: 'workflows', item: 7, x: null }))
    ).toBe('/collection-layouts/active?collection=workflows&item=7')
    expect(batchableGet(get('/settings'))).toBe('/settings')
    expect(batchableGet(get('/last-touch/workflows/372983'))).toBe('/last-touch/workflows/372983')
  })

  it('never batches identity reads, record reads, streams, writes or calls with own headers', () => {
    expect(batchableGet(get('/users/me'))).toBeNull()
    expect(batchableGet(get('/auth/me'))).toBeNull()
    expect(batchableGet(get('/auth/ws-token'))).toBeNull()
    expect(batchableGet(get('/items/workflows/1'))).toBeNull()
    expect(batchableGet(get('/collections/workflows'))).toBeNull()
    expect(batchableGet(get('/efp/workflow-actuals/1'))).toBeNull()
    expect(batchableGet(get('/realtime/worker.js'))).toBeNull()
    expect(batchableGet({ _method: 'POST', _path: '/settings' })).toBeNull()
    expect(
      batchableGet({ _method: 'GET', _path: '/settings', _headers: { 'x-transition': 'a' } })
    ).toBeNull()
  })

  it('lists the paths a cold workflow record page reads in waves', () => {
    for (const p of [
      '/collection-layouts',
      '/collection-layouts/active',
      '/collection-layouts/summary/workflows',
      '/collection-layouts/why',
      '/collection-layouts/10',
      '/data-model/relations/for/workflows',
      '/data-model/resolve-cascade',
      '/field-config/workflows',
      '/field-defaults/mine',
      '/bulk-actions/available',
      '/item-actions/registered',
      '/revisions/latest',
      '/revisions/field-touch',
      '/revisions/o2m-cell-provenance',
      '/comments/counts',
      '/pipelines/instances/workflows',
      '/record-views/workflows/1/viewers',
      '/sla/status/workflows/1',
      '/widgets-internal/3',
      '/items/workflows/1/resolve-paths',
      '/items/workflow_line_items/resolve-paths'
    ])
      expect(BATCHABLE_GET.test(p), p).toBe(true)
    for (const p of [
      '/collection-layouts/10/bundle',
      '/record-views/workflows/1/touch',
      '/users/1'
    ])
      expect(BATCHABLE_GET.test(p), p).toBe(false)
    // Slow on a cold record: they would hold every other part of their batch.
    for (const p of [
      '/pipelines/instance/workflows/1',
      '/pipelines/instance/workflows/1/owners/all',
      '/provenance/workflows/1',
      '/comments/related',
      '/chat/record-room',
      '/lineage/workflows/1/forecast_left',
      '/integration-preview/workflows/1/preflight'
    ])
      expect(BATCHABLE_GET.test(p), p).toBe(false)
  })
})

describe('withGetCoalescing small-GET batching (POST /batch-get)', () => {
  it('follows batchReads and is off without it', async () => {
    const { client, calls } = fakeClient(() => ({ data: 1 }))
    const c = withGetCoalescing(client)
    await Promise.all([c.request(get('/settings')), c.request(get('/roles'))])
    expect(wire(calls)).toEqual(['GET /settings', 'GET /roles'])
  })

  it('sends one wave as one request and answers each caller with its GET body', async () => {
    const { client, calls } = fakeClient(batchServer((p) => ({ status: 200, body: { data: p } })))
    const c = withGetCoalescing(client, { batchReads: true })
    const [a, b, d] = await Promise.all([
      c.request(get('/field-rules', { collection: 'workflows' })),
      c.request(get('/bulk-actions/available', { collection: 'workflows' })),
      c.request(get('/sla/status/workflows/9'))
    ])
    expect(wire(calls)).toEqual(['POST /batch-get'])
    expect((calls[0]._body as { reads: unknown[] }).reads).toEqual([
      { key: '0', path: '/field-rules?collection=workflows' },
      { key: '1', path: '/bulk-actions/available?collection=workflows' },
      { key: '2', path: '/sla/status/workflows/9' }
    ])
    expect(a).toEqual({ data: '/field-rules?collection=workflows' })
    expect(b).toEqual({ data: '/bulk-actions/available?collection=workflows' })
    expect(d).toEqual({ data: '/sla/status/workflows/9' })
  })

  it('rejects a refused part with the NivaroError its GET would throw, without re-sending', async () => {
    const { client, calls } = fakeClient(
      batchServer((p) =>
        p.startsWith('/access-explain')
          ? { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } }
          : { status: 200, body: { data: [] } }
      )
    )
    const c = withGetCoalescing(client, { batchReads: true })
    const [ok, missing] = await Promise.allSettled([
      c.request(get('/tasks', { collection: 'workflows', item: 1 })),
      c.request(get('/access-explain/workflows/999'))
    ])
    expect(ok.status).toBe('fulfilled')
    expect(missing.status).toBe('rejected')
    const err = (missing as PromiseRejectedResult).reason
    expect(isNivaroError(err)).toBe(true)
    expect(err).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Not found',
      requestId: 'req-1',
      method: 'GET',
      path: '/access-explain/workflows/999',
      response: { error: 'Not found', code: 'NOT_FOUND' }
    })
    expect(wire(calls)).toEqual(['POST /batch-get'])
  })

  it('re-sends on its own a part the server could not answer as JSON', async () => {
    const { client, calls } = fakeClient((c) =>
      c._path === '/batch-get'
        ? {
            results: [
              { key: '0', status: 200, body: { data: 'a' } },
              { key: '1', status: 400, error: 'This path cannot be batched' }
            ]
          }
        : { data: 'alone' }
    )
    const c = withGetCoalescing(client, { batchReads: true })
    const [a, b] = await Promise.all([c.request(get('/pinned')), c.request(get('/my-jobs'))])
    expect(a).toEqual({ data: 'a' })
    expect(b).toEqual({ data: 'alone' })
    expect(wire(calls)).toEqual(['POST /batch-get', 'GET /my-jobs'])
  })

  it('an older server without the route: every read goes alone, then the loader steps aside', async () => {
    const { client, calls } = fakeClient((c) =>
      c._path === '/batch-get'
        ? Object.assign(new Error('Not found'), { status: 404 })
        : { data: c._path }
    )
    const c = withGetCoalescing(client, { batchReads: true })
    await Promise.all([c.request(get('/pinned')), c.request(get('/my-jobs'))])
    await Promise.all([c.request(get('/tasks')), c.request(get('/custom-actions'))])
    expect(wire(calls)).toEqual([
      'POST /batch-get',
      'GET /pinned',
      'GET /my-jobs',
      'GET /tasks',
      'GET /custom-actions'
    ])
  })

  it('a batch refused as a whole with a 4xx (signed out, access pending) re-sends each GET', async () => {
    const { client, calls } = fakeClient((c) =>
      c._path === '/batch-get'
        ? Object.assign(new Error('Sign in first'), { status: 401 })
        : c._path === '/settings'
          ? { data: { public: true } }
          : Object.assign(new Error('Sign in first'), { status: 401 })
    )
    const c = withGetCoalescing(client, { batchReads: true })
    const [s, p] = await Promise.allSettled([
      c.request(get('/settings')),
      c.request(get('/pinned'))
    ])
    // A route that answers without signing in still does.
    expect(s).toMatchObject({ status: 'fulfilled', value: { data: { public: true } } })
    expect(p.status).toBe('rejected')
    expect(wire(calls)).toEqual(['POST /batch-get', 'GET /settings', 'GET /pinned'])
  })

  it('a busy server (503) fails the batch without re-sending every read', async () => {
    const busy = Object.assign(new Error('busy'), { status: 503 })
    const { client, calls } = fakeClient(() => busy)
    const c = withGetCoalescing(client, { batchReads: true })
    const r = await Promise.allSettled([c.request(get('/pinned')), c.request(get('/my-jobs'))])
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected'])
    expect(wire(calls)).toEqual(['POST /batch-get'])
  })

  it('splits a large wave into batches of BATCH_GET_LIMIT', async () => {
    const { client, calls } = fakeClient(batchServer(() => ({ status: 200, body: { data: 1 } })))
    const c = withGetCoalescing(client, { batchReads: true })
    await Promise.all(
      Array.from({ length: BATCH_GET_LIMIT + 3 }, (_, i) =>
        c.request(get(`/sla/status/workflows/${i}`))
      )
    )
    expect(wire(calls)).toEqual(['POST /batch-get', 'POST /batch-get'])
    expect((calls[1]._body as { reads: unknown[] }).reads).toHaveLength(3)
  })

  it('identical GETs in one wave still share one part', async () => {
    const { client, calls } = fakeClient(batchServer(() => ({ status: 200, body: { data: [] } })))
    const c = withGetCoalescing(client, { batchReads: true })
    await Promise.all([
      c.request(get('/tasks', { item: 1 })),
      c.request(get('/tasks', { item: 1 })),
      c.request(get('/pinned'))
    ])
    expect((calls[0]._body as { reads: unknown[] }).reads).toHaveLength(2)
  })

  it('queues on the loader a host shared, so both transports of one moment ride one batch', async () => {
    const posted: Array<Array<{ key: string; path: string }>> = []
    const host = createGetBatcher({
      post: async (reads) => {
        posted.push(reads)
        return { results: reads.map((r) => ({ key: r.key, status: 200, body: { data: r.path } })) }
      }
    })
    shareGetLoader(host)
    try {
      const { client, calls } = fakeClient(() => {
        throw new Error('the shared client must not post its own batch')
      })
      const c = withGetCoalescing(client, { batchReads: true })
      const [mine, hosts] = await Promise.all([
        c.request(get('/pinned')),
        host('/ai-settings/workflows', {
          alone: async () => 'alone',
          error: () => new Error('refused')
        })
      ])
      expect(mine).toEqual({ data: '/pinned' })
      expect(hosts).toEqual({ data: '/ai-settings/workflows' })
      expect(calls).toHaveLength(0)
      expect(posted).toEqual([
        [
          { key: '0', path: '/pinned' },
          { key: '1', path: '/ai-settings/workflows' }
        ]
      ])
    } finally {
      shareGetLoader(null)
    }
  })

  it('settings and roles settle: a second read within the window reuses the answer', async () => {
    const { client, calls } = fakeClient(() => ({ data: { x: 1 } }))
    const c = withGetCoalescing(client)
    await c.request(get('/settings'))
    await c.request(get('/roles'))
    await c.request(get('/settings'))
    await c.request(get('/roles'))
    expect(wire(calls)).toEqual(['GET /settings', 'GET /roles'])
  })
})

describe('in-flight joins across writes that change no read', () => {
  it('names reads-by-POST and telemetry as epoch-neutral, real writes and view touches not', () => {
    const post = (p: string) => ({ _method: 'POST', _path: p })
    expect(movesWriteEpoch(post('/session-recordings/start'))).toBe(false)
    expect(movesWriteEpoch(post('/session-recordings/abc/events'))).toBe(false)
    expect(movesWriteEpoch(post('/presence/ping'))).toBe(false)
    expect(movesWriteEpoch(post('/analytics/pageview'))).toBe(false)
    expect(movesWriteEpoch(post('/widgets-internal/3/render'))).toBe(false)
    expect(movesWriteEpoch(post('/items/workflows/1/child-summary'))).toBe(false)
    expect(movesWriteEpoch(post('/users/cards'))).toBe(false)
    expect(movesWriteEpoch(post('/batch-get'))).toBe(false)
    expect(movesWriteEpoch(post('/record-views/workflows/1/touch'))).toBe(true)
    expect(movesWriteEpoch({ _method: 'PATCH', _path: '/items/workflows/1' })).toBe(true)
    expect(movesWriteEpoch(post('/pipelines/instance/workflows/1/transition'))).toBe(true)
  })

  it('a pipeline read asked after the recorder started joins the one in flight', async () => {
    let release: (v: unknown) => void = () => {}
    const slow = new Promise((r) => {
      release = r
    })
    const { client, calls } = fakeClient((c) =>
      c._method === 'GET' ? slow : { data: { id: 'rec' } }
    )
    const c = withGetCoalescing(client)
    const first = c.request(get('/pipelines/instance/workflows/1'))
    await c.request({ _method: 'POST', _path: '/session-recordings/start', _body: {} } as never)
    const second = c.request(get('/pipelines/instance/workflows/1'))
    release({ data: { state: 'a' } })
    expect(await first).toEqual({ data: { state: 'a' } })
    expect(await second).toEqual({ data: { state: 'a' } })
    expect(wire(calls)).toEqual([
      'GET /pipelines/instance/workflows/1',
      'POST /session-recordings/start'
    ])
  })

  it('a real write still splits them', async () => {
    const { client, calls } = fakeClient((c) => (c._method === 'GET' ? { data: 1 } : { data: {} }))
    const c = withGetCoalescing(client)
    const first = c.request(get('/pipelines/instance/workflows/1'))
    const write = c.request({ _method: 'PATCH', _path: '/items/workflows/1', _body: {} } as never)
    const second = c.request(get('/pipelines/instance/workflows/1'))
    await Promise.all([first, write, second])
    expect(wire(calls).filter((x) => x.startsWith('GET'))).toHaveLength(2)
  })
})
