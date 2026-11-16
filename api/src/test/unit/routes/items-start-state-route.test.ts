import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// REST: create a record in a chosen pipeline step — body `$start_state` or
// `?start_state=`; the answer's data carries `$state` (2026-11-16).

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-LINX', role: 'R-INTEGRATION' }
    req.isAdmin = false
  },
  requireAdmin: async () => {}
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
vi.mock('../../../services/activity.js', async (orig) => ({
  ...(await orig<object>()),
  logActivity: vi.fn(async () => null)
}))
vi.mock('../../../db/index.js', () => {
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
        if (prop === 'first') return () => Promise.resolve(undefined)
        return () => chain()
      },
      apply: () => chain()
    })
  const db = Object.assign(() => chain(), { raw: async () => [] })
  return { db, dbRead: db }
})
const svc = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  startState: null as Record<string, unknown> | null,
  refuse: null as null | Error
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  createOneReported: vi.fn(async (_u: unknown, _c: string, data: Record<string, unknown>) => {
    svc.created.push({ ...data })
    if (svc.refuse) throw svc.refuse
    return {
      id: 501,
      item: { id: 501, name: 'x' },
      readable: true,
      linkFailures: [],
      upserted: false,
      startState: svc.startState
    }
  })
}))

import { itemsRoutes } from '../../../routes/items.js'
import { StartStateRefusal } from '../../../services/start-state.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

const STATE = {
  key: 'waiting_on_manager_approval',
  label: 'Waiting on Manager Approval',
  external_label: null,
  color: null,
  is_terminal: false,
  entered_at: '2026-11-16T15:00:00.000Z',
  instance_id: 'I-NEW'
}

beforeEach(() => {
  svc.created = []
  svc.startState = null
  svc.refuse = null
})

describe('POST /items/:collection with a start step', () => {
  it('passes the body $start_state through and answers $state', async () => {
    svc.startState = STATE
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows',
      payload: { name: 'x', $start_state: 'waiting_on_manager_approval' }
    })
    expect(res.statusCode).toBe(201)
    expect(svc.created[0].$start_state).toBe('waiting_on_manager_approval')
    expect(res.json().data).toEqual({ id: 501, name: 'x', $state: STATE })
  })

  it('reads ?start_state= into the body', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows?start_state=complete',
      payload: { name: 'x' }
    })
    expect(res.statusCode).toBe(201)
    expect(svc.created[0].$start_state).toBe('complete')
    // No start happened: no $state in the answer.
    expect(res.json().data).not.toHaveProperty('$state')
  })

  it("the body's own key wins over the query", async () => {
    await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows?start_state=complete',
      payload: { name: 'x', $start_state: 'review' }
    })
    expect(svc.created[0].$start_state).toBe('review')
  })

  it('answers the gate refusal with its status and code', async () => {
    svc.refuse = new StartStateRefusal(
      403,
      'START_STATE_FORBIDDEN',
      'You may not create workflows records in a later step.'
    )
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows',
      payload: { name: 'x', $start_state: 'complete' }
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'START_STATE_FORBIDDEN' })
  })
})
