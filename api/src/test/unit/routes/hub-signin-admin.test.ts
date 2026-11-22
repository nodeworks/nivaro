import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse
} from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: sign-in admin routes (/api/hub/signin). In-memory SQLite with the real
// hub tables. Hub admins manage everything; an app owner manages only their own app's sign-in
// (anything else answers 404); key rotation is admin-only. A client secret is shown once, on
// create or rotate, and never reaches a log, an activity row or a later read.

vi.hoisted(() => {
  process.env.PUBLIC_URL = 'https://hub.example.com/ignored/path'
  process.env.OIDC_CLIENT_ID = 'hub-entra-client-id'
})

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
// Activity rows land in a real nivaro_activity table so the test can read every stored column.
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (opts: Record<string, unknown>) => {
    const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
    const { req: _req, changed_fields, ...rest } = opts
    await db('nivaro_activity').insert({
      action: rest.action ?? null,
      user: rest.user ?? null,
      collection: rest.collection ?? null,
      item: rest.item ?? null,
      comment: rest.comment ?? null,
      extra: JSON.stringify({ changed_fields: changed_fields ?? null })
    })
    return 1
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up550 } = await import('../../../db/migrations/550_hub_oidc.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { hubSigninAdminRoutes } = await import('../../../routes/hub-signin-admin.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { _resetHubKeysForTests } = await import('../../../services/hub/oidc/keys.js')
const { environmentForLinkToken, tokenLookupHash, _resetLinkTokenForTests } = await import(
  '../../../services/hub/link-token.js'
)
const { findClient, clientSecretMatches } = await import('../../../services/hub/oidc/clients.js')
const { isEncrypted } = await import('../../../services/encryption.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'
const KEY = 'a'.repeat(64)
const MASK = '••••••'

const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = KEY
  await up542(db)
  await up550(db)
  await up551(db)
  await db.schema.createTable('nivaro_activity', (t) => {
    t.increments('id')
    t.string('action')
    t.string('user')
    t.string('collection')
    t.string('item')
    t.text('comment')
    t.text('extra')
  })
  app = Fastify()
  app.decorate('redis', { get: vi.fn(), set: vi.fn(), del: vi.fn(async () => 1) } as never)
  await app.register(hubRoutes, { prefix: '/hub' })
  await app.register(hubSigninAdminRoutes, { prefix: '/hub/signin' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY
  for (const t of [
    'nivaro_hub_signins',
    'nivaro_hub_oidc_clients',
    'nivaro_hub_oidc_keys',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps',
    'nivaro_activity'
  ])
    await db(t).del()
  _resetHubKeysForTests()
  _resetLinkTokenForTests()
})

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: unknown
): Promise<LightMyRequestResponse> => {
  const opts: InjectOptions = { method, url, headers }
  if (payload !== undefined) opts.payload = payload as InjectOptions['payload']
  return app.inject(opts)
}

/** App `key` with one production environment; `owner` owns it when given. */
async function seed(key: string, owner?: string) {
  const [appId] = await db('nivaro_hub_apps').insert({
    key,
    name: key.toUpperCase(),
    signin_mode: 'direct',
    adopted: false,
    extensions: '[]'
  })
  const [envId] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'production',
    position: 0,
    status: 'active',
    base_url: `https://${key}.example.com`,
    hostnames: JSON.stringify([`${key}2.example.com`])
  })
  if (owner) await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: owner })
  return { appId: Number(appId), envId: Number(envId) }
}

async function activityText(): Promise<string> {
  return JSON.stringify(await db('nivaro_activity').select('*'))
}

describe('GET /settings', () => {
  it('issuer + idp audience for anyone signed in; keys only for admins', async () => {
    const a = await req('GET', '/hub/signin/settings', asAdmin)
    expect(a.statusCode).toBe(200)
    expect(a.json().data).toMatchObject({
      issuer: 'https://hub.example.com/api/hub/oidc',
      idp_audience: 'hub-entra-client-id'
    })
    expect(Array.isArray(a.json().data.keys)).toBe(true)
    const o = await req('GET', '/hub/signin/settings', asOwner)
    expect(o.statusCode).toBe(200)
    expect(o.json().data.keys).toBeNull()
    expect((await req('GET', '/hub/signin/settings', {})).statusCode).toBe(401)
  })
})

