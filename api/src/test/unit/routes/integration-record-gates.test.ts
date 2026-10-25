import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// army3 (audit-core-mz / audit-core-dl): per-record integration reads and the
// event replay checked only collection-level can(), so a caller who knew a
// sequential id read — or replayed — another record's partner traffic outside
// their User Scope. Each route now runs recordRefusal on the record itself
// (own unit tests in services/erp-record-gate.test.ts); this file proves each
// route asks it, refuses on its answer, and serves an allowed caller.

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'approver', role: 'r1' }
    req.isAdmin = false
  })
  return { authenticate: sign, requireAuth: sign, requireAdmin: sign }
})
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null)
}))
vi.mock('../../../services/erp-record-gate.js', () => ({
  recordRefusal: vi.fn(async () => null),
  recordReadable: vi.fn(async () => true)
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(async (_g: unknown, ids: string[]) => new Set(ids))
}))
vi.mock('../../../services/integration-preview.js', () => ({
  outboundPreview: vi.fn(async () => ({
    state: null,
    integrations: [{ changes: [{ path: 'po', top: 'po', label: 'PO', from: 'A1', to: 'B2' }] }]
  })),
  transitionPreflight: vi.fn(async () => ({ ready: true, issues: [], pushes: [] }))
}))
vi.mock('../../../services/record-notes.js', () => ({ registerNoteSource: vi.fn() }))
vi.mock('../../../services/chain-roots.js', () => ({
  chainIdsForRoots: vi.fn(async () => new Map()),
  recordReplayRoot: vi.fn(async () => undefined)
}))
vi.mock('../../../services/integration-remediation.js', () => ({
  remediationEnabled: vi.fn(async () => false)
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => null)
}))

import { db } from '../../../db/index.js'
import { relatedNoteRegistry } from '../../../extensions/related-notes.js'
import { integrationEventsRoutes } from '../../../routes/integration-events.js'
import { integrationObligationsRoutes } from '../../../routes/integration-obligations.js'
import { mailLogReadRoutes } from '../../../routes/mail-log.js'
import { recordIntegrationsRoutes } from '../../../routes/record-integrations.js'
import { recordMetaRoutes } from '../../../routes/record-meta.js'
import { recordViewRoutes } from '../../../routes/record-views.js'
import { recordRefusal } from '../../../services/erp-record-gate.js'
import { getAllowedFields } from '../../../services/permissions.js'
import { visibleIds } from '../../../services/record-access.js'

function table() {
  const q: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then')
          return (ok: (r: unknown[]) => unknown, fail?: (e: unknown) => unknown) =>
            Promise.resolve([]).then(ok, fail)
        if (prop === 'catch') return () => Promise.resolve([])
        if (prop === 'first') return async () => undefined
        return () => q
      }
    }
  )
  return q
}

function app() {
  const a = Fastify({ logger: false })
  a.register(recordMetaRoutes)
  a.register(mailLogReadRoutes, { prefix: '/mail-log' })
  a.register(integrationObligationsRoutes)
  a.register(recordIntegrationsRoutes)
  a.register(recordViewRoutes)
  a.register(integrationEventsRoutes, { prefix: '/integration-events' })
  return a
}

const refuse404 = { code: 404, body: { error: 'Not found' } }

afterEach(() => {
  vi.clearAllMocks()
  relatedNoteRegistry.unregister('test:shipments')
})

const READS: Array<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'GET', url: '/audience/workflows/77' },
  { method: 'GET', url: '/record-integrations/workflows/77' },
  { method: 'GET', url: '/owner-history/workflows/77' },
  { method: 'GET', url: '/mail-log/record/workflows/77' },
  { method: 'GET', url: '/integration-obligations/record/workflows/77' },
  { method: 'GET', url: '/integration-preview/workflows/77/outbound' },
  { method: 'GET', url: '/integration-preview/workflows/77/preflight?transition_id=t1' },
  { method: 'POST', url: '/record-views/workflows/77/touch' }
]

