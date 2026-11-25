import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 47: the retirement wizard end to end on an in-memory SQLite Hub (every hub
// migration run): plan + hash, the gates (order, MOVE_OPEN, freezes incl. an incident's, the
// retire checklist, typed confirms, by-hand environments, export skips), the five steps, Undo /
// Cancel up to the removal and never after it, and the runner's lease (a lost lease stops; a
// stale run is healed to interrupted and Resume finishes it). Every outside call is a fake.

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
vi.mock('../../../services/hub/notify-events.js', () => ({
  hubEventRecipients: vi.fn(async () => ['admin-1']),
  deliverHubNotice: vi.fn(async (ids: string[]) => ids.length)
}))
vi.mock('../../../services/hub/docker/stack-guards.js', async (orig) => ({
  ...(await orig<object>()),
  dockerTargetOf: vi.fn(async (envId: number) =>
    envId === 2
      ? { driver: { id: 1 }, stackName: 'shop-production', appKey: 'shop', envKey: 'production' }
      : null
  )
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const plan = await import('../../../services/hub/lifecycle/retire-plan.js')
const run = await import('../../../services/hub/lifecycle/retire-run.js')
const store = await import('../../../services/hub/lifecycle/retire-store.js')
const { freezeRefusal } = await import('../../../services/hub/releases/freeze.js')
const notify = await import('../../../services/hub/notify-events.js')

const MIGRATIONS = join(import.meta.dirname, '../../../db/migrations')
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'

const maintenance = vi.fn(async (_env: { id: number }, _on: boolean, _m: string | null) => {})
const startDbBackup = vi.fn(async () => 101)
const startFilesBackup = vi.fn(async () => 102)
const reads = new Map<number, number>()
const readDataRun = vi.fn(async (id: number) => {
  const n = (reads.get(id) ?? 0) + 1
  reads.set(id, n)
  // A verified database backup and a complete files set (review M5), the same facts each read.
  return n === 1
    ? { status: 'running', error: null }
    : {
        status: 'done',
        error: null,
        steps: [{ key: 'verify', state: 'done' }],
        artifact: {
          file: `/bak/${id}.bak`,
          size_bytes: 1000 + id,
          finished_at: 'f',
          set: `set-${id}`
        },
        result: { state: 'done', total: 3, copied: 3, failed: 0, too_large: 0, bytes: 99 }
      }
})
const removeStack = vi.fn(async () => 'removed' as const)
const deliver = vi.fn(
  async (ids: string[], _notice: import('../../../services/hub/notify-events.js').HubNotice) =>
    ids.length
)
const recipients = vi.fn(async () => ({ team: ['admin-1'], people: ['person-9'] }))
const linkMaintenance = vi.fn(async () => true as boolean | null)
const deps = {
  maintenance,
  linkMaintenance,
  startDbBackup,
  startFilesBackup,
  readDataRun,
  removeStack,
  deliver,
  recipients,
  sleep: async () => {},
  pollMs: 0,
  background: false
}

let retId = 0

async function current() {
  return (await store.readRetirement(retId)) as NonNullable<
    Awaited<ReturnType<typeof store.readRetirement>>
  >
}
async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code })
}

beforeAll(async () => {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^5[4-9]\d_hub_.*\.ts$/.test(f))
    .sort()
  for (const f of files) {
    const m = (await import(join(MIGRATIONS, f))) as { up: (k: Knex) => Promise<void> }
    await m.up(db)
  }
  await db('nivaro_hub_apps').insert({ id: 1, key: 'shop', name: 'Shop' })
  await db('nivaro_hub_placements').insert({ id: 7, kind: 'dedicated', driver_id: 1, target: '{}' })
  await db('nivaro_hub_environments').insert([
    {
      id: 1,
      app_id: 1,
      key: 'staging',
      position: 0,
      status: 'active',
      base_url: 'https://staging.shop.test',
      hub_token: 'sealed-staging'
    },
    {
      id: 2,
      app_id: 1,
      key: 'production',
      position: 1,
      status: 'active',
      base_url: 'https://shop.test',
      hub_token: 'sealed-prod',
      placement_id: 7,
      db_ref: 'hub-db:5'
    }
  ])
  await db('nivaro_hub_backup_policies').insert({
    environment_id: 2,
    files_target: JSON.stringify({ kind: 'dir', path: '/srv/backups' })
  })
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(() => {
  maintenance.mockClear()
  deliver.mockClear()
  vi.mocked(notify.deliverHubNotice).mockClear()
})

describe('plan', () => {
  it('names every environment, production by THE rule, and what each step will do', async () => {
    const p = await plan.retirePlan(1)
    expect(p.environments.map((e) => [e.key, e.production, e.kind, e.freeze])).toEqual([
      ['staging', false, 'manual', 'link'],
      ['production', true, 'docker', 'link']
    ])
    expect(p.production).toBe(true)
    expect(p.blockers).toEqual([])
    expect(p.lines.remove.join(' ')).toContain('shop-production')
    expect(p.plan_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('an open move blocks it', async () => {
    await db('nivaro_hub_moves').insert({
      id: 50,
      app_id: 1,
      environment_id: 1,
      from_placement_id: 7,
      to_placement_id: 8,
      kind: 'x',
      routing: 'manual',
      status: 'running',
      steps: '[]'
    })
    expect((await plan.retirePlan(1)).blockers.map((b) => b.code)).toEqual(['MOVE_OPEN'])
    await expectCode(run.openRetirement(1, { plan_hash: 'x' }, ADMIN), 'PLAN_BLOCKED')
    await db('nivaro_hub_moves').where({ id: 50 }).delete()
  })

  it('opens only on the plan read (PLAN_STALE), then once per app (RETIRE_OPEN)', async () => {
    await expectCode(run.openRetirement(1, { plan_hash: 'nope' }, ADMIN), 'PLAN_STALE')
    const p = await plan.retirePlan(1)
    const r = await run.openRetirement(1, { plan_hash: p.plan_hash, notice: 'Bye now.' }, ADMIN)
    retId = r.id
    expect(r.status).toBe('open')
    expect(r.steps.map((s) => s.state)).toEqual(Array(5).fill('pending'))
    expect((await plan.retirePlan(1)).blockers.map((b) => b.code)).toEqual(['RETIRE_OPEN'])
  })
})

describe('gates', () => {
  it('steps go in order', async () => {
    await expectCode(run.startStep(retId, 'export', {}, ADMIN, deps), 'STEP_OUT_OF_ORDER')
    await expectCode(run.startStep(retId, 'nope', {}, ADMIN, deps), 'BAD_STEP')
  })

  it('freezing an app with production needs the typed app key', async () => {
    await expectCode(run.startStep(retId, 'freeze', {}, ADMIN, deps), 'CONFIRM_REQUIRED')
  })

  it('a freeze (an incident’s) stops the step; MOVE_OPEN too', async () => {
    const now = Date.now()
    await db('nivaro_hub_freezes').insert({
      id: 900,
      app_id: 1,
      name: 'Incident #3',
      source: 'incident:3',
      recurrence: 'none',
      starts_at: new Date(now - 60_000),
      ends_at: new Date(now + 3600_000)
    })
    await expectCode(run.startStep(retId, 'freeze', { confirm: 'shop' }, ADMIN, deps), 'FROZEN')
    await db('nivaro_hub_freezes').where({ id: 900 }).delete()
    await db('nivaro_hub_moves').insert({
      id: 51,
      app_id: 1,
      environment_id: 2,
      from_placement_id: 7,
      to_placement_id: 8,
      kind: 'x',
      routing: 'manual',
      status: 'interrupted',
      steps: '[]'
    })
    await expectCode(run.startStep(retId, 'freeze', { confirm: 'shop' }, ADMIN, deps), 'MOVE_OPEN')
    await db('nivaro_hub_moves').where({ id: 51 }).delete()
  })

  it('a required retire checklist item must be ticked first', async () => {
    await db('nivaro_hub_checklist_items').insert({
      id: 30,
      app_id: 1,
      environment_id: null,
      text: 'Data owner agreed',
      required: true,
      tick_by: 'admin',
      actions: 'retire'
    })
    await expectCode(
      run.startStep(retId, 'freeze', { confirm: 'shop' }, ADMIN, deps),
      'CHECKLIST_REQUIRED'
    )
    await db('nivaro_hub_checklist_items').where({ id: 30 }).delete()
  })
})

describe('steps, undo and cancel', () => {
  it('freeze: a Hub freeze + strict maintenance on each linked environment', async () => {
    const r = await run.startStep(retId, 'freeze', { confirm: 'shop', note: 'go' }, ADMIN, deps)
    expect(r.id).toBe(retId)
    const after = await current()
    expect(after.status).toBe('open')
    const s = store.stepOf(after, 'freeze')
    expect(s.state).toBe('done')
    expect(s.signed_off_by).toBe(ADMIN)
    expect(s.sign_note).toBe('go')
    expect(maintenance.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([
      [1, true],
      [2, true]
    ])
    const f = await db('nivaro_hub_freezes')
      .where({ source: `retire:${retId}` })
      .first()
    expect(f).toBeTruthy()
    // The one freeze engine now refuses a promotion of the app …
    expect((await freezeRefusal({ appIds: [1], action: 'promote' }))?.code).toBe('FROZEN')
    // … but never this retirement's own next step.
    expect(await run.retireFreezeRefusal(after, [1, 2])).toBeNull()
  })

  it('export: what the Hub cannot back up must be skipped with a reason', async () => {
    await expectCode(run.startStep(retId, 'export', {}, ADMIN, deps), 'EXPORT_INCOMPLETE')
    const skipOnly = { skip: [{ environment_id: 1, what: 'db' }] }
    await expectCode(run.startStep(retId, 'export', skipOnly, ADMIN, deps), 'EXPORT_INCOMPLETE')
    const skip = {
      skip: [
        { environment_id: 1, what: 'db' },
        { environment_id: 1, what: 'files' }
      ]
    }
    // Review M5: a part the Hub CAN back up is never skipped.
    await expectCode(
      run.startStep(
        retId,
        'export',
        {
          skip: [...skip.skip, { environment_id: 2, what: 'db' }],
          reason: 'not needed at all',
          skip_confirm: 'shop'
        },
        ADMIN,
        deps
      ),
      'SKIP_NOT_ALLOWED'
    )
    await expectCode(
      run.startStep(retId, 'export', { ...skip, skip_confirm: 'shop' }, ADMIN, deps),
      'REASON_REQUIRED'
    )
    await expectCode(
      run.startStep(
        retId,
        'export',
        { ...skip, reason: 'staging holds test data only' },
        ADMIN,
        deps
      ),
      'CONFIRM_REQUIRED'
    )
    // Review M6: a linked app that does not report its maintenance on stops the export.
    linkMaintenance.mockResolvedValueOnce(false)
    await run.startStep(
      retId,
      'export',
      { ...skip, reason: 'staging holds test data only', skip_confirm: 'shop' },
      ADMIN,
      deps
    )
    expect(store.stepOf(await current(), 'export')).toMatchObject({ state: 'failed' })
    expect(String(store.stepOf(await current(), 'export').note)).toContain('maintenance on')
    await run.startStep(
      retId,
      'export',
      { ...skip, reason: 'staging holds test data only', skip_confirm: 'shop' },
      ADMIN,
      deps
    )
    const s = store.stepOf(await current(), 'export')
    expect(s.state).toBe('done')
    expect(startDbBackup).toHaveBeenCalledWith(2, ADMIN)
    expect(startFilesBackup).toHaveBeenCalledWith(2, ADMIN)
    const envs = s.detail.envs as Record<string, Record<string, unknown>>
    expect(envs['1']).toMatchObject({ db: 'skipped', files: 'skipped' })
    expect(envs['2']).toMatchObject({ db: 'done', files: 'done', db_run: 101, files_run: 102 })
    expect((envs['2'].db_fact as { fingerprint: string }).fingerprint).toMatch(/^[0-9a-f]{32}$/)
  })

  it('notice: to the team and the people who signed in; on the maintenance page', async () => {
    await run.startStep(retId, 'notice', {}, ADMIN, deps)
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([['admin-1'], ['person-9']])
    expect(deliver.mock.calls[0][1]).toMatchObject({ message: 'Bye now.', email: true })
    expect(deliver.mock.calls[1][1]).toMatchObject({ path: 'https://shop.test' })
    expect(maintenance.mock.calls.map((c) => c[2])).toEqual(['Bye now.', 'Bye now.'])
    expect(store.stepOf(await current(), 'notice').state).toBe('done')
  })

  it('undo goes back one reversible step at a time (notice: “called off”)', async () => {
    await run.undoLastStep(retId, ADMIN, deps)
    const r = await current()
    expect(store.stepOf(r, 'notice').state).toBe('pending')
    expect(store.stepOf(r, 'notice').signed_off_by).toBeNull()
    expect(deliver.mock.calls[0][0]).toEqual(['admin-1', 'person-9'])
    expect(String(deliver.mock.calls[0]?.[1]?.subject)).toContain('not being retired')
    expect(store.undoableStep(r)?.key).toBe('export')
  })

  it('cancel undoes every done step newest first and lifts the freeze', async () => {
    await run.cancelRetirement(retId, ADMIN, deps)
    const r = await current()
    expect(r.status).toBe('cancelled')
    expect(r.steps.map((s) => s.state)).toEqual(Array(5).fill('pending'))
    expect(maintenance.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([
      [2, false],
      [1, false]
    ])
    expect(await freezeRefusal({ appIds: [1], action: 'promote' })).toBeNull()
    await expectCode(
      run.startStep(retId, 'freeze', { confirm: 'shop' }, ADMIN, deps),
      'RETIRE_CLOSED'
    )
  })

  it('a new retirement runs to the end; nothing goes back from the removal on', async () => {
    const p = await plan.retirePlan(1)
    retId = (await run.openRetirement(1, { plan_hash: p.plan_hash }, ADMIN)).id
    await run.startStep(retId, 'freeze', { confirm: 'shop' }, ADMIN, deps)
    const skip = {
      skip: [
        { environment_id: 1, what: 'db' },
        { environment_id: 1, what: 'files' }
      ],
      reason: 'staging holds test data only',
      skip_confirm: 'shop'
    }
    await run.startStep(retId, 'export', skip, ADMIN, deps)
    await run.startStep(retId, 'notice', { notice: 'Shop closes today.' }, ADMIN, deps)
    // Remove: always the typed key; the environment the Hub cannot stop needs the person's word.
    await expectCode(run.startStep(retId, 'remove', {}, ADMIN, deps), 'CONFIRM_REQUIRED')
    await expectCode(
      run.startStep(retId, 'remove', { confirm: 'shop' }, ADMIN, deps),
      'MANUAL_NEEDED'
    )
    await expectCode(
      run.startStep(retId, 'remove', { confirm: 'shop', manual: [1] }, ADMIN, deps),
      'NOTE_REQUIRED'
    )
    await run.startStep(
      retId,
      'remove',
      { confirm: 'shop', manual: [1], note: 'Stopped the staging VM by hand' },
      ADMIN,
      deps
    )
    expect(removeStack).toHaveBeenCalledWith(2)
    const envs = await db('nivaro_hub_environments').orderBy('id').select('status', 'version_pin')
    expect(envs.map((e) => e.status)).toEqual(['suspended', 'suspended'])
    await expectCode(run.undoLastStep(retId, ADMIN, deps), 'NOT_UNDOABLE')
    await expectCode(run.cancelRetirement(retId, ADMIN, deps), 'NOT_CANCELLABLE')

    await run.startStep(retId, 'archive', {}, ADMIN, deps)
    const r = await current()
    expect(r.status).toBe('done')
    expect(r.finished_at).toBeTruthy()
    const app = await db('nivaro_hub_apps').where({ id: 1 }).first('archived_at', 'archived_by')
    expect(app.archived_at).toBeTruthy()
    expect(app.archived_by).toBe(ADMIN)
    expect((await db('nivaro_hub_environments').select('status')).map((e) => e.status)).toEqual([
      'archived',
      'archived'
    ])
    const f = await db('nivaro_hub_freezes')
      .where({ source: `retire:${retId}` })
      .first()
    // The freeze ends at archive: ENV_ARCHIVED refuses every start from here on.
    expect(new Date(f.ends_at).getTime()).toBeLessThanOrEqual(Date.now())
    expect((await plan.retirePlan(1)).blockers.map((b) => b.code)).toEqual(['APP_ARCHIVED'])
  })
})

describe('lease, heal and resume', () => {
  beforeAll(async () => {
    await db('nivaro_hub_apps').insert({ id: 2, key: 'blog', name: 'Blog' })
    await db('nivaro_hub_environments').insert({
      id: 3,
      app_id: 2,
      key: 'production',
      position: 0,
      status: 'active',
      base_url: 'https://blog.test',
      hub_token: 'sealed'
    })
  })

  it('a runner whose lease was taken stops before its next write', async () => {
    const p = await plan.retirePlan(2)
    retId = (await run.openRetirement(2, { plan_hash: p.plan_hash }, ADMIN)).id
    const stealing = {
      ...deps,
      maintenance: vi.fn(async () => {
        // Another Hub process healed and resumed the row meanwhile.
        await db('nivaro_hub_retirements').where({ id: retId }).update({ runner: 'someone-else' })
      })
    }
    await run.startStep(retId, 'freeze', { confirm: 'blog' }, ADMIN, stealing)
    const r = await current()
    expect(r.status).toBe('running')
    expect(store.stepOf(r, 'freeze').state).toBe('running')
  })

  it('a stale run is healed to interrupted; Resume finishes the same step', async () => {
    await db('nivaro_hub_retirements')
      .where({ id: retId })
      .update({ heartbeat_at: new Date(Date.now() - store.STALE_MS - 1000) })
    await expectCode(
      run.startStep(retId, 'freeze', { confirm: 'blog' }, ADMIN, deps),
      'RETIRE_RUNNING'
    )
    expect((await run.retireTick()).healed).toEqual([retId])
    const healed = await current()
    expect(healed.status).toBe('interrupted')
    expect(store.stepOf(healed, 'freeze').state).toBe('interrupted')
    await expectCode(
      run.startStep(retId, 'freeze', { confirm: 'blog' }, ADMIN, deps),
      'RETIRE_INTERRUPTED'
    )
    await run.resumeRetirement(retId, ADMIN, deps)
    const done = await current()
    expect(done.status).toBe('open')
    expect(store.stepOf(done, 'freeze').state).toBe('done')
    expect(store.stepOf(done, 'freeze').log.map((l) => l.what)).toEqual([
      'signed_off',
      'interrupted',
      'resumed',
      'done'
    ])
  })
})

describe('a retired (archived) app refuses every start: ENV_ARCHIVED', () => {
  // App 1 (shop) was archived by the retirement above: its environments 1 and 2 are archived.
  const actions = ['promote', 'apply', 'move', 'config_promote', 'extension_promote'] as const

  it('through the freeze engine, for every gated action, by environment and by app', async () => {
    const { environmentFreezeRefusal } = await import('../../../services/hub/releases/freeze.js')
    for (const action of actions) {
      expect((await freezeRefusal({ appIds: [1], action, envId: 2 }))?.code, action).toBe(
        'ENV_ARCHIVED'
      )
      // Schedules, train steps and scaling judge the app (with or without an environment).
      expect((await freezeRefusal({ appIds: [1], action }))?.code, action).toBe('ENV_ARCHIVED')
    }
    const move = await environmentFreezeRefusal(1, 'move')
    expect(move).toMatchObject({ code: 'ENV_ARCHIVED', status: 409 })
    expect(move?.message).toContain('is retired (archived)')
    // Another app's start is untouched.
    expect((await freezeRefusal({ appIds: [2], action: 'promote', envId: 3 }))?.code).not.toBe(
      'ENV_ARCHIVED'
    )
  })

  it('restart and rollback ask the same helper; scaling blocks even a change by hand', async () => {
    const { archivedRefusal } = await import('../../../services/hub/releases/archived.js')
    expect((await archivedRefusal({ envId: 2 }))?.code).toBe('ENV_ARCHIVED')
    expect(await archivedRefusal({ envId: 3 })).toBeNull()
    const { scalePauses } = await import('../../../services/hub/scale/pause.js')
    const target = {
      kind: 'environment',
      id: 2,
      key: 'shop/production',
      label: 'Shop · production',
      confirm: 'production',
      app_ids: [1],
      env_ids: [2],
      production: true,
      stack: null,
      driver: null
    } as never
    const deps = {
      envLock: { held: async () => false } as never,
      incidentOpen: (async () => null) as never
    }
    const manual = await scalePauses(target, 'manual', deps)
    expect(manual.blockers.map((b) => b.code)).toContain('ENV_ARCHIVED')
  })
})

describe('a retiring app’s freeze never holds back its shared deployment', () => {
  it('a shared upgrade runs during a retirement; a person’s freeze still stops it', async () => {
    const { sharedFreezeRefusal } = await import('../../../services/hub/releases/freeze.js')
    await db('nivaro_hub_placements').insert({
      id: 20,
      kind: 'shared',
      shared_deployment_id: 9,
      target: '{}'
    })
    await db('nivaro_hub_environments').where({ id: 3 }).update({ placement_id: 20 })
    const now = Date.now()
    const freeze = {
      app_id: 2,
      recurrence: 'none',
      starts_at: new Date(now - 60_000),
      ends_at: new Date(now + 3600_000)
    }
    await db('nivaro_hub_freezes').insert({
      ...freeze,
      id: 950,
      name: 'Retiring blog',
      source: 'retire:77'
    })
    // The retirement's own freeze still holds the app's own starts.
    expect((await freezeRefusal({ appIds: [2], action: 'promote', envId: 3 }))?.code).toBe('FROZEN')
    // … but the deployment's upgrade goes ahead.
    expect(await sharedFreezeRefusal(9)).toBeNull()
    await db('nivaro_hub_freezes').insert({ ...freeze, id: 951, name: 'Quarter end' })
    expect((await sharedFreezeRefusal(9))?.code).toBe('FROZEN')
    await db('nivaro_hub_freezes').whereIn('id', [950, 951]).delete()
  })
})

describe('review round: one open retirement, cancel from interrupted, export re-check', () => {
  beforeAll(async () => {
    await db('nivaro_hub_apps').insert({ id: 3, key: 'desk', name: 'Desk' })
    await db('nivaro_hub_environments').insert({
      id: 30,
      app_id: 3,
      key: 'production',
      position: 0,
      status: 'active',
      base_url: 'https://desk.test',
      hub_token: 'sealed',
      db_ref: 'hub-db:9'
    })
    await db('nivaro_hub_backup_policies').insert({
      environment_id: 30,
      files_target: JSON.stringify({ kind: 'dir', path: '/srv/backups' })
    })
  })

  it('a double-click opens one retirement; the other is refused RETIRE_OPEN', async () => {
    const p = await plan.retirePlan(3)
    const out = await Promise.allSettled([
      run.openRetirement(3, { plan_hash: p.plan_hash }, ADMIN),
      run.openRetirement(3, { plan_hash: p.plan_hash }, ADMIN)
    ])
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toMatchObject({ code: expect.stringMatching(/RETIRE_OPEN|PLAN_BLOCKED/) })
    const open = await db('nivaro_hub_retirements')
      .where({ app_id: 3 })
      .whereIn('status', ['open', 'running', 'interrupted'])
    expect(open).toHaveLength(1)
    retId = Number(open[0].id)
  })

  it('an interrupted retirement is cancelled without any gate, lifting maintenance and freeze', async () => {
    await run.startStep(retId, 'freeze', { confirm: 'desk' }, ADMIN, deps)
    await db('nivaro_hub_retirements')
      .where({ id: retId })
      .update({ status: 'interrupted', step: 'export' })
    // An incident freeze would stop a forward step — never the way back.
    const now = Date.now()
    await db('nivaro_hub_freezes').insert({
      id: 960,
      app_id: 3,
      name: 'Incident',
      source: 'incident:9',
      recurrence: 'none',
      starts_at: new Date(now - 60_000),
      ends_at: new Date(now + 3600_000)
    })
    maintenance.mockClear()
    await run.cancelRetirement(retId, ADMIN, deps, 'Owner changed their mind')
    const r = await current()
    expect(r.status).toBe('cancelled')
    expect(r.error).toBe('Cancelled: Owner changed their mind')
    expect(maintenance.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([[30, false]])
    const live = await db('nivaro_hub_freezes')
      .where({ source: `retire:${retId}` })
      .where('ends_at', '>', new Date())
    expect(live).toHaveLength(0)
    await db('nivaro_hub_freezes').where({ id: 960 }).delete()
    // The app's claim is free again: a new retirement opens.
    const p = await plan.retirePlan(3)
    retId = (await run.openRetirement(3, { plan_hash: p.plan_hash }, ADMIN)).id
  })

  it('a backup that changed after the export refuses the removal; a new environment the archive', async () => {
    await run.startStep(retId, 'freeze', { confirm: 'desk' }, ADMIN, deps)
    await run.startStep(retId, 'export', {}, ADMIN, deps)
    await run.startStep(retId, 'notice', {}, ADMIN, deps)
    const changed = {
      ...deps,
      readDataRun: vi.fn(async () => ({
        status: 'done',
        error: null,
        steps: [{ key: 'verify', state: 'done' }],
        artifact: { file: '/bak/x.bak', size_bytes: 1, finished_at: 'f', deleted_at: 'yesterday' },
        result: { state: 'done', total: 3, copied: 3, failed: 0, too_large: 0, bytes: 99 }
      }))
    }
    await run.startStep(
      retId,
      'remove',
      { confirm: 'desk', manual: [30], note: 'Stopped by hand' },
      ADMIN,
      changed
    )
    const failed = store.stepOf(await current(), 'remove')
    expect(failed.state).toBe('failed')
    expect(failed.note).toContain('gone or changed')
    expect((await db('nivaro_hub_environments').where({ id: 30 }).first('status')).status).toBe(
      'active'
    )
    // With the backups intact the removal goes; then an environment added since blocks archive.
    await run.startStep(
      retId,
      'remove',
      { confirm: 'desk', manual: [30], note: 'Stopped by hand' },
      ADMIN,
      deps
    )
    expect(store.stepOf(await current(), 'remove').state).toBe('done')
    await db('nivaro_hub_environments').insert({
      id: 31,
      app_id: 3,
      key: 'dr',
      position: 1,
      status: 'active',
      base_url: 'https://dr.desk.test'
    })
    await expectCode(run.startStep(retId, 'archive', {}, ADMIN, deps), 'NEW_ENVIRONMENT')
    await db('nivaro_hub_environments').where({ id: 31 }).delete()
    await run.startStep(retId, 'archive', {}, ADMIN, deps)
    expect((await current()).status).toBe('done')
  })
})
