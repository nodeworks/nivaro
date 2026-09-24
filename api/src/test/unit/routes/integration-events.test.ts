import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Route harness: the admin gate is stubbed, and friendly-id resolution is
// mocked so the feed's label fill can be observed without a database.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  requireAuth: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyIds: vi.fn(async (_collection: string, ids: string[]) => {
    const out = new Map<string, string>()
    for (const id of ids) out.set(id, `REC-${id}`)
    return out
  })
}))

vi.mock('../../../services/chain-roots.js', () => ({
  chainIdsForRoots: vi.fn(async () => new Map()),
  recordReplayRoot: vi.fn(async () => undefined)
}))

import { relatedNoteRegistry } from '../../../extensions/related-notes.js'
import { integrationEventsRoutes } from '../../../routes/integration-events.js'
import { chainIdsForRoots, recordReplayRoot } from '../../../services/chain-roots.js'
import { resolveFriendlyIds } from '../../../services/workflow-transitions.js'

type Row = Parameters<NonNullable<Parameters<typeof relatedNoteRegistry.register>[0]['list']>>[0]

function entry(id: number, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    label: 'Source',
    text: `event ${id}`,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    collection: 'orders',
    item_id: String(100 + id),
    status: 'ok' as const,
    ...extra
  }
}

function register(id: string, rows: ReturnType<typeof entry>[]) {
  relatedNoteRegistry.register({
    id,
    collection: 'orders',
    label: id,
    load: async () => [],
    list: async (opts: Row) => rows.slice(0, opts.limit)
  })
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(integrationEventsRoutes, { prefix: '/integration-events' })
  return app
}

afterEach(() => {
  vi.clearAllMocks()
  relatedNoteRegistry.unregister('test:a')
  relatedNoteRegistry.unregister('test:b')
  relatedNoteRegistry.unregister('efp-ops:mdsi')
})

describe('GET /integration-events', () => {
  it('narrows to one source whether the caller says integration= or provider=', async () => {
    register('test:a', [entry(1, 1)])
    register('test:b', [entry(2, 2)])
    const app = buildApp()
    for (const key of ['integration', 'provider']) {
      const res = await app.inject({ method: 'GET', url: `/integration-events?${key}=test:b` })
      expect(res.statusCode).toBe(200)
      const entries = res.json().data.entries as Array<{ provider: string }>
      expect(entries.map((e) => e.provider)).toEqual(['test:b'])
    }
    await app.close()
  })

  it('fills a missing record label from friendly ids, batched per collection', async () => {
    register('test:a', [entry(1, 1), entry(2, 2, { item_label: 'Given label' }), entry(3, 3)])
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-events' })
    const entries = res.json().data.entries as Array<{ id: number; item_label?: string | null }>
    expect(entries.find((e) => e.id === 1)?.item_label).toBe('REC-101')
    expect(entries.find((e) => e.id === 2)?.item_label).toBe('Given label')
    expect(entries.find((e) => e.id === 3)?.item_label).toBe('REC-103')
    expect(vi.mocked(resolveFriendlyIds)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resolveFriendlyIds).mock.calls[0][1].sort()).toEqual(['101', '103'])
    await app.close()
  })

  it('leaves the label empty when friendly-id resolution fails', async () => {
    register('test:a', [entry(1, 1)])
    vi.mocked(resolveFriendlyIds).mockRejectedValueOnce(new Error('db down'))
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-events' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.entries[0].item_label ?? null).toBeNull()
    await app.close()
  })

  it('before= returns only entries strictly older than the cursor', async () => {
    const rows = [entry(1, 1), entry(2, 10), entry(3, 20), entry(4, 30)]
    register('test:a', rows)
    const app = buildApp()
    const cursor = rows[1].created_at
    const res = await app.inject({
      method: 'GET',
      url: `/integration-events?limit=2&before=${encodeURIComponent(cursor)}`
    })
    const ids = (res.json().data.entries as Array<{ id: number }>).map((e) => e.id)
    expect(ids).toEqual([3, 4])
    await app.close()
  })
})

describe('POST /integration-events/:provider/replay', () => {
  it('records the replay as a chain root pointing at the original chain', async () => {
    const replay = vi.fn(async () => ({ detail: 'replayed' }))
    relatedNoteRegistry.register({
      id: 'efp-ops:mdsi',
      collection: 'orders',
      label: 'MDSi',
      load: async () => [],
      replay
    })
    vi.mocked(chainIdsForRoots).mockResolvedValue(new Map([['145266', 'orig-chain']]))
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/integration-events/efp-ops:mdsi/replay',
      payload: { entry_id: '145266' }
    })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(chainIdsForRoots)).toHaveBeenCalledWith('efp-ops:mdsi', ['145266'])
    expect(recordReplayRoot).toHaveBeenCalledWith({
      source: 'efp-ops:mdsi',
      ref: 'replay:145266',
      replayOf: 'orig-chain'
    })
    expect(vi.mocked(recordReplayRoot).mock.invocationCallOrder[0]).toBeLessThan(
      replay.mock.invocationCallOrder[0]
    )
    await app.close()
  })

  it('records a replay with no known original chain as replayOf null', async () => {
    relatedNoteRegistry.register({
      id: 'efp-ops:mdsi',
      collection: 'orders',
      label: 'MDSi',
      load: async () => [],
      replay: async () => ({ detail: 'ok' })
    })
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/integration-events/efp-ops:mdsi/replay',
      payload: { entry_id: 7 }
    })
    expect(res.statusCode).toBe(200)
    expect(recordReplayRoot).toHaveBeenCalledWith({
      source: 'efp-ops:mdsi',
      ref: 'replay:7',
      replayOf: null
    })
    await app.close()
  })
})
