import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock auth middleware so routes don't need real sessions in these tests.
// requireAdmin backs the transition create/PATCH routes; requireAuth backs
// the instance transition-execute route.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  requireAuth: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: vi.fn(async () => {})
}))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { pipelinesRoutes } from '../../../routes/pipelines.js'
import { getCollection } from '../../../services/collections.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app
}

afterEach(() => vi.clearAllMocks())

// ─── Transition create / PATCH validation ──────────────────────────────────

describe('POST /pipelines/:id/transitions — requirements validation', () => {
  function makeDbMock() {
    return vi.fn((table: string) => {
      if (table === 'nivaro_workflow_templates') {
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve({ id: 'tpl-1' })) })) }
      }
      if (table === 'nivaro_workflow_transitions') {
        return {
          insert: vi.fn(() => Promise.resolve([1])),
          where: vi.fn(() => ({
            first: vi.fn(() =>
              Promise.resolve({ id: 'tx-1', requirements: JSON.stringify([{ type: 'future' }]) })
            )
          }))
        }
      }
      throw new Error(`unexpected table: ${table}`)
    })
  }

  it('400s when requirements is not an array', async () => {
    vi.mocked(db).mockImplementation(makeDbMock() as unknown as typeof db)
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/tpl-1/transitions',
      payload: { to_state: 'st-2', label: 'Advance', requirements: 'nope' }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/array/)
  })

  it('400s on a bad identifier in a child_fields entry', async () => {
    vi.mocked(db).mockImplementation(makeDbMock() as unknown as typeof db)
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/tpl-1/transitions',
      payload: {
        to_state: 'st-2',
        label: 'Advance',
        requirements: [{ type: 'child_fields', collection: '1bad', fk_field: 'wf', fields: ['x'] }]
      }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/collection/)
  })

  it('accepts and stores an unknown requirement type untouched', async () => {
    vi.mocked(db).mockImplementation(makeDbMock() as unknown as typeof db)
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/tpl-1/transitions',
      payload: { to_state: 'st-2', label: 'Advance', requirements: [{ type: 'future' }] }
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { data: { requirements: unknown } }
    expect(body.data.requirements).toEqual([{ type: 'future' }])
  })
})

describe('PATCH /pipelines/transitions/:txId — requirements validation', () => {
  function makeDbMock(existing: Record<string, unknown>) {
    let stored = existing
    return vi.fn((table: string) => {
      if (table !== 'nivaro_workflow_transitions') throw new Error(`unexpected table: ${table}`)
      return {
        where: vi.fn(() => ({
          first: vi.fn(() => Promise.resolve(stored)),
          update: vi.fn((patch: Record<string, unknown>) => {
            stored = { ...stored, ...patch }
            return Promise.resolve(1)
          })
        }))
      }
    })
  }

  it('400s when requirements is not an array', async () => {
    vi.mocked(db).mockImplementation(
      makeDbMock({ id: 'tx-1', requirements: null }) as unknown as typeof db
    )
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/pipelines/transitions/tx-1',
      payload: { requirements: { not: 'an array' } }
    })

    expect(res.statusCode).toBe(400)
  })

  it('accepts and stores an unknown requirement type untouched', async () => {
    vi.mocked(db).mockImplementation(
      makeDbMock({ id: 'tx-1', requirements: null }) as unknown as typeof db
    )
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/pipelines/transitions/tx-1',
      payload: { requirements: [{ type: 'future', foo: 'bar' }] }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { requirements: unknown } }
    expect(body.data.requirements).toEqual([{ type: 'future', foo: 'bar' }])
  })
})

// ─── Transition-execute enforcement ────────────────────────────────────────

interface DbFixture {
  instance: Record<string, unknown>
  transition: Record<string, unknown>
  targetState?: Record<string, unknown>
  fieldRows?: Array<{ field: string; label: string | null }>
  childRows?: Array<Record<string, unknown>>
}

function makeExecuteDbMock(fx: DbFixture) {
  return vi.fn((table: string) => {
    switch (table) {
      case 'nivaro_workflow_instances':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(fx.instance)),
            update: vi.fn(() => Promise.resolve(1))
          }))
        }
      case 'nivaro_workflow_transitions':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(fx.transition)) })) }
      case 'nivaro_workflow_states':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(fx.targetState)) })) }
      case 'nivaro_workflow_history':
        return { insert: vi.fn(() => Promise.resolve([1])) }
      case 'nivaro_workflow_bindings':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) })) }
      case 'nivaro_fields':
        return {
          where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve(fx.fieldRows ?? [])) }))
        }
      default:
        // Child collection query: where(...).limit(2000).select([...])
        return {
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ select: vi.fn(() => Promise.resolve(fx.childRows ?? [])) }))
          }))
        }
    }
  })
}

