import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromotionBlocker } from '../../../services/hub/promote-types.js'

// Nivaro Hub (phase 2): promotion routes. Real SQLite for apps/environments/owners/deploys; the
// runner, the gatherer and the job log are mocked (their own tests cover them).

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

const m = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  gather: vi.fn(),
  log: vi.fn(),
  maint: vi.fn()
}))
vi.mock('../../../services/hub/promote-run.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/promote-run.js')>()),
  startPromotion: m.start,
  cancelPromotion: m.cancel,
  recoverOnceAtBoot: vi.fn()
}))
vi.mock('../../../services/hub/promote-gather.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/promote-gather.js')>()),
  gatherPlanInput: m.gather
}))
vi.mock('../../../services/job-runs.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/job-runs.js')>()),
  readJobLog: m.log
}))
vi.mock('../../../services/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/security.js')>()),
  maintenanceState: m.maint
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up543 } = await import('../../../db/migrations/543_hub_promotions.js')
const { up: up570 } = await import('../../../db/migrations/570_hub_people_owner_policy.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { logActivity } = await import('../../../services/activity.js')
const { maintenanceFreezeHook } = await import('../../../services/maintenance-freeze.js')
const { PromotionError } = await import('../../../services/hub/promote-gather.js')
const { GitlabWriteError } = await import('../../../services/hub/gitlab-write.js')

const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'
const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

let app: FastifyInstance
let prevHub: string | undefined
let appId: number
let prodId: number
let deployId: number

const idOf = (r: unknown) => {
  const x = (r as Array<number | { id: number }>)[0]
  return typeof x === 'object' ? x.id : x
}

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  await up(db)
  await up543(db)
  await up570(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
  })
  app = Fastify()
  app.addHook('preHandler', maintenanceFreezeHook)
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
  vi.resetAllMocks()
  for (const t of [
    'nivaro_hub_deploys',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps'
  ])
    await db(t).del()
  appId = idOf(
    await db('nivaro_hub_apps')
      .insert({
        key: 'efp',
        name: 'EFP',
        signin_mode: 'direct',
        extensions: '[]',
        // Owners here act on the chain's last environment (production): the app lets them
        // (owner self-service on production is hub-owner-access.test.ts).
        owners_deploy_production: true
      })
      .returning('id')
  )
  const env = (key: string, position: number) =>
    db('nivaro_hub_environments')
      .insert({
        app_id: appId,
        key,
        base_url: `https://${key}.example.com`,
        hostnames: '[]',
        status: 'active',
        position
      })
      .returning('id')
  await env('staging', 0)
  prodId = idOf(await env('prod', 1))
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER })
  deployId = idOf(
    await db('nivaro_hub_deploys')
      .insert({
        app_id: appId,
        environment_id: prodId,
        kind: 'promote',
        version: '0.3.209',
        from_version: '0.3.208',
        status: 'running',
        step: 'deploy api',
        plan: JSON.stringify({ ok: true }),
        job_run_id: 77,
        started_by: OWNER,
        started_at: new Date()
      })
      .returning('id')
  )
  m.maint.mockResolvedValue({ on: false })
})

const url = (p: string) => `/api/hub${p}`
const get = (p: string, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: url(p), headers })
const post = (p: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: 'POST', url: url(p), headers, payload: payload as never })

describe('access', () => {
  // Cold: the first request loads the whole hub route graph (5–6 s on a busy machine).
  it('a non-owner non-admin gets 404 on every route; owners and admins pass', async () => {
    m.gather.mockResolvedValue(planInput())
    const HASH = 'c'.repeat(64)
    const body = { version: '0.3.209', kind: 'promote', confirm: 'prod', plan_hash: HASH }
    const calls = [
      () => get(`/environments/${prodId}/promotable`, asOther),
      () => post(`/environments/${prodId}/promote/plan`, asOther, body),
      () => post(`/environments/${prodId}/promote`, asOther, body),
      () => get(`/environments/${prodId}/deploys/hub`, asOther),
      () => get(`/promotions/${deployId}`, asOther),
      () => post(`/promotions/${deployId}/cancel`, asOther)
    ]
    for (const c of calls) expect((await c()).statusCode).toBe(404)
    expect(m.start).not.toHaveBeenCalled()
    expect(m.cancel).not.toHaveBeenCalled()
    for (const h of [asOwner, asAdmin])
      expect((await get(`/environments/${prodId}/deploys/hub`, h)).statusCode).toBe(200)
    expect((await get(`/environments/99999/promotable`, asAdmin)).statusCode).toBe(404)
  }, 20000)
})

