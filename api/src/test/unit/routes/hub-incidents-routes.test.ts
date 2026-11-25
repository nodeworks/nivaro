import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub incidents, on-call, status pages and post-mortems (enhancements 32–35, migration 576) on a
// real SQLite with the Hub migrations. Apps are never contacted: the banner push is a spy, every
// notice goes to a spy (deliverHubNotice), the PDF renderer is a stub.

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
const delivered: Array<{
  ids: string[]
  subject: string
  message?: string
  urgent?: boolean
  path: string
}> = []
vi.mock('../../../services/hub/notify-events.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    deliverHubNotice: vi.fn(
      async (
        ids: string[],
        n: { subject: string; message: string; urgent?: boolean; path: string }
      ) => {
        delivered.push({
          ids: [...ids],
          subject: n.subject,
          message: n.message,
          urgent: n.urgent,
          path: n.path
        })
        return ids.length
      }
    )
  }
})
const pushes: Array<{ env: number; clear: boolean; text?: string }> = []
vi.mock('../../../services/hub/incident/banner.js', () => ({
  pushBanner: vi.fn(async (env: { id: number }, b: { clear?: true; text?: string }) => {
    pushes.push({ env: env.id, clear: !!b.clear, text: b.text })
    return b.clear ? 'cleared' : 'shown'
  })
}))
vi.mock('../../../services/pdf-layout.js', () => ({
  htmlToPdf: vi.fn(async (html: string) => Buffer.from(`%PDF-1.4 ${html.length}`))
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/565_hub_release_ops.js'),
  await import('../../../db/migrations/566_hub_fleet.js'),
  await import('../../../db/migrations/570_hub_people_owner_policy.js'),
  await import('../../../db/migrations/576_hub_incidents.js')
]
const { hubIncidentRoutes } = await import('../../../routes/hub-incidents.js')
const { hubStatusPublicRoutes } = await import('../../../routes/hub-status-public.js')
const { freezeRefusal } = await import('../../../services/hub/releases/freeze.js')
const { escalateDuePages, listPages, routeToOnCall, LEASE_MS } = await import(
  '../../../services/hub/incident/paging.js'
)
const { freezeOn } = await import('../../../services/hub/incident/incidents.js')
const { plannedMaintenance } = await import('../../../services/hub/incident/planned.js')
const { runIncidentTick } = await import('../../../services/hub/incident/tick.js')
const { sendHubEvent } = await import('../../../services/hub/notify-events.js')

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000002'
const ONCALL = 'cccccccc-0000-4000-8000-000000000003'
const NEXT = 'dddddddd-0000-4000-8000-000000000004'
const OTHER = 'eeeeeeee-0000-4000-8000-000000000005'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }

let app: FastifyInstance
let prevHub: string | undefined
let appId: number
let prod: number
let staging: number

const idOf = (r: unknown[]) => {
  const x = r[0] as { id: number } | number
  return typeof x === 'object' ? x.id : x
}

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  for (const m of migrations) await m.up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id')
    t.string('first_name').nullable()
    t.string('last_name').nullable()
    t.string('email').nullable()
    t.string('status').nullable()
    t.string('role').nullable()
    t.string('account_kind').nullable()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id')
    t.boolean('admin_access')
  })
  await db('nivaro_roles').insert([
    { id: 'r-admin', admin_access: true },
    { id: 'r-user', admin_access: false }
  ])
  await db('nivaro_users').insert([
    { id: ADMIN, first_name: 'Ada', last_name: 'Admin', status: 'active', role: 'r-admin' },
    { id: OWNER, first_name: 'Owen', last_name: 'Owner', status: 'active', role: 'r-user' },
    { id: ONCALL, first_name: 'Cal', last_name: 'Oncall', status: 'active', role: 'r-user' },
    { id: NEXT, first_name: 'Nell', last_name: 'Next', status: 'active', role: 'r-user' },
    { id: OTHER, first_name: 'Otto', last_name: 'Other', status: 'active', role: 'r-user' }
  ])
  app = Fastify()
  await app.register(hubIncidentRoutes, { prefix: '/hub' })
  await app.register(hubStatusPublicRoutes, { prefix: '/hub/status-page' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
})

