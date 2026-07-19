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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

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

afterEach(() => vi.clearAllMocks())

describe('POST /items/:collection/bulk-transition — requirements enforcement', () => {
  it('blocks an item with incomplete child rows, reports a per-item TRANSITION_REQUIREMENTS error, and never mutates the instance', async () => {
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    vi.mocked(db).mockImplementation(
      makeDbMock({
        transition: baseTransition,
        instance: baseInstance,
        fieldRows: [],
        childRows: [{ id: 1, req_id: null }],
        instanceUpdate
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

    // The gate must run before any state mutation — the instance is never updated.
    expect(instanceUpdate).not.toHaveBeenCalled()
  })

  it('does not abort the rest of the batch when one item is blocked', async () => {
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
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
              ),
              update: instanceUpdate
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
    expect(instanceUpdate).toHaveBeenCalledTimes(1)
  })

  it('proceeds normally when the transition has no requirements configured', async () => {
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    vi.mocked(db).mockImplementation(
      makeDbMock({
        transition: { ...baseTransition, requirements: null },
        instance: baseInstance,
        instanceUpdate
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
    expect(instanceUpdate).toHaveBeenCalledTimes(1)
  })
})
