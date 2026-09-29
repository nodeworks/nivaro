import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// /api/dashboard/* answers for the signed-in person only. These suites pin the
// route contract: a bad `dir` is refused, `days` is clamped to 1–90, an empty
// history is an empty list (never a 500), and changed-since refuses bodies it
// cannot read.

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'USER-1', role: 'role-1' }
    req.isAdmin = false
  })
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/workflow-conditions.js', () => ({
  evaluateConditionRules: vi.fn(() => true),
  evalConditionRule: vi.fn(() => false),
  parseConditionRules: vi.fn((raw: string | null) => (raw ? JSON.parse(raw) : null)),
  fetchRecordForConditions: vi.fn(async () => ({}))
}))
vi.mock('../../../services/transition-requirements.js', () => ({
  evaluateTransitionRequirements: vi.fn(async () => null)
}))
vi.mock('../../../services/user-scopes.js', () => ({
  listScopeDimensions: vi.fn(async () => []),
  getUserScopes: vi.fn(async () => []),
  scopeHopsFor: vi.fn(async () => []),
  getUserScopeEnforcement: vi.fn(async () => ({ filters: [], deny: false })),
  applyScopeEnforcement: vi.fn(),
  resolveRecordDimensionIds: vi.fn(async () => new Map())
}))
vi.mock('../../../routes/sla.js', () => ({ computeStatusBatch: vi.fn(async () => ({})) }))
vi.mock('../../../services/app-links.js', () => ({
  recordLink: vi.fn(async (c: string, id: string) => `/records/${c}/${id}`)
}))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: vi.fn(async () => new Map())
}))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn(async () => ({})) }))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyIds: vi.fn(
    async (c: string, ids: string[]) => new Map(ids.map((i) => [i, `${c.toUpperCase()}-${i}`]))
  )
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async (_u: unknown, collection: string) => ({ collection })),
  visibleIds: vi.fn(async (_g: unknown, ids: string[]) => new Set(ids))
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { requireAuth } from '../../../middleware/authenticate.js'
import { dashboardFeedRoutes } from '../../../routes/dashboard-feed.js'
import { getRowFilter } from '../../../services/permissions.js'
import { visibleIds } from '../../../services/record-access.js'
import { evaluateTransitionRequirements } from '../../../services/transition-requirements.js'
import {
  getUserScopes,
  listScopeDimensions,
  resolveRecordDimensionIds
} from '../../../services/user-scopes.js'
import { evaluateConditionRules } from '../../../services/workflow-conditions.js'
import { resolveFriendlyIds } from '../../../services/workflow-transitions.js'

type Call = { table: string; method: string; args: unknown[] }
const calls: Call[] = []
/** The routes swallow a failed read into [], so an unexpected table would pass
 *  silently — every suite asserts none was touched. */
const unexpected: string[] = []

/** Tables whose reads reject in this test (a failed DB read). */
let failing: string[] = []

/** A knex-shaped chain for one allowed table: every builder method records
 *  itself and returns the chain; awaiting it yields `rows` (the first row
 *  after `.first()`), or rejects when the table is listed in `failing`. */
function chain(table: string, rows: unknown[]) {
  const target: Record<string, unknown> = {}
  let firstOnly = false
  const settle = () =>
    failing.includes(table)
      ? Promise.reject(new Error(`read failed: ${table}`))
      : Promise.resolve(firstOnly ? rows[0] : rows)
  const proxy: Record<string, unknown> = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          settle().then(resolve, reject)
      }
      if (prop === 'catch') {
        return (fn: (e: unknown) => unknown) => settle().catch(fn)
      }
      return (...args: unknown[]) => {
        if (prop === 'first') firstOnly = true
        calls.push({ table, method: prop, args })
        // Run where/join callbacks against the same chain so nested builder
        // calls are recorded too.
        for (const a of args) if (typeof a === 'function') a.call(proxy, proxy)
        return proxy
      }
    }
  })
  return proxy
}