beforeEach(async () => {
  delivered.length = 0
  pushes.length = 0
  for (const t of [
    'nivaro_hub_incidents',
    'nivaro_hub_incident_events',
    'nivaro_hub_oncall_rotas',
    'nivaro_hub_oncall_overrides',
    'nivaro_hub_pages',
    'nivaro_hub_status_pages',
    'nivaro_hub_freezes',
    'nivaro_hub_fleet_status',
    'nivaro_hub_uptime_samples',
    'nivaro_hub_uptime_hours',
    'nivaro_hub_deploys',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps'
  ])
    await db(t).del()
  appId = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'efp', name: 'EFP', signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER })
  const env = async (key: string, position: number) =>
    idOf(
      await db('nivaro_hub_environments')
        .insert({
          app_id: appId,
          key,
          position,
          status: 'active',
          base_url: `https://${key}.secret-host.internal`,
          hostnames: '[]',
          hub_token: 'sealed'
        })
        .returning('id')
    )
  staging = await env('staging', 0)
  prod = await env('production', 1)
})

async function setRota(extra: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: 'PUT',
    url: `/hub/apps/${appId}/on-call`,
    headers: asAdmin,
    payload: {
      people: [ONCALL, NEXT],
      time_zone: 'America/New_York',
      handover_weekday: 1,
      handover_time: '09:00',
      starts_on: new Date(Date.now() - 60_000).toISOString(),
      escalate_minutes: 15,
      ...extra
    }
  })
  expect(r.statusCode, r.body).toBe(200)
}

async function openOne(payload: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: 'POST',
    url: `/hub/apps/${appId}/incidents`,
    headers: asAdmin,
    payload: {
      title: 'Orders fail',
      severity: 'sev1',
      banner_text: 'Orders are failing <b>now</b>',
      ...payload
    }
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().data as { id: number; freeze_id: number; page_id: number | null }
}

describe('incident mode', () => {
  it('opens: freezes deploys, shows the banner on production, starts the timeline', async () => {
    const inc = await openOne()
    expect(await freezeRefusal({ appIds: [appId], action: 'promote' })).toMatchObject({
      code: 'FROZEN'
    })
    // The banner went to production only (the app-level incident), as plain text.
    expect(pushes).toEqual([{ env: prod, clear: false, text: 'Orders are failing bnow/b' }])
    const d = (await app.inject({ url: `/hub/incidents/${inc.id}`, headers: asAdmin })).json().data
    expect(d.frozen).toBe(true)
    expect(d.banner_envs).toEqual([
      expect.objectContaining({ environment_id: prod, state: 'shown' })
    ])
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual([
      'opened',
      'freeze',
      'banner',
      'page'
    ])
    // No rota: the owners and administrators were told, urgently.
    expect(delivered[0].ids.sort()).toEqual([ADMIN, OWNER].sort())
    expect(delivered[0].urgent).toBe(true)
  })

  it('an environment incident banners that environment only', async () => {
    await openOne({ environment_id: staging, severity: 'sev3' })
    expect(pushes.map((p) => p.env)).toEqual([staging])
  })

  it('lift freeze lets promotions through; resolve removes the banner and lifts the freeze', async () => {
    const inc = await openOne()
    const lift = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/freeze`,
      headers: asAdmin,
      payload: { on: false }
    })
    expect(lift.json().data.frozen).toBe(false)
    expect(await freezeRefusal({ appIds: [appId], action: 'promote' })).toBeNull()
    await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/freeze`,
      headers: asAdmin,
      payload: { on: true }
    })
    expect(await freezeRefusal({ appIds: [appId], action: 'promote' })).not.toBeNull()
    const r = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/resolve`,
      headers: asAdmin,
      payload: { note: 'Rolled back' }
    })
    expect(r.json().data.status).toBe('resolved')
    expect(await freezeRefusal({ appIds: [appId], action: 'promote' })).toBeNull()
    expect(pushes.at(-1)).toEqual({ env: prod, clear: true, text: undefined })
  })

  it('every write is admin-only; owners read their app, others get 404', async () => {
    const inc = await openOne()
    const asOwner = { 'x-user': OWNER }
    expect(
      (await app.inject({ url: `/hub/incidents/${inc.id}`, headers: asOwner })).statusCode
    ).toBe(200)
    expect(
      (await app.inject({ url: `/hub/incidents/${inc.id}`, headers: { 'x-user': OTHER } }))
        .statusCode
    ).toBe(404)
    const w = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/resolve`,
      headers: asOwner,
      payload: {}
    })
    expect(w.statusCode).toBe(403)
    const list = (await app.inject({ url: '/hub/incidents', headers: { 'x-user': OTHER } })).json()
    expect(list.data).toEqual([])
  })
})

