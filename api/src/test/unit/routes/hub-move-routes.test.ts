import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 16: the move routes (routes/hub-move.ts) mounted through hubRoutes.
// Real SQLite with the hub tables (542–553); auth is mocked (x-user / x-admin headers); the
// planner and every side effect are fakes put in place through setMoveRunDeps.

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
  await import('../../../db/migrations/553_hub_moves.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const Run = await import('../../../services/hub/move/run.js')
const { MOVE_STEPS, MANUAL_MOVE_STEPS } = await import('../../../services/hub/move/plan.js')
const { memoryPromoteLock, sharedLock } = await import('../../../services/hub/promote-lock.js')
type MovePlan = import('../../../services/hub/move/types.js').MovePlan
type MoveOps = import('../../../services/hub/move/ops.js').MoveOps

const HUB_KEY = 'e'.repeat(64)
const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asUser = { 'x-user': 'BBBBBBBB-0000-4000-8000-000000000002' }
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

let app: FastifyInstance
let envId = 0
let sharedId = 0
let plan: MovePlan
let serving = true
const calls: string[] = []

function planOf(routing: 'automatic' | 'manual' = 'automatic'): MovePlan {
  return {
    kind: 'to_shared',
    routing,
    steps: [...(routing === 'manual' ? MANUAL_MOVE_STEPS : MOVE_STEPS).to_shared],
    route: [{ side: 'target', op: 'add_host', host: 'acme.example.com' }],
    manual_request: routing === 'manual' ? 'Point the name' : null,
    version: '0.3.210',
    hostnames: ['acme.example.com'],
    files: { count: 0, bytes: 0, first_pull: 'full' },
    blockers: [],
    warnings: [],
    checklist: [{ id: 'callbacks_registered', text: 'Register the callbacks', required: true }],
    plan_hash: 'c'.repeat(64)
  }
}

function ops(): MoveOps {
  const r =
    <T>(name: string, v: T) =>
    async () => {
      calls.push(name)
      return v
    }
  return {
    sourceMaintenance: r('sourceMaintenance', undefined),
    targetMaintenance: r('targetMaintenance', undefined),
    freezeTarget: r('freezeTarget', undefined),
    dropTempHost: r('dropTempHost', null),
    verifyTargetKey: r('verifyTargetKey', undefined),
    targetKeyFp: r('targetKeyFp', 'a'.repeat(32)),
    sourceBusy: r('sourceBusy', { imports: 0, exports: 0, renders: 0 }),
    pullFiles: async () => ({
      state: 'done',
      total: 0,
      copied: 0,
      skipped: 0,
      failed: 0,
      missing: [],
      bytes: 0,
      error: null
    }),
    placeOnTarget: r('placeOnTarget', undefined),
    unplace: r('unplace', undefined),
    waitReplicas: r('waitReplicas', undefined),
    targetUnretire: r('targetUnretire', undefined),
    targetReady: r('targetReady', undefined),
    deployTarget: r('deployTarget', undefined),
    removeTarget: r('removeTarget', undefined),
    route: r('route', undefined),
    unroute: r('unroute', undefined),
    verifyName: async () => {
      calls.push('verifyName')
      return serving
    },
    retireSource: r('retireSource', undefined),
    revokeTickets: r('revokeTickets', undefined),
    databaseIdentity: r('databaseIdentity', 'pg|db|5432|acme')
  }
}

let t = Date.parse('2026-11-22T10:00:00Z')

function deps(o: Record<string, unknown> = {}) {
  Run.setMoveRunDeps({
    ops: () => ops(),
    planner: async () => plan,
    lock: memoryPromoteLock,
    sharedLock: sharedLock(null),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
      await new Promise((r) => setTimeout(r, 5))
    },
    startJobRun: async () => ({
      id: 9,
      progress: () => undefined,
      log: () => undefined,
      complete: async () => undefined,
      fail: async () => undefined
    }),
    addresses: async () => ({
      source_link_base: 'https://src.direct.example.com',
      source_link_public: false,
      pull_source: 'https://src.direct.example.com',
      target_link_base: null,
      target_publish_host: null,
      target_temp_host: null
    }),
    renewMs: 3_600_000,
    manualPollMs: 60 * 60_000,
    ...o
  })
}

const inject = (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = asAdmin
) =>
  app.inject({
    method,
    url: `/api/hub${url}`,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {})
  })

const startBody = (o: Record<string, unknown> = {}) => ({
  to: { kind: 'shared', shared_id: sharedId },
  plan_hash: plan.plan_hash,
  confirm: 'acme/prod',
  checklist: { callbacks_registered: true },
  ...o
})

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