const ALLOWED: Record<string, unknown[]> = {
  nivaro_workflow_bindings: [],
  'nivaro_workflow_history as h': [],
  nivaro_record_views: []
}
/** Per-test rows that override / extend ALLOWED. */
let fixtures: Record<string, unknown[]> = {}

function installDb() {
  const fn = vi.fn((table: string) => {
    if (table in fixtures) return chain(table, fixtures[table] as unknown[])
    if (!(table in ALLOWED)) {
      unexpected.push(table)
      throw new Error(`unexpected table: ${table}`)
    }
    return chain(table, ALLOWED[table] as unknown[])
  }) as unknown as typeof db & { raw: unknown }
  ;(fn as unknown as { raw: unknown }).raw = vi.fn((sql: string) => sql)
  vi.mocked(db).mockImplementation(fn as unknown as typeof db)
  ;(db as unknown as { raw: unknown }).raw = vi.fn((sql: string) => sql)
}

async function inject(method: 'GET' | 'POST', url: string, payload?: unknown) {
  installDb()
  const app = Fastify({ logger: false })
  app.register(dashboardFeedRoutes, { prefix: '/dashboard' })
  await app.ready()
  return app.inject({ method, url, payload: payload as Record<string, unknown> })
}

afterEach(() => {
  expect(unexpected).toEqual([])
  unexpected.length = 0
  calls.length = 0
  fixtures = {}
  failing = []
  vi.clearAllMocks()
})

describe('GET /dashboard/send-backs', () => {
  it('refuses an unknown dir', async () => {
    const res = await inject('GET', '/dashboard/send-backs?dir=nope')
    expect(res.statusCode).toBe(400)
  })

  it('answers an empty list when the viewer created nothing', async () => {
    const res = await inject('GET', '/dashboard/send-backs?dir=to_me')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
  })

  it('answers an empty list on an empty history (by_me)', async () => {
    const res = await inject('GET', '/dashboard/send-backs?dir=by_me')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
    const userFilter = calls.find((c) => c.method === 'where' && c.args[0] === 'h.user')
    expect(userFilter?.args[1]).toBe('USER-1')
  })

  it('clamps days to 90', async () => {
    const before = Date.now()
    const res = await inject('GET', '/dashboard/send-backs?dir=by_me&days=999')
    expect(res.statusCode).toBe(200)
    const since = calls.find((c) => c.method === 'where' && c.args[0] === 'h.timestamp')
    expect(since?.args[1]).toBe('>=')
    const days = (before - (since?.args[2] as Date).getTime()) / 86_400_000
    expect(Math.round(days)).toBe(90)
  })

  it('clamps days below 1 up to 1', async () => {
    const before = Date.now()
    await inject('GET', '/dashboard/send-backs?dir=by_me&days=0')
    const since = calls.find((c) => c.method === 'where' && c.args[0] === 'h.timestamp')
    const days = (before - (since?.args[2] as Date).getTime()) / 86_400_000
    expect(Math.round(days)).toBe(1)
  })
})

describe("GET /dashboard/send-backs?dir=to_me on the viewer's own records", () => {
  const sendBack = (id: number, user: string | null) => ({
    id,
    instance: 'INST-1',
    comment: null,
    timestamp: new Date(Date.now() - id * 60_000).toISOString(),
    user,
    to_state: 'S1',
    from_sort: 3,
    to_sort: 1,
    from_label: 'Review',
    to_label: 'Started',
    transition_label: 'Send Back',
    collection: 'orders',
    item: '42',
    current_state: 'S1',
    started_at: null,
    current_key: 'started',
    current_label: 'Started'
  })

  it('leaves out a send-back the viewer made themselves', async () => {
    fixtures = {
      nivaro_workflow_bindings: [{ collection: 'orders' }],
      nivaro_fields: [],
      'information_schema.columns': [{ table_name: 'orders', column_name: 'creator' }],
      orders: ['42'],
      nivaro_users: [{ id: 'OTHER', first_name: 'Kim', last_name: 'Diaz', email: null }],
      // The viewer's own move (id differs only by case) and someone else's.
      'nivaro_workflow_history as h': [
        sendBack(1, 'user-1'),
        sendBack(2, 'OTHER'),
        sendBack(3, null)
      ]
    }
    const res = await inject('GET', '/dashboard/send-backs?dir=to_me')
    expect(res.statusCode).toBe(200)
    const data = res.json().data as Array<{ by: { id: string } | null; label: string }>
    expect(data.map((r) => r.by?.id ?? null)).toEqual(['OTHER', null])
    expect(data[0]?.label).toBe('ORDERS-42')
    // The exclusion also reaches the SQL.
    expect(
      calls.some(
        (c) => c.method === 'orWhereNot' && c.args[0] === 'h.user' && c.args[1] === 'USER-1'
      )
    ).toBe(true)
    // Friendly ids are read once per collection, not per record.
    expect(vi.mocked(resolveFriendlyIds)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resolveFriendlyIds)).toHaveBeenCalledWith('orders', ['42'])
  })
})

