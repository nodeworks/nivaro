import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same route-harness idiom as transition-role-gating.test.ts /
// integration-obligations.test.ts: mock the admin gate + db module before
// importing the route so `/integration-partners/:id`'s id-validation branch
// is reachable with no real auth/DB stack. `db` is a bare stub — the
// validation tests below reject before `buildCards()` ever calls it.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  healthWord,
  hourBuckets,
  integrationPartnersRoutes,
  percentile
} from '../../../routes/integration-partners.js'

describe('percentile', () => {
  it('nearest-rank on a sorted list', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20)
    expect(percentile([10, 20, 30, 40], 95)).toBe(40)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('healthWord', () => {
  const t = (m: number) => new Date(Date.now() - m * 60_000)
  it('healthy needs a success after the last failure', () => {
    expect(
      healthWord({
        calls24: 10,
        failures24: 1,
        lastOkAt: t(1),
        lastFailAt: t(5),
        authFailing: false
      })
    ).toBe('healthy')
    expect(
      healthWord({
        calls24: 10,
        failures24: 1,
        lastOkAt: t(5),
        lastFailAt: t(1),
        authFailing: false
      })
    ).toBe('failing')
  })
  it('degraded when failures are frequent but it still lands; idle with no calls; auth wins', () => {
    expect(
      healthWord({
        calls24: 10,
        failures24: 4,
        lastOkAt: t(1),
        lastFailAt: t(2),
        authFailing: false
      })
    ).toBe('degraded')
    expect(
      healthWord({
        calls24: 0,
        failures24: 0,
        lastOkAt: null,
        lastFailAt: null,
        authFailing: false
      })
    ).toBe('idle')
    expect(
      healthWord({ calls24: 5, failures24: 1, lastOkAt: t(1), lastFailAt: t(2), authFailing: true })
    ).toBe('failing')
  })
})

describe('hourBuckets', () => {
  it('fills every hour, oldest first', () => {
    const now = new Date('2026-09-23T12:30:00Z')
    const b = hourBuckets(
      [
        { created_at: new Date('2026-09-23T12:05:00Z'), ok: true },
        { created_at: new Date('2026-09-23T11:10:00Z'), ok: false }
      ],
      now,
      3
    )
    expect(b.map((x) => [x.hour, x.ok, x.failed])).toEqual([
      ['2026-09-23T10', 0, 0],
      ['2026-09-23T11', 0, 1],
      ['2026-09-23T12', 1, 0]
    ])
  })
})

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(integrationPartnersRoutes)
  return app
}

afterEach(() => {
  vi.clearAllMocks()
})

// Review round 1: `Number(params.id)` was never validated, so a non-numeric
// id (NaN) or `0` — both falsy — made `buildCards`'s old `if (onlyId)` filter
// checks skip entirely, silently returning the FIRST partner's card as a 200
// instead of rejecting the request. Every case here resolves before
// `buildCards()` ever touches the mocked `db` stub, so these are true
// isolated unit tests of the validation branch, not integration tests of the
// query path.
describe('GET /integration-partners/:id — id validation', () => {
  it('rejects a non-numeric id with 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/abc' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid id' })
  })

  it('rejects id=0 with 400 — 0 is falsy but not a valid id', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/0' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a negative id with 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/-1' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a non-integer id with 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/1.5' })
    expect(res.statusCode).toBe(400)
  })
})
