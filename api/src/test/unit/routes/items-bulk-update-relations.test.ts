import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /items/:collection/bulk-update on relation fields (2026-11-13): an M2O
// is set or cleared like any column; a to-many field is appended to, replaced
// or removed from per record through the items service (updateOne) as the
// person; records that already hold the links are skipped; ?dry_run=1 answers
// the preview and writes nothing; per-record refusals come back named.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean; authMethod?: string }) => {
    req.user = { id: 'USER-1', role: 'ROLE-1' }
    req.isAdmin = false
    req.authMethod = 'session'
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
vi.mock('../../../services/bulk-actions.js', async (orig) => ({
  ...(await orig<object>()),
  builtinAllowed: vi.fn(async () => true)
}))
const gate = vi.hoisted(() => ({ form: new Map<string, string>() }))
vi.mock('../../../services/form-field-gate.js', async (orig) => ({
  ...(await orig<object>()),
  bulkFormRefusals: vi.fn(async () => new Map(gate.form))
}))
vi.mock('../../../services/bulk-field-rules.js', async (orig) => ({
  ...(await orig<object>()),
  bulkRuleRefusals: vi.fn(async () => new Map())
}))
vi.mock('../../../services/item-lock-guard.js', async (orig) => ({
  ...(await orig<object>()),
  editLockRefusal: vi.fn(async (_req: unknown, _c: string, id: string) =>
    id === 'HELD' ? { body: { error: 'Ana Ruiz is editing this record' } } : null
  )
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getRelations: vi.fn(async () => [
    {
      many_collection: 'locations_org_codes_1',
      many_field: 'locations_id',
      one_collection: 'locations',
      one_field: 'additional_expenditure_orgs',
      junction_field: 'org_codes_id'
    },
    {
      many_collection: 'locations_org_codes_1',
      many_field: 'org_codes_id',
      one_collection: 'org_codes',
      one_field: null,
      junction_field: 'locations_id'
    },
    {
      many_collection: 'locations',
      many_field: 'default_expenditure_org',
      one_collection: 'org_codes',
      one_field: null,
      junction_field: null
    }
  ])
}))
const svc = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  links: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ id: string; payload: Record<string, unknown>; user: unknown }>,
  reads: [] as string[],
  dropField: null as string | null,
  linkFail: null as string | null
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  readItems: vi.fn(async (_u: unknown, collection: string) => {
    svc.reads.push(collection)
    return { data: collection === 'locations' ? svc.rows : svc.links }
  }),
  readOne: vi.fn(
    async (_u: unknown, _c: string, id: string) =>
      svc.rows.find((r) => String(r.id) === String(id)) ?? null
  ),
  updateOne: vi.fn(
    async (
      u: unknown,
      _c: string,
      id: string,
      payload: Record<string, unknown>,
      _req: unknown,
      _ws: unknown,
      opts?: { outcome?: { linkFailures?: string[] } }
    ) => {
      if (id === 'NOPE') throw Object.assign(new Error('Forbidden'), { name: 'ForbiddenError' })
      if (svc.dropField) delete payload[svc.dropField]
      if (svc.linkFail && opts?.outcome) opts.outcome.linkFailures = [svc.linkFail]
      svc.writes.push({ id, payload: { ...payload }, user: u })
      return { id }
    }
  )
}))

import { itemsRoutes } from '../../../routes/items.js'

let server: Awaited<ReturnType<typeof build>>
async function build() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}
// The items routes' import graph is heavy: load it once, outside any test's timeout.
beforeAll(async () => {
  server = await build()
  // The route loads its helpers lazily: warm them with one request before any test runs.
  await server.inject({
    method: 'POST',
    url: '/api/items/locations/bulk-update?dry_run=1',
    payload: { ids: [1], data: { additional_expenditure_orgs: { create: [1] } } }
  })
}, 120_000)
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  svc.rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
  svc.links = []
  svc.writes = []
  svc.reads = []
  svc.dropField = null
  svc.linkFail = null
  gate.form = new Map()
})

const post = async (payload: unknown, query = '') =>
  server.inject({
    method: 'POST',
    url: `/api/items/locations/bulk-update${query}`,
    payload: payload as never
  })

describe('M2O', () => {
  it('sets one related record on every selected row, as the person', async () => {
    const res = await post({ ids: [1, 2], data: { default_expenditure_org: 9 } })
    expect(res.json()).toMatchObject({ updated: 2, failed: 0 })
    expect(svc.writes.map((w) => w.payload)).toEqual([
      { default_expenditure_org: 9 },
      { default_expenditure_org: 9 }
    ])
    expect(svc.writes[0]?.user).toMatchObject({ id: 'USER-1' })
  })

  it('clears it', async () => {
    svc.rows = [
      { id: 1, default_expenditure_org: 4 },
      { id: 2, default_expenditure_org: null }
    ]
    const res = await post({ ids: [1, 2], data: { default_expenditure_org: null } })
    // Row 2 already holds nothing: skipped, no write.
    expect(res.json()).toMatchObject({ updated: 1, skipped: 1 })
    expect(svc.writes).toEqual([
      expect.objectContaining({ id: 1, payload: { default_expenditure_org: null } })
    ])
  })
})

