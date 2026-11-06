import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { authenticate, requireAuth } from '../../../middleware/authenticate.js'
import {
  accessPendingRouteAllowed,
  resetAccessPendingCache
} from '../../../services/access-pending.js'

// Army 4 review B1: a person still in the new-user flow (First Access / Needs Authorization,
// judged by nivaro_settings.new_user_role / access_request_role) could run every
// `authenticated` custom query, GraphQL and the extension routes unscoped. authenticate now
// refuses them 403 ACCESS_PENDING everywhere except what the Request-access screen calls.

const START = 'AAAAAAAA-0000-4000-8000-00000000000A'
const REVIEW = 'BBBBBBBB-0000-4000-8000-00000000000B'
const REAL = 'CCCCCCCC-0000-4000-8000-00000000000C'

const h = vi.hoisted(() => ({
  users: {} as Record<string, Record<string, unknown>>,
  settings: null as Record<string, unknown> | null,
  settingsReads: 0
}))

function wireDb() {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
    let where: Record<string, unknown> = {}
    const c: Record<string, unknown> = {}
    c.where = vi.fn((w: Record<string, unknown>) => {
      where = w ?? {}
      return c
    })
    c.update = vi.fn(async () => 1)
    c.catch = vi.fn()
    c.first = vi.fn(async () => {
      if (table === 'nivaro_users') {
        const tok = where.static_token as string | undefined
        return tok ? (h.users[tok] ?? null) : null
      }
      if (table === 'nivaro_roles') {
        const id = String(where.id ?? '')
        return { id, admin_access: id === 'ADMIN-ROLE', app_access: true }
      }
      if (table === 'nivaro_settings') {
        h.settingsReads++
        return h.settings
      }
      return null
    })
    return c
  })
}

function user(token: string, role: string, extra: Record<string, unknown> = {}) {
  h.users[token] = {
    id: `U-${token}`,
    email: `${token}@example.test`,
    status: 'active',
    role,
    static_token: token,
    ...extra
  }
}

function buildApp() {
  const app = Fastify({ logger: false })
  // @ts-expect-error — test shim
  app.decorateRequest('session', null)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: unknown }).session = {
      userId: undefined,
      destroy: async () => {}
    }
  })
  // @ts-expect-error
  app.decorateRequest('user', null)
  app.decorateRequest('userRole', null)
  app.decorateRequest('isAdmin', false)
  const ok = async () => ({ ok: true })
  // Core and extension routes behind requireAuth / authenticate.
  app.get('/api/items/:collection', { preHandler: authenticate }, ok)
  app.get('/api/efp/forecast/summary', { preHandler: requireAuth }, ok)
  app.get('/api/auth/me', { preHandler: authenticate }, ok)
  app.get('/api/auth/ws-token', { preHandler: requireAuth }, ok)
  app.post('/api/users/me/access-request', { preHandler: authenticate }, ok)
  app.patch('/api/users/me/preferences', { preHandler: authenticate }, ok)
  app.get('/api/announcements/active', { preHandler: requireAuth }, ok)
  app.post('/api/issues/client', { preHandler: requireAuth }, ok)
  app.post('/api/items/:collection', { preHandler: authenticate }, ok)
  // The optional sign-in pattern (GraphQL, custom query execute, maintenance hook): the
  // caught refusal must leave NO identity on the request.
  app.get('/api/optional', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await authenticate(req, reply)
    } catch {
      /* anonymous */
    }
    return { user: req.user?.id ?? null, admin: !!req.isAdmin }
  })
  return app
}

const as = (token: string) => ({ Authorization: `Bearer ${token}` })

beforeEach(() => {
  resetAccessPendingCache()
  h.users = {}
  h.settings = { new_user_role: START, access_request_role: REVIEW }
  h.settingsReads = 0
  user('first', START)
  user('review', REVIEW)
  user('normal', REAL)
  user('admin', 'ADMIN-ROLE')
  wireDb()
})
afterEach(() => vi.clearAllMocks())

