import { join } from 'node:path'
import type { Knex } from 'knex'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub verification against real SQLite (every Hub migration up to 574): smoke runs queued after
// deploys, moves and shared upgrades, run with injected http + link answers, people told on a
// failure, the automatic rollback rule taking a failed smoke run as a breach; the extension
// matrix (behind / missing) and promoting one extension through a Docker pin or a GitLab pin
// file. Nothing leaves the process: fetches, the stack apply and GitLab commits are injected.

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
vi.mock('../../../services/hub/secrets.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/secrets.js')>()),
  openSecret: (v: string | null) => (v ? `open:${v}` : null)
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const MIGRATIONS = [
  '542_hub_tables',
  '543_hub_promotions',
  '544_hub_databases',
  '545_hub_creations',
  '546_hub_stack_settings',
  '550_hub_oidc',
  '551_hub_signins',
  '552_hub_shared_deployments',
  '553_hub_moves',
  '555_hub_stack_files',
  '565_hub_release_ops',
  '566_hub_fleet',
  '567_hub_capacity',
  '568_hub_ops',
  '569_hub_data',
  '570_hub_people_owner_policy',
  '571_hub_app_templates',
  '573_hub_change_ops',
  '574_hub_verify'
]
const smoke = await import('../../../services/hub/verify/smoke.js')
const ext = await import('../../../services/hub/verify/extensions.js')
const rollback = await import('../../../services/hub/releases/auto-rollback.js')
const { validateSuite } = await import('../../../services/hub/verify/checks.js')

const USER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const DIGEST = (c: string) => `reg.example.com/ext@sha256:${c.repeat(64)}`
let appId: number
const env: Record<string, number> = {}
let clock = Date.parse('2026-11-25T12:00:00Z')
const MIN = 60_000

const okResponse = (status: number, text = '') =>
  new Response(text, { status, headers: { 'content-type': 'text/html' } })

async function deployRow(o: {
  envId: number
  kind?: string
  version: string
  from?: string | null
  status?: string
  finishedAt: number
  plan?: string
}): Promise<number> {
  const [id] = await db('nivaro_hub_deploys').insert({
    app_id: appId,
    environment_id: o.envId,
    kind: o.kind ?? 'promote',
    version: o.version,
    from_version: o.from ?? null,
    status: o.status ?? 'success',
    plan: o.plan ?? '{"steps":[]}',
    started_at: new Date(o.finishedAt - MIN),
    finished_at: new Date(o.finishedAt)
  })
  return Number(id)
}

function suite(over: Record<string, unknown> = {}) {
  const s = validateSuite({
    on_fail: 'notify',
    settle_seconds: 30,
    checks: [
      { id: 'aaaaaaaa', kind: 'http', name: 'Home page', path: '/', contains: 'Nivaro' },
      { id: 'bbbbbbbb', kind: 'read', name: 'Projects list', path: '/api/items/projects?limit=1' },
      { id: 'cccccccc', kind: 'query', name: 'Open orders', slug: 'open-orders', min_rows: 1 }
    ],
    ...over
  })
  if ('error' in s) throw new Error(s.error)
  return s
}

/** A link fetch that answers the reads with these facts. */
function linkAnswer(results: Array<Record<string, unknown>> | null, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetch = vi.fn(async (url: string, _h: Record<string, string>, _t: number, o: unknown) => {
    calls.push({ url, body: (o as { body?: unknown }).body })
    if (results == null) return { ok: false, status, body: { code: 'HUB_LINK_REFUSED' } }
    return { ok: true, status: 200, body: { version: '0.3.215', results } }
  })
  return { fetch, calls }
}

beforeAll(async () => {
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  await (await import('../../../db/migrations/574_hub_verify.js')).up(db) // a second run is a no-op
  const [a] = await db('nivaro_hub_apps').insert({
    key: 'demo',
    name: 'Demo',
    extensions: JSON.stringify(['efp-ops'])
  })
  appId = Number(a)
  for (const [i, key] of ['development', 'staging', 'production'].entries()) {
    const [id] = await db('nivaro_hub_environments').insert({
      app_id: appId,
      key,
      position: i,
      base_url: `https://${key}.example.com`,
      hub_token: `sealed-${key}`
    })
    env[key] = Number(id)
  }
})

beforeEach(async () => {
  for (const t of [
    'nivaro_hub_smoke_suites',
    'nivaro_hub_smoke_runs',
    'nivaro_hub_deploys',
    'nivaro_hub_moves',
    'nivaro_hub_rollback_rules',
    'nivaro_hub_rollback_watches',
    'nivaro_hub_extension_sightings',
    'nivaro_hub_extension_promotions'
  ])
    await db(t).delete()
  clock = Date.parse('2026-11-25T12:00:00Z')
})

describe('migration 574', () => {
  it('creates the verification tables', async () => {
    for (const t of [
      'nivaro_hub_smoke_suites',
      'nivaro_hub_smoke_runs',
      'nivaro_hub_extension_sightings',
      'nivaro_hub_extension_promotions'
    ])
      expect(await db.schema.hasTable(t)).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_smoke_runs', 'source_key')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_smoke_runs', 'trigger_kind')).toBe(true)
  })
})