describe('to-many', () => {
  it('append: writes the alias payload per record and skips records that already have the links', async () => {
    svc.links = [
      { locations_id: 1, org_codes_id: 7 },
      { locations_id: 1, org_codes_id: 8 },
      { locations_id: 2, org_codes_id: 7 }
    ]
    const res = await post({
      ids: [1, 2, 3],
      data: { additional_expenditure_orgs: { create: [7, 8] } }
    })
    expect(res.json()).toMatchObject({ updated: 2, skipped: 1, links_added: 3, links_removed: 0 })
    expect(svc.writes.map((w) => [w.id, w.payload])).toEqual([
      [2, { additional_expenditure_orgs: { create: [7, 8] } }],
      [3, { additional_expenditure_orgs: { create: [7, 8] } }]
    ])
    // One read of the records and one of the junction — never one per record.
    expect(svc.reads).toEqual(['locations', 'locations_org_codes_1'])
  })

  it('replace with nothing picked takes every link off', async () => {
    svc.links = [{ locations_id: 1, org_codes_id: 7 }]
    const res = await post({ ids: [1, 2], data: { additional_expenditure_orgs: { set: [] } } })
    expect(res.json()).toMatchObject({ updated: 1, skipped: 1, links_removed: 1 })
    expect(svc.writes[0]?.payload).toEqual({ additional_expenditure_orgs: { set: [] } })
  })

  it('remove only touches records that have the link', async () => {
    svc.links = [{ locations_id: 2, org_codes_id: 7 }]
    const res = await post({ ids: [1, 2], data: { additional_expenditure_orgs: { delete: [7] } } })
    expect(res.json()).toMatchObject({ updated: 1, skipped: 1, links_removed: 1 })
    expect(svc.writes.map((w) => w.id)).toEqual([2])
  })

  it('refuses a value that is not one of the three shapes', async () => {
    const res = await post({ ids: [1], data: { additional_expenditure_orgs: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BAD_M2M_VALUE')
  })
})

describe('refusals are reported, never silent', () => {
  it('names form locks, edit locks, permission refusals, dropped fields and failed links', async () => {
    svc.rows = [{ id: 'LOCK' }, { id: 'HELD' }, { id: 'NOPE' }, { id: 'OK' }]
    gate.form = new Map([['lock', 'Additional Expenditure Orgs is locked at Approved']])
    const res = await post({
      ids: ['LOCK', 'HELD', 'NOPE', 'OK'],
      data: { additional_expenditure_orgs: { create: [7] } }
    })
    const body = res.json()
    expect(body).toMatchObject({
      updated: 1,
      refused: 1,
      refused_reason: 'Additional Expenditure Orgs is locked at Approved',
      failed: 2
    })
    expect(body.failures).toEqual([
      { id: 'HELD', reason: 'Ana Ruiz is editing this record' },
      { id: 'NOPE', reason: 'Forbidden' }
    ])
  })

  it('a field the service dropped for this person is a failure, not an update', async () => {
    svc.dropField = 'additional_expenditure_orgs'
    const res = await post({ ids: [1], data: { additional_expenditure_orgs: { create: [7] } } })
    expect(res.json()).toMatchObject({ updated: 0, failed: 1 })
    expect(res.json().failures[0].reason).toMatch(/may not change additional_expenditure_orgs/)
  })

  it('a link that did not land is a failure', async () => {
    svc.linkFail = 'additional_expenditure_orgs: You do not have permission'
    const res = await post({ ids: [1], data: { additional_expenditure_orgs: { create: [7] } } })
    expect(res.json()).toMatchObject({ updated: 0, failed: 1 })
  })
})

describe('?dry_run=1 (the preview)', () => {
  it('answers the counts and writes nothing', async () => {
    svc.links = [{ locations_id: 1, org_codes_id: 7 }]
    const res = await post(
      { ids: [1, 2, 9], data: { additional_expenditure_orgs: { create: [7] } } },
      '?dry_run=1'
    )
    expect(res.json().data).toEqual({
      would_update: 1,
      skipped: 1,
      refused: 0,
      refused_reason: null,
      unreadable: 1,
      links_added: 1,
      links_removed: 0
    })
    expect(svc.writes).toEqual([])
  })

  it('refuses a repeated dry_run key instead of writing (the freeze lets dry_run URLs through)', async () => {
    const res = await post(
      { ids: [1], data: { default_expenditure_org: 1 } },
      '?dry_run=1&dry_run=0'
    )
    expect(res.statusCode).toBe(400)
    expect(svc.writes).toEqual([])
  })
})
