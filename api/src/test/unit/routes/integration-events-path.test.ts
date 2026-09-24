import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/event-path/index.js', () => ({
  buildEventPath: vi.fn(async (_s: string, id: string) =>
    id === 'missing' ? null : { root: { key: 'request:c' }, mode: 'exact', warnings: [] }
  ),
  buildChainPath: vi.fn(async (chainId: string) =>
    chainId.startsWith('00000000')
      ? null
      : { root: { key: `request:${chainId}` }, mode: 'exact', warnings: [] }
  ),
  chainsTouchingRecord: vi.fn(async () => ['c1'])
}))
vi.mock('../../../services/event-path/record-ref.js', () => ({
  chainsTouchingRecord: vi.fn(async () => ['c1']),
  findRecordRef: vi.fn(async () => null)
}))
vi.mock('../../../services/integration-event-sources.js', () => ({
  describeEventSources: vi.fn(() => []),
  fillEventLabels: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
  getEvent: vi.fn(async (_s: string, id: string) =>
    id === 'missing'
      ? null
      : {
          id,
          source: 'core:outbound',
          direction: 'out',
          label: 'LinX',
          text: 'pushed',
          created_at: '2026-09-24T00:00:00.000Z',
          collection: 'workflows',
          item_id: '371367',
          chain_id: 'c9'
        }
  )
}))
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(async (_u: unknown, _c: string, q: { filter: { id: { _in: string[] } } }) => ({
    data: q.filter.id._in.map((id) => ({ id }))
  }))
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/chain-roots.js', () => ({
  chainIdsForRoots: vi.fn(async () => new Map()),
  recordReplayRoot: vi.fn(async () => undefined)
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { isAdmin?: boolean; user?: unknown }) => {
    req.isAdmin = true
    req.user = { id: 'u' }
  },
  requireAuth: async (req: { isAdmin?: boolean; user?: unknown }) => {
    req.isAdmin = false
    req.user = { id: 'u' }
  }
}))

import { integrationEventsRoutes } from '../../../routes/integration-events.js'
import { buildChainPath, buildEventPath } from '../../../services/event-path/index.js'
import { getEvent, listEvents } from '../../../services/integration-event-sources.js'
import { readItems } from '../../../services/items.js'
import { can } from '../../../services/permissions.js'

async function app() {
  const a = Fastify()
  await a.register(integrationEventsRoutes, { prefix: '/integration-events' })
  return a
}

type Ev = NonNullable<Awaited<ReturnType<typeof getEvent>>>

function event(extra: Partial<Ev>): Ev {
  return {
    id: '82',
    source: 'core:outbound',
    direction: 'out',
    label: 'LinX',
    text: 'pushed',
    created_at: '2026-09-24T00:00:00.000Z',
    collection: 'workflows',
    item_id: '371367',
    chain_id: 'c9',
    ...extra
  } as Ev
}

const readAll = (async (_u: unknown, _c: string, q: { filter: { id: { _in: string[] } } }) => ({
  data: q.filter.id._in.map((id) => ({ id }))
})) as unknown as typeof readItems

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readItems).mockImplementation(readAll)
})

