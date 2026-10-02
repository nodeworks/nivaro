// The screens tap keeps each page load's calls for the load waterfall (#1205).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null),
  getTrace: vi.fn(() => null)
}))
vi.mock('../settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'select', 'limit', 'orderBy', 'andWhere', 'first'])
    chain[m] = vi.fn(() => chain)
    // biome-ignore lint/suspicious/noThenProperty: knex query builders are thenables
  ;(chain as { then: unknown }).then = (res: (v: unknown) => unknown) => res([])
  return {
    db: Object.assign(
      vi.fn(() => chain),
      { client: { pool: {} } }
    )
  }
})

import { advanceTo, noteRequest, resetTrafficMap } from '../traffic-map.js'
import { loadCalls, loadOfRequest, recentLoads } from '../traffic-taps/screens.js'
import { loadList } from './nav.js'

const T0 = 1_800_000_000
const RID = (i: number) => `0f8fad5b-d9cb-469f-a165-${String(i).padStart(12, '0')}`

function call(load: string, i: number, page = '/collections/workflows/9', status = 200) {
  noteRequest({
    method: 'GET',
    path: `/api/items/workflows/${i}`,
    status,
    latencyMs: 40,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'aaaaaaaa-0000-0000-0000-000000000001',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000 + i * 10,
    req: {
      headers: { 'x-nivaro-app': 'admin', 'x-nivaro-page': page, 'x-nivaro-load': load },
      requestId: RID(i)
    }
  })
}

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
})

describe('screens tap → page load calls', () => {
  it('keeps each call with its request id, route, start and status', () => {
    call('load000001', 1)
    call('load000001', 2, '/collections/workflows/9', 500)
    const e = loadCalls('load000001')
    expect(e?.screen).toBe('admin /collections/workflows/:id')
    expect(e?.calls.map((c) => c.rid)).toEqual([RID(1), RID(2)])
    expect(e?.calls[0]).toMatchObject({
      route: 'GET /api/items/workflows/:id',
      ms: 40,
      status: 200
    })
    expect(e?.calls[0].start).toBe(T0 * 1000 + 10 - 40)
    expect(e?.calls[1].status).toBe(500)
    expect(loadOfRequest(RID(2))?.load).toBe('load000001')
  })

  it('keeps no calls for requests without a load id', () => {
    noteRequest({
      method: 'GET',
      path: '/api/items/workflows',
      status: 200,
      latencyMs: 5,
      authMethod: null,
      apiKeyId: null,
      userId: null,
      graphqlOperation: null,
      graphqlKind: null,
      cacheHit: false,
      at: T0 * 1000,
      req: { headers: { 'x-nivaro-page': '/x' }, requestId: RID(9) }
    })
    expect(loadOfRequest(RID(9))).toBeNull()
    expect(recentLoads()).toEqual([])
  })

  it('lists a page’s newest loads, matched by screen key or bare pattern', async () => {
    call('load000001', 1)
    call('load000002', 5)
    call('load000003', 3, '/users')
    const rows = await loadList('/collections/workflows/:id')
    expect(rows.map((r) => r.load)).toEqual(['load000002', 'load000001'])
    expect(rows[0]).toMatchObject({ calls: 1, caller: 'uAAAAAAAA-0000-0000-0000-000000000001' })
    expect((await loadList('admin /users')).map((r) => r.load)).toEqual(['load000003'])
  })
})