describe('queueing smoke runs', () => {
  it('queues one run per finished promotion, rollback, Apply now, move and shared upgrade, once', async () => {
    await smoke.saveSuite(env.staging, suite(), USER)
    // A deploy finished before the suite was saved is never tested after the fact.
    await db('nivaro_hub_smoke_suites')
      .where({ environment_id: env.staging })
      .update({ updated_at: new Date(clock - 60 * MIN) })
    const promote = await deployRow({
      envId: env.staging,
      version: '0.3.215',
      from: '0.3.214',
      finishedAt: clock - 5 * MIN
    })
    await deployRow({
      envId: env.staging,
      kind: 'rollback',
      version: '0.3.214',
      finishedAt: clock - 4 * MIN
    })
    await deployRow({
      envId: env.staging,
      version: '0.3.214',
      finishedAt: clock - 3 * MIN,
      plan: '{"apply":true}'
    })
    await deployRow({
      envId: env.staging,
      version: '0.3.216',
      status: 'failed',
      finishedAt: clock - 2 * MIN
    })
    await deployRow({ envId: env.staging, version: '0.3.213', finishedAt: clock - 90 * MIN })
    await db('nivaro_hub_moves').insert({
      app_id: appId,
      environment_id: env.staging,
      from_placement_id: 1,
      to_placement_id: 2,
      kind: 'to_shared',
      routing: 'automatic',
      status: 'success',
      steps: '[]',
      finished_at: new Date(clock - MIN)
    })
    // Another environment without a suite: nothing.
    await deployRow({ envId: env.development, version: '0.3.215', finishedAt: clock - MIN })

    expect(await smoke.queueNewRuns(clock)).toBe(4)
    expect(await smoke.queueNewRuns(clock)).toBe(0)
    const runs = await smoke.listRuns({ envIds: [env.staging] })
    expect(runs.map((r) => r.trigger).sort()).toEqual(['apply', 'move', 'promote', 'rollback'])
    const p = runs.find((r) => r.trigger === 'promote')
    expect(p?.deploy_id).toBe(promote)
    expect(p?.version).toBe('0.3.215')
    // Due settle_seconds after the deploy finished.
    expect(Date.parse(p?.due_at ?? '')).toBe(clock - 5 * MIN + 30_000)
  })

  it('a switched-off suite queues nothing; Run now refuses an environment without one', async () => {
    await smoke.saveSuite(env.staging, suite({ enabled: false }), USER)
    await deployRow({ envId: env.staging, version: '0.3.215', finishedAt: clock - MIN })
    expect(await smoke.queueNewRuns(clock)).toBe(0)
    await expect(smoke.queueManualRun(env.development, USER)).rejects.toMatchObject({
      code: 'NO_SUITE'
    })
  })
})

describe('running smoke checks', () => {
  it('passes when every check holds; the reads go over the hub link, never as a person', async () => {
    await smoke.saveSuite(env.staging, suite(), USER)
    const id = await smoke.queueManualRun(env.staging, USER)
    const http = vi.fn(async () => okResponse(200, '<title>Nivaro</title>'))
    const link = linkAnswer([
      { status: 200, ms: 40, rows: 1, code: null },
      { status: 200, ms: 90, rows: 12, code: null }
    ])
    const notify = vi.fn(async () => 1)
    expect(
      await smoke.executeRun(id, {
        now: () => clock,
        httpFetch: http as never,
        link: { fetch: link.fetch as never },
        notify
      })
    ).toBe(true)
    const run = await smoke.readRun(id)
    expect(run?.status).toBe('passed')
    expect(run?.passed).toBe(3)
    expect(http).toHaveBeenCalledWith('https://staging.example.com/', expect.anything())
    expect(link.calls[0].url).toBe('https://staging.example.com/api/hub-link/verify/run')
    expect(link.calls[0].body).toEqual({
      reads: [
        { kind: 'read', path: '/api/items/projects?limit=1' },
        { kind: 'query', slug: 'open-orders', params: {} }
      ]
    })
    expect(notify).not.toHaveBeenCalled()
    // A second claim of the same run does nothing.
    expect(await smoke.executeRun(id, { now: () => clock })).toBe(false)
  })

  it('fails and tells the people (urgent on production) with what failed', async () => {
    await smoke.saveSuite(env.production, suite(), USER)
    const id = await smoke.queueManualRun(env.production, USER)
    const link = linkAnswer([
      { status: 200, ms: 40, rows: 1, code: null },
      { status: 200, ms: 90, rows: 0, code: null }
    ])
    const notify = vi.fn(async () => 1)
    await smoke.executeRun(id, {
      now: () => clock,
      httpFetch: (async () => okResponse(502, 'Bad gateway')) as never,
      link: { fetch: link.fetch as never },
      notify
    })
    const run = await smoke.readRun(id)
    expect(run?.status).toBe('failed')
    expect(run?.failed).toBe(2)
    expect(run?.reason).toContain('Home page: answered 502, expected 200')
    expect(run?.reason).toContain('Open orders: 0 rows, expected at least 1')
    expect(notify).toHaveBeenCalledTimes(1)
    const [, note] = notify.mock.calls[0] as unknown as [number, Record<string, unknown>]
    expect(note.subject).toBe('Smoke checks failed: production')
    expect(note.urgent).toBe(true)
    expect(String(note.path)).toContain(`/hub/smoke?env=${env.production}`)
  })

  it('a refused link cannot judge the signed-in reads: unverified, said in words', async () => {
    await smoke.saveSuite(env.staging, suite(), USER)
    const id = await smoke.queueManualRun(env.staging, USER)
    await smoke.executeRun(id, {
      now: () => clock,
      httpFetch: (async () => okResponse(200, 'Nivaro')) as never,
      link: { fetch: linkAnswer(null, 401).fetch as never },
      notify: async () => 1
    })
    const run = await smoke.readRun(id)
    expect(run?.status).toBe('unverified')
    expect(run?.results.find((r) => r.id === 'bbbbbbbb')?.judged).toBe(false)
    expect(run?.results.find((r) => r.id === 'bbbbbbbb')?.reason).toBe(
      'the app refused the Hub’s link token'
    )
    expect(run?.results.find((r) => r.id === 'aaaaaaaa')?.ok).toBe(true)
  })

  it('settles a run a stopped tick left running', async () => {
    await smoke.saveSuite(env.staging, suite(), USER)
    const id = await smoke.queueManualRun(env.staging, USER)
    await db('nivaro_hub_smoke_runs')
      .where({ id })
      .update({ status: 'running', claimed_at: new Date(clock - 11 * MIN) })
    expect(await smoke.healStaleRuns(clock)).toBe(1)
    expect((await smoke.readRun(id))?.status).toBe('unverified')
  })
})

