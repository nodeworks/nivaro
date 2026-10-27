import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  adminRefusal,
  authenticate,
  credentialMintRefusal,
  delegatedWriteRefusal,
  resetAdminRecheckCache,
  tenantTagRefused
} from '../../../middleware/authenticate.js'

// Security audit H3 + auth Lows: a lasting credential is minted only by a person signed in as
// themselves; a View-as / run-as-key cannot write to credential routes; and its token stops
// working once the admin who started it is no longer an active administrator.

const req = (r: Partial<FastifyRequest> & Record<string, unknown>) => r as unknown as FastifyRequest

describe('credentialMintRefusal', () => {
  it('allows a session or the person’s own static token', () => {
    expect(credentialMintRefusal(req({ authMethod: 'session' }))).toBe(null)
    expect(credentialMintRefusal(req({ authMethod: 'token' }))).toBe(null)
  })

  it('refuses API keys, connected apps, View-as and run-as-key', () => {
    expect(credentialMintRefusal(req({ authMethod: 'api_key' }))?.code).toBe(
      'CREDENTIAL_MINT_REFUSED'
    )
    expect(credentialMintRefusal(req({ authMethod: 'oauth' }))?.code).toBe(
      'CREDENTIAL_MINT_REFUSED'
    )
    expect(credentialMintRefusal(req({ authMethod: 'teams' }))?.code).toBe(
      'CREDENTIAL_MINT_REFUSED'
    )
    expect(credentialMintRefusal(req({ authMethod: 'masquerade' }))?.code).toBe(
      'NOT_WHILE_MASQUERADING'
    )
    expect(credentialMintRefusal(req({ authMethod: 'key_sim' }))?.code).toBe(
      'NOT_WHILE_MASQUERADING'
    )
  })
})

describe('adminRefusal', () => {
  it('needs an admin whose key (if any) is not narrowed', () => {
    expect(adminRefusal(req({ isAdmin: true, user: { id: 'a' } as never }))).toBe(null)
    expect(adminRefusal(req({ isAdmin: false }))?.code).toBe('ADMIN_ONLY')
    expect(
      adminRefusal(
        req({ isAdmin: true, user: { id: 'a', api_key_scopes: [{ collection: 'x' }] } as never })
      )?.code
    ).toBe('API_KEY_SCOPE_MISSING')
  })
})

describe('delegatedWriteRefusal', () => {
  const r = (method: string, url: string) => req({ method, url })
  it('refuses credential writes, allows reads and ending the View-as', () => {
    expect(delegatedWriteRefusal(r('POST', '/api/api-keys'))).not.toBe(null)
    expect(delegatedWriteRefusal(r('POST', '/api/users/me/token'))).not.toBe(null)
    expect(delegatedWriteRefusal(r('POST', '/api/%75sers/abc/token'))).not.toBe(null)
    expect(delegatedWriteRefusal(r('POST', '/api/auth/masquerade'))).not.toBe(null)
    expect(delegatedWriteRefusal(r('DELETE', '/api/auth/masquerade'))).toBe(null)
    expect(delegatedWriteRefusal(r('GET', '/api/api-keys'))).toBe(null)
    expect(delegatedWriteRefusal(r('PATCH', '/api/items/orders/1'))).toBe(null)
  })
})

describe('tenantTagRefused', () => {
  afterEach(() => {
    delete process.env.CLOUD_META_DB_URL
  })
  it('self-hosted: a record without a tenant works, one naming a tenant does not', () => {
    expect(tenantTagRefused(undefined)).toBe(false)
    expect(tenantTagRefused('')).toBe(false)
    expect(tenantTagRefused('tenant-b')).toBe(true)
  })
  it('cloud: a record without a tenant is refused', () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(tenantTagRefused(undefined)).toBe(true)
    expect(tenantTagRefused('tenant-b')).toBe(true)
  })
})

describe('View-as token with a demoted issuer', () => {
  function app(adminIsAdmin: boolean, masqTenant?: string) {
    // nivaro_users: the target (any id) / the issuing admin; nivaro_roles: the role rows.
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      let id: unknown
      const c: Record<string, unknown> = {}
      for (const m of ['whereNull', 'orWhere', 'select', 'orderBy']) c[m] = () => c
      c.where = (arg: unknown) => {
        id = (arg as { id?: unknown } | null)?.id
        return c
      }
      c.first = async () => {
        if (table === 'nivaro_users')
          return id === 'ADM'
            ? { id: 'ADM', role: 'R-ADMIN', status: 'active', is_redacted: false }
            : { id: 'TARGET', role: 'R-USER', status: 'active' }
        if (table === 'nivaro_roles')
          return id === 'R-ADMIN'
            ? { id: 'R-ADMIN', admin_access: adminIsAdmin, app_access: true }
            : { id: 'R-USER', admin_access: false, app_access: true }
        return null
      }
      c.update = () => ({ catch: () => undefined })
      return c
    })
    const a = Fastify({ logger: false })
    a.decorate('redis', {
      get: async (k: string) =>
        k.startsWith('masq:')
          ? JSON.stringify({
              user_id: 'TARGET',
              admin_id: 'ADM',
              ...(masqTenant ? { t: masqTenant } : {})
            })
          : null,
      set: async () => 'OK'
    } as never)
    a.decorateRequest('session', null as never)
    a.addHook('onRequest', async (r) => {
      ;(r as unknown as { session: unknown }).session = { destroy: async () => {} }
    })
    a.get('/api/x', { preHandler: authenticate }, async (r) => ({ id: r.user?.id }))
    a.post('/api/api-keys', { preHandler: authenticate }, async () => ({ ok: true }))
    return a
  }

  afterEach(() => {
    resetAdminRecheckCache()
    vi.clearAllMocks()
  })

  it('works while the issuer is an admin', async () => {
    const res = await app(true).inject({
      method: 'GET',
      url: '/api/x',
      headers: { authorization: 'Bearer nvm_abc' }
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).id).toBe('TARGET')
  })

  it('stops once the issuer is no longer an admin', async () => {
    const res = await app(false).inject({
      method: 'GET',
      url: '/api/x',
      headers: { authorization: 'Bearer nvm_abc' }
    })
    expect(res.statusCode).toBe(401)
  })

  it('a View-as minted for another tenant does not sign in', async () => {
    const res = await app(true, 'tenant-other').inject({
      method: 'GET',
      url: '/api/x',
      headers: { authorization: 'Bearer nvm_abc' }
    })
    expect(res.statusCode).toBe(401)
  })

  it('cannot mint an API key while viewing as someone', async () => {
    const res = await app(true).inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { authorization: 'Bearer nvm_abc' }
    })
    expect(res.statusCode).toBe(403)
  })
})