async function freshEnv(): Promise<void> {
  await db('nivaro_hub_moves').del()
  await db('nivaro_hub_deploys').del()
  await db('nivaro_hub_environments').where({ id: envId }).update({ status: 'active' })
  const p = await db('nivaro_hub_placements').where({ kind: 'dedicated' }).first('id')
  await db('nivaro_hub_environments').where({ id: envId }).update({ placement_id: p.id })
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const m of migrations) await m.up(db)
  sharedId = await insertId('nivaro_hub_shared_deployments', {
    key: 'shared-one',
    name: 'Shared one',
    mode: 'docker',
    link_url: 'https://shared.internal.example.com',
    status: 'active',
    version_pin: '0.3.210'
  })
  const driver = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: 'agent',
    config: JSON.stringify({ agent_url: 'https://agent.example.com' })
  })
  const placement = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: driver,
    target: JSON.stringify({ stack: 'acme-prod' })
  })
  const appId = await insertId('nivaro_hub_apps', { key: 'acme', name: 'Acme' })
  envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    status: 'active',
    base_url: 'https://acme.example.com',
    hostnames: '[]',
    placement_id: placement
  })
  const { setAppKey } = await import('../../../services/hub/shared/store.js')
  await setAppKey(envId, 'ab'.repeat(32))
  app = Fastify()
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  Run.setMoveRunDeps(null)
  await app.close()
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

beforeEach(async () => {
  plan = planOf()
  serving = true
  calls.length = 0
  activity.rows = []
  deps()
  await freshEnv()
})

