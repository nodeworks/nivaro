import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Add owner" hands someone the step's approval rights: only admins and the
// owners of the CURRENT step may, a non-admin hands off the current step only,
// and adding yourself is no back door.
const ME = 'AAAAAAAA-0000-4000-8000-000000000001'
const OTHER = 'BBBBBBBB-0000-4000-8000-000000000002'
const CUR = 'CCCCCCCC-0000-4000-8000-000000000003'
const LATER = 'DDDDDDDD-0000-4000-8000-000000000004'

const who = vi.hoisted(() => ({ admin: false, owner: false }))
const inserts = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'AAAAAAAA-0000-4000-8000-000000000001', role: 'R' }
    req.isAdmin = who.admin
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(set) }
})
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/instance-guard.js', () => ({
  InstanceAccessError: class extends Error {},
  assertInstanceAccess: vi.fn(async () => {}),
  instanceAccessAllowed: vi.fn(async () => true)
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({
    id: 'inst-1',
    template: 'tpl-1',
    collection: 'workflows',
    item: '42',
    current_state: 'CCCCCCCC-0000-4000-8000-000000000003',
    completed_at: null
  }))
}))
vi.mock('../../../services/record-access.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkTransitionOwner: vi.fn(async () => ({ allowed: who.owner, message: 'no' }))
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((_t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'join', 'select', 'leftJoin']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => ({ id: 'x' }))
    c.insert = vi.fn((row: Record<string, unknown>) => {
      inserts.push(row)
      return { returning: vi.fn(async () => [{ id: 9 }]) }
    })
    return c
  })
  return { db }
})

import { pipelinesRoutes } from '../../../routes/pipelines.js'

async function add(body: Record<string, unknown>) {
  const app = Fastify({ logger: false })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app.inject({
    method: 'POST',
    url: '/pipelines/instance/workflows/42/owners',
    payload: body
  })
}

beforeEach(() => {
  who.admin = false
  who.owner = false
  inserts.length = 0
})

describe('POST /pipelines/instance/:collection/:item/owners', () => {
  it('lets an owner of the current step hand it off', async () => {
    who.owner = true
    const res = await add({ user: OTHER })
    expect(res.statusCode).toBe(201)
    // A non-admin's hand-off is bound to the current step, never "every step".
    expect(inserts[0]).toMatchObject({ user: OTHER, state: CUR })
  })

  it('refuses someone who does not own the current step', async () => {
    const res = await add({ user: OTHER })
    expect(res.statusCode).toBe(403)
    expect(inserts).toHaveLength(0)
  })

  it('refuses adding yourself when you do not own the step', async () => {
    const res = await add({ user: ME })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a non-admin handing off a later step', async () => {
    who.owner = true
    const res = await add({ user: OTHER, state: LATER })
    expect(res.statusCode).toBe(403)
    expect(inserts).toHaveLength(0)
  })

  it('lets an admin add an owner for any step', async () => {
    who.admin = true
    const res = await add({ user: OTHER, state: LATER })
    expect(res.statusCode).toBe(201)
    expect(inserts[0]).toMatchObject({ state: LATER })
  })

  it('answers 400 for a user id that is not one', async () => {
    who.owner = true
    const res = await add({ user: 'abc' })
    expect(res.statusCode).toBe(400)
  })
})