describe('per-record integration reads', () => {
  for (const r of READS) {
    it(`${r.method} ${r.url} answers 404 for a record outside the caller’s scope`, async () => {
      vi.mocked(db).mockImplementation((() => table()) as never)
      vi.mocked(recordRefusal).mockResolvedValueOnce(refuse404)
      const res = await app().inject({ method: r.method, url: r.url })
      expect(res.statusCode).toBe(404)
      expect(recordRefusal).toHaveBeenCalledWith(expect.anything(), 'workflows', '77', 'read')
    })
    it(`${r.method} ${r.url} serves an in-scope reader`, async () => {
      vi.mocked(db).mockImplementation((() => table()) as never)
      const res = await app().inject({ method: r.method, url: r.url })
      expect(res.statusCode).toBe(200)
    })
  }

  it('outbound preview withholds change values from a field-limited reader', async () => {
    vi.mocked(getAllowedFields).mockResolvedValueOnce(['id', 'title'])
    const res = await app().inject({
      method: 'GET',
      url: '/integration-preview/workflows/77/outbound'
    })
    expect(res.json().data.integrations[0].changes[0]).toMatchObject({
      label: 'PO',
      from: null,
      to: null
    })
  })

  it('outbound preview keeps the values for a reader of every field', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/integration-preview/workflows/77/outbound'
    })
    expect(res.json().data.integrations[0].changes[0]).toMatchObject({ from: 'A1', to: 'B2' })
  })

  it('obligation summary drops the page rows the caller cannot see', async () => {
    vi.mocked(db).mockImplementation((() => table()) as never)
    vi.mocked(visibleIds).mockResolvedValueOnce(new Set(['1']))
    const res = await app().inject({
      method: 'POST',
      url: '/integration-obligations/summary',
      payload: { collection: 'workflows', ids: ['1', '2'] }
    })
    expect(res.statusCode).toBe(200)
    expect(db).toHaveBeenCalled()
    // The whole page was judged by the caller's access gates before the ledger read.
    expect(vi.mocked(visibleIds).mock.calls[0]?.[1]).toEqual(['1', '2'])
  })

  it('obligation summary reads nothing when no row is visible', async () => {
    vi.mocked(db).mockImplementation((() => table()) as never)
    vi.mocked(visibleIds).mockResolvedValueOnce(new Set())
    const res = await app().inject({
      method: 'POST',
      url: '/integration-obligations/summary',
      payload: { collection: 'workflows', ids: ['1', '2'] }
    })
    expect(res.json()).toEqual({ data: {} })
    expect(db).not.toHaveBeenCalled()
  })
})

describe('POST /integration-events/:provider/replay (non-admin)', () => {
  const replay = vi.fn(async () => ({ detail: 'replayed' }))
  function provider(withGet = true) {
    relatedNoteRegistry.register({
      id: 'test:shipments',
      collection: 'inventory_request',
      load: async () => [],
      replay,
      ...(withGet
        ? {
            get: async (id: string) =>
              id === '404'
                ? null
                : {
                    id,
                    label: 'MDSi',
                    text: 'shipped',
                    created_at: new Date().toISOString(),
                    collection: 'inventory_request',
                    item_id: '5150'
                  }
          }
        : {})
    })
  }

  it('refuses the replay when the entry’s record is out of scope', async () => {
    provider()
    vi.mocked(recordRefusal).mockResolvedValueOnce(refuse404)
    const res = await app().inject({
      method: 'POST',
      url: '/integration-events/test:shipments/replay',
      payload: { entry_id: 9 }
    })
    expect(res.statusCode).toBe(404)
    expect(recordRefusal).toHaveBeenCalledWith(
      expect.anything(),
      'inventory_request',
      '5150',
      'update'
    )
    expect(replay).not.toHaveBeenCalled()
  })

  it('refuses a provider that cannot name the entry’s record', async () => {
    provider(false)
    const res = await app().inject({
      method: 'POST',
      url: '/integration-events/test:shipments/replay',
      payload: { entry_id: 9 }
    })
    expect(res.statusCode).toBe(403)
    expect(replay).not.toHaveBeenCalled()
  })

  it('replays for a caller who may change the record', async () => {
    provider()
    const res = await app().inject({
      method: 'POST',
      url: '/integration-events/test:shipments/replay',
      payload: { entry_id: 9 }
    })
    expect(res.statusCode).toBe(200)
    expect(replay).toHaveBeenCalledWith('9', { userId: 'approver' })
  })
})
