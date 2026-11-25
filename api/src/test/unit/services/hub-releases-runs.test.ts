import type { Knex } from 'knex'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub release operations against real SQLite (migrations 542/543/565): release trains through
// their holds, scheduled starts under freeze windows, and automatic rollback watches. Every
// promotion start, figure read and notification is injected — nothing leaves the process.

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m565 = await import('../../../db/migrations/565_hub_release_ops.js')
const trains = await import('../../../services/hub/releases/trains.js')
const schedules = await import('../../../services/hub/releases/schedules.js')
const rollback = await import('../../../services/hub/releases/auto-rollback.js')
const { PromotionError } = await import('../../../services/hub/promote-lock.js')

const USER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
let appId: number
const env: Record<string, number> = {}
let clock = Date.parse('2026-11-24T12:00:00Z')
const MIN = 60_000

async function deployRow(o: {
  envId: number
  kind?: string
  version: string
  from?: string | null
  status?: string
  finishedAt?: number | null
}): Promise<number> {
  const [id] = await db('nivaro_hub_deploys').insert({
    app_id: appId,
    environment_id: o.envId,
    kind: o.kind ?? 'promote',
    version: o.version,
    from_version: o.from ?? null,
    status: o.status ?? 'running',
    plan: '{"steps":[]}',
    started_at: new Date(clock),
    finished_at: o.finishedAt == null ? null : new Date(o.finishedAt)
  })
  return Number(id)
}

function figures(
  score: number | null,
  recent: Record<string, number> | null = null,
  linked = true
) {
  return {
    linked,
    version: '0.3.215',
    readiness_score: score,
    recent: recent ? { minutes: 5, requests: 0, errors_5xx: 0, crashes: 0, ...recent } : null,
    release_facts: null,
    read_at: 'now'
  }
}

beforeAll(async () => {
  await m542.up(db)
  await m543.up(db)
  await m565.up(db)
  await m565.up(db) // a second run is a no-op
  const [a] = await db('nivaro_hub_apps').insert({ key: 'demo', name: 'Demo' })
  appId = Number(a)
  for (const [i, key] of ['development', 'staging', 'production'].entries()) {
    const [id] = await db('nivaro_hub_environments').insert({
      app_id: appId,
      key,
      position: i,
      base_url: `https://${key}.example.com`
    })
    env[key] = Number(id)
  }
})

beforeEach(async () => {
  for (const t of [
    'nivaro_hub_trains',
    'nivaro_hub_schedules',
    'nivaro_hub_deploys',
    'nivaro_hub_rollback_rules',
    'nivaro_hub_rollback_watches'
  ])
    await db(t).delete()
  clock = Date.parse('2026-11-24T12:00:00Z')
})

describe('migration 565', () => {
  it('creates every release-operations table', async () => {
    for (const t of [
      'nivaro_hub_trains',
      'nivaro_hub_schedules',
      'nivaro_hub_freezes',
      'nivaro_hub_rollback_rules',
      'nivaro_hub_rollback_watches',
      'nivaro_hub_release_notes',
      'nivaro_hub_version_facts'
    ])
      expect(await db.schema.hasTable(t)).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_trains', 'step_index')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_freezes', 'recurrence')).toBe(true)
  })
})

function trainDeps(over: Partial<Parameters<typeof trains.advanceTrain>[1]> = {}) {
  const notes: string[] = []
  const deps = {
    now: () => clock,
    start: vi.fn(async (envId: number) => ({
      deployId: await deployRow({ envId, version: '0.3.215' })
    })),
    deploy: async (id: number) => {
      const r = await db('nivaro_hub_deploys').where({ id }).first()
      return r
        ? {
            status: String(r.status),
            finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
            error: r.error ?? null
          }
        : null
    },
    figures: vi.fn(async () => figures(95)),
    freeze: vi.fn(async () => null),
    rolledBack: async () => false,
    lastSuccess: async () => null,
    startedSince: async () => null,
    notify: vi.fn(async (_a: number, n: { subject: string }) => {
      notes.push(n.subject)
    }),
    notifyAll: vi.fn(async (_a: number, n: { subject: string }) => {
      notes.push(n.subject)
    }),
    watch: vi.fn(async () => 'none'),
    liveVersion: vi.fn(async () => '0.3.215'),
    person: vi.fn(async () => ({ ok: true, name: 'Rob' })),
    logStart: vi.fn(async () => 1),
    ...over
  }
  return {
    deps: deps as unknown as Parameters<typeof trains.advanceTrain>[1],
    notes,
    raw: deps as unknown as Record<string, ReturnType<typeof vi.fn<(...args: any[]) => any>>>
  }
}