describe('a failed smoke run and the automatic rollback rule', () => {
  async function failedPromotionRun(onFail: 'notify' | 'rollback') {
    await smoke.saveSuite(env.staging, suite({ on_fail: onFail }), USER)
    // Saved an hour before the promotion (a deploy finished before the suite was saved is never
    // tested): the real clock is past the test's fixed one.
    await db('nivaro_hub_smoke_suites').update({ updated_at: new Date(clock - 60 * MIN) })
    await rollback.saveRule(
      env.staging,
      {
        enabled: true,
        window_minutes: 30,
        max_error_pct: 50,
        min_requests: 50,
        max_crashes: null,
        min_readiness: null
      },
      USER
    )
    await db('nivaro_hub_rollback_rules')
      .where({ environment_id: env.staging })
      .update({ updated_at: new Date(clock - 60 * MIN) })
    const deployId = await deployRow({
      envId: env.staging,
      version: '0.3.215',
      from: '0.3.214',
      finishedAt: clock - 2 * MIN
    })
    expect(await rollback.openWatches({ now: () => clock })).toBe(1)
    await smoke.queueNewRuns(clock)
    const [run] = await smoke.listRuns({ envIds: [env.staging] })
    const notify = vi.fn(async () => 1)
    await smoke.executeRun(run.id, {
      now: () => clock,
      httpFetch: (async () => okResponse(500)) as never,
      link: {
        fetch: linkAnswer([
          { status: 200, ms: 1, rows: 1, code: null },
          { status: 200, ms: 1, rows: 3, code: null }
        ]).fetch as never
      },
      notify,
      watched: async (id) =>
        !!(await db('nivaro_hub_rollback_watches')
          .where({ deploy_id: id, status: 'watching' })
          .first('id'))
    })
    return { deployId, notify }
  }

  function watchDeps(rolled: Array<Record<string, unknown>>) {
    return {
      now: () => clock,
      figures: async () => ({
        linked: true,
        version: '0.3.215',
        readiness_score: 100,
        recent: { minutes: 2, requests: 10, errors_5xx: 0, crashes: 0 },
        release_facts: null,
        read_at: 'now'
      }),
      rollback: vi.fn(async (_envId: number, o: Record<string, unknown>) => {
        rolled.push(o)
        return { deployId: 999 }
      }),
      notify: vi.fn(async () => 1),
      envKey: async () => 'staging',
      smoke: (id: number, until: string | null) => smoke.smokeVerdictForDeploy(id, until)
    }
  }

  /** A promotion of `envId` watched by an enabled rule, with its smoke run queued (not run). */
  async function watchedPromotion(envId: number, over: Record<string, unknown> = {}) {
    await smoke.saveSuite(envId, suite({ on_fail: 'rollback', ...over }), USER)
    // Saved an hour before the promotion (a deploy finished before the suite was saved is never
    // tested): the real clock is past the test's fixed one.
    await db('nivaro_hub_smoke_suites').update({ updated_at: new Date(clock - 60 * MIN) })
    await rollback.saveRule(
      envId,
      {
        enabled: true,
        window_minutes: 30,
        max_error_pct: 50,
        min_requests: 50,
        max_crashes: null,
        min_readiness: null
      },
      USER
    )
    await db('nivaro_hub_rollback_rules')
      .where({ environment_id: envId })
      .update({ updated_at: new Date(clock - 60 * MIN) })
    const deployId = await deployRow({
      envId,
      version: '0.3.215',
      from: '0.3.214',
      finishedAt: clock - 2 * MIN
    })
    expect(await rollback.openWatches({ now: () => clock })).toBe(1)
    await smoke.queueNewRuns(clock)
    const [run] = await smoke.listRuns({ envIds: [envId] })
    return { deployId, runId: run.id }
  }

  it('the Hub restarts mid-run after a production promotion: unverified, never a rollback', async () => {
    const { deployId, runId } = await watchedPromotion(env.production)
    await db('nivaro_hub_smoke_runs')
      .where({ id: runId })
      .update({ status: 'running', claimed_at: new Date(clock - 11 * MIN) })
    clock += 11 * MIN
    expect(await smoke.healStaleRuns(clock)).toBe(1)
    expect((await smoke.readRun(runId))?.status).toBe('unverified')
    expect(await smoke.smokeVerdictForDeploy(deployId)).toBeNull()
    const rolled: Array<Record<string, unknown>> = []
    expect(await rollback.judgeWatches(watchDeps(rolled) as never)).toBe(0)
    expect(rolled).toEqual([])
  })

  it('the link is unreachable: unverified, the people are told, never a rollback', async () => {
    const { deployId, runId } = await watchedPromotion(env.production, {
      checks: [{ id: 'bbbbbbbb', kind: 'read', name: 'Projects list', path: '/api/items/projects' }]
    })
    const notify = vi.fn(async () => 1)
    await smoke.executeRun(runId, {
      now: () => clock,
      link: {
        fetch: (async () => {
          throw new Error('ECONNREFUSED')
        }) as never
      },
      notify,
      watched: async () => true
    })
    expect((await smoke.readRun(runId))?.status).toBe('unverified')
    const [, note] = notify.mock.calls[0] as unknown as [number, Record<string, unknown>]
    expect(String(note.subject)).toBe('Smoke checks could not judge production')
    expect(String(note.message)).toContain('Nothing was rolled back')
    expect(await smoke.smokeVerdictForDeploy(deployId)).toBeNull()
    const rolled: Array<Record<string, unknown>> = []
    expect(await rollback.judgeWatches(watchDeps(rolled) as never)).toBe(0)
  })

  it('maintenance or the smoke identity refused: not judged either', async () => {
    const { deployId, runId } = await watchedPromotion(env.production, {
      checks: [
        { id: 'bbbbbbbb', kind: 'read', name: 'Projects list', path: '/api/items/projects' },
        { id: 'cccccccc', kind: 'query', name: 'Orders', slug: 'open-orders', min_rows: 1 }
      ]
    })
    await smoke.executeRun(runId, {
      now: () => clock,
      link: {
        fetch: linkAnswer([
          { status: 503, ms: 3, rows: null, code: 'MAINTENANCE' },
          { status: 409, ms: 3, rows: null, code: 'SMOKE_QUERY_NOT_READ_ONLY' }
        ]).fetch as never
      },
      notify: async () => 1
    })
    expect((await smoke.readRun(runId))?.status).toBe('unverified')
    expect(await smoke.smokeVerdictForDeploy(deployId)).toBeNull()
  })

  it('a run that finished after the rule’s window closed never counts', async () => {
    const { deployId, runId } = await watchedPromotion(env.production)
    clock += 40 * MIN
    await smoke.executeRun(runId, {
      now: () => clock,
      httpFetch: (async () => okResponse(500)) as never,
      link: {
        fetch: linkAnswer([
          { status: 200, ms: 1, rows: 1, code: null },
          { status: 200, ms: 1, rows: 3, code: null }
        ]).fetch as never
      },
      notify: async () => 1,
      watched: async () => false
    })
    expect((await smoke.readRun(runId))?.status).toBe('failed')
    const w = await db('nivaro_hub_rollback_watches')
      .where({ deploy_id: deployId })
      .first('until_at')
    expect(
      await smoke.smokeVerdictForDeploy(deployId, new Date(w.until_at).toISOString())
    ).toBeNull()
  })

  it('rollback: the rule takes it as a breach and rolls back through its own path', async () => {
    const { deployId, notify } = await failedPromotionRun('rollback')
    const [, note] = notify.mock.calls[0] as unknown as [number, Record<string, unknown>]
    expect(String(note.message)).toContain('Its automatic rollback rule rolls it back')
    expect(await smoke.smokeVerdictForDeploy(deployId)).toMatchObject({ breach: true })
    const rolled: Array<Record<string, unknown>> = []
    // Figures are healthy: only the smoke run says it is broken.
    expect(await rollback.judgeWatches(watchDeps(rolled) as never)).toBe(1)
    expect(rolled).toEqual([{ kind: 'rollback', version: '0.3.214', userId: null }])
    const w = await db('nivaro_hub_rollback_watches').where({ deploy_id: deployId }).first()
    expect(w.status).toBe('rolled_back')
    expect(String(w.reason)).toMatch(/^smoke checks failed: /)
  })

  it('notify: never a breach — the rule judges its figures only', async () => {
    const { deployId } = await failedPromotionRun('notify')
    expect(await smoke.smokeVerdictForDeploy(deployId)).toBeNull()
    const rolled: Array<Record<string, unknown>> = []
    expect(await rollback.judgeWatches(watchDeps(rolled) as never)).toBe(0)
    expect(rolled).toEqual([])
  })

  it('rollback without a watching rule: the people are told it is not rolled back', async () => {
    await smoke.saveSuite(env.staging, suite({ on_fail: 'rollback' }), USER)
    // Saved an hour before the promotion (a deploy finished before the suite was saved is never
    // tested): the real clock is past the test's fixed one.
    await db('nivaro_hub_smoke_suites').update({ updated_at: new Date(clock - 60 * MIN) })
    await deployRow({
      envId: env.staging,
      version: '0.3.215',
      from: '0.3.214',
      finishedAt: clock - MIN
    })
    await smoke.queueNewRuns(clock)
    const [run] = await smoke.listRuns({ envIds: [env.staging] })
    const notify = vi.fn(async () => 1)
    await smoke.executeRun(run.id, {
      now: () => clock,
      httpFetch: (async () => okResponse(500)) as never,
      link: { fetch: linkAnswer([]).fetch as never },
      notify,
      watched: async () => false
    })
    const [, note] = notify.mock.calls[0] as unknown as [number, Record<string, unknown>]
    expect(String(note.message)).toContain('NOT rolled back')
  })
})

