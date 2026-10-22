import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RESP = '33333333-3333-4333-8333-333333333333'
const OUTSIDER = '44444444-4444-4444-8444-444444444444'

// The caller is chosen per request: `x-as: <user id>`; only ADMIN is an administrator.
vi.mock('../middleware/authenticate.js', () => {
  const sign = (req: { headers: Record<string, string>; user?: unknown; isAdmin?: boolean }) => {
    const id = req.headers['x-as'] || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    req.user = { id, first_name: id.slice(0, 4), email: `${id}@x` }
    req.isAdmin = id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    return req
  }
  return {
    requireAuth: async (req: never) => {
      sign(req)
    },
    requireAdmin: async (req: never) => {
      const r = sign(req) as { isAdmin?: boolean }
      if (!r.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }
  }
})
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(null) }))
vi.mock('../services/job-runs.js', () => ({
  startJobRun: vi.fn().mockResolvedValue({
    id: 7,
    progress: vi.fn(),
    log: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined)
  })
}))
vi.mock('../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => ({})) }))

import { _resetBlindForTests } from '../services/chaos/blind.js'
import { _resetDrillForTests } from '../services/chaos/drill.js'
import { _resetGamedayForTests } from '../services/chaos/gameday.js'
import { _resetRegistryForTests } from '../services/chaos/registry.js'
import { _setRunStoreForTests } from '../services/chaos/runs.js'
import { chaosRoutes } from './chaos.js'
import { chaosGamedayRoutes } from './chaos-gameday.js'

const saved = { ...process.env }

async function build() {
  const app = Fastify()
  await app.register(chaosRoutes)
  await app.register(chaosGamedayRoutes)
  await app.ready()
  return app
}

const as = (id: string) => ({ 'x-as': id })

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _setRunStoreForTests('memory')
})
afterEach(async () => {
  await _resetRegistryForTests()
  _resetDrillForTests()
  _resetGamedayForTests()
  _resetBlindForTests()
  _setRunStoreForTests(null)
  process.env = { ...saved }
})

describe('blind drills (#2854)', () => {
  it('GET /armed hides a blind drill from responders until it is revealed', async () => {
    const app = await build()
    const start = await app.inject({
      method: 'POST',
      url: '/blind/runs',
      payload: { fault_key: 'slow_requests', seconds: 60 }
    })
    expect(start.statusCode).toBe(201)
    const runId = start.json().data.run.id

    const forResponder = await app.inject({ method: 'GET', url: '/armed', headers: as(RESP) })
    expect(forResponder.json().data.armed).toEqual([])
    const forLead = await app.inject({ method: 'GET', url: '/armed', headers: as(ADMIN) })
    expect(forLead.json().data.armed).toHaveLength(1)

    const reveal = await app.inject({ method: 'POST', url: `/blind/runs/${runId}/reveal` })
    expect(reveal.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: '/armed', headers: as(RESP) })
    expect(after.json().data.armed).toHaveLength(1)

    // Stop all always works, blind or not.
    const stop = await app.inject({ method: 'POST', url: '/stop-all' })
    expect(stop.json().data.stopped).toHaveLength(1)
    await app.close()
  })

  it('Declare incident always answers ok, even with nothing running or chaos refused', async () => {
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/declare', headers: as(OUTSIDER) })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.ok).toBe(true)
    process.env.CLOUD_META_DB_URL = 'x'
    const refused = await app.inject({ method: 'POST', url: '/declare', headers: as(OUTSIDER) })
    expect(refused.json().data.ok).toBe(true)
    await app.close()
  })
})

describe('game day routes (#2852, #2853)', () => {
  const plan = () => ({
    title: 'Route day',
    starts_at: new Date(Date.now() + 3600_000).toISOString(),
    duration_min: 30,
    lead: ADMIN,
    responders: [RESP],
    channel: false,
    injects: [{ id: 'a', at_s: 0, kind: 'checkpoint', label: 'Start' }]
  })

  it('refuses a bad plan with every error listed', async () => {
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/gamedays', payload: { title: '' } })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('CHAOS_PLAN')
    expect(r.json().details.errors.length).toBeGreaterThan(1)
    await app.close()
  })

  it('plans, starts, lists for participants only, takes notes from participants only, ends', async () => {
    const app = await build()
    const created = await app.inject({ method: 'POST', url: '/gamedays', payload: plan() })
    expect(created.statusCode).toBe(201)
    const id = created.json().data.run.id

    const mine = await app.inject({ method: 'GET', url: '/gamedays/active', headers: as(RESP) })
    expect(mine.json().data).toEqual([
      expect.objectContaining({ id, role: 'responder', status: 'planned' })
    ])
    expect(mine.json().data[0]).not.toHaveProperty('injects')
    const theirs = await app.inject({
      method: 'GET',
      url: '/gamedays/active',
      headers: as(OUTSIDER)
    })
    expect(theirs.json().data).toEqual([])

    const start = await app.inject({ method: 'POST', url: `/gamedays/${id}/start` })
    expect(start.json().data.status).toBe('running')

    const note = await app.inject({
      method: 'POST',
      url: `/runs/${id}/notes`,
      headers: as(RESP),
      payload: { mark: 'noticed', text: 'banner?' }
    })
    expect(note.statusCode).toBe(201)
    const outsider = await app.inject({
      method: 'POST',
      url: `/runs/${id}/notes`,
      headers: as(OUTSIDER),
      payload: { mark: 'noticed' }
    })
    expect(outsider.statusCode).toBe(403)
    const hidden = await app.inject({
      method: 'GET',
      url: `/runs/${id}/notes`,
      headers: as(OUTSIDER)
    })
    expect(hidden.statusCode).toBe(404)
    const notes = await app.inject({ method: 'GET', url: `/runs/${id}/notes`, headers: as(RESP) })
    expect(notes.json().data.notes).toHaveLength(1)

    // Administrators only for the plan itself.
    const detailAsResponder = await app.inject({
      method: 'GET',
      url: `/gamedays/${id}`,
      headers: as(RESP)
    })
    expect(detailAsResponder.statusCode).toBe(403)
    const detail = await app.inject({ method: 'GET', url: `/gamedays/${id}` })
    expect(detail.json().data.run.id).toBe(id)

    const end = await app.inject({ method: 'POST', url: `/gamedays/${id}/end`, payload: {} })
    expect(end.json().data.status).toBe('completed')
    await app.close()
  })

  it('the gate refuses planning in cloud mode; ending a running day still works', async () => {
    const app = await build()
    const created = await app.inject({ method: 'POST', url: '/gamedays', payload: plan() })
    const id = created.json().data.run.id
    await app.inject({ method: 'POST', url: `/gamedays/${id}/start` })
    process.env.CLOUD_META_DB_URL = 'x'
    const refused = await app.inject({ method: 'POST', url: '/gamedays', payload: plan() })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().code).toBe('CHAOS_GATE')
    const end = await app.inject({ method: 'POST', url: `/gamedays/${id}/end`, payload: {} })
    expect(end.statusCode).toBe(200)
    await app.close()
  })
})