function planInput(over: Record<string, unknown> = {}) {
  return {
    targetVersion: '0.3.208',
    previousVersion: '0.3.210',
    previousDeployedVersions: ['0.3.210', '0.3.209', '0.3.208', '0.3.100'],
    targetDeployedVersions: ['0.3.208', '0.3.150', '0.3.20', '0.3.9', '0.3.300'],
    ...over
  }
}

describe('promotable', () => {
  it('promote = previous env versions newer than the target; rollback = older ones deployed here; newest first', async () => {
    m.gather.mockImplementation(async (_id: number, o: { kind: string }) =>
      planInput(o.kind === 'rollback' ? {} : { targetDeployedVersions: ['0.3.208'] })
    )
    const r = await get(`/environments/${prodId}/promotable`, asOwner)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      data: {
        promote: ['0.3.210', '0.3.209'],
        rollback: ['0.3.150', '0.3.20', '0.3.9'],
        finish: null,
        previous: null
      }
    })
    // P29: names the environment promotions come from.
    m.gather.mockResolvedValue(planInput({ previous: { key: 'staging' } }))
    expect((await get(`/environments/${prodId}/promotable`, asOwner)).json().data.previous).toBe(
      'staging'
    )
  })

  it('P21: rollback offers only versions whose every build the Hub recorded', async () => {
    m.gather.mockImplementation(async (_id: number, o: { kind: string }) =>
      planInput(
        o.kind === 'rollback'
          ? { rollbackVersions: ['0.3.150', '0.3.9'] }
          : { targetDeployedVersions: ['0.3.208'] }
      )
    )
    const r = await get(`/environments/${prodId}/promotable`, asOwner)
    expect(r.json().data.rollback).toEqual(['0.3.150', '0.3.9'])
  })

  it('B5: offers the running version again while a Hub promotion of it stopped between components', async () => {
    const components = [
      { position: 1, name: 'api', kind: 'api' },
      { position: 2, name: 'frontend', kind: 'frontend' }
    ]
    m.gather.mockImplementation(async (_id: number, o: { kind: string }) =>
      planInput({
        components,
        ...(o.kind === 'rollback' ? {} : { targetDeployedVersions: ['0.3.208'] })
      })
    )
    const promotable = async () =>
      (await get(`/environments/${prodId}/promotable`, asOwner)).json().data
    // The Hub never promoted 0.3.208 here: nothing to finish.
    expect(await promotable()).toMatchObject({ promote: ['0.3.210', '0.3.209'], finish: null })
    const run = (status: string, steps: unknown[], kind = 'promote') =>
      db('nivaro_hub_deploys').insert({
        app_id: appId,
        environment_id: prodId,
        kind,
        version: '0.3.208',
        status,
        step: 'deploy api',
        plan: JSON.stringify({ steps }),
        started_at: new Date()
      })
    // A rollback run of 0.3.208 that stopped never counts.
    await run('cancelled', [{ kind: 'api', component: 'api', position: 1 }], 'rollback')
    expect(await promotable()).toMatchObject({ finish: null })
    // Stopped after the api deployed: the running version is offered to finish it.
    await run('cancelled', [
      { kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' },
      { kind: 'frontend', component: 'frontend', position: 2 }
    ])
    expect(await promotable()).toMatchObject({
      promote: ['0.3.210', '0.3.209', '0.3.208'],
      finish: '0.3.208'
    })
    // Finished: not offered again.
    await run('success', [
      { kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' },
      { kind: 'frontend', component: 'frontend', position: 2, deployedSha: 'beef' }
    ])
    expect(await promotable()).toMatchObject({ promote: ['0.3.210', '0.3.209'], finish: null })
    // A component added after that complete run is not a stopped promotion.
    components.push({ position: 3, name: 'worker', kind: 'api' })
    expect(await promotable()).toMatchObject({ finish: null })
  })

  it('no known current version: nothing to roll back to, every previous version promotes', async () => {
    m.gather.mockResolvedValue(planInput({ targetVersion: null }))
    const r = await get(`/environments/${prodId}/promotable`, asAdmin)
    expect(r.json().data.rollback).toEqual([])
    expect(r.json().data.promote).toEqual(['0.3.210', '0.3.209', '0.3.208', '0.3.100'])
  })

  it('phase 4: a first all-stack environment also offers published releases newer than it runs', async () => {
    m.gather.mockImplementation(async (_id: number, o: { kind: string }) =>
      planInput(
        o.kind === 'rollback'
          ? {}
          : {
              previousDeployedVersions: [],
              registryVersions: ['0.3.211', '0.3.210', '0.3.150', '0.3.9']
            }
      )
    )
    const r = await get(`/environments/${prodId}/promotable`, asAdmin)
    expect(r.json().data.promote).toEqual(['0.3.211', '0.3.210'])
  })
})

