import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, final review moves I-2 (ruling P6-37): an open move (running, waiting or
// interrupted — the last holds no lock) refuses the person-facing actions that would change what
// it relies on: 409 MOVE_OPEN naming the move. services/hub/move-open.ts is the one helper; this
// file covers the helper, place-on-shared, the shared upgrade (plan blocker + start) and
// promotions (startPromotion, which promote/rollback and Apply now share). The routes are in
// routes/hub-move-open-routes.test.ts. Real SQLite with the hub tables (542–553).

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

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
const MoveOpen = await import('../../../services/hub/move-open.js')
const { OPEN_MOVE_STATUSES } = await import('../../../services/hub/move/rows.js')
const Store = await import('../../../services/hub/shared/store.js')
const Place = await import('../../../services/hub/shared/place.js')
const Plan = await import('../../../services/hub/shared/upgrade-plan.js')
const Run = await import('../../../services/hub/shared/upgrade-run.js')
const { startPromotion, startStackApply } = await import('../../../services/hub/promote-run.js')
const { sharedLock, memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')

const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }
let seq = 0
let driverId = 0

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

async function newShared(): Promise<number> {
  const key = `sh${++seq}`
  const v = Store.validateSharedInput({
    key,
    name: key,
    link_url: `https://${key}.internal.example.com`,
    mode: 'docker',
    driver_id: driverId,
    stack: key,
    host_pattern: '*.apps.example.com',
    extensions: []
  })
  if (!v.ok) throw new Error(v.code)
  const id = (await Store.createShared(v.row, null)).row.id
  await db('nivaro_hub_shared_deployments')
    .where({ id })
    .update({ version_pin: '0.3.209', status: 'active' })
  return id
}

async function sharedPlacement(sharedId: number) {
  return insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: sharedId,
    target: JSON.stringify({ pool_max: 5 })
  })
}

async function dockerPlacement() {
  return insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: driverId,
    target: JSON.stringify({ stack: `stk${++seq}` })
  })
}

async function newEnv(o: Record<string, unknown> = {}) {
  const key = `app${++seq}`
  const appId = await insertId('nivaro_hub_apps', { key, name: key })
  const envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'production',
    status: 'active',
    base_url: `https://${key}.apps.example.com`,
    hostnames: '[]',
    version_pin: '0.3.209',
    ...o
  })
  return { appId, appKey: key, envId }
}

async function newMove(
  e: { appId: number; envId: number },
  from: number,
  to: number,
  status = 'interrupted'
) {
  return insertId('nivaro_hub_moves', {
    app_id: e.appId,
    environment_id: e.envId,
    from_placement_id: from,
    to_placement_id: to,
    kind: 'to_shared',
    routing: 'manual',
    status,
    steps: '[]'
  })
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (err) {
    return err as { code: string; message: string }
  }
  throw new Error('expected a refusal')
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const m of migrations) await m.up(db)
  driverId = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify({
      agent_url: 'https://agent.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'example.com',
      edge_target: null
    }),
    secret: sealSecret('agent-Token-Value-0123456789-abcdefghij')
  })
})