describe('path routes', () => {
  const CHAIN = '8b6213be-eae8-4cb2-b027-2f0ab216282b'

  it('chain path returns the built path for a chain id', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: `/integration-events/chain/${CHAIN}/path`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.root.key).toBe(`request:${CHAIN}`)
    expect(vi.mocked(buildChainPath).mock.calls[0]).toEqual([CHAIN, { isAdmin: true }])
    expect(buildEventPath).not.toHaveBeenCalled()
  })

  it('chain path 400s an id that is not a uuid', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/chain/not-a-chain/path'
    })
    expect(res.statusCode).toBe(400)
    expect(buildChainPath).not.toHaveBeenCalled()
  })

  it('chain path 404s a chain with no rows', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/chain/00000000-0000-4000-8000-000000000000/path'
    })
    expect(res.statusCode).toBe(404)
  })

  it('chain path answers 503, never a 500, when assembly throws', async () => {
    vi.mocked(buildChainPath).mockRejectedValueOnce(new Error('boom'))
    const res = await (await app()).inject({
      method: 'GET',
      url: `/integration-events/chain/${CHAIN}/path`
    })
    expect(res.statusCode).toBe(503)
  })

  it('admin path returns the built path', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/core:outbound/82/path'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.mode).toBe('exact')
    expect(vi.mocked(buildEventPath).mock.calls[0][2]).toMatchObject({ isAdmin: true })
  })

  it('404s an unknown event', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/core:outbound/missing/path'
    })
    expect(res.statusCode).toBe(404)
  })

  it('answers a clean error, never a 500, when path assembly throws', async () => {
    vi.mocked(buildEventPath).mockRejectedValueOnce(new Error('boom'))
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/core:outbound/82/path'
    })
    expect(res.statusCode).not.toBe(500)
    expect(res.json().error).toBeTruthy()
  })

  it('record-side path never carries bodies and filters by permission', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367/path?source=core:outbound&id=82'
    })
    expect(res.statusCode).toBe(200)
    const viewer = vi.mocked(buildEventPath).mock.calls.at(-1)?.[2]
    expect(viewer?.isAdmin).toBe(false)
    expect(typeof viewer?.canReadRecords).toBe('function')
  })

  it('record-side path 404s an event that does not concern the record', async () => {
    vi.mocked(getEvent).mockResolvedValueOnce(
      event({ collection: 'workflows', item_id: '999', chain_id: 'c9' })
    )
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367/path?source=core:outbound&id=82'
    })
    expect(res.statusCode).toBe(404)
    expect(buildEventPath).not.toHaveBeenCalled()
  })

  it('record-side path serves an event on another record linked by a shared chain', async () => {
    vi.mocked(getEvent).mockResolvedValueOnce(
      event({ collection: 'purchase_orders', item_id: '5', chain_id: 'c1' })
    )
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367/path?source=core:outbound&id=82'
    })
    expect(res.statusCode).toBe(200)
  })

  it('record-side path 404s when the root step sits on a record the viewer cannot read', async () => {
    vi.mocked(buildEventPath).mockResolvedValueOnce({
      root: {
        key: 'request:c',
        parent: null,
        kind: 'request',
        at: '2026-09-24T00:00:00.000Z',
        summary: 'x',
        record: { collection: 'purchase_orders', item: '5' },
        children: [],
        offset_ms: 0
      },
      mode: 'exact',
      truncated: false,
      step_count: 1,
      first_failure: null,
      replay_of: null,
      replayed_as: [],
      warnings: []
    })
    vi.mocked(getEvent).mockResolvedValueOnce(
      event({ collection: 'purchase_orders', item_id: '5', chain_id: 'c1' })
    )
    vi.mocked(readItems).mockImplementation((async (
      _u: unknown,
      collection: string,
      q: { filter: { id: { _in: string[] } } }
    ) => ({
      data: collection === 'purchase_orders' ? [] : q.filter.id._in.map((id) => ({ id }))
    })) as unknown as typeof readItems)
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367/path?source=core:outbound&id=82'
    })
    expect(res.statusCode).toBe(404)
  })

  it('record-side path 403s without read permission on the collection', async () => {
    vi.mocked(can).mockResolvedValueOnce(false)
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367/path?source=core:outbound&id=82'
    })
    expect(res.statusCode).toBe(403)
  })

  it('record-side path requires source and id', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367/path'
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('record activity route', () => {
  it('lists chain-linked events for the record and pages them', async () => {
    vi.mocked(listEvents).mockResolvedValueOnce(
      Array.from({ length: 26 }, (_, i) => event({ id: String(i) }))
    )
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367'
    })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.entries).toHaveLength(25)
    expect(body.has_more).toBe(true)
    expect(body.page).toBe(1)
    expect(vi.mocked(listEvents).mock.calls[0][0]).toMatchObject({
      record: { collection: 'workflows', item: '371367' },
      chainIds: ['c1'],
      // People's own token calls are not a record's integration activity.
      includePeople: false
    })
  })

  it('drops entries about records the viewer cannot open', async () => {
    vi.mocked(readItems).mockImplementation((async (
      _u: unknown,
      collection: string,
      q: { filter: { id: { _in: string[] } } }
    ) => ({
      data: collection === 'purchase_orders' ? [] : q.filter.id._in.map((id) => ({ id }))
    })) as unknown as typeof readItems)
    vi.mocked(listEvents).mockResolvedValueOnce([
      event({ id: '1' }),
      event({ id: '2', collection: 'purchase_orders', item_id: '5', chain_id: 'c1' })
    ])
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.entries.map((e: { id: string }) => e.id)).toEqual(['1'])
  })

  it('404s a record the viewer cannot read', async () => {
    vi.mocked(readItems).mockImplementation((async () => ({
      data: []
    })) as unknown as typeof readItems)
    const res = await (await app()).inject({
      method: 'GET',
      url: '/integration-events/record/workflows/371367'
    })
    expect(res.statusCode).toBe(404)
    expect(listEvents).not.toHaveBeenCalled()
  })
})
