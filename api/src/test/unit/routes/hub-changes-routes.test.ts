import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub change operations (routes/hub-changes.ts) mounted through hubRoutes: deploy windows on the
// release-time engine (promote refused OUTSIDE_WINDOW, rollbacks not, queue for the opening),
// pre-deploy checklists on production promote / move / shared upgrade (who may tick, claim and
// give back, unattended starts), and the change calendar + .ics. Real SQLite with the Hub
// tables; auth mocked (x-user / x-admin headers).

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
    req.user = { id, status: 'active', first_name: 'Ada', last_name: 'Lovelace', email: 'a@x' }
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
  await import('../../../db/migrations/565_hub_release_ops.js'),
  await import('../../../db/migrations/570_hub_people_owner_policy.js'),
  await import('../../../db/migrations/573_hub_change_ops.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const { startPromotion, defaultStartDeps } = await import('../../../services/hub/promote-run.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { PromotionError } = await import('../../../services/hub/promote-gather.js')
const { checklistGate, readRun } = await import('../../../services/hub/changes/checklist.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const STRANGER = 'CCCCCCCC-0000-4000-8000-000000000003'
const NAMED = 'DDDDDDDD-0000-4000-8000-000000000004'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asStranger = { 'x-user': STRANGER }
const asNamed = { 'x-user': NAMED }
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

let app: FastifyInstance
let appId = 0
let otherAppId = 0
let dev = 0
let prod = 0
let otherProd = 0
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

/** A start under the gate with no network: the plan read throws a passing refusal. */
function promoteProd(o: { version?: string; checklistRunId?: unknown } = {}) {
  return startPromotion(
    prod,
    {
      kind: 'promote',
      version: o.version ?? '0.3.215',
      confirm: 'prod',
      planHash: 'a'.repeat(64),
      user: { id: ADMIN },
      checklistRunId: o.checklistRunId
    },
    {
      ...defaultStartDeps(),
      lock: memoryPromoteLock,
      gather: async () => {
        throw new PromotionError('GITLAB_UNREACHABLE', 'GitLab did not answer', 503)
      }
    }
  ).then(
    () => ({ code: 'STARTED', message: '' }),
    (e) => e as { code: string; message: string }
  )
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const m of migrations) await m.up(db)
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id').primary()
    t.boolean('admin_access')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
    t.string('status')
    t.string('role')
    t.string('account_kind')
  })
  await db('nivaro_users').insert({
    id: NAMED,
    first_name: 'Dee',
    last_name: 'Bea',
    email: 'dba@x',
    status: 'active'
  })
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
  const placement = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: sharedId
  })
  otherProd = await insertId('nivaro_hub_environments', {
    app_id: otherAppId,
    key: 'production',
    position: 0,
    base_url: 'https://other.example.com',
    placement_id: placement
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
    'nivaro_hub_deploy_windows',
    'nivaro_hub_checklist_items',
    'nivaro_hub_checklist_runs',
    'nivaro_hub_calendar_entries',
    'nivaro_hub_schedules',
    'nivaro_hub_freezes',
    'nivaro_hub_deploys'
  ])
    await db(t).del()
})

/** A window that is closed now: an hour-long one-off window starting in a day. */
const closedWindow = (over: Record<string, unknown> = {}) =>
  inject('POST', '/deploy-windows', {
    name: 'Release slot',
    app_id: appId,
    recurrence: 'none',
    starts_at: new Date(Date.now() + 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 90_000_000).toISOString(),
    ...over
  })

