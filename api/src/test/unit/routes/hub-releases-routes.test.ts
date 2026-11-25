import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub release operations routes (routes/hub-releases.ts) mounted through hubRoutes, plus the
// freeze guard on the existing promote / move / shared-upgrade starts. Real SQLite with the hub
// tables (542–553, 565); auth is mocked (x-user / x-admin headers).

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
  return { db, migrationsDir: '/nowhere' }
})
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active', first_name: 'Ada', last_name: 'Admin', email: 'a@x' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
const activity = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (row: Record<string, unknown>) => {
    activity.rows.push(row)
    return null
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/565_hub_release_ops.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const { startPromotion, defaultStartDeps } = await import('../../../services/hub/promote-run.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const STRANGER = 'CCCCCCCC-0000-4000-8000-000000000003'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asStranger = { 'x-user': STRANGER }
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

let app: FastifyInstance
let appId = 0
let otherAppId = 0
let dev = 0
let prod = 0
let sharedId = 0

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

function inject(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = asAdmin
) {
  return app.inject({ method, url: `/api/hub${url}`, payload: payload as never, headers })
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const m of migrations) await m.up(db)
  appId = await insertId('nivaro_hub_apps', { key: 'acme', name: 'Acme' })
  otherAppId = await insertId('nivaro_hub_apps', { key: 'other', name: 'Other' })
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER })
  dev = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'dev',
    position: 0,
    base_url: 'https://dev.acme.example.com'
  })
  prod = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    position: 1,
    base_url: 'https://acme.example.com'
  })
  sharedId = await insertId('nivaro_hub_shared_deployments', {
    key: 'shared-one',
    name: 'Shared one',
    mode: 'docker',
    link_url: 'https://shared.internal.example.com',
    status: 'active',
    version_pin: '0.3.210'
  })
  app = Fastify()
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

beforeEach(async () => {
  activity.rows = []
  for (const t of [
    'nivaro_hub_freezes',
    'nivaro_hub_schedules',
    'nivaro_hub_trains',
    'nivaro_hub_rollback_rules'
  ])
    await db(t).del()
})

const hubWideFreeze = () =>
  inject('POST', '/freezes', {
    name: 'Release freeze',
    starts_at: new Date(Date.now() - 60_000).toISOString(),
    ends_at: new Date(Date.now() + 3_600_000).toISOString()
  })