describe('hub move routes', () => {
  it('every route answers 403 to a non-admin', async () => {
    const routes: Array<['GET' | 'POST', string]> = [
      ['POST', `/environments/${envId}/move/plan`],
      ['POST', `/environments/${envId}/move`],
      ['GET', '/moves/1'],
      ['GET', `/environments/${envId}/moves`],
      ['POST', '/moves/1/cancel'],
      ['POST', '/moves/1/resume'],
      ['POST', '/moves/1/confirm-route'],
      ['POST', '/moves/1/checklist']
    ]
    for (const [method, url] of routes) {
      const r = await inject(method, url, method === 'POST' ? {} : undefined, asUser)
      expect(r.statusCode, url).toBe(403)
    }
    expect(await db('nivaro_hub_moves').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('plan answers the planner’s plan; a bad target is 400', async () => {
    const ok = await inject('POST', `/environments/${envId}/move/plan`, {
      to: { kind: 'shared', shared_id: sharedId }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.plan_hash).toBe(plan.plan_hash)
    const bad = await inject('POST', `/environments/${envId}/move/plan`, { to: { kind: 'x' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_TARGET')
  })

  it('start: wrong confirm → 400 CONFIRM_MISMATCH; open required item → 409 CHECKLIST_INCOMPLETE; stale hash → 409 PLAN_CHANGED with the plan', async () => {
    const wrong = await inject(
      'POST',
      `/environments/${envId}/move`,
      startBody({ confirm: 'prod' })
    )
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json()).toMatchObject({ code: 'CONFIRM_MISMATCH', statusCode: 400 })
    const open = await inject('POST', `/environments/${envId}/move`, startBody({ checklist: {} }))
    expect(open.statusCode).toBe(409)
    expect(open.json()).toMatchObject({
      code: 'CHECKLIST_INCOMPLETE',
      open: ['callbacks_registered']
    })
    expect(open.json().message).toContain('Register the callbacks')
    const stale = await inject(
      'POST',
      `/environments/${envId}/move`,
      startBody({ plan_hash: 'd'.repeat(64) })
    )
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('PLAN_CHANGED')
    expect(stale.json().plan.plan_hash).toBe(plan.plan_hash)
    expect(await db('nivaro_hub_moves').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('start → 202 {move_id}; GET the move and the list; a second start → 409 BUSY', async () => {
    plan = planOf('manual')
    serving = false
    const r = await inject('POST', `/environments/${envId}/move`, startBody())
    expect(r.statusCode).toBe(202)
    const id = r.json().data.move_id as number
    expect(id).toBeGreaterThan(0)
    const again = await inject('POST', `/environments/${envId}/move`, startBody())
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('BUSY')
    for (let i = 0; i < 200; i++) {
      const g = await inject('GET', `/moves/${id}`)
      if (g.json().data.status === 'waiting') break
      await new Promise((res) => setTimeout(res, 5))
    }
    const one = await inject('GET', `/moves/${id}`)
    expect(one.json().data).toMatchObject({ id, status: 'waiting', kind: 'to_shared' })
    const list = await inject('GET', `/environments/${envId}/moves`)
    expect(list.json().data.map((m: { id: number }) => m.id)).toEqual([id])

    // confirm-route while the name does not serve, then the checklist, then cancel.
    const c1 = await inject('POST', `/moves/${id}/confirm-route`, {})
    expect(c1.json().data).toEqual({ serving: false })
    const tick = await inject('POST', `/moves/${id}/checklist`, {
      item: 'callbacks_registered',
      done: false
    })
    expect(tick.statusCode).toBe(200)
    expect(tick.json().data[0]).toMatchObject({ id: 'callbacks_registered', done: false })
    const unknown = await inject('POST', `/moves/${id}/checklist`, { item: 'nope', done: true })
    expect(unknown.json().code).toBe('UNKNOWN_ITEM')
    const resume = await inject('POST', `/moves/${id}/resume`, {})
    expect(resume.statusCode).toBe(409)
    expect(resume.json().code).toBe('NOT_INTERRUPTED')
    const cancel = await inject('POST', `/moves/${id}/cancel`, {})
    expect(cancel.statusCode).toBe(202)
    await Run.awaitMove(id)
    expect((await inject('GET', `/moves/${id}`)).json().data.status).toBe('cancelled')
    const late = await inject('POST', `/moves/${id}/cancel`, {})
    expect(late.json().code).toBe('MOVE_ENDED')
  })

  // R6-M-1: no sealed value (open transfer tickets, anything sealed with the Hub key) and no lock
  // token ever leaves in a move answer, one move or the list.
  it('R6-M-1: GET /moves/:id and the list hold no sealed value and no lock token', async () => {
    const r = await inject('POST', `/environments/${envId}/move`, startBody())
    const id = r.json().data.move_id as number
    await Run.awaitMove(id)
    const { sealSecret } = await import('../../../services/hub/secrets.js')
    const { isEncrypted } = await import('../../../services/encryption.js')
    const row = await db('nivaro_hub_moves').where({ id }).first()
    const steps = JSON.parse(String(row.steps))
    steps.open_tickets = [sealSecret(`nvt_${'Q'.repeat(43)}`)]
    steps.addresses = { ...(steps.addresses ?? {}), note: sealSecret('anything sealed') }
    steps.locks = { env: 'env-token-1', shared: [{ id: 1, token: 'shared-token-1' }] }
    await db('nivaro_hub_moves')
      .where({ id })
      .update({ steps: JSON.stringify(steps) })
    const sealedIn = (v: unknown): boolean =>
      isEncrypted(v) ||
      (Array.isArray(v)
        ? v.some(sealedIn)
        : !!v && typeof v === 'object' && Object.values(v).some(sealedIn))
    for (const body of [
      (await inject('GET', `/moves/${id}`)).json().data,
      (await inject('GET', `/environments/${envId}/moves`)).json().data
    ]) {
      expect(sealedIn(body)).toBe(false)
      const text = JSON.stringify(body)
      expect(text).not.toContain('open_tickets')
      expect(text).not.toContain('env-token-1')
      expect(text).not.toContain('shared-token-1')
    }
    // Dates and the rest of the move are answered as they were.
    const one = (await inject('GET', `/moves/${id}`)).json().data
    expect(typeof one.started_at).toBe('string')
    expect(one.steps.list.length).toBeGreaterThan(0)
  })

  it('a move that ran to the end answers success; confirm-route on it is 409 NOT_WAITING', async () => {
    const r = await inject('POST', `/environments/${envId}/move`, startBody())
    const id = r.json().data.move_id as number
    await Run.awaitMove(id)
    expect((await inject('GET', `/moves/${id}`)).json().data.status).toBe('success')
    const c = await inject('POST', `/moves/${id}/confirm-route`, {})
    expect(c.statusCode).toBe(409)
    expect(c.json().code).toBe('NOT_WAITING')
    // Nothing answered carries a secret column: the stored move has none.
    expect(JSON.stringify((await inject('GET', `/moves/${id}`)).json())).not.toMatch(
      /token|ticket|password/i
    )
  })

  it('unknown ids answer 404', async () => {
    expect((await inject('GET', '/moves/999')).statusCode).toBe(404)
    expect((await inject('GET', '/moves/abc')).statusCode).toBe(404)
    expect((await inject('POST', '/moves/999/cancel', {})).statusCode).toBe(404)
    expect((await inject('GET', '/environments/999/moves')).statusCode).toBe(404)
  })
})