const baseInstance = {
  id: 'inst-1',
  template: 'tpl-1',
  collection: 'workflows',
  item: 'wf-1',
  current_state: null,
  completed_at: null
}

const terminalTargetState = {
  id: 'st-done',
  template: 'tpl-1',
  key: 'done',
  label: 'Done',
  is_initial: false,
  is_terminal: true
}

function baseTransition(requirements: unknown) {
  return {
    id: 'tx-1',
    template: 'tpl-1',
    from_state: null,
    to_state: 'st-done',
    label: 'Advance',
    required_roles: null,
    condition_rules: null,
    requirements: requirements === undefined ? null : JSON.stringify(requirements)
  }
}

describe('POST /pipelines/instance/:collection/:item/transition — requirements enforcement', () => {
  it('blocks with the exact 422 payload shape when a row has an empty required field', async () => {
    vi.mocked(getCollection).mockResolvedValueOnce({
      display_template: '{{req_id}}'
    } as unknown as Awaited<ReturnType<typeof getCollection>>)
    vi.mocked(db).mockImplementation(
      makeExecuteDbMock({
        instance: baseInstance,
        transition: baseTransition([
          {
            type: 'child_fields',
            collection: 'workflow_line_items',
            fk_field: 'workflow',
            fields: ['req_id'],
            labels: { req_id: 'REQ ID' },
            title: 'Enter REQ IDs'
          }
        ]),
        targetState: terminalTargetState,
        fieldRows: [],
        childRows: [
          { id: 1, req_id: null },
          { id: 2, req_id: '   ' },
          { id: 3, req_id: 'REQ-3' }
        ]
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as {
      error: string
      requirements: Array<{
        type: string
        collection: string
        fk_field: string
        title: string
        fields: Array<{ field: string; label: string }>
        rows: Array<{
          id: number
          label: string
          complete: boolean
          values: Record<string, unknown>
        }>
      }>
    }
    expect(body.error).toBe('TRANSITION_REQUIREMENTS')
    expect(body.requirements).toEqual([
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: 'workflow',
        title: 'Enter REQ IDs',
        fields: [{ field: 'req_id', label: 'REQ ID' }],
        rows: [
          { id: 1, label: '#1', complete: false, values: { req_id: null } },
          { id: 2, label: '#2', complete: false, values: { req_id: '   ' } },
          { id: 3, label: 'REQ-3', complete: true, values: { req_id: 'REQ-3' } }
        ]
      }
    ])
  })

  it('passes when every required field is filled on every row', async () => {
    vi.mocked(getCollection).mockResolvedValueOnce(undefined)
    vi.mocked(db).mockImplementation(
      makeExecuteDbMock({
        instance: baseInstance,
        transition: baseTransition([
          {
            type: 'child_fields',
            collection: 'workflow_line_items',
            fk_field: 'workflow',
            fields: ['req_id']
          }
        ]),
        targetState: terminalTargetState,
        fieldRows: [],
        childRows: [
          { id: 1, req_id: 'REQ-1' },
          { id: 2, req_id: 'REQ-2' }
        ]
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
  })

  it('passes with zero child rows', async () => {
    vi.mocked(getCollection).mockResolvedValueOnce(undefined)
    vi.mocked(db).mockImplementation(
      makeExecuteDbMock({
        instance: baseInstance,
        transition: baseTransition([
          {
            type: 'child_fields',
            collection: 'workflow_line_items',
            fk_field: 'workflow',
            fields: ['req_id']
          }
        ]),
        targetState: terminalTargetState,
        fieldRows: [],
        childRows: []
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
  })

  it('passes when the stored requirements JSON is malformed', async () => {
    vi.mocked(db).mockImplementation(
      makeExecuteDbMock({
        instance: baseInstance,
        transition: {
          ...baseTransition(undefined),
          requirements: '{not valid json'
        },
        targetState: terminalTargetState
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
  })

  it('ignores an unrecognized requirement type', async () => {
    vi.mocked(db).mockImplementation(
      makeExecuteDbMock({
        instance: baseInstance,
        transition: baseTransition([{ type: 'record_fields', fields: ['x'] }]),
        targetState: terminalTargetState
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
  })

  it('proceeds untouched when requirements is null', async () => {
    vi.mocked(db).mockImplementation(
      makeExecuteDbMock({
        instance: baseInstance,
        transition: baseTransition(undefined),
        targetState: terminalTargetState
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
  })
})