describe('plan', () => {
  it('returns the plan and never starts a promotion', async () => {
    m.gather.mockResolvedValue({
      app: { key: 'efp', name: 'EFP' },
      target: { key: 'prod' },
      previous: null,
      components: [],
      kind: 'promote',
      version: '0.3.209',
      targetVersion: '0.3.208',
      previousVersion: null,
      previousDeployedVersions: [],
      targetDeployedVersions: [],
      sources: {},
      frontendServed: {},
      frontendOnSource: {},
      sourceOnTarget: {},
      digest: null,
      slimDigest: null,
      running: false,
      targetState: 'ok',
      drivers: {}
    })
    const r = await post(`/environments/${prodId}/promote/plan`, asOwner, {
      version: '0.3.209',
      kind: 'promote'
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toHaveProperty('ok')
    expect(r.json().data).toHaveProperty('blockers')
    expect(m.gather).toHaveBeenCalledWith(prodId, { kind: 'promote', version: '0.3.209' })
    expect(m.start).not.toHaveBeenCalled()
  })

  it('bad kind is 400; a GitLab refusal keeps its code', async () => {
    const bad = await post(`/environments/${prodId}/promote/plan`, asAdmin, {
      version: '0.3.209',
      kind: 'nope'
    })
    expect(bad.statusCode).toBe(400)
    m.gather.mockRejectedValue(
      new GitlabWriteError('GITLAB_NO_TOKEN', 'no token', { step: 'gather' })
    )
    const r = await post(`/environments/${prodId}/promote/plan`, asAdmin, {
      version: '0.3.209',
      kind: 'promote'
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('GITLAB_NO_TOKEN')
  })
})

describe('promote', () => {
  const HASH = 'c'.repeat(64)
  const body = { version: '0.3.209', kind: 'promote', confirm: 'prod', plan_hash: HASH }

  it('202 with ids; the owner is the starter; one activity row on the deploy', async () => {
    m.start.mockResolvedValue({ deployId: 9, jobRunId: 12 })
    const r = await post(`/environments/${prodId}/promote`, asOwner, body)
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual({ data: { deploy_id: 9, job_run_id: 12 } })
    expect(m.start).toHaveBeenCalledWith(prodId, {
      kind: 'promote',
      version: '0.3.209',
      confirm: 'prod',
      planHash: HASH,
      user: { id: OWNER }
    })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub-promote-start',
        collection: 'nivaro_hub_deploys',
        item: '9',
        user: OWNER
      })
    )
  })

  it('blockers answer 409 with every blocker and log nothing', async () => {
    const blockers: PromotionBlocker[] = [
      { code: 'PREVIOUS_NEVER_RAN', text: 'x' },
      { code: 'ALREADY_RUNS', text: 'y' }
    ]
    m.start.mockRejectedValue(new PromotionError('VERSION_NOT_ON_PREVIOUS', 'x', 409, blockers))
    const r = await post(`/environments/${prodId}/promote`, asAdmin, body)
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'VERSION_NOT_ON_PREVIOUS', blockers })
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('CONFIRM_REQUIRED is 400; a held lock is 409 PROMOTION_RUNNING; lock trouble is 503', async () => {
    m.start.mockRejectedValueOnce(new PromotionError('CONFIRM_REQUIRED', 'Type prod', 400))
    const a = await post(`/environments/${prodId}/promote`, asAdmin, { ...body, confirm: '' })
    expect(a.statusCode).toBe(400)
    expect(a.json().code).toBe('CONFIRM_REQUIRED')
    m.start.mockRejectedValueOnce(
      new PromotionError('PROMOTION_RUNNING', 'running', 409, [
        { code: 'PROMOTION_RUNNING', text: 'running' }
      ])
    )
    const b = await post(`/environments/${prodId}/promote`, asAdmin, body)
    expect(b.statusCode).toBe(409)
    expect(b.json().code).toBe('PROMOTION_RUNNING')
    m.start.mockRejectedValueOnce(new PromotionError('LOCK_UNAVAILABLE', 'no lock', 503))
    expect((await post(`/environments/${prodId}/promote`, asAdmin, body)).statusCode).toBe(503)
  })

  it('PLAN_CHANGED is 409 with the plan as it stands now; a missing hash is 400', async () => {
    const now = { ok: true, blockers: [], lines: ['x'], steps: [], plan_hash: 'd'.repeat(64) }
    m.start.mockRejectedValueOnce(
      new PromotionError('PLAN_CHANGED', 'The plan changed', 409, undefined, now)
    )
    const r = await post(`/environments/${prodId}/promote`, asOwner, body)
    expect(r.statusCode).toBe(409)
    expect(r.json()).toEqual({ error: 'The plan changed', code: 'PLAN_CHANGED', plan: now })
    expect(logActivity).not.toHaveBeenCalled()
    m.start.mockRejectedValueOnce(new PromotionError('PLAN_HASH_REQUIRED', 'Send it', 400))
    const { plan_hash: _drop, ...noHash } = body
    const n = await post(`/environments/${prodId}/promote`, asOwner, noHash)
    expect(n.statusCode).toBe(400)
    expect(m.start).toHaveBeenLastCalledWith(
      prodId,
      expect.objectContaining({ planHash: undefined })
    )
  })

  it('the plan route answers a plan_hash', async () => {
    m.gather.mockResolvedValue({
      app: { key: 'efp', name: 'EFP' },
      target: { key: 'prod', hub_managed: true },
      previous: null,
      components: [],
      kind: 'promote',
      version: '0.3.209',
      targetVersion: '0.3.208',
      previousVersion: null,
      previousDeployedVersions: [],
      targetDeployedVersions: [],
      sources: {},
      frontendServed: {},
      frontendOnSource: {},
      sourceOnTarget: {},
      digest: null,
      slimDigest: null,
      running: false,
      targetState: 'ok',
      drivers: {}
    })
    const r = await post(`/environments/${prodId}/promote/plan`, asOwner, {
      version: '0.3.209',
      kind: 'promote'
    })
    expect(r.json().data.plan_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a maintenance freeze refuses the POST before the route runs', async () => {
    m.maint.mockResolvedValue({ on: true, message: 'down', until: null })
    const r = await post(`/environments/${prodId}/promote`, asOwner, body)
    expect(r.statusCode).toBe(503)
    expect(r.json().code).toBe('MAINTENANCE')
    expect(m.start).not.toHaveBeenCalled()
    // The plan is a read: it answers during maintenance.
    m.gather.mockRejectedValue(new PromotionError('NOT_FOUND', 'Not found', 404))
    const plan = await post(`/environments/${prodId}/promote/plan`, asOwner, {
      version: '0.3.209',
      kind: 'promote'
    })
    expect(plan.json().code).not.toBe('MAINTENANCE')
    expect(m.gather).toHaveBeenCalled()
  })
})

describe('history, detail and cancel', () => {
  it('lists Hub deploys newest first with the starter name and clamps limit', async () => {
    await db('nivaro_users')
      .del()
      .catch(() => undefined)
    await db('nivaro_users').insert({
      id: OWNER.toLowerCase(),
      first_name: 'Olive',
      last_name: 'Owner'
    })
    const r = await get(`/environments/${prodId}/deploys/hub?limit=500`, asOwner)
    expect(r.statusCode).toBe(200)
    const rows = r.json().data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: deployId, version: '0.3.209' })
    expect(rows[0].started_by_name).toBe('Olive Owner')
  })

  it('P27: answers never carry the GitLab repository a run is bound to', async () => {
    const bound = {
      position: 1,
      component: 'api',
      driverIdentity: 'https://gitlab.internal|efp/deploy'
    }
    await db('nivaro_hub_deploys')
      .where({ id: deployId })
      .update({ plan: JSON.stringify({ ok: true, steps: [bound] }), heartbeat_at: new Date() })
    const detail = (await get(`/promotions/${deployId}`, asOwner)).json().data
    expect(detail.plan.steps).toEqual([{ position: 1, component: 'api' }])
    m.start.mockRejectedValueOnce(
      new PromotionError('PLAN_CHANGED', 'changed', 409, undefined, { ok: true, steps: [bound] })
    )
    const r = await post(`/environments/${prodId}/promote`, asOwner, {
      version: '0.3.209',
      kind: 'promote',
      confirm: 'prod',
      plan_hash: 'c'.repeat(64)
    })
    expect(JSON.stringify(r.json())).not.toContain('gitlab.internal')
  })

  it('detail carries the parsed plan and the job log; no job run = empty log', async () => {
    m.log.mockResolvedValue([{ seq: 1, at: 't', level: 'info', line: 'hello' }])
    const r = await get(`/promotions/${deployId}`, asOwner)
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({
      id: deployId,
      plan: { ok: true },
      log: [{ seq: 1, at: 't', level: 'info', line: 'hello' }]
    })
    expect(m.log).toHaveBeenCalledWith(77)
    await db('nivaro_hub_deploys').where({ id: deployId }).update({ job_run_id: null })
    const r2 = await get(`/promotions/${deployId}`, asAdmin)
    expect(r2.json().data.log).toEqual([])
    expect((await get('/promotions/99999', asAdmin)).statusCode).toBe(404)
  })

  it('P25: a status read marks a run whose server stopped (no lock, stale heartbeat) interrupted', async () => {
    const r = await get(`/promotions/${deployId}`, asOwner)
    expect(r.json().data).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during deploy api'
    })
    // A run with a fresh heartbeat is left running, on both reads.
    await db('nivaro_hub_deploys')
      .where({ id: deployId })
      .update({ status: 'running', error: null, finished_at: null, heartbeat_at: new Date() })
    expect((await get(`/promotions/${deployId}`, asOwner)).json().data.status).toBe('running')
    const list = (await get(`/environments/${prodId}/deploys/hub`, asOwner)).json().data
    expect(list[0]).toMatchObject({ id: deployId, status: 'running' })
    // Stale again: the history read heals it.
    await db('nivaro_hub_deploys')
      .where({ id: deployId })
      .update({ heartbeat_at: new Date(Date.now() - 10 * 60_000) })
    const after = (await get(`/environments/${prodId}/deploys/hub`, asOwner)).json().data
    expect(after[0]).toMatchObject({ id: deployId, status: 'interrupted' })
  })

  it('P25: a cancel that healed the row answers its status', async () => {
    m.cancel.mockResolvedValueOnce({ ok: true, interrupted: true })
    const r = await post(`/promotions/${deployId}/cancel`, asOwner)
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual({ data: { id: deployId, status: 'interrupted' } })
  })

  it('cancel answers 202 and logs; NOT_RUNNING is 409', async () => {
    m.cancel.mockResolvedValueOnce({ ok: true })
    const r = await post(`/promotions/${deployId}/cancel`, asOwner)
    expect(r.statusCode).toBe(202)
    expect(m.cancel).toHaveBeenCalledWith(deployId, { id: OWNER })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub-promote-cancel',
        collection: 'nivaro_hub_deploys',
        item: String(deployId)
      })
    )
    m.cancel.mockResolvedValueOnce({ ok: false, code: 'NOT_RUNNING' })
    const r2 = await post(`/promotions/${deployId}/cancel`, asAdmin)
    expect(r2.statusCode).toBe(409)
    expect(r2.json().code).toBe('NOT_RUNNING')
  })
})