describe('POST /keys/rotate', () => {
  it('admin rotates → kid, logged; the keys list shows it active', async () => {
    const r = await req('POST', '/hub/signin/keys/rotate', asAdmin)
    expect(r.statusCode).toBe(200)
    const kid = r.json().data.kid as string
    expect(kid).toBeTruthy()
    const s = await req('GET', '/hub/signin/settings', asAdmin)
    const keys = s.json().data.keys as Array<{ kid: string; active: boolean }>
    expect(keys.find((k) => k.active)?.kid).toBe(kid)
    expect(JSON.stringify(keys)).not.toMatch(/"d"|enc:/)
    const rows = await db('nivaro_activity').where({ action: 'hub-signin-key-rotate' })
    expect(rows).toHaveLength(1)
  })

  it('non-admin → 403, nothing rotated', async () => {
    await seed('efp', OWNER)
    const r = await req('POST', '/hub/signin/keys/rotate', asOwner)
    expect(r.statusCode).toBe(403)
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 0 }])
  })
})

describe('PATCH /apps/:id/mode', () => {
  it('owner switches their app; logged', async () => {
    const { appId } = await seed('efp', OWNER)
    const r = await req('PATCH', `/hub/signin/apps/${appId}/mode`, asOwner, { signin_mode: 'hub' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.signin_mode).toBe('hub')
    expect((await db('nivaro_hub_apps').where({ id: appId }).first()).signin_mode).toBe('hub')
    expect(await db('nivaro_activity').where({ action: 'hub-signin-mode' })).toHaveLength(1)
  })

  it('bad mode → 400 BAD_SIGNIN_MODE; someone else’s app → 404; unknown → 404', async () => {
    const { appId } = await seed('efp', OWNER)
    const other = await seed('beta')
    const bad = await req('PATCH', `/hub/signin/apps/${appId}/mode`, asOwner, {
      signin_mode: 'sso'
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_SIGNIN_MODE')
    expect(
      (await req('PATCH', `/hub/signin/apps/${other.appId}/mode`, asOwner, { signin_mode: 'hub' }))
        .statusCode
    ).toBe(404)
    expect(
      (await req('PATCH', `/hub/signin/apps/${appId}/mode`, asOther, { signin_mode: 'hub' }))
        .statusCode
    ).toBe(404)
    expect(
      (await req('PATCH', '/hub/signin/apps/99999/mode', asAdmin, { signin_mode: 'hub' }))
        .statusCode
    ).toBe(404)
    expect(
      (await req('PATCH', '/hub/signin/apps/abc/mode', asAdmin, { signin_mode: 'hub' })).statusCode
    ).toBe(404)
    expect((await db('nivaro_hub_apps').where({ id: other.appId }).first()).signin_mode).toBe(
      'direct'
    )
  })
})

describe('environment clients', () => {
  it('create shows the secret once (201, no-store); the row is sealed; GET masks it', async () => {
    const { envId } = await seed('efp', OWNER)
    const before = await req('GET', `/hub/signin/environments/${envId}/client`, asOwner)
    expect(before.statusCode).toBe(200)
    expect(before.json().data).toMatchObject({
      client: null,
      env_lines: {
        HUB_URL: 'https://hub.example.com',
        HUB_CLIENT_ID: null,
        HUB_IDP_AUDIENCE: 'hub-entra-client-id'
      },
      signins_30d: 0
    })

    const c = await req('POST', `/hub/signin/environments/${envId}/client`, asOwner)
    expect(c.statusCode).toBe(201)
    expect(c.headers['cache-control']).toBe('no-store')
    const { client_id, client_secret, env_lines } = c.json().data
    expect(client_id).toMatch(/^hubc_[0-9a-f]{24}$/)
    expect(client_secret).toMatch(/^hubs_/)
    expect(env_lines).toEqual({
      HUB_URL: 'https://hub.example.com',
      HUB_CLIENT_ID: client_id,
      HUB_IDP_AUDIENCE: 'hub-entra-client-id'
    })
    const row = await db('nivaro_hub_oidc_clients').where({ environment_id: envId }).first()
    expect(isEncrypted(row.client_secret)).toBe(true)

    const g = await req('GET', `/hub/signin/environments/${envId}/client`, asOwner)
    expect(g.statusCode).toBe(200)
    const data = g.json().data
    expect(data.client).toMatchObject({
      client_id,
      active: true,
      secret: MASK,
      redirect_uris: [
        'https://efp.example.com/api/auth/callback',
        'https://efp2.example.com/api/auth/callback'
      ],
      post_logout_uris: ['https://efp.example.com/login', 'https://efp2.example.com/login'],
      secret_rotated_at: null
    })
    expect(typeof data.client.created_at).toBe('string')
    expect(data.env_lines.HUB_CLIENT_ID).toBe(client_id)
    expect(g.body).not.toContain(client_secret)
    expect(g.body).not.toContain(row.client_secret)

    // No activity row, in any column, holds the secret (plain or sealed).
    const acts = await activityText()
    expect(acts).toContain('hub-signin-client-create')
    expect(acts).not.toContain(client_secret)
    expect(acts).not.toContain(client_secret.slice(5))
    expect(acts).not.toContain(row.client_secret)
    const createRow = await db('nivaro_activity')
      .where({ action: 'hub-signin-client-create' })
      .first()
    expect(createRow.collection).toBe('nivaro_hub_oidc_clients')
  })

  it('a second create → 409 CLIENT_EXISTS', async () => {
    const { envId } = await seed('efp', OWNER)
    expect(
      (await req('POST', `/hub/signin/environments/${envId}/client`, asAdmin)).statusCode
    ).toBe(201)
    const again = await req('POST', `/hub/signin/environments/${envId}/client`, asAdmin)
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('CLIENT_EXISTS')
    expect(again.body).not.toMatch(/hubs_/)
  })

  it('rotate: a new secret once; the old one stops matching; nothing logged in plain', async () => {
    const { envId } = await seed('efp', OWNER)
    const c = (await req('POST', `/hub/signin/environments/${envId}/client`, asOwner)).json().data
    const r = await req('POST', `/hub/signin/environments/${envId}/client/rotate`, asOwner)
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    const fresh = r.json().data.client_secret as string
    expect(fresh).toMatch(/^hubs_/)
    expect(fresh).not.toBe(c.client_secret)
    const client = (await findClient(c.client_id))!
    expect(clientSecretMatches(client, c.client_secret)).toBe(false)
    expect(clientSecretMatches(client, fresh)).toBe(true)
    const acts = await activityText()
    expect(acts).toContain('hub-signin-client-rotate')
    expect(acts).not.toContain(fresh)
    expect(acts).not.toContain(c.client_secret)
    const g = await req('GET', `/hub/signin/environments/${envId}/client`, asOwner)
    expect(g.json().data.client.secret_rotated_at).toEqual(expect.any(String))
    expect(g.body).not.toContain(fresh)
  })

  it('PATCH {active} toggles and logs; a non-boolean → 400', async () => {
    const { envId } = await seed('efp', OWNER)
    await req('POST', `/hub/signin/environments/${envId}/client`, asOwner)
    const off = await req('PATCH', `/hub/signin/environments/${envId}/client`, asOwner, {
      active: false
    })
    expect(off.statusCode).toBe(200)
    expect(off.json().data.client.active).toBe(false)
    expect(await db('nivaro_activity').where({ action: 'hub-signin-client-toggle' })).toHaveLength(
      1
    )
    const bad = await req('PATCH', `/hub/signin/environments/${envId}/client`, asOwner, {
      active: 'no'
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_ACTIVE')
  })

  it('rotate / toggle without a client → 404', async () => {
    const { envId } = await seed('efp', OWNER)
    expect(
      (await req('POST', `/hub/signin/environments/${envId}/client/rotate`, asOwner)).statusCode
    ).toBe(404)
    expect(
      (await req('PATCH', `/hub/signin/environments/${envId}/client`, asOwner, { active: true }))
        .statusCode
    ).toBe(404)
  })

  it('the owner of app A gets 404 on every client route of app B’s environment', async () => {
    await seed('alpha', OWNER)
    const b = await seed('beta')
    await req('POST', `/hub/signin/environments/${b.envId}/client`, asAdmin)
    const routes: Array<['GET' | 'POST' | 'PATCH', string, unknown?]> = [
      ['GET', `/hub/signin/environments/${b.envId}/client`],
      ['POST', `/hub/signin/environments/${b.envId}/client`],
      ['POST', `/hub/signin/environments/${b.envId}/client/rotate`],
      ['PATCH', `/hub/signin/environments/${b.envId}/client`, { active: false }]
    ]
    for (const [m, url, payload] of routes) {
      const r = await req(m, url, asOwner, payload)
      expect(r.statusCode).toBe(404)
      expect(r.body).not.toMatch(/hubs_|hubc_/)
    }
    const row = await db('nivaro_hub_oidc_clients').where({ environment_id: b.envId }).first()
    expect(row.active).toBeTruthy()
    expect(row.secret_rotated_at).toBeNull()
    expect((await req('GET', '/hub/signin/environments/99999/client', asAdmin)).statusCode).toBe(
      404
    )
    expect((await req('GET', '/hub/signin/environments/0/client', asAdmin)).statusCode).toBe(404)
  })

  it('signins_30d counts recent sign-ins of that environment only', async () => {
    const { appId, envId } = await seed('efp', OWNER)
    const other = await seed('beta')
    const old = new Date(Date.now() - 40 * 86_400_000)
    const recent = new Date(Date.now() - 2 * 86_400_000)
    // Every row names its times: a multi-row insert on SQLite fills absent columns with NULL.
    const seen = { first_seen: recent, last_seen: recent }
    await db('nivaro_hub_signins').insert([
      { identity_key: 'email:a@x', app_id: appId, environment_id: envId, via: 'hub', ...seen },
      { identity_key: 'email:b@x', app_id: appId, environment_id: envId, via: 'direct', ...seen },
      {
        identity_key: 'email:c@x',
        app_id: appId,
        environment_id: envId,
        via: 'hub',
        first_seen: old,
        last_seen: old
      },
      {
        identity_key: 'email:a@x',
        app_id: other.appId,
        environment_id: other.envId,
        via: 'hub',
        ...seen
      }
    ])
    const g = await req('GET', `/hub/signin/environments/${envId}/client`, asOwner)
    expect(g.json().data.signins_30d).toBe(2)
  })
})

describe('hub token writes keep the lookup in step (routes/hub.ts)', () => {
  const TOKEN = 'link-token-0123456789abcdefghijklmnop'

  it('create stores the lookup; patch rotates it; the mask keeps it; clear empties it', async () => {
    const [appId] = await db('nivaro_hub_apps').insert({
      key: 'efp',
      name: 'EFP',
      signin_mode: 'direct',
      adopted: false,
      extensions: '[]'
    })
    const c = await req('POST', `/hub/apps/${appId}/environments`, asAdmin, {
      key: 'production',
      base_url: 'https://efp.example.com',
      hub_token: TOKEN
    })
    expect(c.statusCode).toBe(200)
    const envId = c.json().data.id as number
    expect(c.body).not.toContain(tokenLookupHash(TOKEN))
    const lookup = async () =>
      (await db('nivaro_hub_environments').where({ id: envId }).first()).hub_token_lookup
    expect(await lookup()).toBe(tokenLookupHash(TOKEN))
    expect(await environmentForLinkToken(TOKEN)).toMatchObject({ environment_id: envId })

    await req('PATCH', `/hub/environments/${envId}`, asAdmin, { hub_token: MASK })
    expect(await lookup()).toBe(tokenLookupHash(TOKEN))
    await req('PATCH', `/hub/environments/${envId}`, asAdmin, { position: 3 })
    expect(await lookup()).toBe(tokenLookupHash(TOKEN))

    await req('PATCH', `/hub/environments/${envId}`, asAdmin, { hub_token: `${TOKEN}-2` })
    expect(await lookup()).toBe(tokenLookupHash(`${TOKEN}-2`))
    expect(await environmentForLinkToken(TOKEN)).toBeNull()
    expect(await environmentForLinkToken(`${TOKEN}-2`)).toMatchObject({ environment_id: envId })

    await req('PATCH', `/hub/environments/${envId}`, asAdmin, { hub_token: '' })
    expect(await lookup()).toBeNull()
    expect(await environmentForLinkToken(`${TOKEN}-2`)).toBeNull()

    const none = await req('POST', `/hub/apps/${appId}/environments`, asAdmin, {
      key: 'staging',
      base_url: 'https://efp-staging.example.com'
    })
    expect(
      (await db('nivaro_hub_environments').where({ id: none.json().data.id }).first())
        .hub_token_lookup
    ).toBeNull()
  })
})
