import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub release operations, app side: GET /api/hub-link/status adds aggregate counts
// (?recent_minutes) and build facts (?release_facts=1) only when asked, bounded like the rest.

const { recentFigures, releaseFacts } = vi.hoisted(() => ({
  recentFigures: vi.fn<(...a: any[]) => any>(),
  releaseFacts: vi.fn<(...a: any[]) => any>()
}))

vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'production' } }))
vi.mock('../../../routes/preflight.js', () => ({
  runPreflight: async () => ({ status: 'ok', checks: [] })
}))
vi.mock('../../../services/readiness.js', () => ({ readReadiness: async () => ({ score: 90 }) }))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: () => null }))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'production' }))
vi.mock('../../../services/hub-link/release-figures.js', () => ({ recentFigures, releaseFacts }))
// The route's first answer loads the maintenance reader lazily: slow under a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

import { _resetHubLinkForTests, hubLinkRoutes } from '../../../routes/hub-link.js'

const TOKEN = 'h'.repeat(40)
const headers = { authorization: `Bearer ${TOKEN}` }
let app: FastifyInstance | null = null
const saved = process.env.HUB_TOKEN

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  await a.register(hubLinkRoutes, { prefix: '/api/hub-link' })
  await a.ready()
  app = a
  return a
}

beforeEach(() => {
  _resetHubLinkForTests({ boundMs: 2000 })
  process.env.HUB_TOKEN = TOKEN
  recentFigures
    .mockReset()
    .mockResolvedValue({ minutes: 15, requests: 120, errors_5xx: 3, crashes: 1 })
  releaseFacts
    .mockReset()
    .mockResolvedValue({ migrations: ['565_hub_release_ops'], env_keys: ['HUB'] })
})

afterEach(async () => {
  await app?.close()
  app = null
  if (saved === undefined) delete process.env.HUB_TOKEN
  else process.env.HUB_TOKEN = saved
})

describe('GET /api/hub-link/status — release extras', () => {
  it('adds nothing unless asked', async () => {
    const a = await build()
    const body = (await a.inject({ method: 'GET', url: '/api/hub-link/status', headers })).json()
    expect(body.recent).toBeUndefined()
    expect(body.release_facts).toBeUndefined()
    expect(recentFigures).not.toHaveBeenCalled()
    expect(releaseFacts).not.toHaveBeenCalled()
  })

  it('answers the counts and the build facts when asked (minutes clamped to 60)', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status?recent_minutes=500&release_facts=1',
      headers
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(recentFigures).toHaveBeenCalledWith(60)
    expect(body.recent).toEqual({ minutes: 15, requests: 120, errors_5xx: 3, crashes: 1 })
    expect(body.release_facts).toEqual({ migrations: ['565_hub_release_ops'], env_keys: ['HUB'] })
  })

  it('leaves out a part that does not answer in time, or fails', async () => {
    recentFigures.mockReturnValue(new Promise(() => {}))
    releaseFacts.mockRejectedValue(new Error('boom'))
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status?recent_minutes=5&release_facts=1',
      headers
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().recent).toBeUndefined()
    expect(res.json().release_facts).toBeUndefined()
  })

  it('still needs the bearer', async () => {
    const a = await build()
    const res = await a.inject({ method: 'GET', url: '/api/hub-link/status?recent_minutes=5' })
    expect(res.statusCode).toBe(401)
    expect(recentFigures).not.toHaveBeenCalled()
  })
})