describe('on-call and escalation', () => {
  it('a paged non-owner acknowledging the incident gets a receipt, not the incident', async () => {
    await setRota()
    const inc = await openOne({ summary: 'Internal: the DB password rotated' })
    // The pager notice names app, severity and title only.
    // ONCALL cannot read the app: app, environment kind, severity and a generic title only.
    expect(delivered[0].subject).toBe('SEV 1 alert: EFP')
    expect(delivered[0].message).toBe(
      'EFP · SEV 1: An incident was opened. Open the Hub to acknowledge.'
    )
    expect(delivered[0].message).not.toContain('Orders fail')
    expect(delivered[0].message).not.toContain('password')
    const r = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/acknowledge`,
      headers: { 'x-user': ONCALL }
    })
    expect(r.statusCode).toBe(200)
    const data = r.json().data
    expect(Object.keys(data).sort()).toEqual(
      ['acknowledged_at', 'acknowledged_by', 'id', 'status'].sort()
    )
    expect(data.status).toBe('acked')
    expect(JSON.stringify(data)).not.toMatch(/Orders fail|password/)
    const owner = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/acknowledge`,
      headers: { 'x-user': OWNER }
    })
    expect(owner.json().data.title).toBe('Orders fail')
    const stranger = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/acknowledge`,
      headers: { 'x-user': OTHER }
    })
    expect(stranger.statusCode).toBe(404)
  })

  it('pages the person on call first, escalates after the minutes, a paged person acknowledges', async () => {
    await setRota()
    const inc = await openOne()
    expect(inc.page_id).not.toBeNull()
    expect(delivered.map((d) => d.ids)).toEqual([[ONCALL]])
    expect(delivered[0].path).toBe(`/hub/on-call?page=${inc.page_id}`)
    // Not due yet.
    expect((await escalateDuePages({ now: () => Date.now() + 60_000 })).escalated).toBe(0)
    const later = Date.now() + 16 * 60_000
    expect((await escalateDuePages({ now: () => later })).escalated).toBe(1)
    expect(delivered.at(-1)).toMatchObject({ ids: [NEXT] })
    expect(delivered.at(-1)?.subject).toMatch(/^Not acknowledged:/)
    // Someone never paged cannot acknowledge (404); the next person can.
    const no = await app.inject({
      method: 'POST',
      url: `/hub/pages/${inc.page_id}/acknowledge`,
      headers: { 'x-user': OTHER }
    })
    expect(no.statusCode).toBe(404)
    const ok = await app.inject({
      method: 'POST',
      url: `/hub/pages/${inc.page_id}/acknowledge`,
      headers: { 'x-user': NEXT }
    })
    expect(ok.json().data.status).toBe('acked')
    expect((await escalateDuePages({ now: () => later + 60 * 60_000 })).escalated).toBe(0)
    const d = (await app.inject({ url: `/hub/incidents/${inc.id}`, headers: asAdmin })).json().data
    expect(d.acknowledged_by_name).toBe('Nell Next')
    // The page receipt only, never the page or incident text, for someone who cannot read the app.
    expect(Object.keys(ok.json().data).sort()).toEqual(
      ['acknowledged_at', 'acknowledged_by', 'id', 'status'].sort()
    )
    // The paged person sees the page on their on-call view.
    const mine = (await app.inject({ url: '/hub/on-call', headers: { 'x-user': ONCALL } })).json()
      .data
    expect(mine.rotas).toHaveLength(1)
    expect(mine.recent.map((p: { id: number }) => p.id)).toContain(inc.page_id)
  })

  it('urgent Hub events go to on-call; no rota keeps the old fan-out', async () => {
    const deliver = vi.fn(async (ids: Array<string | null | undefined>) => ids.length)
    const page = (p: Parameters<typeof routeToOnCall>[0]) => routeToOnCall(p, { deliver })
    const sent = vi.fn(async () => null)
    // No rota → null → sendHubEvent delivers to owners + admins itself.
    expect(
      await sendHubEvent({ kind: 'promote_failed', appId, envId: prod }, { page, notify: sent })
    ).toBe(2)
    expect(deliver).not.toHaveBeenCalled()
    await setRota()
    expect(
      await sendHubEvent({ kind: 'promote_failed', appId, envId: prod }, { page, notify: sent })
    ).toBe(1)
    expect(deliver.mock.calls[0][0]).toEqual([ONCALL])
    // A repeat within 30 minutes joins the open page (no second page).
    expect(
      await sendHubEvent({ kind: 'promote_failed', appId, envId: prod }, { page, notify: sent })
    ).toBe(0)
    // Not urgent: never paged.
    deliver.mockClear()
    await sendHubEvent({ kind: 'promote_done', appId, envId: prod }, { page, notify: sent })
    expect(deliver).not.toHaveBeenCalled()
  })

  it('overrides put someone else on call', async () => {
    await setRota()
    const r = await app.inject({
      method: 'POST',
      url: `/hub/apps/${appId}/on-call/overrides`,
      headers: asAdmin,
      payload: {
        user_id: OTHER,
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 3_600_000).toISOString()
      }
    })
    expect(r.statusCode).toBe(201)
    const v = (await app.inject({ url: '/hub/on-call', headers: asAdmin })).json().data
    expect(v.rotas[0].on_call.user_id).toBe(OTHER)
    expect(v.rotas[0].on_call.next_user_id).toBe(ONCALL)
  })

  it('a rota names active Hub accounts only', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: `/hub/apps/${appId}/on-call`,
      headers: asAdmin,
      payload: { people: ['ffffffff-0000-4000-8000-000000000009'] }
    })
    expect(r.statusCode).toBe(400)
  })

  it('the outage watch pages on-call for production and closes the page once it answers', async () => {
    await setRota()
    const hubEvent = vi.fn(async () => 1)
    const down = await runIncidentTick({
      samples: async () => [false, false, false],
      hubEvent,
      production: async () => [prod]
    })
    expect(down.outages).toBe(1)
    expect(hubEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'uptime_down', envId: prod }),
      expect.anything()
    )
    await db('nivaro_hub_pages').insert({
      app_id: appId,
      environment_id: prod,
      kind: 'uptime_down',
      subject: 'Down: EFP · production',
      message: 'x',
      path: '/hub/on-call',
      status: 'open',
      level: 0,
      sent_to: JSON.stringify([
        { level: 0, step: 'on_call', users: [ONCALL], at: new Date().toISOString() }
      ]),
      created_at: new Date()
    })
    const up = await runIncidentTick({
      samples: async () => [true, true, true],
      hubEvent,
      production: async () => [prod]
    })
    expect(up.recovered).toBe(1)
    expect(delivered.at(-1)).toMatchObject({ ids: [ONCALL], subject: 'Back up: EFP' })
    expect((await db('nivaro_hub_pages').first('status')).status).toBe('closed')
  })
})

describe('status pages', () => {
  async function fleet(envId: number, up: boolean) {
    await db('nivaro_hub_fleet_status').insert({
      environment_id: envId,
      app_id: appId,
      state: up ? 'ok' : 'unreachable',
      version: '0.3.214',
      error: 'ECONNREFUSED 10.0.0.5:3055',
      checked_at: new Date(),
      probed_at: new Date(),
      up
    })
  }

  it('a public link shows health with no internal detail; only the hash is stored', async () => {
    await fleet(prod, false)
    await fleet(staging, true)
    const c = await app.inject({
      method: 'POST',
      url: '/hub/status-pages',
      headers: asAdmin,
      payload: { name: 'Acme status', audience: 'public' }
    })
    expect(c.statusCode).toBe(201)
    const token = c.json().data.token as string
    expect(token).toMatch(/^nvs_/)
    const row = await db('nivaro_hub_status_pages').first()
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row.token_hash).toHaveLength(64)
    const page = await app.inject({ url: `/hub/status-page/${token}` })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toMatch(/text\/html/)
    expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    for (const leak of [
      'secret-host',
      '0.3.214',
      'ECONNREFUSED',
      '10.0.0.5',
      'production',
      'staging'
    ])
      expect(page.body).not.toContain(leak)
    expect(page.body).toContain('Major outage')
    const json = (await app.inject({ url: `/hub/status-page/${token}?format=json` })).json().data
    expect(json.apps[0]).toMatchObject({ name: 'EFP', state: 'major_outage' })
    expect(JSON.stringify(json)).not.toMatch(/secret-host|0\.3\.214|ECONNREFUSED/)
  })

  it('an open incident shows its banner text; rotate kills the old link; bad tokens are limited', async () => {
    await fleet(prod, true)
    await openOne({ severity: 'sev2', banner_text: 'Some orders are slow' })
    const c = await app.inject({
      method: 'POST',
      url: '/hub/status-pages',
      headers: asAdmin,
      payload: { name: 'S' }
    })
    const { id, token } = c.json().data
    const page = await app.inject({ url: `/hub/status-page/${token}?format=json` })
    expect(page.json().data.apps[0]).toMatchObject({
      state: 'partial_outage',
      incident: expect.objectContaining({ text: 'Some orders are slow' })
    })
    const rot = await app.inject({
      method: 'POST',
      url: `/hub/status-pages/${id}/rotate`,
      headers: asAdmin,
      payload: {}
    })
    expect(rot.json().data.token).not.toBe(token)
    expect((await app.inject({ url: `/hub/status-page/${token}` })).statusCode).toBe(404)
    let last = 0
    for (let i = 0; i < 22; i++)
      last = (
        await app.inject({
          url: `/hub/status-page/nvs_${'x'.repeat(43)}`,
          remoteAddress: '10.9.9.9'
        })
      ).statusCode
    expect(last).toBe(429)
  })

  it('an expired link is gone; internal pages open for anyone signed in, never public', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/hub/status-pages',
      headers: asAdmin,
      payload: { name: 'P', expires_in_days: 1 }
    })
    await db('nivaro_hub_status_pages').update({ expires_at: new Date(Date.now() - 1000) })
    expect((await app.inject({ url: `/hub/status-page/${c.json().data.token}` })).statusCode).toBe(
      404
    )
    const i = await app.inject({
      method: 'POST',
      url: '/hub/status-pages',
      headers: asAdmin,
      payload: { name: 'Inside', audience: 'internal' }
    })
    expect(i.json().data.token).toBeNull()
    const list = (
      await app.inject({ url: '/hub/status-pages', headers: { 'x-user': OTHER } })
    ).json().data
    expect(list.map((p: { name: string }) => p.name)).toEqual(['Inside'])
    const v = await app.inject({
      url: `/hub/status-pages/${i.json().data.id}/view`,
      headers: { 'x-user': OTHER }
    })
    expect(v.statusCode).toBe(200)
    expect(v.json().data.apps[0].name).toBe('EFP')
  })
})

describe('post-mortem', () => {
  it('drafts from the records, saves an edit, exports Markdown and PDF', async () => {
    const inc = await openOne()
    await db('nivaro_hub_deploys').insert({
      app_id: appId,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.215',
      status: 'failed',
      started_at: new Date(Date.now() - 30 * 60_000),
      finished_at: new Date(Date.now() - 25 * 60_000)
    })
    await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/resolve`,
      headers: asAdmin,
      payload: { note: 'Rolled back' }
    })
    const d = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/postmortem/draft`,
      headers: asAdmin,
      payload: {}
    })
    expect(d.statusCode, d.body).toBe(200)
    const doc = d.json().data
    const texts = doc.timeline.map((t: { text: string }) => t.text)
    expect(texts).toContain('Deploy of 0.3.215 to production failed')
    expect(texts.some((t: string) => t.startsWith('Incident resolved: Rolled back'))).toBe(true)
    const again = await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/postmortem/draft`,
      headers: asAdmin,
      payload: {}
    })
    expect(again.statusCode).toBe(409)
    const save = await app.inject({
      method: 'PUT',
      url: `/hub/incidents/${inc.id}/postmortem`,
      headers: asAdmin,
      payload: { postmortem: { ...doc, root_cause: 'A bad migration' } }
    })
    expect(save.statusCode).toBe(200)
    const md = await app.inject({
      url: `/hub/incidents/${inc.id}/postmortem.md`,
      headers: { 'x-user': OWNER }
    })
    expect(md.headers['content-type']).toMatch(/text\/markdown/)
    expect(md.body).toContain('## Root cause')
    expect(md.body).toContain('A bad migration')
    const pdf = await app.inject({
      url: `/hub/incidents/${inc.id}/postmortem.pdf`,
      headers: asAdmin
    })
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.body.startsWith('%PDF')).toBe(true)
  })
})

