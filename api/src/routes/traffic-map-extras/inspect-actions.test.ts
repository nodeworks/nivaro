// Traffic Map drill-down Task 8: investigation routes (permissions, validation) and Explain.
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  ready: true,
  rows: new Map<string, Record<string, unknown>>()
}))
const ai = vi.hoisted(() => ({ client: null as unknown }))
const activity = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))

vi.mock('../../services/traffic-inspect/actions-store.js', () => ({
  INVESTIGATIONS_TABLE: 'nivaro_traffic_investigations',
  investigationsReady: async () => store.ready,
  listInvestigations: async () => [...store.rows.values()],
  getInvestigation: async (id: string) => store.rows.get(id) ?? null,
  insertInvestigation: async (row: Record<string, unknown>) => {
    store.rows.set(String(row.id), {
      ...row,
      created_by_name: null,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z'
    })
  },
  updateInvestigation: async (id: string, patch: Record<string, unknown>) => {
    const r = store.rows.get(id)
    if (r) store.rows.set(id, { ...r, ...patch })
  },
  deleteInvestigation: async (id: string) => {
    store.rows.delete(id)
  }
}))
vi.mock('../../services/ai-client.js', () => ({
  getAiClient: async () => ai.client,
  getAiModelSettings: async () => ({ model: 'test-model' })
}))
vi.mock('../../services/activity.js', () => ({
  logActivity: async (opts: Record<string, unknown>) => {
    activity.calls.push(opts)
    return 1
  }
}))

import { resetInspectSources } from '../../services/traffic-inspect.js'
import { inspectActionsRoutes } from './inspect-actions.js'

const SAVER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER = '11111111-2222-4333-8444-555555555555'
const INV = '99999999-8888-4777-8666-555555555555'

async function app(user: string | null, isAdmin: boolean): Promise<FastifyInstance> {
  const a = Fastify()
  a.addHook('preHandler', async (req) => {
    ;(req as unknown as { user: unknown }).user = user ? { id: user } : undefined
    ;(req as unknown as { isAdmin: boolean }).isAdmin = isAdmin
  })
  await a.register(inspectActionsRoutes, { prefix: '/traffic-map' })
  await a.ready()
  return a
}

function seed() {
  store.rows.set(INV, {
    id: INV,
    title: 'Slow writes',
    stack: `request:${SAVER}`,
    notes: null,
    context: '{"levels":[]}',
    created_by: SAVER,
    created_by_name: 'Saver',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z'
  })
}

beforeEach(() => {
  store.ready = true
  store.rows.clear()
  activity.calls = []
  ai.client = null
})
afterEach(() => resetInspectSources())

describe('investigation permissions', () => {
  it('lets the saver patch and delete', async () => {
    seed()
    const a = await app(SAVER, false)
    const p = await a.inject({
      method: 'PATCH',
      url: `/traffic-map/investigations/${INV}`,
      payload: { notes: 'checked the trace' }
    })
    expect(p.statusCode).toBe(200)
    expect(p.json().data.notes).toBe('checked the trace')
    expect(p.json().data.can_edit).toBe(true)
    const d = await a.inject({ method: 'DELETE', url: `/traffic-map/investigations/${INV}` })
    expect(d.statusCode).toBe(204)
    expect(store.rows.has(INV)).toBe(false)
    await a.close()
  })
  it('refuses someone else who is not an admin', async () => {
    seed()
    const a = await app(OTHER, false)
    const p = await a.inject({
      method: 'PATCH',
      url: `/traffic-map/investigations/${INV}`,
      payload: { notes: 'x' }
    })
    expect(p.statusCode).toBe(403)
    expect(p.json().code).toBe('INVESTIGATION_FORBIDDEN')
    const d = await a.inject({ method: 'DELETE', url: `/traffic-map/investigations/${INV}` })
    expect(d.statusCode).toBe(403)
    expect(store.rows.has(INV)).toBe(true)
    const g = await a.inject({ url: `/traffic-map/investigations/${INV}` })
    expect(g.json().data.can_edit).toBe(false)
    await a.close()
  })
  it('lets any admin change it', async () => {
    seed()
    const a = await app(OTHER, true)
    const p = await a.inject({
      method: 'PATCH',
      url: `/traffic-map/investigations/${INV}`,
      payload: { title: 'Renamed' }
    })
    expect(p.statusCode).toBe(200)
    expect(p.json().data.title).toBe('Renamed')
    await a.close()
  })
  it('answers 404 for a bad or unknown id and 503 before migration 390', async () => {
    const a = await app(SAVER, true)
    expect((await a.inject({ url: '/traffic-map/investigations/nope' })).statusCode).toBe(404)
    expect((await a.inject({ url: `/traffic-map/investigations/${INV}` })).statusCode).toBe(404)
    store.ready = false
    expect((await a.inject({ url: `/traffic-map/investigations/${INV}` })).statusCode).toBe(503)
    const list = await a.inject({ url: '/traffic-map/investigations' })
    expect(list.json()).toEqual({ data: [], ready: false })
    await a.close()
  })
})

