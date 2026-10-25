import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock auth/workspace middleware so routes don't need real auth in these tests.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  })
}))

vi.mock('../../../middleware/workspace.js', () => ({
  resolveWorkspace: vi.fn(async (req: { workspaceId?: string }) => {
    req.workspaceId = 'ws-1'
  })
}))

vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
// The bulk-actions registry gate (builtinAllowed) reads nivaro_bulk_actions;
// these suites exercise the endpoints' own rules, so the gate is open here.
vi.mock('../../../services/bulk-actions.js', () => ({
  builtinAllowed: vi.fn(async () => true)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
// The record's instance through the same table mock (branch exclusion has its
// own unit test in services/branch-instances.test.ts).
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: async (collection: string, item: string) => {
    const { db } = await import('../../../db/index.js')
    return (db as unknown as (t: string) => { where: (w: unknown) => { first: () => unknown } })(
      'nivaro_workflow_instances'
    )
      .where({ collection, item })
      .first()
  }
}))
// The start/advance gate (instance-guard) is unit-tested on its own; here it
// allows unless a test sets `guard.deny`.
const guard = vi.hoisted(() => ({ deny: null as null | 403 | 404 }))
vi.mock('../../../services/instance-guard.js', () => {
  class InstanceAccessError extends Error {
    statusCode: number
    constructor(statusCode: number, message: string) {
      super(message)
      this.statusCode = statusCode
    }
  }
  return {
    InstanceAccessError,
    assertInstanceAccess: vi.fn(async () => {
      if (guard.deny) throw new InstanceAccessError(guard.deny, 'Record not found')
    }),
    instanceAccessAllowed: vi.fn(async () => !guard.deny)
  }
})

// The mutation chain the single-record route runs (workflow-transitions.ts,
// covered on its own): here it records each record it would move, and throws
// a blocking-action refusal for an item named in `chain.blocked`.
const chain = vi.hoisted(() => ({
  applied: [] as string[],
  blocked: new Set<string>(),
  released: 0
}))
vi.mock('../../../services/workflow-transitions.js', async () => {
  const { TransitionBlockedError } = await import('../../../services/workflow-actions.js')
  return {
    applyTransition: vi.fn(async (opts: { instance: { item: string } }) => {
      if (chain.blocked.has(opts.instance.item))
        throw new TransitionBlockedError('Fusion refused the submission')
      chain.applied.push(opts.instance.item)
      return {
        updatedInstance: undefined,
        newStateObj: { id: 'st-done', label: 'Done' },
        previousState: null,
        history_id: 1
      }
    }),
    runAutoTransitions: vi.fn(async () => {})
  }
})
vi.mock('../../../services/transition-guard.js', async (orig) => ({
  ...(await orig<object>()),
  claimTransition: vi.fn(async () => ({
    release: async () => {
      chain.released++
    }
  }))
}))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  clearAutoFailures: vi.fn(async () => {})
}))

import { db } from '../../../db/index.js'
import { itemsRoutes } from '../../../routes/items.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(itemsRoutes, { prefix: '/items' })
  return app
}

interface DbFixture {
  transition: Record<string, unknown>
  instance: Record<string, unknown> | undefined
  fieldRows?: Array<{ field: string; label: string | null }>
  childRows?: Array<Record<string, unknown>>
  instanceUpdate?: ReturnType<typeof vi.fn>
}

function makeDbMock(fx: DbFixture) {
  return vi.fn((table: string) => {
    switch (table) {
      case 'nivaro_workflow_transitions':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(fx.transition)) })) }
      case 'nivaro_workflow_bindings':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) })) }
      case 'nivaro_workflow_instances':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(fx.instance)),
            update: fx.instanceUpdate ?? vi.fn(() => Promise.resolve(1))
          }))
        }
      case 'nivaro_workflow_history':
        return { insert: vi.fn(() => Promise.resolve([1])) }
      case 'nivaro_workflow_states':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() =>
              Promise.resolve({ id: 'st-done', is_terminal: true, is_initial: false })
            )
          }))
        }
      case 'nivaro_fields':
        return {
          where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve(fx.fieldRows ?? [])) }))
        }
      default:
        // Child collection query for the requirements gate: where(...).limit(2000).select([...])
        return {
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ select: vi.fn(() => Promise.resolve(fx.childRows ?? [])) }))
          }))
        }
    }
  })
}

const baseTransition = {
  id: 'tx-1',
  template: 'tpl-1',
  from_state: null,
  to_state: 'st-done',
  label: 'Advance',
  required_roles: null,
  requirements: JSON.stringify([
    {
      type: 'child_fields',
      collection: 'workflow_line_items',
      fk_field: 'workflow',
      fields: ['req_id']
    }
  ])
}