describe('review fixes', () => {
  it('H1: a delivery that throws mid-step is resumed by the next tick, never lost', async () => {
    await setRota()
    const inc = await openOne()
    const later = Date.now() + 16 * 60_000
    // The escalation to NEXT throws inside the delivery.
    const boom = vi.fn(async () => {
      throw new Error('push gateway down')
    })
    const r1 = await escalateDuePages({ now: () => later, deliver: boom as never })
    expect(r1.errors.length).toBe(1)
    const row = await db('nivaro_hub_pages').where({ id: inc.page_id }).first()
    // Still claimed with a lease (never NULL), the step recorded for NEXT, nobody marked yet.
    expect(row.next_at).not.toBeNull()
    const sent = JSON.parse(row.sent_to)
    expect(sent.at(-1)).toMatchObject({ users: [NEXT], delivered: [] })
    // Before the lease runs out nothing happens; after it the step is delivered once.
    expect((await escalateDuePages({ now: () => later + 60_000 })).escalated).toBe(0)
    const before = delivered.length
    const r2 = await escalateDuePages({ now: () => later + LEASE_MS + 1000 })
    expect(r2.escalated).toBe(1)
    expect(delivered.slice(before).map((d) => d.ids)).toEqual([[NEXT]])
    // NEXT may acknowledge it (the step was recorded before the throw).
    const ok = await app.inject({
      method: 'POST',
      url: `/hub/pages/${inc.page_id}/acknowledge`,
      headers: { 'x-user': NEXT }
    })
    expect(ok.json().data.status).toBe('acked')
  })

  it('M2: a 2-hour outage is one page and at most 5 notices', async () => {
    await setRota({ people: [ONCALL] })
    const start = Date.now()
    let t = start
    const deps = {
      now: () => t,
      samples: async () => [false, false, false],
      production: async () => [prod],
      hubEvent: (e: Parameters<typeof sendHubEvent>[0]) =>
        sendHubEvent(e, {
          page: (p) => routeToOnCall(p, { now: () => t }),
          notify: async () => null
        })
    }
    const before = delivered.length
    for (let m = 0; m <= 120; m++) {
      t = start + m * 60_000
      await runIncidentTick(deps)
    }
    const notices = delivered.slice(before)
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.length).toBeLessThanOrEqual(5)
    expect(
      await db('nivaro_hub_pages').where({ kind: 'uptime_down' }).count({ n: '*' }).first()
    ).toMatchObject({ n: 1 })
    // The chain ended with the owners and the administrators even though the rota lists one step.
    expect(notices.map((n) => n.ids[0])).toEqual(expect.arrayContaining([ONCALL, OWNER, ADMIN]))
  })

  it('M2: a rota needs at least one person', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: `/hub/apps/${appId}/on-call`,
      headers: asAdmin,
      payload: { people: [] }
    })
    expect(r.statusCode).toBe(400)
  })

  it('M3: a rota member who cannot read the app sees receipts and their own shifts only', async () => {
    await setRota()
    await routeToOnCall({
      appId,
      envId: prod,
      kind: 'promote_failed',
      subject: 'Deploy failed: EFP · production — 0.3.215 on production',
      message: 'The deploy did not finish — promote 0.3.215 on production.',
      path: '/hub?app=1'
    })
    expect(delivered.at(-1)?.subject).toBe('Urgent alert: EFP')
    expect(delivered.at(-1)?.message).not.toMatch(/0\.3\.215|production —/)
    const v = (await app.inject({ url: '/hub/on-call', headers: { 'x-user': NEXT } })).json().data
    expect(v.rotas[0].limited).toBe(true)
    expect(v.rotas[0].rota.people).toEqual([NEXT])
    expect(v.rotas[0].on_call.user_id).toBeNull()
    expect(v.pages).toEqual([])
    const mine = (await app.inject({ url: '/hub/on-call', headers: { 'x-user': ONCALL } })).json()
      .data
    expect(mine.pages).toHaveLength(1)
    expect(mine.pages[0]).toMatchObject({
      limited: true,
      sent_to: [],
      subject: 'Urgent alert: EFP'
    })
    expect(JSON.stringify(mine)).not.toMatch(/0\.3\.215|Nell Next/)
    const own = (await app.inject({ url: '/hub/on-call', headers: { 'x-user': OWNER } })).json()
      .data
    expect(own.pages[0].subject).toMatch(/0\.3\.215/)
  })

  it('L1: two freezes at once leave exactly one live freeze, lifted on resolve', async () => {
    const inc = await openOne({ freeze: false })
    await Promise.all([freezeOn(inc.id, ADMIN), freezeOn(inc.id, ADMIN)])
    const live = await db('nivaro_hub_freezes')
      .where({ source: `incident:${inc.id}` })
      .where('ends_at', '>', new Date())
    expect(live).toHaveLength(1)
    await app.inject({
      method: 'POST',
      url: `/hub/incidents/${inc.id}/resolve`,
      headers: asAdmin,
      payload: {}
    })
    expect(await freezeRefusal({ appIds: [appId], action: 'promote' })).toBeNull()
  })

  it('L9: planned maintenance hides incident freezes by tag, not by name', async () => {
    await openOne()
    await db('nivaro_hub_freezes').insert({
      app_id: appId,
      name: 'Incident #99 drill (a person’s own window)',
      recurrence: 'none',
      starts_at: new Date(Date.now() + 3_600_000),
      ends_at: new Date(Date.now() + 7_200_000)
    })
    const items = await plannedMaintenance({ appIds: [appId] })
    expect(items.filter((i) => i.kind === 'freeze')).toHaveLength(1)
  })

  it('L2: an incident on a non-production environment is not the app’s outage', async () => {
    await db('nivaro_hub_fleet_status').insert({
      environment_id: prod,
      app_id: appId,
      state: 'ok',
      checked_at: new Date(),
      probed_at: new Date(),
      up: true
    })
    await openOne({ environment_id: staging, severity: 'sev1' })
    const c = await app.inject({
      method: 'POST',
      url: '/hub/status-pages',
      headers: asAdmin,
      payload: { name: 'S' }
    })
    const j = (
      await app.inject({ url: `/hub/status-page/${c.json().data.token}?format=json` })
    ).json()
    expect(j.data.apps[0]).toMatchObject({ state: 'operational', incident: null })
  })

  it('L4: a person’s own older page is found past other apps’ newer pages', async () => {
    await db('nivaro_hub_pages').insert({
      app_id: appId,
      kind: 'test',
      subject: 's',
      message: 'm',
      path: '/hub/on-call',
      status: 'open',
      level: 0,
      sent_to: JSON.stringify([
        { level: 0, step: 'on_call', users: [NEXT], delivered: [NEXT], at: '' }
      ]),
      created_at: new Date(Date.now() - 86_400_000)
    })
    const rows = Array.from({ length: 120 }, () => ({
      app_id: 999,
      kind: 'test',
      subject: 's',
      message: 'm',
      path: '/hub/on-call',
      status: 'open',
      level: 0,
      sent_to: '[]',
      created_at: new Date()
    }))
    await db('nivaro_hub_pages').insert(rows)
    const mine = await listPages({ userId: NEXT, isAdmin: false, ownedAppIds: [], limit: 100 })
    expect(mine).toHaveLength(1)
  })
})