describe('access-pending gate (army 4 B1)', () => {
  it('refuses a First Access person on items, an extension route and anything off the list', async () => {
    const app = buildApp()
    for (const url of ['/api/items/workflows', '/api/efp/forecast/summary', '/api/optional']) {
      const res = await app.inject({ method: 'GET', url, headers: as('first') })
      if (url === '/api/optional') {
        // caught by the route: it carries on as an ANONYMOUS caller, never as the person
        expect(res.json()).toEqual({ user: null, admin: false })
        continue
      }
      expect(res.statusCode, url).toBe(403)
      expect(res.json()).toMatchObject({ code: 'ACCESS_PENDING' })
    }
  })

  it('refuses a Needs Authorization person the same way', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/workflows?limit=5',
      headers: as('review')
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'ACCESS_PENDING' })
  })

  it('lets the Request-access screen through', async () => {
    const app = buildApp()
    const calls: Array<[string, string]> = [
      ['GET', '/api/auth/me'],
      ['GET', '/api/auth/ws-token'],
      ['POST', '/api/users/me/access-request'],
      ['PATCH', '/api/users/me/preferences'],
      ['GET', '/api/items/divisions?limit=200'],
      ['GET', '/api/items/vendors?sort=name,id&fields=id,name&limit=500&offset=0'],
      ['GET', '/api/announcements/active'],
      ['POST', '/api/issues/client']
    ]
    for (const [method, url] of calls) {
      const res = await app.inject({ method: method as 'GET', url, headers: as('first') })
      expect(res.statusCode, `${method} ${url}`).toBe(200)
    }
  })

  it('reads the picker collections only — no writes to them', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/vendors',
      headers: as('first')
    })
    expect(res.statusCode).toBe(403)
  })

  it('leaves a normal person and an administrator alone', async () => {
    const app = buildApp()
    for (const token of ['normal', 'admin']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/items/workflows',
        headers: as(token)
      })
      expect(res.statusCode, token).toBe(200)
    }
  })

  it('an administrator on a flow role is never pending', async () => {
    h.settings = { new_user_role: 'ADMIN-ROLE', access_request_role: REVIEW }
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/workflows',
      headers: as('admin')
    })
    expect(res.statusCode).toBe(200)
  })

  it('reads the flow settings once per window, not per request', async () => {
    const app = buildApp()
    for (let i = 0; i < 5; i++)
      await app.inject({ method: 'GET', url: '/api/items/workflows', headers: as('normal') })
    expect(h.settingsReads).toBe(1)
  })

  it('no flow configured = nobody is pending', async () => {
    h.settings = null
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/workflows',
      headers: as('first')
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('accessPendingRouteAllowed', () => {
  it('matches exact paths and methods; variants are refused', () => {
    expect(accessPendingRouteAllowed('GET', '/api/items/divisions')).toBe(true)
    expect(accessPendingRouteAllowed('GET', '/api/items/divisions/')).toBe(true)
    expect(accessPendingRouteAllowed('GET', '/api/items/divisions/5')).toBe(false)
    expect(accessPendingRouteAllowed('PATCH', '/api/items/divisions')).toBe(false)
    expect(accessPendingRouteAllowed('GET', '/api/items/divisionsX')).toBe(false)
    expect(accessPendingRouteAllowed('POST', '/api/custom-queries/forecast-grid/execute')).toBe(
      false
    )
    expect(accessPendingRouteAllowed('POST', '/api/graphql')).toBe(false)
    expect(accessPendingRouteAllowed('POST', '/api/mcp')).toBe(false)
    expect(accessPendingRouteAllowed('GET', '/api/users/me/stats')).toBe(false)
    expect(accessPendingRouteAllowed('POST', '/api/auth/logout')).toBe(true)
    expect(accessPendingRouteAllowed('DELETE', '/api/auth/masquerade')).toBe(true)
    expect(accessPendingRouteAllowed('GET', '/api/authx/me')).toBe(false)
  })
})