async function newTrain(steps: Array<Record<string, unknown>>) {
  const input = trains.validateTrain({ version: '0.3.215', steps }, [
    { id: env.development, key: 'development', position: 0 },
    { id: env.staging, key: 'staging', position: 1 },
    { id: env.production, key: 'production', position: 2 }
  ])
  if ('error' in input) throw new Error(input.error)
  return trains.createTrain(appId, input, { userId: USER })
}

const finish = (id: number | null, status = 'success') =>
  db('nivaro_hub_deploys')
    .where({ id })
    .update({ status, finished_at: new Date(clock) })

describe('release trains', () => {
  it('promotes step by step, soaks, waits for readiness, then finishes', async () => {
    const t = await newTrain([
      { environment_id: env.staging, soak_minutes: 30, min_readiness: 80 },
      { environment_id: env.production, soak_minutes: 0 }
    ])
    const { deps, notes, raw } = trainDeps()
    let cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0]).toMatchObject({ status: 'promoting' })
    expect(raw.start).toHaveBeenCalledWith(env.staging, {
      kind: 'promote',
      version: '0.3.215',
      userId: USER
    })
    // Still deploying: nothing moves.
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].status).toBe('promoting')
    await finish(cur?.steps[0].deploy_id ?? null)
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].status).toBe('soaking')
    expect(cur?.steps[0].note).toMatch(/^Soaking until/)
    // After the soak, readiness 70 < 80 keeps it waiting.
    clock += 31 * MIN
    raw.figures.mockResolvedValueOnce(figures(70))
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0]).toMatchObject({ status: 'soaking', readiness: 70 })
    expect(cur?.steps[0].note).toMatch(/readiness 70 is below 80/)
    // 95 passes; production starts in the same pass.
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].status).toBe('passed')
    expect(cur?.step_index).toBe(1)
    expect(cur?.steps[1].status).toBe('promoting')
    await finish(cur?.steps[1].deploy_id ?? null)
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.status).toBe('done')
    expect(notes).toEqual(['Release train 0.3.215 finished'])
  })

  it('waits on a freeze, then starts once it ends', async () => {
    const t = await newTrain([{ environment_id: env.staging }])
    const { deps, raw } = trainDeps()
    raw.freeze.mockResolvedValueOnce({
      status: 409,
      code: 'FROZEN',
      message: 'Promotions are frozen',
      freeze: { id: 1, name: 'x', app_id: null, ends_at: 'later' }
    } as never)
    let cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0]).toMatchObject({ status: 'pending' })
    expect(cur?.steps[0].note).toMatch(/Waiting for the freeze to end/)
    expect(raw.start).not.toHaveBeenCalled()
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].status).toBe('promoting')
  })

  it('tries a passing refusal again, fails the train on any other', async () => {
    const t = await newTrain([{ environment_id: env.staging }])
    const { deps, notes, raw } = trainDeps()
    raw.start.mockRejectedValueOnce(new PromotionError('PROMOTION_RUNNING', 'busy', 409))
    let cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0]).toMatchObject({ status: 'pending', attempts: 1 })
    expect(cur?.steps[0].note).toMatch(/^Trying again: PROMOTION_RUNNING/)
    raw.start.mockRejectedValueOnce(
      new PromotionError('NO_SOURCE_COMMIT', 'no commit names 0.3.215', 409)
    )
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.status).toBe('failed')
    expect(cur?.error).toMatch(/staging: NO_SOURCE_COMMIT/)
    expect(notes[0]).toMatch(/stopped at staging/)
  })

  it('a step whose environment already runs the version goes to its hold', async () => {
    const t = await newTrain([{ environment_id: env.staging, soak_minutes: 0 }])
    const { deps, raw } = trainDeps()
    raw.start.mockRejectedValueOnce(new PromotionError('ALREADY_RUNS', 'already', 409))
    const cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.status).toBe('done')
    expect(cur?.steps[0].status).toBe('passed')
    expect(raw.start).toHaveBeenCalledTimes(1)
  })

  it('holds for a person after max_hold, who may skip the hold', async () => {
    const t = await newTrain([
      { environment_id: env.staging, soak_minutes: 0, min_readiness: 90, max_hold_minutes: 10 }
    ])
    const { deps, notes, raw } = trainDeps()
    raw.figures.mockResolvedValue(figures(null, null, false))
    let cur = await trains.advanceTrain(t.id, deps)
    await finish(cur?.steps[0].deploy_id ?? null)
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].note).toMatch(/cannot be read/)
    clock += 11 * MIN
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].status).toBe('held')
    expect(notes[0]).toMatch(/needs a person at staging/)
    await expect(trains.skipStep(t.id, 1, 'Rob')).rejects.toMatchObject({ code: 'NOT_CURRENT' })
    await trains.skipStep(t.id, 0, 'Rob', clock)
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.status).toBe('done')
    expect(cur?.steps[0].note).toBe('Hold skipped by Rob')
  })

  it('a rollback during the hold fails the step; skip refuses a running promotion; abort stops it', async () => {
    const t = await newTrain([{ environment_id: env.staging, soak_minutes: 60 }])
    const { deps } = trainDeps({ rolledBack: async () => true })
    let cur = await trains.advanceTrain(t.id, deps)
    await expect(trains.skipStep(t.id, 0, 'Rob')).rejects.toMatchObject({ code: 'STEP_RUNNING' })
    await finish(cur?.steps[0].deploy_id ?? null)
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.status).toBe('failed')
    expect(cur?.steps[0].note).toMatch(/rolled back during the hold/)

    const t2 = await newTrain([{ environment_id: env.staging }])
    await trains.abortTrain(t2.id, 'Rob')
    expect((await trains.readTrain(t2.id))?.status).toBe('aborted')
    await expect(trains.abortTrain(t2.id, 'Rob')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  it('settles a claim a stopped tick left: adopts the run it started', async () => {
    const t = await newTrain([{ environment_id: env.staging, soak_minutes: 0 }])
    await trains.mutateTrain(t.id, (x) => {
      x.steps[0].status = 'starting'
      x.steps[0].started_at = new Date(clock).toISOString()
      return x
    })
    const id = await deployRow({ envId: env.staging, version: '0.3.215' })
    const { deps, raw } = trainDeps({ startedSince: async () => id })
    let cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].status).toBe('starting') // not stale yet
    clock += 11 * MIN
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0]).toMatchObject({ status: 'promoting', deploy_id: id })
    expect(raw.start).not.toHaveBeenCalled()
  })

  it('a step passes only once its rollback watch ended clean; a rollback fails it', async () => {
    const t = await newTrain([
      { environment_id: env.staging, soak_minutes: 0 },
      { environment_id: env.production, soak_minutes: 0 }
    ])
    const { deps, raw } = trainDeps()
    raw.watch.mockResolvedValue('watching')
    let cur = await trains.advanceTrain(t.id, deps)
    await finish(cur?.steps[0].deploy_id ?? null)
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0].status).toBe('soaking')
    expect(cur?.steps[0].note).toBe('Waiting for the automatic rollback watch to end')
    expect(raw.start).toHaveBeenCalledTimes(1)
    raw.watch.mockResolvedValue('rolled_back')
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.status).toBe('failed')
    expect(cur?.steps[0].note).toBe('staging was rolled back automatically')
    expect(raw.start).toHaveBeenCalledTimes(1)
  })

  it('reads the real watch state: a rule with no watch row yet still holds the step', async () => {
    const id = await deployRow({
      envId: env.staging,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - MIN
    })
    await rollback.saveRule(
      env.staging,
      {
        enabled: true,
        window_minutes: 30,
        max_error_pct: 5,
        min_requests: 10,
        max_crashes: null,
        min_readiness: null
      },
      USER
    )
    await db('nivaro_hub_rollback_rules').update({ updated_at: new Date(clock - 10 * MIN) })
    expect(await trains.watchStateOf(env.staging, id, clock)).toBe('pending')
    expect(await trains.watchStateOf(env.staging, id, clock + 40 * MIN)).toBe('none')
    await rollback.openWatches({ now: () => clock })
    expect(await trains.watchStateOf(env.staging, id, clock)).toBe('watching')
  })

  it('before each next step, an earlier environment must still run the version', async () => {
    const t = await newTrain([
      { environment_id: env.staging, soak_minutes: 0 },
      { environment_id: env.production, soak_minutes: 0 }
    ])
    const { deps, notes, raw } = trainDeps()
    let cur = await trains.advanceTrain(t.id, deps)
    await finish(cur?.steps[0].deploy_id ?? null)
    raw.liveVersion.mockResolvedValue('0.3.214')
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.step_index).toBe(1)
    expect(cur?.steps[1]).toMatchObject({ status: 'held', blocked: true })
    expect(cur?.steps[1].note).toMatch(/staging runs 0\.3\.214 now/)
    expect(notes[0]).toMatch(/held: staging no longer runs it/)
    expect(raw.start).toHaveBeenCalledTimes(1)
    // A person decides to go on anyway: Skip starts it without the check.
    await trains.skipStep(t.id, 1, 'Rob', clock)
    cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[1].status).toBe('promoting')
    expect(raw.start).toHaveBeenCalledTimes(2)
    expect(raw.logStart).toHaveBeenCalledWith(
      expect.any(Number),
      expect.stringMatching(/step 2 \(production\)/),
      USER
    )
  })

  it('a train whose person can no longer act holds before its next start and tells admins', async () => {
    const t = await newTrain([{ environment_id: env.staging }])
    const { deps, notes, raw } = trainDeps()
    raw.person.mockResolvedValue({ ok: false, why: 'Rob is no longer active' })
    const cur = await trains.advanceTrain(t.id, deps)
    expect(cur?.steps[0]).toMatchObject({ status: 'held', blocked: true })
    expect(cur?.steps[0].note).toMatch(/Rob is no longer active/)
    expect(raw.notifyAll).toHaveBeenCalled()
    expect(notes[0]).toMatch(/needs a person/)
    expect(raw.start).not.toHaveBeenCalled()
  })

  it('refuses a second running train for the app', async () => {
    await newTrain([{ environment_id: env.staging }])
    await expect(newTrain([{ environment_id: env.production }])).rejects.toMatchObject({
      code: 'TRAIN_RUNNING'
    })
  })
})