describe('hub change routes', () => {
  it('every window, item and entry write is admin-only', async () => {
    const writes: Array<['POST' | 'PATCH' | 'DELETE', string]> = [
      ['POST', '/deploy-windows'],
      ['PATCH', '/deploy-windows/1'],
      ['DELETE', '/deploy-windows/1'],
      ['POST', '/checklist-items'],
      ['PATCH', '/checklist-items/1'],
      ['DELETE', '/checklist-items/1'],
      ['POST', '/calendar/entries'],
      ['PATCH', '/calendar/entries/1'],
      ['DELETE', '/calendar/entries/1'],
      ['POST', `/environments/${prod}/promote/queue`],
      ['POST', `/shared/${sharedId}/checklist-runs`]
    ]
    for (const [method, url] of writes) {
      const r = await inject(method, url, {}, asOwner)
      expect(r.statusCode, url).toBe(403)
    }
  })

  it('a closed production window refuses a promotion, not dev, not a rollback; queue waits for it', async () => {
    const made = await closedWindow()
    expect(made.statusCode).toBe(201)
    expect(activity.rows.map((r) => r.action)).toContain('hub-deploy-window-create')

    const view = await inject('GET', `/environments/${prod}/deploy-window`, undefined, asOwner)
    expect(view.json().data).toMatchObject({ governed: true, open: false, production: true })
    const devView = await inject('GET', `/environments/${dev}/deploy-window`, undefined, asOwner)
    expect(devView.json().data.governed).toBe(false)

    const promote = await inject('POST', `/environments/${prod}/promote`, {
      kind: 'promote',
      version: '0.3.215',
      confirm: 'prod',
      plan_hash: 'a'.repeat(64)
    })
    expect(promote.statusCode).toBe(409)
    expect(promote.json().code).toBe('OUTSIDE_WINDOW')
    // The Promote panel's banner reads the same engine.
    const banner = await inject('GET', `/environments/${prod}/freeze`, undefined, asOwner)
    expect(banner.json().data.code).toBe('OUTSIDE_WINDOW')

    const back = await startPromotion(
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
    expect(back.code).not.toBe('OUTSIDE_WINDOW')

    const queued = await inject('POST', `/environments/${prod}/promote/queue`, {
      version: '0.3.215',
      confirm: 'prod'
    })
    expect(queued.statusCode).toBe(201)
    const opens = Date.parse(made.json().data.starts_at)
    expect(Date.parse(queued.json().data.run_at)).toBe(opens + 60_000)
    expect(queued.json().data.on_freeze).toBe('wait')
  })

  it('a Hub-wide window governs every app without its own; the app’s own replaces it', async () => {
    await closedWindow({ app_id: null, env_scope: 'all', name: 'Hub slot' })
    expect((await inject('GET', `/environments/${dev}/deploy-window`)).json().data.governed).toBe(
      true
    )
    // acme gets its own production window open now: production opens, dev keeps the Hub one
    // (acme's own window does not fit dev).
    await inject('POST', '/deploy-windows', {
      name: 'Always',
      app_id: appId,
      ranges: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00' }],
      time_zone: 'UTC'
    })
    expect((await inject('GET', `/environments/${prod}/deploy-window`)).json().data.open).toBe(true)
    expect((await inject('GET', `/environments/${dev}/deploy-window`)).json().data.open).toBe(false)
    const overview = await inject('GET', '/changes/overview', undefined, asOwner)
    expect(overview.statusCode).toBe(200)
    const envs = overview.json().data.environments as Array<{
      key: string
      production: boolean
      window: { open: boolean }
    }>
    expect(envs.map((e) => [e.key, e.production, e.window.open])).toEqual([
      ['dev', false, false],
      ['prod', true, true]
    ])
  })

  it('a production promotion needs its checklist; ticks by who the item allows; claimed once', async () => {
    const owners = await inject('POST', '/checklist-items', {
      app_id: appId,
      text: 'Support told about the release'
    })
    expect(owners.statusCode).toBe(201)
    const dba = await inject('POST', '/checklist-items', {
      app_id: appId,
      text: 'DBA approved the migration',
      tick_by: 'people',
      tick_people: [NAMED]
    })
    const optional = await inject('POST', '/checklist-items', {
      app_id: appId,
      text: 'Release notes posted',
      required: false
    })
    expect(optional.statusCode).toBe(201)

    // Dev needs none; prod needs one.
    const devList = await inject(
      'GET',
      `/environments/${dev}/checklist?action=promote&version=0.3.215`,
      undefined,
      asOwner
    )
    expect(devList.json().data.required).toBe(false)
    expect((await promoteProd()).code).toBe('CHECKLIST_REQUIRED')

    const opened = await inject(
      'POST',
      `/environments/${prod}/checklist-runs`,
      { action: 'promote', version: '0.3.215' },
      asOwner
    )
    expect(opened.statusCode, opened.body).toBe(201)
    const runId = opened.json().data.run.id as number
    const ownerKey = `${owners.json().data.id}@${prod}`
    const dbaKey = `${dba.json().data.id}@${prod}`
    expect(
      opened.json().data.entries.map((e: { key: string; may_tick: boolean }) => [e.key, e.may_tick])
    ).toEqual([
      [ownerKey, true],
      [dbaKey, false],
      [`${optional.json().data.id}@${prod}`, true]
    ])

    // The owner may not tick the DBA's item; a stranger cannot even read the checklist.
    const refused = await inject('POST', `/checklist-runs/${runId}/tick`, { key: dbaKey }, asOwner)
    expect(refused.statusCode).toBe(403)
    expect(
      (await inject('POST', `/checklist-runs/${runId}/tick`, { key: ownerKey }, asStranger))
        .statusCode
    ).toBe(404)
    expect(
      (await inject('POST', `/checklist-runs/${runId}/tick`, { key: ownerKey }, asOwner)).statusCode
    ).toBe(200)
    const half = await promoteProd({ checklistRunId: runId })
    expect(half.code).toBe('CHECKLIST_INCOMPLETE')
    expect(half.message).toContain('DBA approved')

    // The named person reads it through its own route and ticks it with a note.
    expect((await inject('GET', `/checklist-runs/${runId}`, undefined, asNamed)).statusCode).toBe(
      200
    )
    const ticked = await inject(
      'POST',
      `/checklist-runs/${runId}/tick`,
      { key: dbaKey, note: 'Reviewed 573' },
      asNamed
    )
    expect(ticked.json().data.ready).toBe(true)
    expect(activity.rows.filter((r) => r.action === 'hub-checklist-tick')).toHaveLength(2)

    // Another version's start does not use it.
    expect((await promoteProd({ version: '0.3.216', checklistRunId: runId })).code).toBe(
      'CHECKLIST_MISMATCH'
    )
    // A start that fails after the claim gives it back (ticks kept)…
    expect((await promoteProd({ checklistRunId: runId })).code).toBe('GITLAB_UNREACHABLE')
    const again = await readRun(runId)
    expect(again?.status).toBe('open')
    expect(Object.keys(again?.ticks ?? {}).sort()).toEqual([dbaKey, ownerKey].sort())

    // …and a claim that started a run is linked to it and never used twice.
    const claim = await checklistGate({
      target: { kind: 'environment', envId: prod },
      action: 'promote',
      version: '0.3.215',
      runId
    })
    expect(claim?.runId).toBe(runId)
    await claim?.link('deploy', 4242)
    expect((await promoteProd({ checklistRunId: runId })).code).toBe('CHECKLIST_USED')
    const past = await inject('GET', `/checklist-runs/${runId}`, undefined, asOwner)
    expect(past.json().data.run).toMatchObject({ status: 'used', run_kind: 'deploy', run_id: 4242 })
  })

  it('a rollback and Apply now never wait on a checklist', async () => {
    await inject('POST', '/checklist-items', { app_id: appId, text: 'Support told' })
    const back = await startPromotion(
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
        gather: async () => {
          throw new PromotionError('GITLAB_UNREACHABLE', 'GitLab did not answer', 503)
        }
      }
    ).then(
      () => ({ code: 'STARTED' }),
      (e) => e as { code: string }
    )
    expect(back.code).toBe('GITLAB_UNREACHABLE')
  })

  it('an unattended start opens its checklist once, tells people, and passes once ticked', async () => {
    const item = await inject('POST', '/checklist-items', { app_id: appId, text: 'Support told' })
    const opened: number[] = []
    const gate = () =>
      checklistGate({
        target: { kind: 'environment', envId: prod },
        action: 'promote',
        version: '0.3.215',
        source: { kind: 'schedule', id: 77 },
        onOpened: async (run) => {
          opened.push(run.id)
        }
      }).then(
        (c) => ({ code: 'PASSED', claim: c }),
        (e) => ({ code: (e as { code: string }).code, claim: null })
      )
    // Opened on the first try (the people told once), then it waits for its ticks.
    expect((await gate()).code).toBe('CHECKLIST_INCOMPLETE')
    expect((await gate()).code).toBe('CHECKLIST_INCOMPLETE')
    expect(opened).toHaveLength(1)
    const waiting = await inject('GET', '/changes/overview', undefined, asOwner)
    expect(waiting.json().data.waiting).toEqual([
      expect.objectContaining({ id: opened[0], source: 'schedule', source_id: 77, env_key: 'prod' })
    ])
    await inject(
      'POST',
      `/checklist-runs/${opened[0]}/tick`,
      { key: `${item.json().data.id}@${prod}` },
      asOwner
    )
    const passed = await gate()
    expect(passed.code).toBe('PASSED')
    expect(passed.claim?.runId).toBe(opened[0])
  })

  it('a production move and a shared upgrade carrying production need their checklist', async () => {
    await inject('POST', '/checklist-items', {
      app_id: appId,
      text: 'Users told',
      actions: ['move']
    })
    const move = await inject('POST', `/environments/${prod}/move`, { confirm: 'acme/prod' })
    expect(move.statusCode).toBe(409)
    expect(move.json().code).toBe('CHECKLIST_REQUIRED')

    const otherItem = await inject('POST', '/checklist-items', {
      app_id: otherAppId,
      text: 'Other app owners agree',
      tick_by: 'admin'
    })
    const upgrade = await inject('POST', `/shared/${sharedId}/upgrade`, { version: '0.3.215' })
    expect(upgrade.statusCode).toBe(409)
    expect(upgrade.json().code).toBe('CHECKLIST_REQUIRED')
    // A rollback of the deployment never waits on it.
    const back = await inject('POST', `/shared/${sharedId}/upgrade`, {
      kind: 'rollback',
      version: '0.3.209'
    })
    expect(back.json().code).not.toMatch(/^CHECKLIST_/)

    const list = await inject('GET', `/shared/${sharedId}/checklist?version=0.3.215`)
    expect(list.json().data.entries.map((e: { key: string }) => e.key)).toEqual([
      `${otherItem.json().data.id}@${otherProd}`
    ])
    const run = await inject('POST', `/shared/${sharedId}/checklist-runs`, { version: '0.3.215' })
    expect(run.statusCode).toBe(201)
  })

  it('the calendar shows the apps the caller may see; .ics downloads them', async () => {
    const now = Date.now()
    await db('nivaro_hub_deploys').insert({
      app_id: appId,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      started_at: new Date(now - 3_600_000),
      finished_at: new Date(now - 3_000_000)
    })
    await db('nivaro_hub_deploys').insert({
      app_id: otherAppId,
      environment_id: otherProd,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      started_at: new Date(now - 3_600_000)
    })
    await db('nivaro_hub_schedules').insert({
      app_id: appId,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.216',
      run_at: new Date(now + 86_400_000),
      status: 'scheduled'
    })
    await inject('POST', '/freezes', {
      name: 'Year end',
      starts_at: new Date(now + 2 * 86_400_000).toISOString(),
      ends_at: new Date(now + 3 * 86_400_000).toISOString()
    })
    await closedWindow()
    const entry = await inject('POST', '/calendar/entries', {
      title: 'Database patching',
      app_id: appId,
      starts_at: new Date(now + 4 * 86_400_000).toISOString(),
      ends_at: new Date(now + 4 * 86_400_000 + 7_200_000).toISOString()
    })
    expect(entry.statusCode).toBe(201)

    const mine = await inject('GET', '/calendar', undefined, asOwner)
    expect(mine.statusCode).toBe(200)
    const kinds = (mine.json().data.events as Array<{ kind: string; app_key: string | null }>).map(
      (e) => `${e.kind}:${e.app_key ?? '-'}`
    )
    expect(kinds).toEqual(
      expect.arrayContaining([
        'promote:acme',
        'scheduled:acme',
        'freeze:-',
        'window:acme',
        'maintenance:acme'
      ])
    )
    expect(kinds).not.toContain('promote:other')
    expect((await inject('GET', '/calendar')).json().data.events.length).toBe(kinds.length + 1)
    expect(
      (await inject('GET', `/calendar?app_id=${otherAppId}`, undefined, asOwner)).statusCode
    ).toBe(404)
    expect(
      (await inject('GET', '/calendar?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z'))
        .statusCode
    ).toBe(400)

    const ics = await inject('GET', `/calendar.ics?app_id=${appId}`, undefined, asOwner)
    expect(ics.statusCode).toBe(200)
    expect(ics.headers['content-type']).toContain('text/calendar')
    expect(ics.body).toContain('SUMMARY:Database patching')
    expect(ics.body).not.toContain('Deploy window')
    expect(
      (await inject('GET', `/calendar.ics?owner=${ADMIN}`, undefined, asOwner)).statusCode
    ).toBe(404)
    expect(
      (await inject('GET', `/calendar.ics?owner=${OWNER}`, undefined, asOwner)).statusCode
    ).toBe(200)
  })
})