describe('hub release routes', () => {
  it('every write is admin-only', async () => {
    const writes: Array<['POST' | 'PUT' | 'PATCH' | 'DELETE', string]> = [
      ['POST', `/apps/${appId}/trains`],
      ['POST', '/trains/1/skip'],
      ['POST', '/trains/1/abort'],
      ['POST', '/schedules'],
      ['POST', '/schedules/1/cancel'],
      ['POST', '/freezes'],
      ['PATCH', '/freezes/1'],
      ['DELETE', '/freezes/1'],
      ['PUT', `/environments/${prod}/rollback-rule`],
      ['DELETE', `/environments/${prod}/rollback-rule`]
    ]
    for (const [method, url] of writes) {
      const r = await inject(method, url, {}, asOwner)
      expect(r.statusCode, url).toBe(403)
    }
  })

  it('a freeze is created, listed with its window, and refuses promote / move / upgrade — not a rollback', async () => {
    const made = await hubWideFreeze()
    expect(made.statusCode).toBe(201)
    expect(activity.rows.map((r) => r.action)).toContain('hub-freeze-create')

    const view = await inject('GET', '/releases/overview', undefined, asOwner)
    expect(view.json().data.freezes[0].active).not.toBeNull()

    const promote = await inject('POST', `/environments/${prod}/promote`, {
      kind: 'promote',
      version: '0.3.215',
      confirm: 'prod',
      plan_hash: 'a'.repeat(64)
    })
    expect(promote.statusCode).toBe(409)
    expect(promote.json().code).toBe('FROZEN')

    // A rollback is judged after gather (injected here: no network). Only one to an OLDER
    // version than the running one passes the freeze.
    const older = await startPromotion(
      prod,
      {
        kind: 'rollback',
        version: '0.3.214',
        confirm: 'prod',
        planHash: 'a'.repeat(64),
        user: null
      },
      {
        ...defaultStartDeps(),
        lock: memoryPromoteLock,
        gather: async () => ({ targetVersion: '0.3.215' }) as never
      }
    ).then(
      () => ({ code: 'STARTED' }),
      (e) => e as { code: string }
    )
    expect(older.code).not.toBe('FROZEN')
    const newer = await startPromotion(
      prod,
      {
        kind: 'rollback',
        version: '0.3.216',
        confirm: 'prod',
        planHash: 'a'.repeat(64),
        user: null
      },
      {
        ...defaultStartDeps(),
        lock: memoryPromoteLock,
        gather: async () => ({ targetVersion: '0.3.215' }) as never
      }
    ).then(
      () => ({ code: 'STARTED' }),
      (e) => e as { code: string }
    )
    expect(newer.code).toBe('FROZEN')
    const unknown = await startPromotion(
      prod,
      {
        kind: 'rollback',
        version: '0.3.214',
        confirm: 'prod',
        planHash: 'a'.repeat(64),
        user: null
      },
      {
        ...defaultStartDeps(),
        lock: memoryPromoteLock,
        gather: async () => ({ targetVersion: null }) as never
      }
    ).then(
      () => ({ code: 'STARTED' }),
      (e) => e as { code: string }
    )
    expect(unknown.code).toBe('FROZEN')

    const move = await inject('POST', `/environments/${prod}/move`, {})
    expect(move.statusCode).toBe(409)
    expect(move.json().code).toBe('FROZEN')

    const upgrade = await inject('POST', `/shared/${sharedId}/upgrade`, { version: '0.3.215' })
    expect(upgrade.statusCode).toBe(409)
    expect(upgrade.json().code).toBe('FROZEN')
    const sharedBack = await inject('POST', `/shared/${sharedId}/upgrade`, {
      kind: 'rollback',
      version: '0.3.209'
    })
    expect(sharedBack.json().code).not.toBe('FROZEN')

    const banner = await inject('GET', `/environments/${prod}/freeze`, undefined, asOwner)
    expect(banner.json().data.code).toBe('FROZEN')
  })

  it('an app freeze binds only its app', async () => {
    const r = await inject('POST', '/freezes', {
      name: 'Other only',
      app_id: otherAppId,
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      ends_at: new Date(Date.now() + 3_600_000).toISOString()
    })
    expect(r.statusCode).toBe(201)
    expect((await inject('GET', `/environments/${prod}/freeze`)).json().data).toBeNull()
    // Owners of acme do not see another app's freeze.
    const view = await inject('GET', '/releases/overview', undefined, asOwner)
    expect(view.json().data.freezes).toEqual([])
    expect(view.json().data.apps.map((a: { key: string }) => a.key)).toEqual(['acme'])
    const id = r.json().data.id
    expect((await inject('DELETE', `/freezes/${id}`)).statusCode).toBe(200)
  })

  it('refuses a bad freeze', async () => {
    const r = await inject('POST', '/freezes', { name: 'x', recurrence: 'month_end' })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_FREEZE')
  })

  it('a schedule needs the typed key, a future time, and is cancelled while waiting', async () => {
    const base = {
      kind: 'promote',
      app_id: appId,
      environment_id: prod,
      version: '0.3.215',
      run_at: new Date(Date.now() + 3_600_000).toISOString()
    }
    expect((await inject('POST', '/schedules', { ...base, confirm: 'nope' })).json().code).toBe(
      'CONFIRM_REQUIRED'
    )
    expect(
      (
        await inject('POST', '/schedules', {
          ...base,
          confirm: 'prod',
          run_at: '2020-01-01T00:00:00Z'
        })
      ).json().code
    ).toBe('BAD_SCHEDULE')
    const ok = await inject('POST', '/schedules', { ...base, confirm: 'prod', on_freeze: 'fail' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().data).toMatchObject({
      status: 'scheduled',
      on_freeze: 'fail',
      created_by: ADMIN
    })
    const id = ok.json().data.id
    const cancel = await inject('POST', `/schedules/${id}/cancel`)
    expect(cancel.json().data.status).toBe('cancelled')
    expect((await inject('POST', `/schedules/${id}/cancel`)).statusCode).toBe(409)
  })

  it('a train needs the app key; its environments follow the app order; strangers see nothing', async () => {
    const steps = [{ environment_id: prod }, { environment_id: dev }]
    const bad = await inject('POST', `/apps/${appId}/trains`, {
      version: '0.3.215',
      steps,
      confirm: 'acme'
    })
    expect(bad.json().code).toBe('BAD_TRAIN')
    const noKey = await inject('POST', `/apps/${appId}/trains`, {
      version: '0.3.215',
      steps: [{ environment_id: dev }],
      confirm: 'dev'
    })
    expect(noKey.json().code).toBe('CONFIRM_REQUIRED')
    expect(
      (
        await inject(
          'POST',
          `/apps/${appId}/trains/check`,
          { version: '0.3.215', steps: [] },
          asStranger
        )
      ).statusCode
    ).toBe(404)
    expect((await inject('GET', '/trains/999', undefined, asOwner)).statusCode).toBe(404)
  })

  it('a rollback rule is saved, read by owners, and deleted', async () => {
    const bad = await inject('PUT', `/environments/${prod}/rollback-rule`, { window_minutes: 30 })
    expect(bad.json().code).toBe('BAD_RULE')
    const ok = await inject('PUT', `/environments/${prod}/rollback-rule`, {
      window_minutes: 20,
      max_error_pct: 5,
      min_requests: 100
    })
    expect(ok.statusCode).toBe(200)
    const read = await inject('GET', `/environments/${prod}/rollback-rule`, undefined, asOwner)
    expect(read.json().data.rule).toMatchObject({
      window_minutes: 20,
      max_error_pct: 5,
      enabled: true
    })
    expect(
      (await inject('GET', `/environments/${prod}/rollback-rule`, undefined, asStranger)).statusCode
    ).toBe(404)
    expect((await inject('DELETE', `/environments/${prod}/rollback-rule`)).statusCode).toBe(200)
    expect((await inject('DELETE', `/environments/${prod}/rollback-rule`)).statusCode).toBe(404)
  })

  it('a run with no stored notes answers null', async () => {
    const id = await insertId('nivaro_hub_deploys', {
      app_id: appId,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.215',
      status: 'success'
    })
    expect(
      (await inject('GET', `/deploys/${id}/release-notes`, undefined, asOwner)).json().data
    ).toBeNull()
    expect(
      (await inject('GET', `/deploys/${id}/release-notes`, undefined, asStranger)).statusCode
    ).toBe(404)
  })
})
