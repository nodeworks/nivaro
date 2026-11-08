import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 11 a4: a bystander who can read a record must not acknowledge (and so
// silence) another approver's SLA breach; a late owner must not lengthen
// their own clock; "escalating" only when the rule escalates to someone.

const who = vi.hoisted(() => ({ admin: false, owner: false, manager: false }))
vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-virginia', role: 'r-approver' }
    req.isAdmin = who.admin
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(set) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/sla-visibility.js', () => ({
  canSeeRecord: vi.fn(async () => true),
  visibleRecordIds: vi.fn(async (_u: unknown, _c: string, ids: string[]) => ids)
}))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwners: vi.fn(async () => [{ id: 'u-andy' }])
}))
vi.mock('../../../services/record-access.js', () => ({
  canActOn: vi.fn(async () => ({
    can_act: true,
    is_owner: who.owner,
    state: 'Waiting on Level 4 Approval',
    summary: ''
  }))
}))
const inserted = vi.hoisted(() => [] as string[])
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'select', 'join', 'leftJoin'])
      c[m] = vi.fn(() => c)
    c.first = vi.fn(async (...cols: string[]) => {
      if (t === 'nivaro_workflow_instances' && cols.includes('current_state'))
        return { id: 'i1', current_state: 'S4' }
      if (t === 'nivaro_users' && cols.length === 1 && cols[0] === 'id')
        return who.manager ? { id: 'u-andy' } : undefined
      return t === 'nivaro_users' ? { id: 'u-virginia' } : undefined
    })
    c.insert = vi.fn(() => {
      inserted.push(t)
      return { catch: () => undefined }
    })
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return c
  })
  return { db }
})

import { managesAStepOwner, ownerMayAdjust, ruleEscalates, slaRoutes } from '../../../routes/sla.js'

async function app() {
  const a = Fastify()
  await a.register(slaRoutes, { prefix: '/sla' })
  return a
}

beforeEach(() => {
  who.admin = false
  who.owner = false
  who.manager = false
  inserted.length = 0
})

describe('POST /sla/ack', () => {
  it('refuses someone who only reads the record', async () => {
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/sla/ack',
      payload: { collection: 'workflows', item: '372696' }
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('SLA_ACK_FORBIDDEN')
    expect(inserted).toEqual([])
  })

  it('lets the step owner through to the breach check', async () => {
    who.owner = true
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/sla/ack',
      payload: { collection: 'workflows', item: '372696' }
    })
    // No instance in the mocked DB → "no active breach", not a 403.
    expect(r.statusCode).toBe(400)
  })
})

describe("an owner's manager (Rob 2026-11-08)", () => {
  it('may acknowledge', async () => {
    who.manager = true
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/sla/ack',
      payload: { collection: 'workflows', item: '372696' }
    })
    expect(r.statusCode).toBe(400) // through the gate; no breach in the mocked DB
  })
  it("managesAStepOwner reads the current step owners' manager", async () => {
    who.manager = true
    expect(await managesAStepOwner('u-virginia', 'workflows', '372696')).toBe(true)
    who.manager = false
    expect(await managesAStepOwner('u-virginia', 'workflows', '372696')).toBe(false)
  })
})

describe('ownerMayAdjust / ruleEscalates', () => {
  it('a breached step is an admin matter', () => {
    expect(ownerMayAdjust(true).ok).toBe(false)
    expect(ownerMayAdjust(false).ok).toBe(true)
  })
  it('an empty ladder with no escalation person escalates to nobody', () => {
    expect(ruleEscalates({ escalation_ladder: [], escalation_user: null })).toBe(false)
    expect(ruleEscalates({ escalation_ladder: null })).toBe(false)
    expect(ruleEscalates({ escalation_ladder: [{ after_hours: 4 }] })).toBe(true)
    expect(ruleEscalates({ escalation_ladder: [], escalation_user: 'u1' })).toBe(true)
  })
})