describe('GET /dashboard/owner-absence', () => {
  it('answers an empty list when the viewer created nothing', async () => {
    const res = await inject('GET', '/dashboard/owner-absence')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
  })
})

describe('POST /dashboard/changed-since', () => {
  it('refuses a body without an items array', async () => {
    const res = await inject('POST', '/dashboard/changed-since', { items: 'x' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses more than 60 items', async () => {
    const items = Array.from({ length: 61 }, (_, i) => ({ collection: 'orders', item: String(i) }))
    const res = await inject('POST', '/dashboard/changed-since', { items })
    expect(res.statusCode).toBe(400)
  })

  it('a record the viewer never opened reads unchanged with no watermark', async () => {
    const res = await inject('POST', '/dashboard/changed-since', {
      items: [{ collection: 'orders', item: 7 }]
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: {
        'orders:7': {
          changed: false,
          since: null,
          editors: [],
          field_changes: 0,
          comments: 0,
          transitions: 0
        }
      }
    })
  })

  it('never reads a system collection', async () => {
    const res = await inject('POST', '/dashboard/changed-since', {
      items: [{ collection: 'nivaro_users', item: 'x' }]
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data['nivaro_users:x'].changed).toBe(false)
    expect(calls.some((c) => c.table === 'nivaro_record_views')).toBe(false)
  })
})

describe('GET /dashboard/submission-readiness', () => {
  it('refuses a request without a collection', async () => {
    const res = await inject('GET', '/dashboard/submission-readiness?ids=1')
    expect(res.statusCode).toBe(400)
  })

  it('refuses a system collection', async () => {
    const res = await inject('GET', '/dashboard/submission-readiness?collection=nivaro_users&ids=1')
    expect(res.statusCode).toBe(400)
  })

  it('refuses more than 50 ids', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1)).join(',')
    const res = await inject('GET', `/dashboard/submission-readiness?collection=orders&ids=${ids}`)
    expect(res.statusCode).toBe(400)
  })

  it('leaves out a record the viewer did not create (never a 403)', async () => {
    fixtures = {
      nivaro_fields: [],
      'information_schema.columns': [
        { table_name: 'orders', column_name: 'id' },
        { table_name: 'orders', column_name: 'creator' }
      ],
      // Only record 1 is the viewer's — the ownership read returns it alone.
      orders: ['1'],
      nivaro_collection_layouts: [],
      nivaro_relations: [],
      nivaro_workflow_instances: []
    }
    const res = await inject('GET', '/dashboard/submission-readiness?collection=orders&ids=1,2')
    expect(res.statusCode).toBe(200)
    const data = res.json().data as Record<string, { ready: boolean; blockers: unknown[] }>
    expect(Object.keys(data)).toEqual(['1'])
    expect(data['1']).toEqual({ ready: true, blockers: [] })
    const owned = calls.find(
      (c) => c.table === 'orders' && c.method === 'where' && c.args[0] === 'creator'
    )
    expect(owned?.args[1]).toBe('USER-1')
  })
})