function scheduleDeps(over: Record<string, unknown> = {}) {
  const deps = {
    now: () => clock,
    freeze: vi.fn(async () => null),
    startPromotion: vi.fn(async () => ({ deployId: 77 })),
    startTrain: vi.fn(async () => ({ trainId: 5 })),
    notify: vi.fn(async () => 1),
    notifyAll: vi.fn(async () => 1),
    person: vi.fn(async () => ({ ok: true, name: 'Rob' })),
    startedSince: vi.fn(async () => null),
    trainOf: vi.fn(async () => null),
    logStart: vi.fn(async () => 1),
    ...over
  }
  return deps as typeof deps & Parameters<typeof schedules.runDueSchedules>[0]
}

async function schedule(over: Record<string, unknown> = {}) {
  return schedules.createSchedule({
    app_id: appId,
    environment_id: env.production,
    kind: 'promote',
    version: '0.3.215',
    run_at: new Date(clock - MIN),
    on_freeze: 'wait',
    train: null,
    created_by: USER,
    ...over
  } as never)
}

const FROZEN = {
  status: 409,
  code: 'FROZEN',
  message: 'Promotions are frozen for this app',
  freeze: { id: 1, name: 'x', app_id: 1, ends_at: new Date(clock + 60 * MIN).toISOString() }
}

