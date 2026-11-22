import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runPreflight = vi.fn<(...a: any[]) => any>()
const readReadiness = vi.fn<(...a: any[]) => any>()
const poolCounters = vi.fn<(...a: any[]) => any>()

vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'production' } }))
vi.mock('../../../routes/preflight.js', () => ({
  runPreflight: (...a: unknown[]) => runPreflight(...a)
}))
vi.mock('../../../services/readiness.js', () => ({
  readReadiness: (...a: unknown[]) => readReadiness(...a)
}))
vi.mock('../../../services/pool-attribution.js', () => ({
  poolCounters: (...a: unknown[]) => poolCounters(...a)
}))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'production' }))

import { _resetHubLinkForTests, hubLinkRoutes } from '../../../routes/hub-link.js'

const TOKEN = 'h'.repeat(40)
let app: FastifyInstance | null = null
const saved = { HUB_TOKEN: process.env.HUB_TOKEN, CLOUD: process.env.CLOUD_META_DB_URL }

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  await a.register(hubLinkRoutes, { prefix: '/api/hub-link' })
  await a.ready()
  app = a
  return a
}

beforeEach(() => {
  _resetHubLinkForTests()
  process.env.HUB_TOKEN = TOKEN
  delete process.env.CLOUD_META_DB_URL
  runPreflight.mockReset().mockResolvedValue({
    status: 'warn',
    checks: [
      { id: 'database', status: 'ok', summary: 'Database reachable.', detail: { host: 'db' } },
      { id: 'render', status: 'fail', summary: 'No render.' },
      { id: 'redis', status: 'warn', summary: 'Redis slow.' }
    ]
  })
  readReadiness.mockReset().mockResolvedValue({ score: 92, checks: [{ id: 'x', detail: 's' }] })
  poolCounters.mockReset().mockReturnValue({
    used: 3,
    free: 7,
    pending_acquires: 1,
    pending_creates: 0,
    max: 60
  })
})

afterEach(async () => {
  await app?.close()
  app = null
  if (saved.HUB_TOKEN === undefined) delete process.env.HUB_TOKEN
  else process.env.HUB_TOKEN = saved.HUB_TOKEN
  if (saved.CLOUD === undefined) delete process.env.CLOUD_META_DB_URL
  else process.env.CLOUD_META_DB_URL = saved.CLOUD
})

describe('GET /api/hub-link/status', () => {
  it('refuses a request without a bearer', async () => {
    const a = await build()
    const res = await a.inject({ method: 'GET', url: '/api/hub-link/status' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HUB_LINK_REFUSED')
    expect(runPreflight).not.toHaveBeenCalled()
  })

  it('refuses a wrong bearer', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status',
      headers: { authorization: `Bearer ${'x'.repeat(40)}` }
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HUB_LINK_REFUSED')
  })

  it('answers the status shape, and nothing else, for the right bearer', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.version).toBe('string')
    expect(Object.keys(body).sort()).toEqual(
      [
        'environment',
        'instance',
        'maintenance',
        'preflight',
        'process',
        'readiness_score',
        'retired',
        'version'
      ].sort()
    )
    expect(body.environment).toBe('production')
    expect(body.instance).toBe('production')
    expect(body.preflight).toEqual({ status: 'warn', failing: ['render'] })
    expect(body.readiness_score).toBe(92)
    expect(Object.keys(body.process).sort()).toEqual(['memory_mb', 'pool', 'uptime_s'])
    expect(body.process.pool).toEqual({ used: 3, free: 7, pending: 1 })
    expect(typeof body.process.uptime_s).toBe('number')
    expect(typeof body.process.memory_mb).toBe('number')
    // The cached scorecard, never a live run.
    expect(readReadiness).toHaveBeenCalledWith()
    // No check detail (hosts, database names) leaves the app.
    expect(JSON.stringify(body)).not.toContain('db')
  })

  it('answers with what it has when a source fails', async () => {
    runPreflight.mockRejectedValue(new Error('boom'))
    readReadiness.mockRejectedValue(new Error('boom'))
    poolCounters.mockReturnValue(null)
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.preflight).toEqual({ status: 'unknown', failing: [] })
    expect(body.readiness_score).toBeNull()
    expect(body.process.pool).toBeNull()
  })

  it('reuses a recent preflight instead of running it again', async () => {
    const a = await build()
    const headers = { authorization: `Bearer ${TOKEN}` }
    await a.inject({ method: 'GET', url: '/api/hub-link/status', headers })
    await a.inject({ method: 'GET', url: '/api/hub-link/status', headers })
    expect(runPreflight).toHaveBeenCalledTimes(1)
  })

  it('answers within the bound when the preflight and the scorecard hang', async () => {
    _resetHubLinkForTests({ boundMs: 50 })
    runPreflight.mockReturnValue(new Promise(() => {}))
    readReadiness.mockReturnValue(new Promise(() => {}))
    const a = await build()
    const started = Date.now()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.statusCode).toBe(200)
    expect(res.json().preflight).toEqual({ status: 'timeout', failing: [] })
    expect(res.json().readiness_score).toBeNull()
  })

  it('lets a hung preflight run go: a later request starts a fresh one', async () => {
    _resetHubLinkForTests({ boundMs: 30, staleMs: 60 })
    runPreflight.mockReturnValueOnce(new Promise(() => {}))
    const a = await build()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const first = await a.inject({ method: 'GET', url: '/api/hub-link/status', headers })
    expect(first.json().preflight.status).toBe('timeout')
    await new Promise((r) => setTimeout(r, 80))
    const second = await a.inject({ method: 'GET', url: '/api/hub-link/status', headers })
    expect(second.json().preflight).toEqual({ status: 'warn', failing: ['render'] })
    expect(runPreflight).toHaveBeenCalledTimes(2)
  })

  it('is not mounted when HUB_TOKEN is shorter than 32 characters', async () => {
    process.env.HUB_TOKEN = 'short-token'
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status',
      headers: { authorization: 'Bearer short-token' }
    })
    expect(res.statusCode).toBe(404)
  })

  it('is not mounted in cloud mode', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-link/status',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.statusCode).toBe(404)
  })
})