describe('GET /dashboard/my-throughput', () => {
  it('answers zeros on an empty history', async () => {
    fixtures = { nivaro_users: [{ preferences: null }] }
    const res = await inject('GET', '/dashboard/my-throughput?weeks=4')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.this_week).toEqual({ transitions: 0, send_backs: 0, completions: 0 })
    expect(res.json().data.send_back_ratio).toBeNull()
  })
})

describe('GET /dashboard/zone-pulse', () => {
  it('refuses an unknown dimension', async () => {
    fixtures = { nivaro_scope_dimensions: [] }
    const res = await inject('GET', '/dashboard/zone-pulse?dimension=nope')
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /dashboard/submission-readiness — the next step', () => {
  const pipelineFixtures = (transition: Record<string, unknown>) => ({
    nivaro_fields: [],
    'information_schema.columns': [
      { table_name: 'orders', column_name: 'id' },
      { table_name: 'orders', column_name: 'creator' }
    ],
    orders: ['1'],
    nivaro_collection_layouts: [],
    nivaro_relations: [],
    nivaro_workflow_instances: [{ id: 'I1', item: '1', template: 'T1', current_state: 'S1' }],
    nivaro_workflow_states: [
      { id: 'S1', key: 'draft', sort: 1 },
      { id: 'S2', key: 'review', sort: 2 }
    ],
    nivaro_workflow_transitions: [
      {
        id: 'X1',
        template: 'T1',
        from_state: 'S1',
        to_state: 'S2',
        label: 'Submit',
        sort: 1,
        auto_trigger: 0,
        condition_rules: null,
        required_roles: null,
        requirements: '[{"type":"child_fields"}]',
        ...transition
      }
    ]
  })

  it('a forward step only another role may press still lists its requirement gaps', async () => {
    fixtures = pipelineFixtures({ required_roles: '["APPROVER-ROLE"]' })
    vi.mocked(evaluateTransitionRequirements).mockResolvedValueOnce([
      {
        type: 'child_fields',
        collection: 'lines',
        fk_field: 'order',
        title: 'Enter REQ IDs',
        fields: [{ field: 'req', label: 'REQ ID', type: 'string' }],
        display_fields: [],
        rows: [
          { id: 1, label: 'Line 1', complete: false, values: {}, display: {} },
          { id: 2, label: 'Line 2', complete: true, values: {}, display: {} }
        ]
      }
    ])
    const res = await inject('GET', '/dashboard/submission-readiness?collection=orders&ids=1')
    expect(res.statusCode).toBe(200)
    expect(res.json().data['1']).toEqual({
      ready: false,
      blockers: [
        {
          kind: 'requirement',
          label: 'Enter REQ IDs',
          message: 'Before “Submit”: 1 of 2 lines need REQ ID'
        }
      ]
    })
    expect(vi.mocked(evaluateTransitionRequirements).mock.calls[0]?.[1]).toBe(
      '[{"type":"child_fields"}]'
    )
  })

  it('every forward step closed by its conditions reads as one blocker naming the condition', async () => {
    fixtures = pipelineFixtures({
      condition_rules: '[{"field":"vendor","op":"nnull","value":null}]'
    })
    vi.mocked(evaluateConditionRules).mockReturnValueOnce(false)
    const res = await inject('GET', '/dashboard/submission-readiness?collection=orders&ids=1')
    expect(res.statusCode).toBe(200)
    expect(res.json().data['1']).toEqual({
      ready: false,
      blockers: [
        {
          kind: 'requirement',
          label: 'No forward step available',
          message: '“Submit”: Vendor must be set'
        }
      ]
    })
    expect(vi.mocked(evaluateTransitionRequirements)).not.toHaveBeenCalled()
  })
})

describe('GET /dashboard/zone-pulse — row-filtered collections', () => {
  it('leaves out a collection whose read policy carries a row filter', async () => {
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([
      {
        id: 1,
        name: 'division',
        label: 'Zone',
        target_collection: 'divisions',
        display_field: 'short_name',
        options_sort: null,
        overrides: null,
        exclusions: null,
        strict: false,
        is_active: true
      }
    ])
    vi.mocked(getRowFilter).mockImplementation(async (_u, _a, c) =>
      c === 'orders' ? [{ field: 'owner', op: '_eq', value: '$CURRENT_USER' }] : null
    )
    vi.mocked(resolveRecordDimensionIds).mockResolvedValue(new Map([['5', ['1']]]))
    fixtures = {
      divisions: [{ id: 1, short_name: 'Z1' }],
      nivaro_workflow_bindings: [{ collection: 'orders' }, { collection: 'tasks' }],
      'nivaro_workflow_instances as i': [
        { id: 'I1', item: '5', current_state: 'S', template: 'T', started_at: '2026-09-01' }
      ],
      'information_schema.columns': []
    }
    const res = await inject('GET', '/dashboard/zone-pulse?dimension=division')
    expect(res.statusCode).toBe(200)
    const zones = res.json().data.zones as Array<{ id: string; open: Record<string, number> }>
    expect(zones).toHaveLength(1)
    expect(zones[0]?.open).toEqual({ tasks: 1 })
    expect(Object.keys(zones[0]?.open ?? {})).not.toContain('orders')
  })
})

const UNAVAILABLE = { error: 'Could not load this right now', code: 'DASHBOARD_FEED_UNAVAILABLE' }

describe('GET /dashboard/headline-history — User Scopes', () => {
  const AREA_DIM = {
    id: 1,
    name: 'area',
    label: 'Area',
    target_collection: 'areas',
    display_field: 'label',
    options_sort: null,
    overrides: null,
    exclusions: null,
    strict: false,
    is_active: true
  }
  const settings = {
    dashboard_headline: JSON.stringify({
      query: 'budget',
      year_param: 'years',
      zone_param: 'zones',
      zone_collection: 'areas',
      zone_field: 'label',
      fields: { pubd: 'p', spend: 's', committed: 'c', remaining: 'r' }
    })
  }
  const point = {
    snapshot_date: '2026-09-27',
    pubd: 10,
    spend: 4,
    committed: 1,
    remaining: 5,
    projects: 2
  }
  const restrictToZone1 = () => {
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([AREA_DIM] as never)
    vi.mocked(getUserScopes).mockResolvedValueOnce([
      { dimension: 'area', mode: 'restrict', values: ['1'] }
    ] as never)
    fixtures = {
      nivaro_settings: [settings],
      areas: ['Zone 1'],
      nivaro_dashboard_snapshots: [point]
    }
  }
  const snapshotsRead = () => calls.some((c) => c.table === 'nivaro_dashboard_snapshots')

  it('an admin reads any zone', async () => {
    vi.mocked(requireAuth).mockImplementationOnce((async (req: {
      user?: unknown
      isAdmin?: boolean
    }) => {
      req.user = { id: 'ADMIN', role: 'admin' }
      req.isAdmin = true
    }) as never)
    fixtures = { nivaro_dashboard_snapshots: [point] }
    const res = await inject('GET', '/dashboard/headline-history?year=2026&zone=Zone%202')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })

  it('a restricted person reads their own zone', async () => {
    restrictToZone1()
    const res = await inject('GET', '/dashboard/headline-history?year=2026&zone=Zone%201')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })

  it('a zone outside the allowance answers an empty history, unread', async () => {
    restrictToZone1()
    const res = await inject('GET', '/dashboard/headline-history?year=2026&zone=Zone%202')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
    expect(snapshotsRead()).toBe(false)
  })

  it('the all-zones row is empty for a restricted person', async () => {
    restrictToZone1()
    const res = await inject('GET', '/dashboard/headline-history?year=2026')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
    expect(snapshotsRead()).toBe(false)
  })

  it('a failed read answers 503, never an empty history', async () => {
    restrictToZone1()
    failing = ['nivaro_settings']
    const res = await inject('GET', '/dashboard/headline-history?year=2026&zone=Zone%201')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual(UNAVAILABLE)
  })
})
