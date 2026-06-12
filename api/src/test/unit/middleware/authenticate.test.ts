import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { cidrMatch } from '../../../middleware/authenticate.js'
import { makeAdminUser, makeRegularUser } from '../../helpers.js'

// ─── cidrMatch (pure, no DB) ──────────────────────────────────────────────────

describe('cidrMatch', () => {
  it('matches exact IP (treated as /32)', () => {
    expect(cidrMatch('192.168.1.1', '192.168.1.1')).toBe(true)
  })

  it('matches IP within a /24 subnet', () => {
    expect(cidrMatch('10.0.0.55', '10.0.0.0/24')).toBe(true)
  })

  it('does not match IP outside a /24 subnet', () => {
    expect(cidrMatch('10.0.1.55', '10.0.0.0/24')).toBe(false)
  })

  it('matches any IP for /0', () => {
    expect(cidrMatch('1.2.3.4', '0.0.0.0/0')).toBe(true)
  })

  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(cidrMatch('::ffff:192.168.1.1', '192.168.1.0/24')).toBe(true)
  })

  it('returns false for invalid IP', () => {
    expect(cidrMatch('not-an-ip', '10.0.0.0/8')).toBe(false)
  })

  it('returns false for invalid CIDR range', () => {
    expect(cidrMatch('10.0.0.1', 'not-a-cidr')).toBe(false)
  })

  it('returns false for out-of-range prefix length', () => {
    expect(cidrMatch('10.0.0.1', '10.0.0.0/33')).toBe(false)
  })
})

// ─── authenticate middleware (DB-mocked) ──────────────────────────────────────
//
// We test the authenticate function by building a minimal Fastify app that
// wires the middleware as a preHandler and hits it with inject().

import Fastify from 'fastify'
import { authenticate } from '../../../middleware/authenticate.js'

function buildApp() {
  const app = Fastify({ logger: false })

  // Minimal session shim expected by authenticate
  app.decorateRequest('session', null)
  app.addHook('onRequest', async (req) => {
    if (!(req as unknown as { session?: unknown }).session) {
      ;(req as unknown as { session: { userId: string | undefined; destroy: () => Promise<void> } }).session = {
        userId: undefined,
        destroy: async () => {},
      }
    }
  })

  // Decorate with fields authenticate writes to
  app.decorateRequest('user', null)
  app.decorateRequest('userRole', null)
  app.decorateRequest('isAdmin', false)

  app.get('/protected', { preHandler: authenticate }, async () => ({ ok: true }))
  return app
}

function mockDbSequence(results: unknown[]) {
  let callCount = 0
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation(() => {
    const result = results[callCount++] ?? null
    return {
      where: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(result),
      update: vi.fn().mockResolvedValue(1),
      catch: vi.fn(),
    } as unknown as ReturnType<typeof db>
  })
}

afterEach(() => vi.clearAllMocks())

describe('authenticate middleware', () => {
  it('returns 401 when no Authorization header and no session', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for Bearer token that is not a valid static_token', async () => {
    // DB returns null → token not found
    mockDbSequence([null])

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer invalid-token-xyz' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('authenticates successfully with a valid static Bearer token', async () => {
    const user = makeRegularUser({ static_token: 'valid-token-abc' })
    const role = { id: user.role, admin_access: false, app_access: true }
    mockDbSequence([user, role])

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer valid-token-abc' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it('authenticates successfully for an admin via static token', async () => {
    const user = makeAdminUser()
    const role = { id: user.role, admin_access: true, app_access: true }
    mockDbSequence([user, role])

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer admin-static-token' },
    })
    expect(res.statusCode).toBe(200)
  })
})
