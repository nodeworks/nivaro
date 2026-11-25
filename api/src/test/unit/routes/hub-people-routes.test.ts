import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub people directory + "Offboard everywhere" (routes/hub-people.ts,
// services/hub/people/*). Real SQLite for the Hub tables; the calls to the apps (link-calls.ts),
// the user service and the session store are mocked — no app is ever contacted.

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
const m = vi.hoisted(() => ({
  logActivity: vi.fn(async (..._a: unknown[]) => null),
  call: vi.fn(),
  revoke: vi.fn(async (..._a: unknown[]) => 1)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))
vi.mock('../../../services/hub/promote-run.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/promote-run.js')>()),
  recoverOnceAtBoot: vi.fn()
}))
vi.mock('../../../services/hub/people/link-calls.js', () => ({
  peopleTargetOf: vi.fn(async (env: { id: number; hub_token?: string | null; base_url: string }) =>
    env.hub_token
      ? { kind: 'dedicated', envId: env.id, base_url: env.base_url, token: env.hub_token }
      : null
  ),
  callPeople: m.call
}))
vi.mock('../../../auth/session.js', () => ({ revokeUserSessions: m.revoke }))
vi.mock('../../../services/users.js', async () => {
  const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
  return {
    updateUser: vi.fn(async (id: string, data: Record<string, unknown>) => {
      await db('nivaro_users').where({ id }).update(data)
    })
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m551 = await import('../../../db/migrations/551_hub_signins.js')
const m570 = await import('../../../db/migrations/570_hub_people_owner_policy.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { hubSigninBlocked, readOffboard } = await import('../../../services/hub/people/offboard.js')
const { assertEmailNotOffboarded, emailOffboarded } = await import(
  '../../../services/hub/people/block.js'
)
const { groupPeople } = await import('../../../services/hub/people/directory.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const ADMIN2 = 'AAAAAAAA-0000-4000-8000-000000000009'
const DANA = 'DDDDDDDD-0000-4000-8000-000000000004'
const VICTIM = 'VVVVVVVV-0000-4000-8000-000000000006'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': 'BBBBBBBB-0000-4000-8000-000000000002' }
const ADMIN_ROLE = '0A000000-0000-4000-8000-000000000001'

let app: FastifyInstance
let prevHub: string | undefined
let envA: number
let envB: number
let envC: number

const idOf = (r: unknown) => {
  const x = (r as Array<number | { id: number }>)[0]
  return typeof x === 'object' ? x.id : x
}

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  for (const mig of [m542, m543, m551, m570]) await mig.up(db)
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id').primary()
    t.boolean('admin_access')
    t.dateTime('created_at')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
    t.string('role')
    t.string('status')
    t.string('account_kind')
    t.string('entra_oid')
    t.string('entra_tid')
    t.dateTime('updated_at')
    t.dateTime('created_at')
  })
  app = Fastify()
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
})
beforeEach(async () => {
  vi.clearAllMocks()
  for (const t of [
    'nivaro_hub_offboards',
    'nivaro_hub_offboard_ids',
    'nivaro_hub_signins',
    'nivaro_hub_environments',
    'nivaro_hub_apps',
    'nivaro_users',
    'nivaro_roles'
  ])
    await db(t).del()
  await db('nivaro_roles').insert({ id: ADMIN_ROLE, admin_access: true })
  await db('nivaro_users').insert([
    { id: ADMIN, email: 'admin@x.io', role: ADMIN_ROLE, status: 'active' },
    { id: ADMIN2, email: 'admin2@x.io', role: ADMIN_ROLE, status: 'active' },
    {
      id: DANA,
      first_name: 'Dana',
      last_name: 'Doe',
      email: 'dana@x.io',
      status: 'active',
      entra_oid: 'oid-dana',
      entra_tid: 'tid-1'
    }
  ])
  const appRow = async (key: string) =>
    idOf(
      await db('nivaro_hub_apps')
        .insert({ key, name: key.toUpperCase(), signin_mode: 'hub', extensions: '[]' })
        .returning('id')
    )
  const efp = await appRow('efp')
  const pole = await appRow('pole')
  const env = async (appId: number, key: string, token: string | null) =>
    idOf(
      await db('nivaro_hub_environments')
        .insert({
          app_id: appId,
          key,
          base_url: `https://${key}.x.io`,
          hostnames: '[]',
          status: 'active',
          position: 0,
          hub_token: token
        })
        .returning('id')
    )
  envA = await env(efp, 'production', 'sealed-a')
  envB = await env(pole, 'production', 'sealed-b')
  envC = await env(pole, 'staging', null)
  await db('nivaro_hub_signins').insert([
    {
      identity_key: 'entra:tid-1:oid-dana',
      hub_user_id: DANA,
      email: 'dana@x.io',
      app_id: efp,
      environment_id: envA,
      via: 'hub',
      last_seen: new Date()
    },
    {
      identity_key: 'email:dana@x.io',
      hub_user_id: null,
      email: 'dana@x.io',
      app_id: pole,
      environment_id: envB,
      via: 'direct',
      last_seen: new Date()
    },
    {
      identity_key: 'email:eve@x.io',
      hub_user_id: null,
      email: 'eve@x.io',
      app_id: pole,
      environment_id: envB,
      via: 'direct',
      last_seen: new Date(Date.now() - 86_400_000)
    }
  ])
})

const call = (method: 'GET' | 'POST', p: string, headers: Record<string, string>, body?: unknown) =>
  app.inject({ method, url: `/api/hub${p}`, headers, payload: body as never })

/** POST offboard as the page does: with the identity hash the person read showed. */
async function offboard(key: string, headers: Record<string, string>, confirm: string) {
  const read = await call('GET', `/people/${key}`, asAdmin)
  return call('POST', `/people/${key}/offboard`, headers, {
    confirm,
    identity_hash: read.json().data?.identity_hash
  })
}

async function settled(id: number) {
  for (let i = 0; i < 100; i++) {
    const r = await readOffboard(id)
    if (r && r.status !== 'running') return r
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('offboard did not finish')
}

describe('directory', () => {
  it('groups sign-ins per person; a key a Hub account carries joins that account', async () => {
    const r = await call('GET', '/people', asAdmin)
    expect(r.statusCode).toBe(200)
    const { data, total } = r.json()
    expect(total).toBe(2)
    expect(data[0]).toMatchObject({ key: `u:${DANA}`, name: 'Dana Doe', email: 'dana@x.io' })
    expect(
      data[0].environments.map((e: { environment_id: number }) => e.environment_id).sort()
    ).toEqual([envA, envB].sort())
    expect(data[1].key).toMatch(/^k:\d+$/)
    expect((await call('GET', '/people?q=EVE', asAdmin)).json().total).toBe(1)
  })

  it('a key two Hub accounts carry belongs to neither (pure)', () => {
    const row = (id: number, key: string, user: string | null) => ({
      id,
      identity_key: key,
      hub_user_id: user,
      email: null,
      environment_id: 1,
      app_id: 1,
      via: 'hub',
      last_seen: null,
      env_key: 'p',
      app_key: 'a',
      app_name: 'A'
    })
    const g = groupPeople([
      row(1, 'email:x@y.z', 'U1'),
      row(2, 'email:x@y.z', 'U2'),
      row(3, 'email:x@y.z', null)
    ])
    expect([...g.keys()].sort()).toEqual(['k:1', 'u:U1', 'u:U2'])
  })

  it('admins only; an unknown or malformed key is 404', async () => {
    expect((await call('GET', '/people', asOwner)).statusCode).toBe(403)
    expect((await call('GET', `/people/u:${DANA}/access`, asOwner)).statusCode).toBe(403)
    expect((await call('POST', `/people/u:${DANA}/offboard`, asOwner, {})).statusCode).toBe(403)
    expect((await call('GET', '/people/dana@x.io', asAdmin)).statusCode).toBe(404)
    expect((await call('GET', '/people/k:999999', asAdmin)).statusCode).toBe(404)
  })

  it('person detail: exactly what would be suspended (proven only) + its hash, no app asked', async () => {
    const r = (await call('GET', `/people/u:${DANA}`, asAdmin)).json().data
    expect(r.identity).toEqual({
      emails: ['dana@x.io'],
      entra: [{ oid: 'oid-dana', tid: 'tid-1' }]
    })
    expect(r.identity_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.offboards).toEqual([])
    expect(m.call).not.toHaveBeenCalled()
  })
})

describe('access (live)', () => {
  it('asks every environment by email + Entra id; one with no link says so', async () => {
    m.call.mockImplementation(async (t: { envId: number }, op: string, ident: unknown) => {
      expect(op).toBe('lookup')
      expect(ident).toEqual({
        emails: ['dana@x.io'],
        entra: [{ oid: 'oid-dana', tid: 'tid-1' }]
      })
      return t.envId === envA
        ? {
            ok: true,
            accounts: [
              { user_id: 'x', status: 'active', role: 'Admin', admin: true, matched_by: 'entra' }
            ]
          }
        : { ok: false, code: 'LINK_UNREACHABLE', status: 0 }
    })
    const data = (await call('GET', `/people/u:${DANA}/access`, asAdmin)).json().data
    const by = (id: number) => data.find((d: { environment_id: number }) => d.environment_id === id)
    expect(by(envA)).toMatchObject({ state: 'account', accounts: [{ role: 'Admin' }] })
    expect(by(envB)).toMatchObject({ state: 'error', code: 'LINK_UNREACHABLE' })
    expect(by(envC)).toMatchObject({ state: 'no_link' })
  })
})

describe('offboard everywhere', () => {
  it('needs the typed email; suspends the Hub account at once and blocks Hub sign-in', async () => {
    m.call.mockResolvedValue({ ok: true, state: 'suspended', accounts: [{}] })
    const wrong = await offboard(`u:${DANA}`, asAdmin, 'dana')
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().code).toBe('CONFIRM_REQUIRED')
    expect(await hubSigninBlocked({ id: DANA })).toBe(false)

    // The confirm binds to what the page showed: a stale or missing hash is refused.
    const stale = await call('POST', `/people/u:${DANA}/offboard`, asAdmin, {
      confirm: 'dana@x.io',
      identity_hash: 'f'.repeat(64)
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({
      code: 'IDENTITY_CHANGED',
      identity: { emails: ['dana@x.io'] }
    })
    const r = await offboard(`u:${DANA}`, asAdmin, 'DANA@x.io')
    expect(r.statusCode).toBe(202)
    expect(r.json().data).toMatchObject({ hub_account: 'suspended', blocked: true })
    expect((await db('nivaro_users').where({ id: DANA }).first()).status).toBe('suspended')
    // Blocked by account, by email and by Entra id (an account made again is refused too).
    expect(await hubSigninBlocked({ id: DANA })).toBe(true)
    expect(await hubSigninBlocked({ id: 'other', email: ' Dana@X.io ' })).toBe(true)
    expect(await hubSigninBlocked({ id: 'other', entra_oid: 'OID-DANA' })).toBe(true)
    expect(await hubSigninBlocked({ id: ADMIN, email: 'admin@x.io' })).toBe(false)

    const done = await settled(r.json().data.id)
    // Two environments with a link suspended; the one without a link is not finished.
    expect(done.status).toBe('partial')
    const st = Object.fromEntries(done.results.map((x) => [x.environment_id, x.state]))
    expect(st).toEqual({ [envA]: 'suspended', [envB]: 'suspended', [envC]: 'no_link' })
    expect(m.call.mock.calls.every((c) => c[1] === 'suspend')).toBe(true)
  })

  it('a refusal (last admin) and a failure stay open; Retry asks only those again', async () => {
    m.call.mockImplementation(async (t: { envId: number }) =>
      t.envId === envA
        ? { ok: false, code: 'LAST_ADMIN', status: 409 }
        : { ok: false, code: 'TIMEOUT', status: 0 }
    )
    const id = (await offboard(`u:${DANA}`, asAdmin, 'dana@x.io')).json().data.id
    const first = await settled(id)
    const st = Object.fromEntries(first.results.map((x) => [x.environment_id, x]))
    expect(st[envA]).toMatchObject({ state: 'refused', code: 'LAST_ADMIN', attempts: 1 })
    expect(st[envB]).toMatchObject({ state: 'failed', code: 'TIMEOUT' })

    m.call.mockReset()
    m.call.mockImplementation(async (t: { envId: number }) =>
      t.envId === envA
        ? { ok: true, state: 'suspended', accounts: [{}] }
        : { ok: true, state: 'none', accounts: [] }
    )
    // Lift needs the typed email; it lifts the block AND makes the Hub account active again.
    expect(
      (await call('POST', `/offboards/${id}/lift`, asAdmin, { confirm: 'x' })).json().code
    ).toBe('CONFIRM_REQUIRED')
    const lifted = await call('POST', `/offboards/${id}/lift`, asAdmin, { confirm: 'dana@x.io' })
    expect(lifted.json().data).toMatchObject({ blocked: false, hub_account_reactivated: true })
    expect((await db('nivaro_users').where({ id: DANA }).first()).status).toBe('active')
    expect(await hubSigninBlocked({ id: 'x', email: 'dana@x.io' })).toBe(false)
    expect(await hubSigninBlocked({ id: DANA })).toBe(false)
    expect((await call('POST', `/offboards/${id}/retry`, asAdmin)).statusCode).toBe(202)
    const second = await settled(id)
    const s2 = Object.fromEntries(second.results.map((x) => [x.environment_id, x]))
    expect(s2[envA]).toMatchObject({ state: 'suspended', attempts: 2 })
    expect(s2[envB]).toMatchObject({ state: 'none', attempts: 2 })
    expect(second.blocked).toBe(true)
  })

  it('refuses the caller themselves and the Hub’s last admin', async () => {
    await db('nivaro_hub_signins').insert({
      identity_key: 'email:admin@x.io',
      hub_user_id: ADMIN,
      email: 'admin@x.io',
      app_id: 1,
      environment_id: envA,
      via: 'hub'
    })
    const self = await offboard(`u:${ADMIN}`, asAdmin, 'admin@x.io')
    expect(self.json().code).toBe('OFFBOARD_SELF')
    await db('nivaro_users').where({ id: ADMIN2 }).update({ status: 'suspended' })
    const last = await offboard(`u:${ADMIN}`, { 'x-user': DANA, 'x-admin': '1' }, 'admin@x.io')
    expect(last.json().code).toBe('LAST_HUB_ADMIN')
    expect((await db('nivaro_users').where({ id: ADMIN }).first()).status).toBe('active')
    expect(await db('nivaro_hub_offboards').count({ n: '*' })).toEqual([{ n: 0 }])
  })
})

describe('offboard identity is proven data only', () => {
  it('a direct (app-reported) row with a forged email or Entra key never adds it', async () => {
    // An app reports a sign-in naming Dana's Hub account but someone else's email and oid.
    await db('nivaro_users').insert({ id: VICTIM, email: 'victim@x.io', status: 'active' })
    await db('nivaro_hub_signins').insert([
      {
        identity_key: 'email:victim@x.io',
        hub_user_id: DANA,
        email: 'victim@x.io',
        app_id: 1,
        environment_id: envB,
        via: 'direct'
      },
      {
        identity_key: 'entra:tid-1:oid-victim',
        hub_user_id: DANA,
        email: 'victim@x.io',
        app_id: 1,
        environment_id: envB,
        via: 'direct'
      }
    ])
    // A Hub-recorded row whose free email column says something else adds nothing either.
    await db('nivaro_hub_signins')
      .where({ identity_key: 'entra:tid-1:oid-dana' })
      .update({ email: 'forged@x.io' })
    const r = (await call('GET', `/people/u:${DANA}`, asAdmin)).json().data
    expect(r.identity).toEqual({
      emails: ['dana@x.io'],
      entra: [{ oid: 'oid-dana', tid: 'tid-1' }]
    })
    m.call.mockResolvedValue({ ok: true, accounts: [] })
    await call('GET', `/people/u:${DANA}/access`, asAdmin)
    for (const c of m.call.mock.calls) {
      expect(JSON.stringify(c[2])).not.toContain('victim')
      expect(JSON.stringify(c[2])).not.toContain('forged')
    }
  })

  it('an email key from a direct row counts only when it is that account’s alone', async () => {
    await db('nivaro_hub_signins').insert({
      identity_key: 'email:dana.alias@x.io',
      hub_user_id: DANA,
      email: null,
      app_id: 1,
      environment_id: envB,
      via: 'direct'
    })
    // No Hub account holds the alias: not proven.
    expect((await call('GET', `/people/u:${DANA}`, asAdmin)).json().data.identity.emails).toEqual([
      'dana@x.io'
    ])
  })

  it('a person no Hub account owns has nothing proven: offboard is refused', async () => {
    const people = (await call('GET', '/people?q=eve', asAdmin)).json().data
    const key = people[0].key as string
    expect(key).toMatch(/^k:/)
    const r = (await call('GET', `/people/${key}`, asAdmin)).json().data
    expect(r.identity).toEqual({ emails: [], entra: [] })
    const res = await offboard(key, asAdmin, key)
    expect(res.json().code).toBe('NO_IDENTITY')
  })

  const blockRun = async (hubUserId: string | null) => {
    const [row] = await db('nivaro_hub_offboards')
      .insert({
        person_key: hubUserId ? `u:${hubUserId}` : 'k:1',
        hub_user_id: hubUserId,
        identity: JSON.stringify({ emails: ['shared@x.io'], entra: [{ oid: 'oid-z', tid: null }] }),
        status: 'done',
        blocked: true,
        started_at: new Date('2026-11-01T10:00:00Z')
      })
      .returning('id')
    const offboard_id = typeof row === 'object' ? (row as { id: number }).id : row
    await db('nivaro_hub_offboard_ids').insert([
      { offboard_id, kind: 'email', value: 'shared@x.io' },
      { offboard_id, kind: 'oid', value: 'oid-z' }
    ])
  }
  const OLD = new Date('2026-01-01T00:00:00Z')

  it('Hub sign-in block: a listed email spares only a proven DIFFERENT, older person', async () => {
    await blockRun('XXXXXXXX-0000-4000-8000-000000000009')
    // An older shared mailbox with a Microsoft id of its own (none of the run's): spared.
    expect(
      await hubSigninBlocked({
        id: 'a',
        email: 'shared@x.io',
        entra_oid: 'oid-someone-else',
        created_at: OLD
      })
    ).toBe(false)
    // An older account with NO Microsoft id: not proven different, blocked.
    expect(
      await hubSigninBlocked({ id: 'a', email: 'shared@x.io', entra_oid: null, created_at: OLD })
    ).toBe(true)
    // Read from the row when not passed: an older row without an oid is blocked too.
    await db('nivaro_users').insert({
      id: 'OLDROW',
      email: 'shared@x.io',
      status: 'active',
      created_at: OLD
    })
    expect(await hubSigninBlocked({ id: 'OLDROW', email: 'shared@x.io' })).toBe(true)
    await db('nivaro_users').where({ id: 'OLDROW' }).update({ entra_oid: 'oid-mailbox' })
    expect(await hubSigninBlocked({ id: 'OLDROW', email: 'shared@x.io' })).toBe(false)
    // A second account made (or re-linked) after the offboard started: still blocked, oid or not.
    expect(
      await hubSigninBlocked({
        id: 'b',
        email: 'Shared@x.io',
        entra_oid: 'oid-b',
        created_at: new Date('2026-11-02T00:00:00Z')
      })
    ).toBe(true)
    // An account whose age cannot be told: blocked (fails closed).
    expect(await hubSigninBlocked({ id: 'nobody', email: 'shared@x.io' })).toBe(true)
    // The run's own person, and anyone with the listed Microsoft id: blocked.
    expect(
      await hubSigninBlocked({
        id: 'XXXXXXXX-0000-4000-8000-000000000009',
        email: 'shared@x.io',
        entra_oid: 'oid-x',
        created_at: OLD
      })
    ).toBe(true)
    expect(await hubSigninBlocked({ id: 'a', entra_oid: 'OID-Z', created_at: OLD })).toBe(true)
    // Creating an account with that email (no row yet) is refused while the block holds.
    expect(await emailOffboarded({ email: 'SHARED@x.io' })).toBe(true)
    expect(await emailOffboarded({ email: 'other@x.io' })).toBe(false)
    await expect(assertEmailNotOffboarded({ email: 'shared@x.io' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'EMAIL_OFFBOARDED'
    })
  })

  it('Hub sign-in block: a run with no Hub account blocks EVERY holder of the email', async () => {
    await blockRun(null)
    expect(
      await hubSigninBlocked({
        id: 'a',
        email: 'shared@x.io',
        entra_oid: 'oid-someone-else',
        created_at: OLD
      })
    ).toBe(true)
    expect(await hubSigninBlocked({ id: 'c', email: 'other@x.io', created_at: OLD })).toBe(false)
  })

  it('the guard is Hub mode only', async () => {
    await blockRun(null)
    process.env.HUB = 'off'
    try {
      expect(await emailOffboarded({ email: 'shared@x.io' })).toBe(false)
    } finally {
      process.env.HUB = 'on'
    }
  })
})

describe('offboard refusals (H2, single flight)', () => {
  it('IDENTITY_SHARED: an email in the list belongs to another active Hub account', async () => {
    await db('nivaro_users').insert({ id: VICTIM, email: 'Dana@x.io', status: 'active' })
    const r = await offboard(`u:${DANA}`, asAdmin, 'dana@x.io')
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('IDENTITY_SHARED')
    expect((await db('nivaro_users').where({ id: DANA }).first()).status).toBe('active')
    expect(await db('nivaro_hub_offboards').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('IDENTITY_SHARED: a SUSPENDED (or waiting) account holding a listed email counts too', async () => {
    await db('nivaro_users').insert({ id: VICTIM, email: 'dana@x.io', status: 'suspended' })
    const r = await offboard(`u:${DANA}`, asAdmin, 'dana@x.io')
    expect(r.json().code).toBe('IDENTITY_SHARED')
    await db('nivaro_users').where({ id: VICTIM }).update({ status: 'invited', email: 'v@x.io' })
    await db('nivaro_users').where({ id: VICTIM }).update({ entra_oid: 'oid-dana' })
    const r2 = await offboard(`u:${DANA}`, asAdmin, 'dana@x.io')
    expect(r2.json().code).toBe('IDENTITY_SHARED')
    expect(await db('nivaro_hub_offboards').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('OFFBOARD_SELF: the list names the caller’s own Microsoft id', async () => {
    await db('nivaro_users').where({ id: ADMIN }).update({ entra_oid: 'oid-dana' })
    const r = await offboard(`u:${DANA}`, asAdmin, 'dana@x.io')
    expect(r.json().code).toBe('OFFBOARD_SELF')
  })

  it('two starts for one person at once: exactly one runs', async () => {
    m.call.mockImplementation(
      () =>
        new Promise((res) => setTimeout(() => res({ ok: true, state: 'none', accounts: [] }), 50))
    )
    const read = (await call('GET', `/people/u:${DANA}`, asAdmin)).json().data
    const go = () =>
      call('POST', `/people/u:${DANA}/offboard`, asAdmin, {
        confirm: 'dana@x.io',
        identity_hash: read.identity_hash
      })
    const [a, b] = await Promise.all([go(), go()])
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409])
    expect([a.json().code, b.json().code]).toContain('OFFBOARD_RUNNING')
    const id = (a.statusCode === 202 ? a : b).json().data.id
    await settled(id)
  })
})

describe('lift reactivates only the offboard’s own suspension', () => {
  it('an admin suspended the account again after the offboard: Lift leaves it suspended', async () => {
    m.call.mockResolvedValue({ ok: true, state: 'suspended', accounts: [{}] })
    const id = (await offboard(`u:${DANA}`, asAdmin, 'dana@x.io')).json().data.id
    await settled(id)
    // Later, an administrator suspends Dana for another reason (the row changes again).
    await db('nivaro_users')
      .where({ id: DANA })
      .update({ status: 'suspended', updated_at: new Date(Date.now() + 5_000) })
    const r = await call('POST', `/offboards/${id}/lift`, asAdmin, { confirm: 'dana@x.io' })
    expect(r.json().data).toMatchObject({ blocked: false, hub_account_reactivated: false })
    expect(r.json().data.hub_account_note).toMatch(/stays suspended/)
    expect((await db('nivaro_users').where({ id: DANA }).first()).status).toBe('suspended')
  })
})