describe('scheduled promotions', () => {
  it('starts what is due, as the person who scheduled it, and leaves the rest', async () => {
    const due = await schedule()
    const later = await schedule({ run_at: new Date(clock + 60 * MIN) })
    const deps = scheduleDeps()
    expect(await schedules.runDueSchedules(deps)).toBe(1)
    expect(deps.startPromotion).toHaveBeenCalledWith(env.production, {
      kind: 'promote',
      version: '0.3.215',
      userId: USER
    })
    expect(await schedules.readSchedule(due.id)).toMatchObject({ status: 'started', deploy_id: 77 })
    expect((await schedules.readSchedule(later.id))?.status).toBe('scheduled')
    expect(await schedules.cancelSchedule(later.id)).toBe(true)
    expect(await schedules.cancelSchedule(due.id)).toBe(false)
  })

  it('inside a freeze: waits (and starts after it) or fails, per on_freeze', async () => {
    const wait = await schedule()
    const fail = await schedule({ on_freeze: 'fail' })
    const deps = scheduleDeps({ freeze: vi.fn(async () => FROZEN) })
    await schedules.runDueSchedules(deps)
    expect(await schedules.readSchedule(wait.id)).toMatchObject({ status: 'waiting' })
    expect((await schedules.readSchedule(wait.id))?.note).toMatch(/Waiting for the freeze/)
    expect(await schedules.readSchedule(fail.id)).toMatchObject({ status: 'failed' })
    expect((await schedules.readSchedule(fail.id))?.error).toMatch(/^FROZEN/)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    await schedules.runDueSchedules(scheduleDeps())
    expect((await schedules.readSchedule(wait.id))?.status).toBe('started')
  })

  it('a schedule found hours late is missed, never a surprise deploy', async () => {
    const s = await schedule({ run_at: new Date(clock - 7 * 60 * MIN) })
    const deps = scheduleDeps()
    await schedules.runDueSchedules(deps)
    expect(await schedules.readSchedule(s.id)).toMatchObject({ status: 'failed' })
    expect(deps.startPromotion).not.toHaveBeenCalled()
  })

  it('a passing refusal waits; another fails and tells people', async () => {
    const s = await schedule()
    await schedules.runDueSchedules(
      scheduleDeps({
        startPromotion: vi.fn(async () => {
          throw new PromotionError('PROMOTION_RUNNING', 'busy', 409)
        })
      })
    )
    expect((await schedules.readSchedule(s.id))?.status).toBe('waiting')
    const deps = scheduleDeps({
      startPromotion: vi.fn(async () => {
        throw new PromotionError('OLDER_THAN_CURRENT', 'older', 409)
      })
    })
    await schedules.runDueSchedules(deps)
    expect(await schedules.readSchedule(s.id)).toMatchObject({ status: 'failed', attempts: 2 })
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('starts a scheduled train', async () => {
    const s = await schedule({
      kind: 'train',
      environment_id: null,
      train: { version: '0.3.215', steps: [], keys: [] }
    })
    const deps = scheduleDeps()
    await schedules.runDueSchedules(deps)
    expect(await schedules.readSchedule(s.id)).toMatchObject({ status: 'started', train_id: 5 })
    expect(deps.logStart).toHaveBeenCalledWith(expect.objectContaining({ id: s.id }), {
      trainId: 5
    })
  })

  it('a re-claimed schedule adopts what an earlier claim started, never a second start', async () => {
    const s = await schedule()
    await db('nivaro_hub_schedules')
      .where({ id: s.id })
      .update({
        status: 'starting',
        started_at: new Date(clock - 20 * MIN),
        claimed_at: new Date(clock - 20 * MIN)
      })
    const deps = scheduleDeps({ startedSince: vi.fn(async () => 88) })
    await schedules.runDueSchedules(deps)
    expect(await schedules.readSchedule(s.id)).toMatchObject({ status: 'started', deploy_id: 88 })
    expect(deps.startPromotion).not.toHaveBeenCalled()

    const tr = await schedule({
      kind: 'train',
      environment_id: null,
      train: { version: '0.3.215', steps: [], keys: [] }
    })
    await db('nivaro_hub_schedules')
      .where({ id: tr.id })
      .update({ status: 'waiting', started_at: new Date(clock - 20 * MIN) })
    const deps2 = scheduleDeps({ trainOf: vi.fn(async () => 9) })
    await schedules.runDueSchedules(deps2)
    expect(await schedules.readSchedule(tr.id)).toMatchObject({ status: 'started', train_id: 9 })
    expect(deps2.startTrain).not.toHaveBeenCalled()
  })

  it('freeze waits use up no tries; long after the freeze ended the schedule is missed', async () => {
    const s = await schedule()
    const ended = new Date(clock + 30 * MIN).toISOString()
    const deps = scheduleDeps({
      freeze: vi.fn(async () => ({ ...FROZEN, freeze: { ...FROZEN.freeze, ends_at: ended } }))
    })
    await schedules.runDueSchedules(deps)
    await schedules.runDueSchedules(deps)
    expect(await schedules.readSchedule(s.id)).toMatchObject({ status: 'waiting', attempts: 0 })
    // The Hub comes back 7 hours after the freeze ended: missed, not deployed.
    clock += 30 * MIN + 7 * 60 * MIN
    const late = scheduleDeps()
    await schedules.runDueSchedules(late)
    expect(await schedules.readSchedule(s.id)).toMatchObject({ status: 'failed' })
    expect((await schedules.readSchedule(s.id))?.error).toMatch(/^MISSED/)
    expect(late.startPromotion).not.toHaveBeenCalled()
  })

  it('a schedule whose person can no longer act fails and tells owners and admins', async () => {
    const s = await schedule()
    const deps = scheduleDeps({
      person: vi.fn(async () => ({ ok: false, why: 'Rob is no longer active' }))
    })
    await schedules.runDueSchedules(deps)
    expect(await schedules.readSchedule(s.id)).toMatchObject({ status: 'failed' })
    expect((await schedules.readSchedule(s.id))?.error).toMatch(/^PERSON_GONE/)
    expect(deps.notifyAll).toHaveBeenCalled()
    expect(deps.startPromotion).not.toHaveBeenCalled()
  })
})

function watchDeps(over: Record<string, unknown> = {}) {
  const deps = {
    now: () => clock,
    figures: vi.fn(async () => figures(95, { requests: 500, errors_5xx: 2 })),
    rollback: vi.fn(async () => ({ deployId: 900 })),
    notify: vi.fn(async () => 1),
    envKey: async () => 'production',
    ...over
  }
  return deps as typeof deps & Parameters<typeof rollback.judgeWatches>[0]
}

describe('automatic rollback', () => {
  beforeEach(async () => {
    await rollback.saveRule(
      env.production,
      {
        enabled: true,
        window_minutes: 30,
        max_error_pct: 5,
        min_requests: 100,
        max_crashes: null,
        min_readiness: null
      },
      USER
    )
    // Saved well before the promotions below (a rule never reaches back past its own save).
    await db('nivaro_hub_rollback_rules').update({ updated_at: new Date(clock - 120 * MIN) })
  })

  it('a rule saved after a promotion never watches it', async () => {
    await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await db('nivaro_hub_rollback_rules').update({ updated_at: new Date(clock - MIN) })
    expect(await rollback.openWatches({ now: () => clock })).toBe(0)
  })

  it('never rolls back a version deployed outside the Hub: the watch ends superseded', async () => {
    await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await rollback.openWatches({ now: () => clock })
    const deps = watchDeps({
      figures: vi.fn(async () => ({
        ...figures(95, { requests: 400, errors_5xx: 200 }),
        version: '0.3.216'
      }))
    })
    expect(await rollback.judgeWatches(deps)).toBe(0)
    expect(deps.rollback).not.toHaveBeenCalled()
    const [w] = await rollback.listWatches({ envId: env.production })
    expect(w.status).toBe('superseded')
    expect(w.reason).toMatch(/runs 0\.3\.216 now/)
    expect(deps.notify).toHaveBeenCalled()
  })

  it('opens one watch per successful promotion inside the window, never for Apply now', async () => {
    await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await deployRow({
      envId: env.production,
      version: '0.3.214',
      from: '0.3.213',
      status: 'success',
      finishedAt: clock - 50 * MIN
    })
    const apply = await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.215',
      status: 'success',
      finishedAt: clock
    })
    await db('nivaro_hub_deploys')
      .where({ id: apply })
      .update({ plan: '{"apply":true,"steps":[]}' })
    expect(await rollback.openWatches({ now: () => clock })).toBe(1)
    expect(await rollback.openWatches({ now: () => clock })).toBe(0)
  })

  it('rolls back to the version before on a breach, once, and tells the owners', async () => {
    const id = await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await rollback.openWatches({ now: () => clock })
    const deps = watchDeps({
      figures: vi.fn(async () => figures(95, { requests: 400, errors_5xx: 40 }))
    })
    expect(await rollback.judgeWatches(deps)).toBe(1)
    expect(deps.rollback).toHaveBeenCalledWith(env.production, {
      kind: 'rollback',
      version: '0.3.214',
      userId: null
    })
    expect(deps.figures).toHaveBeenCalledWith(env.production, 5)
    const [w] = await rollback.listWatches({ envId: env.production })
    expect(w).toMatchObject({ deploy_id: id, status: 'rolled_back', rollback_deploy_id: 900 })
    expect(w.reason).toMatch(/5xx rate 10\.0%/)
    expect(deps.notify).toHaveBeenCalledWith(
      appId,
      expect.objectContaining({ subject: 'production rolled back to 0.3.214', urgent: true })
    )
    expect(await rollback.judgeWatches(deps)).toBe(0)
  })

  it('passes a quiet window; a newer deploy supersedes the watch', async () => {
    await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await rollback.openWatches({ now: () => clock })
    const deps = watchDeps()
    await rollback.judgeWatches(deps)
    expect((await rollback.listWatches({ envId: env.production }))[0].status).toBe('watching')
    clock += 30 * MIN
    await rollback.judgeWatches(deps)
    expect((await rollback.listWatches({ envId: env.production }))[0].status).toBe('passed')

    await deployRow({
      envId: env.production,
      version: '0.3.216',
      from: '0.3.215',
      status: 'success',
      finishedAt: clock
    })
    await rollback.openWatches({ now: () => clock })
    await deployRow({
      envId: env.production,
      version: '0.3.217',
      from: '0.3.216',
      status: 'running'
    })
    await rollback.judgeWatches(deps)
    expect((await rollback.listWatches({ envId: env.production }))[0].status).toBe('superseded')
  })

  it('a rollback that cannot start fails the watch and asks for a person', async () => {
    await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await rollback.openWatches({ now: () => clock })
    const deps = watchDeps({
      figures: vi.fn(async () => figures(95, { requests: 400, errors_5xx: 40 })),
      rollback: vi.fn(async () => {
        throw new PromotionError('ROLLBACK_NOT_RECORDED', 'no build', 409)
      })
    })
    await rollback.judgeWatches(deps)
    const [w] = await rollback.listWatches({ envId: env.production })
    expect(w.status).toBe('failed')
    expect(w.reason).toMatch(/ROLLBACK_NOT_RECORDED/)
    expect(deps.notify).toHaveBeenCalledWith(
      appId,
      expect.objectContaining({ subject: 'production: automatic rollback could not start' })
    )
  })

  it('without figures the watch ends failed (NO_FIGURES), never a rollback', async () => {
    await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await rollback.openWatches({ now: () => clock })
    clock += 40 * MIN
    const deps = watchDeps({ figures: vi.fn(async () => figures(null, null, false)) })
    await rollback.judgeWatches(deps)
    const [w] = await rollback.listWatches({ envId: env.production })
    expect(w.status).toBe('failed')
    expect(w.reason).toMatch(/^NO_FIGURES/)
    expect(deps.rollback).not.toHaveBeenCalled()
  })

  it('settles a claim a stopped tick left', async () => {
    const id = await deployRow({
      envId: env.production,
      version: '0.3.215',
      from: '0.3.214',
      status: 'success',
      finishedAt: clock - 5 * MIN
    })
    await rollback.openWatches({ now: () => clock })
    await db('nivaro_hub_rollback_watches').update({
      status: 'rolling',
      last_check_at: new Date(clock - 10 * MIN)
    })
    const rb = await deployRow({ envId: env.production, kind: 'rollback', version: '0.3.214' })
    expect(await rollback.healRolling(clock)).toBe(1)
    expect((await rollback.listWatches({ envId: env.production }))[0]).toMatchObject({
      deploy_id: id,
      status: 'rolled_back',
      rollback_deploy_id: rb
    })
  })
})
