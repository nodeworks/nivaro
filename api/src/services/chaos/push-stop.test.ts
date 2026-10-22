import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../job-runs.js', () => ({
  startJobRun: vi.fn().mockResolvedValue({
    id: 7,
    progress: vi.fn(),
    log: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined)
  })
}))
vi.mock('../activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(null) }))
vi.mock('../../middleware/authenticate.js', () => ({
  authenticate: async () => {
    throw Object.assign(new Error('Sign in'), { statusCode: 401 })
  },
  requireAuth: async () => {
    throw Object.assign(new Error('Sign in'), { statusCode: 401 })
  },
  requireAdmin: async () => {
    throw Object.assign(new Error('Sign in'), { statusCode: 401 })
  }
}))

import { db } from '../../db/index.js'
import { chaosOpsRoutes, pushRateLimited } from '../../routes/chaos-ops.js'
import { _resetDrillForTests, abortDrill, startDrill } from './drill.js'
import './faults/index.js'
import {
  _setStopPushForTests,
  mintStopToken,
  redeemStopToken,
  setStopTokenRedis,
  verifyStopToken
} from './push-stop.js'
import { _resetRegistryForTests, armedFaults, chaosPoint } from './registry.js'
import { _setRunStoreForTests } from './runs.js'

const ADA = '11111111-1111-1111-1111-111111111111'
const pushes: Array<{ user: string; title: string; stop_token?: string | null }> = []

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _setRunStoreForTests('memory')
  pushes.length = 0
  _setStopPushForTests(async (user, p) => {
    pushes.push({ user, title: p.title, stop_token: p.stop_token })
    return 1
  })
})
afterEach(async () => {
  await _resetRegistryForTests()
  _resetDrillForTests()
  _setRunStoreForTests(null)
  _setStopPushForTests(null)
})

describe('stop tokens (#2861)', () => {
  it('verifies a fresh token and refuses tampered or expired ones', () => {
    const now = Date.now()
    const t = mintStopToken('run-1', ADA, now + 60_000)
    expect(verifyStopToken(t, now)).toMatchObject({ r: 'run-1', u: ADA })
    const [payload, sig] = t.split('.')
    const forged = `${Buffer.from(JSON.stringify({ r: 'run-2', u: ADA, e: now + 60_000, n: 'x' })).toString('base64url')}.${sig}`
    expect(() => verifyStopToken(forged, now)).toThrow(/not valid/)
    expect(() => verifyStopToken(`${payload}.AAAA`, now)).toThrow(/not valid/)
    expect(() => verifyStopToken('junk', now)).toThrow(/not valid/)
    expect(() => verifyStopToken(t, now + 61_000)).toThrow(/expired/)
  })

  it('is single-use in this process and across replicas', async () => {
    const t = mintStopToken('run-1', ADA, Date.now() + 60_000)
    expect(await redeemStopToken(t)).toEqual({ run_id: 'run-1', user_id: ADA })
    await expect(redeemStopToken(t)).rejects.toMatchObject({
      statusCode: 410,
      code: 'CHAOS_STOP_USED'
    })

    // Another replica spent it first: Redis SET NX answers null.
    setStopTokenRedis({ set: async () => null })
    const t2 = mintStopToken('run-1', ADA, Date.now() + 60_000)
    await expect(redeemStopToken(t2)).rejects.toMatchObject({ code: 'CHAOS_STOP_USED' })
    // Redis down: the Stop still works (spent locally).
    setStopTokenRedis({
      set: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    const t3 = mintStopToken('run-1', ADA, Date.now() + 60_000)
    expect(await redeemStopToken(t3)).toMatchObject({ run_id: 'run-1' })
  })

  it('rate limits the unauthenticated route per address', () => {
    const now = 1_000_000
    for (let i = 0; i < 20; i++) expect(pushRateLimited('9.9.9.9', now)).toBe(false)
    expect(pushRateLimited('9.9.9.9', now)).toBe(true)
    expect(pushRateLimited('9.9.9.9', now + 61_000)).toBe(false)
  })
})

describe('drill pushes and the phone Stop (#2861)', () => {
  async function build() {
    const app = Fastify()
    await app.register(chaosOpsRoutes)
    await app.ready()
    return app
  }

  function asOperator(active = true) {
    vi.mocked(db).mockImplementationOnce((() => {
      const chain: Record<string, unknown> = {}
      for (const m of ['leftJoin', 'join', 'where']) chain[m] = () => chain
      chain.first = async () => ({
        status: active ? 'active' : 'suspended',
        role: 'r',
        admin_access: true
      })
      return chain
    }) as never)
  }

  it('pushes the starter on start with a Stop token that ends every fault, once', async () => {
    const app = await build()
    const { run } = await startDrill({ fault_key: 'slow_requests', by: { id: ADA, name: 'Ada' } })
    await startDrill({ fault_key: 'mail_down', by: { id: ADA, name: 'Ada' } })
    await new Promise((r) => setTimeout(r, 20))
    const first = pushes.find((p) => p.title.includes('Slow requests'))
    expect(first?.user).toBe(ADA)
    expect(first?.stop_token).toBeTruthy()
    expect(armedFaults()).toHaveLength(2)

    asOperator()
    const res = await app.inject({
      method: 'POST',
      url: '/stop-all/push',
      payload: { token: first?.stop_token }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.stopped).toHaveLength(2)
    expect(res.json().data.runs).toContain(run.id)
    expect(armedFaults()).toEqual([])
    expect(chaosPoint('http.request')).toBeNull()

    const again = await app.inject({
      method: 'POST',
      url: '/stop-all/push',
      payload: { token: first?.stop_token }
    })
    expect(again.statusCode).toBe(410)
    const bad = await app.inject({
      method: 'POST',
      url: '/stop-all/push',
      payload: { token: 'nope' }
    })
    expect(bad.statusCode).toBe(400)
    await app.close()
  })

  it('refuses a token whose person is no longer a chaos operator', async () => {
    const app = await build()
    await startDrill({ fault_key: 'slow_requests', by: { id: ADA, name: 'Ada' } })
    await new Promise((r) => setTimeout(r, 20))
    asOperator(false)
    const res = await app.inject({
      method: 'POST',
      url: '/stop-all/push',
      payload: { token: pushes[0].stop_token }
    })
    expect(res.statusCode).toBe(403)
    expect(armedFaults()).toHaveLength(1)
    await app.close()
  })

  it('pushes again when a drill auto-aborts', async () => {
    const app = await build()
    const { run } = await startDrill({ fault_key: 'slow_requests', by: { id: ADA, name: 'Ada' } })
    await new Promise((r) => setTimeout(r, 20))
    pushes.length = 0
    await abortDrill(run.id, 'http.5xx_pct crossed 1 three times')
    await new Promise((r) => setTimeout(r, 20))
    expect(pushes).toEqual([
      expect.objectContaining({
        user: ADA,
        title: 'Chaos drill aborted: Slow requests',
        stop_token: expect.any(String)
      })
    ])
    await app.close()
  })
})