describe('saving', () => {
  it('saves a valid stack, logs the activity with a short label only', async () => {
    const a = await app(SAVER, true)
    const res = await a.inject({
      method: 'POST',
      url: '/traffic-map/investigations',
      payload: { title: '  Checkout errors ', stack: `request:${SAVER}`, context: { levels: [] } }
    })
    expect(res.statusCode).toBe(201)
    const { id } = res.json().data
    expect(store.rows.get(id)?.title).toBe('Checkout errors')
    expect(store.rows.get(id)?.created_by).toBe(SAVER)
    expect(activity.calls[0]).toMatchObject({
      action: 'traffic-investigation',
      collection: 'nivaro_traffic_investigations',
      item: id,
      comment: 'Investigation "Checkout errors"'
    })
    await a.close()
  })
  it('refuses a malformed stack and an oversized context', async () => {
    const a = await app(SAVER, true)
    const bad = await a.inject({
      method: 'POST',
      url: '/traffic-map/investigations',
      payload: { stack: 'not a stack' }
    })
    expect(bad.statusCode).toBe(400)
    const big = await a.inject({
      method: 'POST',
      url: '/traffic-map/investigations',
      payload: { stack: 'entity:x', context: { pad: 'x'.repeat(70 * 1024) } }
    })
    expect(big.statusCode).toBe(413)
    expect(store.rows.size).toBe(0)
    await a.close()
  })
})

describe('explain', () => {
  it('passes AI_NOT_CONFIGURED through as 503', async () => {
    const a = await app(SAVER, true)
    const res = await a.inject({
      method: 'POST',
      url: '/traffic-map/inspect/explain',
      payload: { context: { levels: [{ kind: 'request', title: 'GET /api/items' }] } }
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('AI_NOT_CONFIGURED')
    await a.close()
  })
  it('needs levels, returns the model text, and never writes it to the activity row', async () => {
    let sent: Record<string, unknown> | null = null
    ai.client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          sent = params
          return { content: [{ type: 'text', text: 'What happened: a 500 [L1].' }] }
        }
      }
    }
    const a = await app(SAVER, true)
    const none = await a.inject({
      method: 'POST',
      url: '/traffic-map/inspect/explain',
      payload: { context: { levels: [] } }
    })
    expect(none.statusCode).toBe(400)
    const res = await a.inject({
      method: 'POST',
      url: '/traffic-map/inspect/explain',
      payload: {
        context: {
          levels: [
            {
              kind: 'request',
              title: 'GET /api/items',
              detail: { headers: { authorization: 'Bearer s3cret' }, status: 500 }
            }
          ]
        }
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.text).toBe('What happened: a 500 [L1].')
    expect(sent).not.toBeNull()
    // the prompt carries the facts but never a credential-looking value
    const prompt = JSON.stringify((sent as unknown as { messages: unknown[] }).messages)
    expect(prompt).toContain('500')
    expect(prompt).not.toContain('s3cret')
    expect(activity.calls).toHaveLength(1)
    expect(activity.calls[0].action).toBe('traffic-inspect-explain')
    expect(String(activity.calls[0].comment)).not.toContain('500')
    await a.close()
  })
})