const baseInstance = {
  id: 'inst-1',
  template: 'tpl-1',
  collection: 'workflows',
  item: 'wf-1',
  current_state: null,
  completed_at: null
}

afterEach(() => {
  vi.clearAllMocks()
  chain.applied = []
  chain.blocked.clear()
  chain.released = 0
})

describe('POST /items/:collection/bulk-transition — requirements enforcement', () => {
  it('blocks an item with incomplete child rows, reports a per-item TRANSITION_REQUIREMENTS error, and never mutates the instance', async () => {
    vi.mocked(db).mockImplementation(
      makeDbMock({
        transition: baseTransition,
        instance: baseInstance,
        fieldRows: [],
        childRows: [{ id: 1, req_id: null }]
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1'], transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      succeeded: number
      failed: number
      errors: Array<{ item: string; error: string }>
    }
    expect(body.succeeded).toBe(0)
    expect(body.failed).toBe(1)
    expect(body.errors).toEqual([{ item: 'wf-1', error: 'TRANSITION_REQUIREMENTS' }])

    // The gate must run before any state mutation — the record is never moved.
    expect(chain.applied).toEqual([])
  })

  it('does not abort the rest of the batch when one item is blocked', async () => {
    let call = 0
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_workflow_instances') {
        return {
          where: vi.fn(() => {
            call++
            // First lookup (item wf-1) blocked by incomplete child rows; second
            // (item wf-2) has no child rows at all, so it passes the gate.
            return {
              first: vi.fn(() =>
                Promise.resolve({ ...baseInstance, item: call === 1 ? 'wf-1' : 'wf-2' })
              )
            }
          })
        }
      }
      if (table === 'nivaro_workflow_transitions') {
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(baseTransition)) })) }
      }
      if (table === 'nivaro_workflow_bindings') {
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) })) }
      }
      if (table === 'nivaro_workflow_history') {
        return { insert: vi.fn(() => Promise.resolve([1])) }
      }
      if (table === 'nivaro_workflow_states') {
        return {
          where: vi.fn(() => ({
            first: vi.fn(() =>
              Promise.resolve({ id: 'st-done', is_terminal: true, is_initial: false })
            )
          }))
        }
      }
      if (table === 'nivaro_fields') {
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      }
      // Child collection: first item has an incomplete row, second has none.
      return {
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            select: vi.fn(() => Promise.resolve(call === 1 ? [{ id: 1, req_id: null }] : []))
          }))
        }))
      }
    }) as unknown as typeof db)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1', 'wf-2'], transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      succeeded: number
      failed: number
      errors: Array<{ item: string; error: string }>
    }
    expect(body.failed).toBe(1)
    expect(body.succeeded).toBe(1)
    expect(body.errors).toEqual([{ item: 'wf-1', error: 'TRANSITION_REQUIREMENTS' }])
    // Only the passing item (wf-2) reaches the mutation.
    expect(chain.applied).toEqual(['wf-2'])
  })

  it('proceeds normally when the transition has no requirements configured', async () => {
    vi.mocked(db).mockImplementation(
      makeDbMock({
        transition: { ...baseTransition, requirements: null },
        instance: baseInstance
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1'], transition_id: 'tx-1' }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { succeeded: number; failed: number }
    expect(body.succeeded).toBe(1)
    expect(body.failed).toBe(0)
    expect(chain.applied).toEqual(['wf-1'])
  })
})

describe('POST /items/:collection/bulk-transition — the single route gate chain', () => {
  async function send(transition: Record<string, unknown>) {
    vi.mocked(db).mockImplementation(
      makeDbMock({ transition, instance: baseInstance }) as unknown as typeof db
    )
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1'], transition_id: 'tx-1' }
    })
    return JSON.parse(res.body) as {
      succeeded: number
      failed: number
      errors: Array<{ item: string; error: string }>
    }
  }

  it('refuses an automatic transition, as the single route does', async () => {
    const body = await send({ ...baseTransition, requirements: null, auto_trigger: true })
    expect(body).toMatchObject({ succeeded: 0, failed: 1 })
    expect(body.errors[0].error).toMatch(/Automatic transitions/)
    expect(chain.applied).toEqual([])
  })

  it('leaves the record where it is when a blocking action refuses', async () => {
    chain.blocked.add('wf-1')
    const body = await send({ ...baseTransition, requirements: null })
    expect(body).toMatchObject({ succeeded: 0, failed: 1 })
    expect(body.errors[0].error).toBe('Fusion refused the submission')
    // The double-fire claim is given back so a retry may run.
    expect(chain.released).toBe(1)
  })

  it('moves a record the gate chain allows', async () => {
    const body = await send({ ...baseTransition, requirements: null })
    expect(body).toMatchObject({ succeeded: 1, failed: 0 })
    expect(chain.applied).toEqual(['wf-1'])
  })
})