describe('extension version manager', () => {
  let dockerDriver: number
  let gitlabDriver: number

  beforeAll(async () => {
    const [d] = await db('nivaro_hub_drivers').insert({
      kind: 'docker',
      name: 'swarm',
      config: JSON.stringify({ agent_url: 'https://agent.example.com' })
    })
    dockerDriver = Number(d)
    const [g] = await db('nivaro_hub_drivers').insert({
      kind: 'gitlab',
      name: 'gitlab',
      config: JSON.stringify({
        api: 'https://gitlab.example.com',
        project: 'efp/deploy',
        branch: 'production',
        pin_file: 'deploy/nivaro.pin',
        deploy_job: 'deploy'
      })
    })
    gitlabDriver = Number(g)
    const [pd] = await db('nivaro_hub_placements').insert({
      kind: 'dedicated',
      driver_id: dockerDriver,
      target: JSON.stringify({ stack: 'demo-dev' })
    })
    const [ps] = await db('nivaro_hub_placements').insert({
      kind: 'dedicated',
      driver_id: dockerDriver,
      target: JSON.stringify({ stack: 'demo-staging' })
    })
    const [pg] = await db('nivaro_hub_placements').insert({
      kind: 'dedicated',
      driver_id: gitlabDriver,
      target: JSON.stringify({ branch: 'production' })
    })
    await db('nivaro_hub_environments')
      .where({ id: env.development })
      .update({
        placement_id: Number(pd),
        extension_pins: JSON.stringify({ 'efp-ops': DIGEST('b') })
      })
    await db('nivaro_hub_environments')
      .where({ id: env.staging })
      .update({
        placement_id: Number(ps),
        extension_pins: JSON.stringify({ 'efp-ops': DIGEST('a') })
      })
    await db('nivaro_hub_environments')
      .where({ id: env.production })
      .update({ placement_id: Number(pg) })
  })

  const inventory = (version: string, build: string) => ({
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        version: '0.3.215',
        extensions: [{ id: 'efp-ops', status: 'loaded', enabled: true, version, build }]
      }
    }))
  })

  it('reads what runs and what is pinned; flags the environment behind the one before it', async () => {
    const files = vi.fn(async (_ctx: unknown, path: string, ref: string) =>
      path === 'deploy/extensions/efp-ops.pin' && ref === 'production' ? `${DIGEST('a')}\n` : null
    )
    const targets = (await import('../../../services/hub/verify/link.js')).verifyTargets
    for (const [key, ver, build] of [
      ['development', '2.1.0', 'b1'],
      ['staging', '2.0.0', 'a1'],
      ['production', '2.0.0', 'a1']
    ] as const) {
      const [t] = await targets([env[key]])
      expect(
        await ext.refreshEnvironment(t, ['efp-ops'], {
          link: inventory(ver, build),
          readFile: files as never,
          now: () => clock
        })
      ).toBe('ok')
    }
    const [m] = await ext.extensionMatrix(null)
    expect(m.environments.map((e) => [e.key, e.production])).toEqual([
      ['development', false],
      ['staging', false],
      ['production', true]
    ])
    const row = m.extensions.find((x) => x.id === 'efp-ops')
    expect(row?.cells.map((c) => [c?.pin_source, c?.state])).toEqual([
      ['docker', 'first'],
      ['docker', 'behind'],
      ['gitlab', 'same']
    ])
    expect(row?.behind).toBe(1)
  })

  /** A lock that is held by someone else (`busy`) or free; records what it handed out. */
  function testLock(busy = false) {
    const taken: string[] = []
    return {
      taken,
      lock: {
        take: vi.fn(async () => {
          if (busy) return null
          taken.push('tok')
          return 'tok'
        }),
        renew: vi.fn(async () => true),
        release: vi.fn(async () => undefined),
        held: vi.fn(async () => busy),
        holder: vi.fn(async () => null)
      }
    }
  }

  /** startStackApply through the REAL startPromotion, with its outside world faked. */
  async function realApply(o: { busy?: boolean; gather?: () => Promise<never> }) {
    const run = await import('../../../services/hub/promote-run.js')
    const { lock } = testLock(o.busy)
    return (envId: number, req: Parameters<typeof run.startStackApply>[1]) =>
      run.startStackApply(envId, req, {
        lock: lock as never,
        gather: (o.gather ??
          (async () => {
            throw Object.assign(new Error('the agent did not answer'), {
              code: 'AGENT_UNREACHABLE',
              status: 502
            })
          })) as never,
        startJobRun: (async () => ({ id: 1, log() {}, fail: async () => undefined })) as never,
        gitCtx: (async () => ({})) as never
      })
  }

  const pinsOf = async (envId: number) =>
    JSON.parse(
      (await db('nivaro_hub_environments').where({ id: envId }).first('extension_pins'))
        .extension_pins
    )

  it('Docker: a concurrent deploy refuses the start before the pin is written (no leak)', async () => {
    await db('nivaro_hub_environments')
      .where({ id: env.staging })
      .update({ version_pin: '0.3.215' })
    const plan = await ext.planExtensionPromote(env.staging, 'efp-ops', {})
    expect(plan).toMatchObject({
      via: 'docker',
      from_env: { key: 'development' },
      current_pin: DIGEST('a'),
      to_pin: DIGEST('b'),
      blockers: []
    })
    await expect(
      ext.promoteExtension(env.staging, 'efp-ops', { confirm: 'nope' }, { id: USER }, {})
    ).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
    // Another run holds the environment's lock: refused, the stored pins never changed.
    await expect(
      ext.promoteExtension(
        env.staging,
        'efp-ops',
        { confirm: 'staging' },
        { id: USER },
        { apply: await realApply({ busy: true }) }
      )
    ).rejects.toMatchObject({ code: 'PROMOTION_RUNNING' })
    expect(await pinsOf(env.staging)).toEqual({ 'efp-ops': DIGEST('a') })
    const [p] = await ext.listExtensionPromotions({})
    expect(p.status).toBe('failed')
  })

  it('Docker: a start that fails after the pin was written puts it back; a retry is allowed', async () => {
    let seen: unknown = null
    const failing = await realApply({
      gather: async () => {
        // gather runs inside the lock, after the hook: it already reads the new pin.
        seen = await pinsOf(env.staging)
        throw Object.assign(new Error('agent down'), { code: 'AGENT_UNREACHABLE', status: 502 })
      }
    })
    await expect(
      ext.promoteExtension(
        env.staging,
        'efp-ops',
        { confirm: 'staging' },
        { id: USER },
        { apply: failing }
      )
    ).rejects.toMatchObject({ code: 'AGENT_UNREACHABLE' })
    expect(seen).toEqual({ 'efp-ops': DIGEST('b') })
    expect(await pinsOf(env.staging)).toEqual({ 'efp-ops': DIGEST('a') })
    // The retry is not ALREADY_PINNED: the pin really is the old one again.
    const plan = await ext.planExtensionPromote(env.staging, 'efp-ops', {})
    expect(plan.blockers).toEqual([])

    // A start that hands off, then a deploy that fails: onEnd puts the pin back.
    let hooks: {
      onLocked?: () => Promise<void>
      onEnd?: (ok: boolean, id: number | null) => Promise<void>
    } = {}
    const started = vi.fn(async (_envId: number, req: { hooks?: typeof hooks }) => {
      hooks = req.hooks ?? {}
      await hooks.onLocked?.()
      return { deployId: 78, jobRunId: null }
    })
    const out = await ext.promoteExtension(
      env.staging,
      'efp-ops',
      { confirm: 'staging' },
      { id: USER },
      { apply: started as never }
    )
    expect(out).toMatchObject({ via: 'docker', deploy_id: 78 })
    expect(await pinsOf(env.staging)).toEqual({ 'efp-ops': DIGEST('b') })
    await hooks.onEnd?.(false, 78)
    expect(await pinsOf(env.staging)).toEqual({ 'efp-ops': DIGEST('a') })
    const [p] = await ext.listExtensionPromotions({})
    expect(p).toMatchObject({ status: 'failed', deploy_id: 78 })

    // And one that succeeds keeps it; the tick settles a run whose process stopped.
    const ok = await ext.promoteExtension(
      env.staging,
      'efp-ops',
      { confirm: 'staging' },
      { id: USER },
      { apply: started as never }
    )
    await db('nivaro_hub_deploys').insert({
      id: 78,
      app_id: appId,
      environment_id: env.staging,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      plan: '{"apply":true}',
      finished_at: new Date(clock)
    })
    expect(await ext.settleExtensionPromotions()).toBe(1)
    expect((await ext.listExtensionPromotions({}))[0]).toMatchObject({ id: ok.id, status: 'done' })
    expect(await pinsOf(env.staging)).toEqual({ 'efp-ops': DIGEST('b') })
    await db('nivaro_hub_environments')
      .where({ id: env.staging })
      .update({ extension_pins: JSON.stringify({ 'efp-ops': DIGEST('a') }) })
  })

  it('refuses an extension the app neither lists nor runs', async () => {
    const plan = await ext.planExtensionPromote(env.staging, 'not-ours', { pin: DIGEST('e') })
    expect(plan.blockers.map((b) => b.code)).toContain('UNKNOWN_EXTENSION')
  })

  it('GitLab: commits the pin under the locks, records an extension deploy and watches its pipeline', async () => {
    await deployRow({ envId: env.production, version: '0.3.214', finishedAt: clock - 60 * MIN })
    const commit = vi.fn(async () => ({ sha: 'f'.repeat(40), changed: true }))
    let finishDeploy: (ok: boolean) => void = () => undefined
    const deployJob = vi.fn(
      () =>
        new Promise<{ status: 'success'; job: never }>((resolve, reject) => {
          finishDeploy = (ok) =>
            ok
              ? resolve({ status: 'success', job: {} as never })
              : reject(Object.assign(new Error('deploy failed'), { code: 'DEPLOY_FAILED' }))
        })
    )
    const notify = vi.fn()
    const { lock } = testLock()
    const out = await ext.promoteExtension(
      env.production,
      'efp-ops',
      { from_env_id: env.development, confirm: 'production' },
      { id: USER },
      {
        commit,
        deployJob: deployJob as never,
        lock: lock as never,
        notify,
        readFile: (async () => null) as never
      }
    )
    expect(out).toMatchObject({ via: 'gitlab', commit_sha: 'f'.repeat(40) })
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'efp/deploy' }),
      'production',
      'deploy/extensions/efp-ops.pin',
      `${DIGEST('b')}\n`,
      'Pin extension efp-ops (Nivaro Hub)'
    )
    const row = await db('nivaro_hub_deploys').where({ id: out.deploy_id }).first()
    expect(row).toMatchObject({ kind: 'extension', status: 'running', version: '0.3.214' })
    expect(lock.release).not.toHaveBeenCalled()
    expect(deployJob).toHaveBeenCalledWith(expect.anything(), 'production', 'f'.repeat(40), {
      before: null,
      deploy: 'deploy',
      minutes: 60
    })
    finishDeploy(false)
    await vi.waitFor(async () =>
      expect((await db('nivaro_hub_deploys').where({ id: out.deploy_id }).first()).status).toBe(
        'failed'
      )
    )
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalled())
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'promote_failed' }))
    expect((await ext.listExtensionPromotions({}))[0]).toMatchObject({ status: 'failed' })
  })

  it('GitLab: a successful extension deploy is smoke-tested afterwards', async () => {
    await deployRow({ envId: env.production, version: '0.3.214', finishedAt: clock - 60 * MIN })
    await smoke.saveSuite(env.production, suite(), USER)
    await db('nivaro_hub_smoke_suites')
      .where({ environment_id: env.production })
      .update({ updated_at: new Date(Date.now() - 120 * MIN) })
    const out = await ext.promoteExtension(
      env.production,
      'efp-ops',
      { from_env_id: env.development, confirm: 'production' },
      { id: USER },
      {
        commit: (async () => ({ sha: 'e'.repeat(40), changed: true })) as never,
        deployJob: (async () => ({ status: 'success', job: {} })) as never,
        lock: testLock().lock as never,
        notify: vi.fn(),
        readFile: (async () => null) as never
      }
    )
    await vi.waitFor(async () =>
      expect((await db('nivaro_hub_deploys').where({ id: out.deploy_id }).first()).status).toBe(
        'success'
      )
    )
    await smoke.queueNewRuns(Date.now())
    const runs = await smoke.listRuns({ envIds: [env.production] })
    expect(runs.filter((r) => r.trigger === 'extension').map((r) => r.deploy_id)).toEqual([
      out.deploy_id
    ])
  })

  describe('the change engine (deploy windows, checklist, outside the window)', () => {
    /** An ISO weekday (1 = Monday … 7 = Sunday) that is not today. */
    const otherDay = () => {
      const d = new Date().getUTCDay()
      const iso = d === 0 ? 7 : d
      return ((iso - 1 + 3) % 7) + 1
    }
    beforeEach(async () => {
      await db('nivaro_hub_deploy_windows').delete()
      await db('nivaro_hub_checklist_items').delete()
      await db('nivaro_hub_checklist_runs').delete()
      await db('nivaro_hub_environments')
        .where({ id: env.staging })
        .update({
          version_pin: '0.3.215',
          extension_pins: JSON.stringify({ 'efp-ops': DIGEST('a') })
        })
    })
    /** A weekly window for every environment of the app that is closed right now. */
    const closedWindow = () =>
      db('nivaro_hub_deploy_windows').insert({
        app_id: appId,
        name: 'Tuesday nights',
        env_scope: 'all',
        recurrence: 'weekly',
        ranges: JSON.stringify([{ days: [otherDay()], from: '01:00', to: '01:30' }]),
        time_zone: 'UTC',
        enabled: true
      })
    const handOff = () =>
      vi.fn(async (_envId: number, req: { hooks?: { onLocked?: () => Promise<void> } }) => {
        await req.hooks?.onLocked?.()
        return { deployId: 91, jobRunId: null }
      })

    it('outside a deploy window → refused OUTSIDE_WINDOW (the plan says so first)', async () => {
      await closedWindow()
      const plan = await ext.planExtensionPromote(env.staging, 'efp-ops', {})
      expect(plan.blockers.map((b) => b.code)).toContain('OUTSIDE_WINDOW')
      const apply = handOff()
      await expect(
        ext.promoteExtension(
          env.staging,
          'efp-ops',
          { confirm: 'staging' },
          { id: USER },
          { apply }
        )
      ).rejects.toMatchObject({ code: 'OUTSIDE_WINDOW' })
      expect(apply).not.toHaveBeenCalled()
      expect(await pinsOf(env.staging)).toEqual({ 'efp-ops': DIGEST('a') })
    })

    it('production without its checklist ticked → refused, nothing committed', async () => {
      await deployRow({ envId: env.production, version: '0.3.214', finishedAt: clock - 60 * MIN })
      await db('nivaro_hub_checklist_items').insert({
        app_id: appId,
        environment_id: null,
        text: 'Tell the service desk',
        required: true,
        tick_by: 'admin',
        actions: 'extension_promote'
      })
      const commit = vi.fn(async () => ({ sha: 'a'.repeat(40), changed: true }))
      const before = (await ext.listExtensionPromotions({})).length
      await expect(
        ext.promoteExtension(
          env.production,
          'efp-ops',
          { from_env_id: env.development, confirm: 'production' },
          { id: USER },
          { commit, lock: testLock().lock as never, readFile: (async () => null) as never }
        )
      ).rejects.toMatchObject({ code: 'CHECKLIST_REQUIRED' })
      expect(commit).not.toHaveBeenCalled()
      expect((await ext.listExtensionPromotions({})).length).toBe(before)
      // The checklist is ticked for this extension and image: the promote goes through.
      const { checklistFor, createRun, tickRun } = await import(
        '../../../services/hub/changes/checklist.js'
      )
      const target = { kind: 'environment' as const, envId: env.production }
      const { entries } = await checklistFor(target, 'extension_promote')
      const run = await createRun({
        target,
        action: 'extension_promote',
        version: ext.extensionChecklistVersion('efp-ops', DIGEST('b')),
        userId: USER,
        entries
      })
      await tickRun(run.id, {
        key: entries[0].key,
        ticked: true,
        note: null,
        who: { id: USER, isAdmin: true, owns: new Set() },
        whoName: 'Ada'
      })
      const out = await ext.promoteExtension(
        env.production,
        'efp-ops',
        { from_env_id: env.development, confirm: 'production', checklist_run_id: run.id },
        { id: USER },
        {
          commit,
          deployJob: (async () => ({ status: 'success', job: {} })) as never,
          lock: testLock().lock as never,
          notify: vi.fn(),
          readFile: (async () => null) as never
        }
      )
      expect(out.via).toBe('gitlab')
      const linked = await db('nivaro_hub_checklist_runs').where({ id: run.id }).first()
      expect(linked).toMatchObject({ status: 'used', run_kind: 'extension', run_id: out.id })
    })

    it('an administrator’s outside-window reason → allowed, logged and told', async () => {
      await closedWindow()
      const { logActivity } = (await import('../../../services/activity.js')) as unknown as {
        logActivity: ReturnType<typeof vi.fn>
      }
      logActivity.mockClear()
      const apply = handOff()
      const out = await ext.promoteExtension(
        env.staging,
        'efp-ops',
        {
          confirm: 'staging',
          outsideWindow: { reason: 'Security fix for the vendor portal, cannot wait' }
        },
        { id: USER },
        { apply: apply as never }
      )
      expect(out).toMatchObject({ via: 'docker', deploy_id: 91 })
      expect(apply).toHaveBeenCalledWith(
        env.staging,
        expect.objectContaining({
          outsideWindow: { reason: 'Security fix for the vendor portal, cannot wait' }
        })
      )
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'hub-outside-window-start',
          collection: 'nivaro_hub_extension_promotions',
          item: String(out.id),
          comment: expect.stringContaining('Security fix for the vendor portal')
        })
      )
      await db('nivaro_hub_environments')
        .where({ id: env.staging })
        .update({ extension_pins: JSON.stringify({ 'efp-ops': DIGEST('a') }) })
    })
  })

  it('refuses a shared one', async () => {
    const [sd] = await db('nivaro_hub_shared_deployments').insert({
      key: 'pool-a',
      name: 'Pool A',
      mode: 'registered',
      extensions: JSON.stringify(['efp-ops']),
      extension_pins: JSON.stringify({ 'efp-ops': DIGEST('a') }),
      link_url: 'https://pool-a.example.com',
      pool_budget: 50,
      status: 'active'
    })
    const [psh] = await db('nivaro_hub_placements').insert({
      kind: 'shared',
      shared_deployment_id: Number(sd),
      target: '{}'
    })
    const [qa] = await db('nivaro_hub_environments').insert({
      app_id: appId,
      key: 'qa',
      position: 1,
      base_url: 'https://qa.example.com',
      placement_id: Number(psh)
    })
    const plan = await ext.planExtensionPromote(Number(qa), 'efp-ops', { pin: DIGEST('d') })
    expect(plan.via).toBe('shared')
    expect(plan.blockers.map((b) => b.code)).toContain('EXTENSION_ON_SHARED')
    await db('nivaro_hub_environments').where({ id: qa }).delete()
  })

  it('pure rules: pin file path, pin parsing and the chain', () => {
    expect(ext.extensionPinPath('deploy/nivaro.pin', 'efp-ops')).toBe(
      'deploy/extensions/efp-ops.pin'
    )
    expect(ext.extensionPinPath('nivaro.pin', 'x')).toBe('extensions/x.pin')
    expect(ext.pinFromFile(`\n ${DIGEST('a')} \n`)).toBe(DIGEST('a'))
    expect(ext.pinFromFile('reg/ext:latest')).toBeNull()
    const f = (version: string | null, pin: string | null = null, status = 'loaded') => ({
      version,
      build: null,
      status,
      pin
    })
    expect(ext.judgeChain([f('2.0.0'), f('2.0.0'), f('1.9.0')])).toEqual([
      'first',
      'same',
      'behind'
    ])
    expect(ext.judgeChain([f('2.0.0'), f('2.1.0')])).toEqual(['first', 'ahead'])
    expect(ext.judgeChain([f('2.0.0'), f(null, null, 'absent')])).toEqual(['first', 'missing'])
    expect(ext.judgeChain([f(null, DIGEST('a')), f(null, DIGEST('b'))])).toEqual([
      'first',
      'behind'
    ])
    expect(ext.judgeChain([null, f('1.0.0')])).toEqual(['unknown', 'first'])
  })
})
