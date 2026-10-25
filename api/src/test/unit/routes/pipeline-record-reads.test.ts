import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pipeline reads that answered about records the caller cannot see (army
// 2026-10-25): the state list of every record of a collection, the simulate
// panel's record values and owners, and company-wide flow counts.

const who = vi.hoisted(() => ({ admin: false, hidden: new Set<string>() }))

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-paul', role: 'role-approver' }
    req.isAdmin = who.admin
  }
  const admin = async (
    req: { user?: unknown; isAdmin?: boolean },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    await set(req)
    if (!who.admin) return reply.code(403).send({ error: 'Forbidden' })
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(admin) }
})
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/instance-guard.js', () => {
  class InstanceAccessError extends Error {
    statusCode: number
    constructor(code: number, msg: string) {
      super(msg)
      this.statusCode = code
    }
  }
  return {
    InstanceAccessError,
    assertInstanceAccess: vi.fn(async (_u: unknown, _a: unknown, _c: string, item: string) => {
      if (who.hidden.has(item)) throw new InstanceAccessError(404, 'Not found')
    }),
    instanceAccessAllowed: vi.fn(async () => true)
  }
})
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => ['id', 'amount'])
}))
vi.mock('../../../services/record-access.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => !who.hidden.has(i)))
  )
}))
vi.mock('../../../services/pipeline-engine.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  resolveStateOwnersBatch: vi.fn(async () => new Map())
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({
    id: 'inst-1',
    template: 'tpl-1',
    collection: 'workflows',
    item: '1',
    current_state: 'S1',
    completed_at: null
  }))
}))
vi.mock('../../../services/workflow-conditions.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchRecordForConditions: vi.fn(async () => ({ amount: 500, secret_note: 'hidden' }))
}))

const instanceRows = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const rows =
      t === 'nivaro_workflow_bindings'
        ? [{ template: 'tpl-1', collection: 'workflows' }]
        : t === 'nivaro_workflow_instances as i'
          ? instanceRows
          : t === 'nivaro_workflow_transitions'
            ? [
                {
                  id: 'T1',
                  from_state: 'S1',
                  to_state: 'S2',
                  required_roles: null,
                  condition_rules: JSON.stringify([
                    { field: 'secret_note', op: '_eq', value: 'x' },
                    { field: 'amount', op: '_gt', value: 1 }
                  ])
                }
              ]
            : []
    const c: Record<string, unknown> = {}
    for (const m of [
      'where',
      'whereIn',
      'whereNull',
      'whereNotNull',
      'leftJoin',
      'join',
      'select',
      'orderBy',
      'groupBy',
      'max',
      'count',
      'modify'
    ])
      c[m] = vi.fn((arg?: unknown) => {
        if (m === 'modify' && typeof arg === 'function') (arg as (q: unknown) => void)(c)
        return c
      })
    c.first = vi.fn(async () => rows[0])
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    c.catch = () => Promise.resolve(rows)
    return c
  })
  return { db }
})

import { pipelinesRoutes } from '../../../routes/pipelines.js'

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const app = Fastify({ logger: false })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app.inject({ method, url, payload: payload as object })
}

beforeEach(() => {
  who.admin = false
  who.hidden.clear()
  instanceRows.length = 0
  instanceRows.push(
    { item: '1', state_key: 'l1', instance_id: 'i1', current_state: 'S1' },
    { item: '2', state_key: 'l1', instance_id: 'i2', current_state: 'S1' }
  )
})

describe('GET /pipelines/instances/:collection', () => {
  it('refuses the every-record form for a non-admin', async () => {
    const res = await call('GET', '/pipelines/instances/workflows')
    expect(res.statusCode).toBe(400)
  })

  it('answers a non-admin only for the ids they can see', async () => {
    who.hidden.add('2')
    // The rows the db hands back are already narrowed to the visible ids by
    // whereIn in production; here we check the id list that reached it.
    const res = await call('GET', '/pipelines/instances/workflows?ids=1,2')
    expect(res.statusCode).toBe(200)
    const { db } = await import('../../../db/index.js')
    const whereIn = vi
      .mocked(db)
      .mock.results.map((r) => (r.value as { whereIn: ReturnType<typeof vi.fn> }).whereIn)
      .flatMap((f) => f.mock.calls)
      .find((args) => args[0] === 'i.item')
    expect(whereIn?.[1]).toEqual(['1'])
  })

  it('still gives an admin the whole map', async () => {
    who.admin = true
    const res = await call('GET', '/pipelines/instances/workflows')
    expect(res.statusCode).toBe(200)
    expect(Object.keys(JSON.parse(res.body).data.instances)).toEqual(['1', '2'])
  })
})

describe('POST /pipelines/simulate', () => {
  it('404s a record hidden from the caller', async () => {
    who.hidden.add('9')
    const res = await call('POST', '/pipelines/simulate', { collection: 'workflows', item_id: 9 })
    expect(res.statusCode).toBe(404)
  })

  it('answers for a visible record, echoing only fields the caller may read', async () => {
    const res = await call('POST', '/pipelines/simulate', { collection: 'workflows', item_id: 1 })
    expect(res.statusCode).toBe(200)
    const rules = JSON.parse(res.body).data.transitions[0].condition_rules
    expect(rules.find((r: { field: string }) => r.field === 'secret_note').record_value).toBeNull()
    expect(rules.find((r: { field: string }) => r.field === 'amount').record_value).toBe(500)
  })
})

describe('company-wide pipeline reads are admin-only', () => {
  it('refuses flow-map / replay / matrix for a non-admin and serves an admin', async () => {
    for (const p of ['flow-map', 'replay', 'matrix']) {
      expect((await call('GET', `/pipelines/tpl-1/${p}`)).statusCode).toBe(403)
    }
    who.admin = true
    expect((await call('GET', '/pipelines/tpl-1/flow-map')).statusCode).toBe(200)
  })
})
