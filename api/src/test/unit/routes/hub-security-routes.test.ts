import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub security (routes/hub-security.ts, services/hub/security/*): access reviews, the
// compliance pack, the image scan, the TLS watch and break-glass. Real SQLite for every Hub
// table; the app calls (security link + people suspend), notices and the PDF renderer are mocked —
// no app, scanner, DNS server or certificate is ever contacted.

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
    authMethod?: string
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
    req.authMethod = req.headers['x-auth'] ?? 'session'
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
  suspend: vi.fn(),
  notice: vi.fn(async (..._a: unknown[]) => 1)
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
  callPeople: m.suspend
}))
vi.mock('../../../services/hub/security/link.js', () => ({ callSecurity: m.call }))
vi.mock('../../../services/hub/notify-events.js', () => ({
  deliverHubNotice: m.notice,
  hubEventRecipients: vi.fn(async () => ['BBBBBBBB-0000-4000-8000-000000000002']),
  notifyHubEvent: vi.fn(),
  sendHubEvent: vi.fn(async () => 0)
}))
vi.mock('../../../services/pdf-layout.js', () => ({
  htmlToPdf: vi.fn(async () => {
    throw Object.assign(new Error('no renderer'), { code: 'RENDER_UNAVAILABLE' })
  })
}))

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const ADMIN2 = 'AAAAAAAA-0000-4000-8000-000000000009'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'
const ADMIN_ROLE = '0A000000-0000-4000-8000-000000000001'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asAdmin2 = { 'x-user': ADMIN2, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/568_hub_ops.js'),
  await import('../../../db/migrations/569_hub_data.js'),
  await import('../../../db/migrations/570_hub_people_owner_policy.js'),
  await import('../../../db/migrations/578_hub_security.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const bg = await import('../../../services/hub/security/break-glass.js')
const tls = await import('../../../services/hub/security/tls.js')
const vuln = await import('../../../services/hub/security/vuln.js')
const seams = await import('../../../services/hub/security/seams.js')

let app: FastifyInstance
let prevHub: string | undefined
let appId: number
let otherApp: number
let prod: number
let staging: number

const idOf = (r: unknown) => {
  const x = (r as Array<number | { id: number }>)[0]
  return typeof x === 'object' ? x.id : x
}
const json = (r: { body: string }) => JSON.parse(r.body)

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id').primary()
    t.string('name')
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
    t.dateTime('created_at')
    t.dateTime('updated_at')
  })
  await db.schema.createTable('nivaro_extension_settings', (t) => {
    t.increments('id')
    t.string('extension_id')
    t.string('key')
    t.text('value')
    t.dateTime('updated_at')
  })
  for (const mig of migrations) await mig.up(db)
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
    'nivaro_hub_break_glass',
    'nivaro_hub_access_reviews',
    'nivaro_hub_access_review_items',
    'nivaro_hub_security_settings',
    'nivaro_hub_cert_checks',
    'nivaro_hub_vuln_findings',
    'nivaro_hub_vuln_scans',
    'nivaro_hub_deploys',
    'nivaro_hub_data_runs',
    'nivaro_hub_secret_rotations',
    'nivaro_hub_app_owners',
    'nivaro_hub_environments',
    'nivaro_hub_apps',
    'nivaro_extension_settings',
    'nivaro_users',
    'nivaro_roles'
  ])
    await db(t).del()
  await db('nivaro_roles').insert({ id: ADMIN_ROLE, name: 'Admin', admin_access: true })
  await db('nivaro_users').insert([
    { id: ADMIN, email: 'admin@x.io', role: ADMIN_ROLE, status: 'active', first_name: 'Ada' },
    { id: ADMIN2, email: 'admin2@x.io', role: ADMIN_ROLE, status: 'active' },
    { id: OWNER, email: 'owner@x.io', status: 'active', first_name: 'Olu', entra_oid: 'oid-o' },
    { id: OTHER, email: 'other@x.io', status: 'active' }
  ])
  appId = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'efp', name: 'EFP', signin_mode: 'hub', extensions: '[]' })
      .returning('id')
  )
  otherApp = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'pole', name: 'Pole', signin_mode: 'hub', extensions: '[]' })
      .returning('id')
  )
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER })
  const env = async (a: number, key: string, position: number, token: string | null) =>
    idOf(
      await db('nivaro_hub_environments')
        .insert({
          app_id: a,
          key,
          base_url: `https://${key}.efp.example`,
          hostnames: JSON.stringify([`www.${key}.efp.example`]),
          status: 'active',
          position,
          hub_token: token
        })
        .returning('id')
    )
  staging = await env(appId, 'staging', 0, 'SEALED-HUB-TOKEN-STAGING')
  prod = await env(appId, 'production', 1, 'SEALED-HUB-TOKEN-PROD')
  await env(otherApp, 'production', 0, 'SEALED-POLE')
})

describe('break-glass', () => {
  const ask = (headers: Record<string, string>, envId = staging, payload: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/hub/environments/${envId}/break-glass`,
      headers,
      payload: { hours: 2, reason: 'Fix the stuck import job', ...(payload as object) }
    })

  it('only on the person’s own session, only for owners/admins, within the longest grant', async () => {
    expect((await ask({ ...asOwner, 'x-auth': 'api_key' })).statusCode).toBe(403)
    expect(json(await ask({ ...asOwner, 'x-auth': 'masquerade' })).code).toBe('OWN_SESSION_ONLY')
    expect((await ask(asOther)).statusCode).toBe(404)
    expect(json(await ask(asOwner, staging, { hours: 9 })).code).toBe('BAD_HOURS')
    expect(json(await ask(asOwner, staging, { reason: 'short' })).code).toBe('BAD_REASON')
    const r = await ask(asOwner)
    expect(r.statusCode).toBe(201)
    expect(json(r).data).toMatchObject({ status: 'pending', hours: 2, requester_id: OWNER })
    // One open request per person and environment.
    expect(json(await ask(asOwner)).code).toBe('BREAK_GLASS_OPEN')
    // Hub admins were told (a review notice).
    expect(m.notice).toHaveBeenCalledWith(
      expect.arrayContaining([ADMIN, ADMIN2]),
      expect.objectContaining({ action: 'review' })
    )
  })

  it('a Hub admin approves (never their own); the grant goes over the link; the job revokes on time', async () => {
    const req = json(await ask(asOwner)).data
    // The owner cannot approve; nobody approves their own request.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/hub/break-glass/${req.id}/approve`,
          headers: asOwner
        })
      ).statusCode
    ).toBe(403)
    const mine = json(await ask(asAdmin2, prod)).data
    expect(
      json(
        await app.inject({
          method: 'POST',
          url: `/api/hub/break-glass/${mine.id}/approve`,
          headers: asAdmin2
        })
      ).code
    ).toBe('SELF_APPROVAL')
    // Not from an API key, even an admin's.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/hub/break-glass/${req.id}/approve`,
          headers: { ...asAdmin, 'x-auth': 'api_key' }
        })
      ).statusCode
    ).toBe(403)
    m.call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { state: 'granted', user_id: 'APP-USER-1', until: '2099-01-01T00:00:00.000Z' }
    })
    const ok = await app.inject({
      method: 'POST',
      url: `/api/hub/break-glass/${req.id}/approve`,
      headers: asAdmin
    })
    expect(ok.statusCode).toBe(200)
    await vi.waitFor(async () => expect((await bg.readBreakGlass(req.id))?.status).toBe('active'))
    const [target, method, op, sent] = m.call.mock.calls[0]
    expect([target.envId, method, op]).toEqual([staging, 'POST', 'break-glass'])
    // The requester's PROVEN identity (their Hub account), the ref and the reason.
    expect(sent).toMatchObject({
      ref: `bg-${req.id}`,
      emails: ['owner@x.io'],
      entra: [{ oid: 'oid-o', tid: null }],
      reason: 'Fix the stuck import job'
    })
    // Time runs out → the job revokes over the link.
    await db('nivaro_hub_break_glass')
      .where({ id: req.id })
      .update({ expires_at: new Date(Date.now() - 1000) })
    m.call.mockResolvedValueOnce({ ok: true, status: 200, body: { state: 'revoked' } })
    const tick = await bg.breakGlassTick()
    expect(tick.revoked).toEqual([req.id])
    expect(m.call.mock.calls[1][2]).toBe('break-glass/revoke')
    expect(m.call.mock.calls[1][3]).toEqual({ ref: `bg-${req.id}`, user_id: 'APP-USER-1' })
    expect((await bg.readBreakGlass(req.id))?.status).toBe('expired')
  })

  it('a revoke the app cannot take now is retried until it answers', async () => {
    const req = json(await ask(asOwner)).data
    m.call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { state: 'granted', user_id: 'APP-USER-2', until: '2099-01-01T00:00:00.000Z' }
    })
    await bg.approveBreakGlass(req.id, ADMIN, {}, { background: false })
    m.call.mockResolvedValueOnce({ ok: false, code: 'LINK_UNREACHABLE', status: 0 })
    await bg.revokeEarly(req.id, OWNER, { background: false })
    let row = await bg.readBreakGlass(req.id)
    expect(row).toMatchObject({ status: 'revoking', last_error: 'LINK_UNREACHABLE' })
    // Not yet due → the tick leaves it; once due it tries again and ends it.
    expect((await bg.breakGlassTick()).retried).toEqual([])
    await db('nivaro_hub_break_glass')
      .where({ id: req.id })
      .update({ next_try_at: new Date(0) })
    m.call.mockResolvedValueOnce({ ok: true, status: 200, body: { state: 'none' } })
    expect((await bg.breakGlassTick()).retried).toEqual([req.id])
    row = await bg.readBreakGlass(req.id)
    expect(row).toMatchObject({ status: 'revoked', revoke_reason: 'early', app_state: 'none' })
  })

  it('a grant whose answer never came is revoked anyway, by identity', async () => {
    const req = json(await ask(asOwner)).data
    m.call.mockResolvedValue({ ok: false, code: 'TIMEOUT', status: 0 })
    await bg.approveBreakGlass(req.id, ADMIN, {}, { background: false })
    expect((await bg.readBreakGlass(req.id))?.status).toBe('granting')
    // Give up after 30 minutes of trying: revoke what may have landed.
    await db('nivaro_hub_break_glass')
      .where({ id: req.id })
      .update({ decided_at: new Date(Date.now() - 31 * 60_000), next_try_at: new Date(0) })
    m.call.mockReset()
    m.call
      .mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', status: 0 })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { state: 'revoked' } })
    await bg.breakGlassTick()
    const last = m.call.mock.calls.at(-1)
    expect(last?.[2]).toBe('break-glass/revoke')
    expect(last?.[3]).toMatchObject({ ref: `bg-${req.id}`, emails: ['owner@x.io'] })
    expect((await bg.readBreakGlass(req.id))?.status).toBe('revoked')
  })

  it('self-approval only through the incident seam: closed without the incident feature', async () => {
    expect(json(await ask(asOwner, staging, { self_approve: true })).code).toBe('NO_INCIDENT')
    expect(await seams.onCallIncident(appId, OWNER)).toBeNull()
    // With the feature present and the person on call during an open incident, it opens.
    const fake = await seams.onCallIncident(appId, OWNER, {
      hasTable: async () => true,
      load: async (spec) =>
        spec.includes('store')
          ? { readRota: async () => ({}), listOverrides: async () => [] }
          : { onCallAt: () => ({ user_id: OWNER }) }
    })
    // No open incident row in this database → still closed.
    expect(fake).toBeNull()
  })

  it('pending requests nobody decided are withdrawn after 24 h; the requester may withdraw', async () => {
    const a = json(await ask(asOwner)).data
    const b = json(await ask(asOwner, prod)).data
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/hub/break-glass/${a.id}/cancel`,
          headers: asOwner
        })
      ).statusCode
    ).toBe(200)
    await db('nivaro_hub_break_glass')
      .where({ id: b.id })
      .update({ created_at: new Date(Date.now() - 25 * 3_600_000) })
    expect((await bg.breakGlassTick()).withdrawn).toEqual([b.id])
    const list = json(
      await app.inject({ method: 'GET', url: '/api/hub/break-glass', headers: asOwner })
    ).data
    expect(list.requests.map((r: { status: string }) => r.status).sort()).toEqual([
      'cancelled',
      'cancelled'
    ])
    // Another person sees nothing of it.
    const theirs = json(
      await app.inject({ method: 'GET', url: '/api/hub/break-glass', headers: asOther })
    ).data
    expect(theirs.requests).toEqual([])
  })
})

describe('access reviews', () => {
  const accounts = (env: number) => ({
    ok: true,
    status: 200,
    body: {
      accounts: [
        {
          user_id: `A-${env}`,
          name: 'Ann',
          email: 'ann@x.io',
          role: 'Admin',
          admin: true,
          status: 'active'
        },
        {
          user_id: `B-${env}`,
          name: 'Bo',
          email: 'bo@x.io',
          role: 'Staff',
          admin: false,
          status: 'active'
        },
        {
          user_id: `S-${env}`,
          email: 'svc@x.io',
          role: 'Admin',
          admin: true,
          status: 'active',
          kind: 'service'
        }
      ]
    }
  })

  it('owners start, decide and complete; removals go through the suspend route', async () => {
    m.call.mockImplementation(async (t: { envId: number }) => accounts(t.envId))
    // Another app's owner cannot start one here.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/hub/apps/${appId}/access-reviews`,
          headers: asOther
        })
      ).statusCode
    ).toBe(404)
    const start = await app.inject({
      method: 'POST',
      url: `/api/hub/apps/${appId}/access-reviews`,
      headers: asOwner
    })
    expect(start.statusCode).toBe(202)
    const id = json(start).data.id
    await vi.waitFor(async () =>
      expect(
        json(
          await app.inject({
            method: 'GET',
            url: `/api/hub/access-reviews/${id}`,
            headers: asOwner
          })
        ).data.status
      ).toBe('open')
    )
    expect(
      json(
        await app.inject({
          method: 'POST',
          url: `/api/hub/apps/${appId}/access-reviews`,
          headers: asOwner
        })
      ).code
    ).toBe('REVIEW_OPEN')
    const review = json(
      await app.inject({ method: 'GET', url: `/api/hub/access-reviews/${id}`, headers: asOwner })
    ).data
    expect(review.items).toHaveLength(6)
    expect(review.environments.map((e: { state: string }) => e.state)).toEqual(['read', 'read'])
    // Every account needs a decision first.
    expect(
      json(
        await app.inject({
          method: 'POST',
          url: `/api/hub/access-reviews/${id}/complete`,
          headers: asOwner
        })
      ).code
    ).toBe('DECISIONS_PENDING')
    const items = review.items.map((i: { id: number; app_user_id: string }) => ({
      id: i.id,
      decision: i.app_user_id.startsWith('A-') ? 'keep' : 'remove'
    }))
    const d = await app.inject({
      method: 'POST',
      url: `/api/hub/access-reviews/${id}/decisions`,
      headers: asOwner,
      payload: { items }
    })
    expect(json(d).data.counts).toMatchObject({ pending: 0, keep: 2, remove: 4 })
    m.suspend
      .mockResolvedValueOnce({ ok: true, state: 'suspended', accounts: [] })
      .mockResolvedValueOnce({ ok: false, code: 'LAST_ADMIN', status: 409 })
    const done = await app.inject({
      method: 'POST',
      url: `/api/hub/access-reviews/${id}/complete`,
      headers: asOwner
    })
    expect(done.statusCode).toBe(202)
    await vi.waitFor(async () =>
      expect(
        json(
          await app.inject({
            method: 'GET',
            url: `/api/hub/access-reviews/${id}`,
            headers: asOwner
          })
        ).data.status
      ).toBe('completed')
    )
    const after = json(
      await app.inject({ method: 'GET', url: `/api/hub/access-reviews/${id}`, headers: asOwner })
    ).data
    const state = Object.fromEntries(
      after.items.map((i: { app_user_id: string; removal_state: string | null }) => [
        i.app_user_id,
        i.removal_state
      ])
    )
    // Two people suspended through the app's route (by email, marked as an access review), a
    // service account never: remove it in the app.
    expect(m.suspend).toHaveBeenCalledTimes(2)
    expect(m.suspend.mock.calls[0][2]).toEqual({
      emails: ['bo@x.io'],
      entra: [],
      reason: 'access_review'
    })
    expect(state[`S-${staging}`]).toBe('manual')
    expect(Object.values(state).filter((s) => s === 'last_admin')).toHaveLength(1)
    const csv = await app.inject({
      method: 'GET',
      url: `/api/hub/access-reviews/${id}/evidence.csv`,
      headers: asOwner
    })
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body.split('\r\n').filter(Boolean)).toHaveLength(7)
    expect(csv.body).toContain('"remove"')
    // No PDF renderer in this test: a 503 that names the CSV.
    expect(
      json(
        await app.inject({
          method: 'GET',
          url: `/api/hub/access-reviews/${id}/evidence.pdf`,
          headers: asOwner
        })
      ).code
    ).toBe('RENDER_UNAVAILABLE')
  })

  it('an environment the Hub cannot reach is named, never guessed', async () => {
    m.call.mockResolvedValue({ ok: false, code: 'LINK_MISSING', status: 404 })
    const id = json(
      await app.inject({
        method: 'POST',
        url: `/api/hub/apps/${appId}/access-reviews`,
        headers: asAdmin
      })
    ).data.id
    await vi.waitFor(async () =>
      expect(
        json(
          await app.inject({
            method: 'GET',
            url: `/api/hub/access-reviews/${id}`,
            headers: asAdmin
          })
        ).data.status
      ).toBe('failed')
    )
  })

  it('the cadence starts reviews by itself (admin sets it)', async () => {
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/hub/apps/${appId}/security`,
          headers: asOwner,
          payload: { review_every_months: 3 }
        })
      ).statusCode
    ).toBe(403)
    const put = await app.inject({
      method: 'PUT',
      url: `/api/hub/apps/${appId}/security`,
      headers: asAdmin,
      payload: { review_every_months: 3, review_due_days: 10 }
    })
    expect(json(put).data).toMatchObject({ review_every_months: 3, review_due_days: 10 })
    await db('nivaro_hub_security_settings').update({ next_review_at: new Date(Date.now() - 1000) })
    m.call.mockImplementation(async (t: { envId: number }) => accounts(t.envId))
    const { reviewTick } = await import('../../../services/hub/security/reviews.js')
    const r = await reviewTick()
    expect(r.started).toHaveLength(1)
    const next = await db('nivaro_hub_security_settings').first('next_review_at')
    expect(new Date(next.next_review_at).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('compliance pack', () => {
  it('a zip of the summary and CSVs, with no secret in it', async () => {
    await db('nivaro_hub_deploys').insert({
      app_id: appId,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      started_by: ADMIN,
      started_at: new Date(),
      plan: JSON.stringify({ secret: 'PLAN-SECRET-VALUE' })
    })
    await db('nivaro_hub_data_runs').insert({
      kind: 'db_backup',
      environment_id: prod,
      status: 'done',
      started_at: new Date(),
      finished_at: new Date(),
      keep_secret: 'KEEP-SECRET-VALUE',
      artifact: JSON.stringify({ path: '/backups/secret-path' })
    })
    await db('nivaro_hub_secret_rotations').insert({
      ref: `hub_token:${prod}`,
      kind: 'hub_token',
      via: 'helper',
      rotated_by: ADMIN,
      rotated_at: new Date()
    })
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/hub/apps/${appId}/compliance-pack`,
          headers: asOther
        })
      ).statusCode
    ).toBe(404)
    const r = await app.inject({
      method: 'GET',
      url: `/api/hub/apps/${appId}/compliance-pack?months=12`,
      headers: asOwner
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('application/zip')
    const zip = r.rawPayload
    const text = zip.toString('latin1')
    for (const name of [
      'summary.html',
      'deploys.csv',
      'access-reviews.csv',
      'break-glass.csv',
      'backups.csv',
      'secret-rotations.csv',
      'incidents.csv',
      'certificates.csv',
      'vulnerabilities.csv',
      'README.txt'
    ])
      expect(text).toContain(name)
    for (const secret of [
      'SEALED-HUB-TOKEN',
      'PLAN-SECRET-VALUE',
      'KEEP-SECRET-VALUE',
      'secret-path'
    ])
      expect(text).not.toContain(secret)
    expect(text).toContain('0.3.215')
    expect(text).toContain(`hub_token:${prod}`)
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-compliance-pack' })
    )
  })
})

describe('settings', () => {
  it('the scanner token is write-only; owners cannot change settings', async () => {
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/hub/security/settings',
          headers: asOwner,
          payload: {}
        })
      ).statusCode
    ).toBe(403)
    expect(
      json(
        await app.inject({
          method: 'PUT',
          url: '/api/hub/security/settings',
          headers: asAdmin,
          payload: { scanner_url: 'http://scanner.internal' }
        })
      ).code
    ).toBe('BAD_SCANNER_URL')
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)
    const put = await app.inject({
      method: 'PUT',
      url: '/api/hub/security/settings',
      headers: asAdmin,
      payload: {
        scanner_url: 'https://scan.example',
        scanner_token: 'tok-123',
        break_glass_max_hours: 4
      }
    })
    expect(put.statusCode).toBe(200)
    const got = json(
      await app.inject({ method: 'GET', url: '/api/hub/security/settings', headers: asAdmin })
    ).data
    expect(got).toMatchObject({
      scanner_url: 'https://scan.example',
      scanner_token: '••••••',
      break_glass_max_hours: 4
    })
    const stored = await db('nivaro_extension_settings').first('value')
    expect(stored.value).not.toContain('tok-123')
  })
})

describe('TLS watch', () => {
  it('warns at 30 / 14 / 3 days once each, on DNS failure once, and writes calendar entries', async () => {
    const put = vi.fn(async () => undefined)
    const day = 86_400_000
    let left = 40
    const probe = async (t: { hostname: string }) => ({
      dns_ok: !t.hostname.startsWith('www.production'),
      addresses: ['10.0.0.1'],
      expires_at: new Date(Date.now() + left * day + 3_600_000),
      issuer: 'Test CA',
      subject: t.hostname,
      authorized: true,
      error_code: t.hostname.startsWith('www.production') ? 'ENOTFOUND' : null
    })
    const deps = {
      probe,
      hasTable: async (n: string) => n === 'nivaro_hub_calendar_entries',
      load: async () => ({ upsertCalendarEntry: put, removeCalendarEntry: vi.fn() })
    }
    let r = await tls.tlsWatchTick(deps)
    expect(r.checked).toBe(6) // 3 environments × (base_url + one hostname)
    // Only the DNS failures warned at 40 days (www.production of both apps).
    expect(m.notice).toHaveBeenCalledTimes(2)
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tls', source: 'tls' }))
    left = 20
    m.notice.mockClear()
    r = await tls.tlsWatchTick(deps)
    expect(r.warned).toBe(4) // the 30-day warning of the four names that resolve
    m.notice.mockClear()
    await tls.tlsWatchTick(deps)
    expect(m.notice).not.toHaveBeenCalled() // not again at the same level
    left = 2
    r = await tls.tlsWatchTick(deps)
    expect(r.warned).toBe(4) // straight to the 3-day level
    const list = json(
      await app.inject({ method: 'GET', url: '/api/hub/security/certificates', headers: asOwner })
    ).data
    expect(list.certificates).toHaveLength(4) // the owner's app only
    expect(list.certificates.filter((c: { state: string }) => c.state === 'warning')).toHaveLength(
      3
    )
  })

  it('judges and lists hosts without any network', () => {
    const now = Date.parse('2026-11-25T00:00:00Z')
    const f = (days: number, authorized = true) => ({
      dns_ok: true,
      addresses: [],
      expires_at: new Date(now + days * 86_400_000 + 1000),
      issuer: null,
      subject: null,
      authorized,
      error_code: null
    })
    expect(tls.judgeCert(f(45), true, now)).toMatchObject({ state: 'ok', level: null })
    expect(tls.judgeCert(f(20), true, now)).toMatchObject({ state: 'warning', level: 30 })
    expect(tls.judgeCert(f(10), true, now)).toMatchObject({ state: 'warning', level: 14 })
    expect(tls.judgeCert(f(1), true, now)).toMatchObject({ state: 'warning', level: 3 })
    expect(tls.judgeCert(f(-1), true, now)).toMatchObject({ state: 'expired', level: 0 })
    expect(tls.judgeCert(f(45, false), true, now).state).toBe('error')
    expect(
      tls.hostTargets([
        {
          id: 1,
          app_id: 1,
          key: 'p',
          base_url: 'https://a.example:8443',
          hostnames: '["b.example","a.example"]'
        },
        { id: 2, app_id: 1, key: 'd', base_url: 'http://localhost:3055', hostnames: '[]' }
      ])
    ).toEqual([
      { environment_id: 1, app_id: 1, env_key: 'p', hostname: 'a.example', port: 8443, tls: true },
      { environment_id: 1, app_id: 1, env_key: 'p', hostname: 'b.example', port: 443, tls: true },
      { environment_id: 2, app_id: 1, env_key: 'd', hostname: 'localhost', port: 3055, tls: false }
    ])
  })
})

describe('image scan', () => {
  const PIN = (n: string) => `nodeworks/nivaro@sha256:${n.repeat(64)}`

  it('no outbound call without an operator-set URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hub/security/vulnerabilities/scan',
      headers: asAdmin
    })
    expect(json(res).code).toBe('NO_SCANNER')
  })

  it('finds pinned images, keeps findings per digest and resolves the ones gone', async () => {
    await db('nivaro_hub_deploys').insert({
      app_id: appId,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      started_at: new Date(),
      plan: JSON.stringify({
        steps: [
          {
            driver: 'docker',
            deployedImage: PIN('a'),
            stack: { extensions: { 'efp-ops': PIN('b') } }
          }
        ]
      })
    })
    const images = await vuln.pinnedImages()
    expect(images.map((i) => [i.image, i.role, i.environment_ids])).toEqual([
      [PIN('a'), 'nivaro', [prod]],
      [PIN('b'), 'extension:efp-ops', [prod]]
    ])
    const answers = [
      [
        {
          id: 'CVE-2026-1',
          severity: 'CRITICAL',
          package: 'openssl',
          installed: '3.0.1',
          fixed: '3.0.7',
          url: 'https://nvd.example/1'
        },
        { id: 'CVE-2026-2', severity: 'low', package: 'zlib', url: 'javascript:alert(1)' }
      ],
      []
    ]
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const image = JSON.parse(init.body).image as string
      const list = image === PIN('a') ? answers[0] : answers[1]
      return new Response(JSON.stringify({ vulnerabilities: list }), { status: 200 })
    })
    const endpoint = async () => ({ url: 'https://scan.example', token: 'tok' })
    await vuln.startScan(
      { by: ADMIN, via: 'person' },
      { fetch: fetch as never, endpoint, background: false }
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('https://scan.example/scan')
    let open = await vuln.openFindings([vuln.digestOf(PIN('a'))])
    expect(open.map((f) => [f.vuln_id, f.severity, f.url])).toEqual([
      ['CVE-2026-1', 'critical', 'https://nvd.example/1'],
      ['CVE-2026-2', 'low', null]
    ])
    // A later scan no longer lists CVE-2026-2: resolved.
    answers[0] = answers[0].slice(0, 1)
    await vuln.startScan(
      { by: ADMIN, via: 'person' },
      { fetch: fetch as never, endpoint, background: false }
    )
    open = await vuln.openFindings([vuln.digestOf(PIN('a'))])
    expect(open.map((f) => f.vuln_id)).toEqual(['CVE-2026-1'])
    const page = json(
      await app.inject({
        method: 'GET',
        url: '/api/hub/security/vulnerabilities',
        headers: asOwner
      })
    ).data
    expect(page.images.find((i: { image: string }) => i.image === PIN('a')).counts.critical).toBe(1)
    // Another app's owner sees none of it.
    const theirs = json(
      await app.inject({
        method: 'GET',
        url: '/api/hub/security/vulnerabilities',
        headers: asOther
      })
    ).data
    expect(theirs.images).toEqual([])
  })
})