afterAll(async () => {
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

describe('openMoveFor / moveOpenRefusal', () => {
  it('the open statuses are the move runner’s own list', () => {
    expect([...MoveOpen.MOVE_OPEN_STATUSES].sort()).toEqual([...OPEN_MOVE_STATUSES].sort())
  })

  it('finds a move by its environment, or by a from/to placement of the shared deployment', async () => {
    const shared = await newShared()
    const other = await newShared()
    const src = await dockerPlacement()
    const dst = await sharedPlacement(shared)
    const e = await newEnv({ placement_id: src })
    const id = await newMove(e, src, dst)

    const byEnv = await MoveOpen.openMoveFor({ envIds: [e.envId] })
    expect(byEnv).toMatchObject({ id, environment_id: e.envId, status: 'interrupted' })
    expect(byEnv?.label).toBe(`${e.appKey}/production`)
    expect((await MoveOpen.openMoveFor({ sharedId: shared }))?.id).toBe(id)
    expect(await MoveOpen.openMoveFor({ sharedId: other })).toBeNull()
    // Out of a deployment counts too (from placement).
    const back = await newEnv({ placement_id: dst })
    const out = await newMove(
      back,
      await sharedPlacement(other),
      await dockerPlacement(),
      'waiting'
    )
    expect((await MoveOpen.openMoveFor({ sharedId: other }))?.id).toBe(out)

    const r = await MoveOpen.moveOpenRefusal({ envIds: [e.envId] })
    expect(r).toEqual({
      code: 'MOVE_OPEN',
      status: 409,
      move_id: id,
      message: `The move of ${e.appKey}/production (move ${id}) is interrupted: resume it or roll it back first.`
    })
  })

  it('a finished, rolled-back or planned move is not open; nothing asked = nothing found', async () => {
    const src = await dockerPlacement()
    const e = await newEnv({ placement_id: src })
    for (const s of ['success', 'rolled_back', 'failed', 'planned', 'cancelled'])
      await newMove(e, src, await dockerPlacement(), s)
    expect(await MoveOpen.openMoveFor({ envIds: [e.envId] })).toBeNull()
    expect(await MoveOpen.openMoveFor({})).toBeNull()
  })
})

describe('MOVE_OPEN refusals', () => {
  it('place-on-shared: the environment has an open move', async () => {
    const shared = await newShared()
    const src = await dockerPlacement()
    const e = await newEnv({ placement_id: src, status: 'provisioning' })
    const id = await newMove(e, src, await sharedPlacement(shared))
    const err = await refusal(
      Place.placeOnShared(
        e.envId,
        { shared_id: shared, database_id: 1, first_admin: { email: 'a@example.com' } },
        'admin-1',
        { lock: memoryPromoteLock }
      )
    )
    expect(err).toMatchObject({ code: 'MOVE_OPEN', statusCode: 409 })
    expect(err.message).toContain(`move ${id}`)
    expect(await memoryPromoteLock.held(e.envId)).toBe(false)
  })

  it('shared upgrade: the plan is blocked MOVE_OPEN and the start answers 409 MOVE_OPEN', async () => {
    const shared = await newShared()
    const src = await dockerPlacement()
    const e = await newEnv({ placement_id: src })
    const id = await newMove(e, src, await sharedPlacement(shared))
    const deps = {
      agentHealth: vi.fn(async () => {
        throw new Error('not read')
      }),
      imageDigest: vi.fn(async () => `sha256:${'a'.repeat(64)}`),
      client: () => ({ appStatus: vi.fn() }),
      sharedLock: sharedLock(null),
      envLock: memoryPromoteLock,
      hubPublicUrl: () => 'https://hub.example.com',
      hubUrlWarning: () => null
    }
    const plan = await Plan.planSharedUpgrade(shared, '0.3.210', 'upgrade', deps as never)
    const blocker = plan.blockers.find((b) => b.code === 'MOVE_OPEN')
    expect(blocker?.text).toContain(`move ${id}`)
    const err = await refusal(
      Run.startSharedUpgrade(
        shared,
        { version: '0.3.210', plan_hash: plan.plan_hash, confirm: plan.confirm },
        'admin-1',
        deps as never
      )
    )
    expect(err).toMatchObject({ code: 'MOVE_OPEN', statusCode: 409 })
    // A re-apply (token rotation, settings) is not started either.
    const sh = await Store.getShared(shared)
    expect(await Run.startSharedReapply(sh as never, 'admin-1', deps as never)).toEqual({
      started: false,
      reason: 'MOVE_OPEN'
    })
  })

  it('promote, rollback and Apply now (startPromotion) answer 409 MOVE_OPEN', async () => {
    const src = await dockerPlacement()
    const e = await newEnv({ placement_id: src })
    await newMove(e, src, await sharedPlacement(await newShared()), 'running')
    for (const p of [
      startPromotion(e.envId, {
        kind: 'promote',
        version: '0.3.210',
        confirm: 'production',
        planHash: 'x',
        user: { id: 'u' }
      }),
      startPromotion(e.envId, {
        kind: 'rollback',
        version: '0.3.208',
        confirm: 'production',
        planHash: 'x',
        user: { id: 'u' }
      }),
      startStackApply(e.envId, { confirm: 'production', user: { id: 'u' } })
    ]) {
      const err = (await refusal(p)) as unknown as { code: string; status: number }
      expect(err).toMatchObject({ code: 'MOVE_OPEN', status: 409 })
    }
  })
})

describe('the move runner never passes through the guarded entry points', () => {
  // The guard sits on the callers a person reaches; the move deploys with lower-level steps
  // (deployComponentAt, prepareStackSpec, the agent, its own shared render). If a move module
  // ever imported one of these, its own action would refuse itself MOVE_OPEN.
  const GUARDED = [
    'startPromotion',
    'startStackApply',
    'startSharedUpgrade',
    'startSharedReapply',
    'gatherSharedUpgrade',
    'planSharedUpgrade',
    'placeOnShared',
    'moveOpenRefusal',
    'openMoveFor'
  ]
  it('no file under services/hub/move (nor routes/hub-move.ts) names them', () => {
    const root = join(import.meta.dirname, '../../..')
    const dir = join(root, 'services/hub/move')
    const files = [
      ...readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(dir, f)),
      join(root, 'routes/hub-move.ts')
    ]
    expect(files.length).toBeGreaterThan(5)
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const name of GUARDED)
        if (new RegExp(`\\b${name}\\b`).test(text)) hits.push(`${f}: ${name}`)
    }
    expect(hits).toEqual([])
  })
})
