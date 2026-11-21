import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 2: the promotion runner. The real GitLab write client runs over an in-memory
// GitLab (hub-fake-gitlab.ts, a fetch stub); a fake clock makes every wait instant. Real SQLite
// holds the deploy rows.

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const run = await import('../../../services/hub/promote-run.js')
const { buildPromotionPlan } = await import('../../../services/hub/promote-plan.js')
const { hubPromoteLockKey } = await import('../../../services/hub/promote-gather.js')
const { FakeGitLab } = await import('./hub-fake-gitlab.js')
const { createBranch: gwCreateBranch } = await import('../../../services/hub/gitlab-write.js')
type Fake = InstanceType<typeof FakeGitLab>

import type {
  HubComponent,
  HubEnvironmentRow,
  PlanInput,
  PromotionPlan
} from '../../../services/hub/promote-types.js'
import type { JobRunHandle } from '../../../services/job-runs.js'

const DIGEST = `sha256:${'a'.repeat(64)}`
const SLIM = `sha256:${'b'.repeat(64)}`
const API_URL = 'https://efp.example.com/api/version'
const FE_URL = 'https://efp.example.com/version.json'
const USER = 'AAAAAAAA-0000-4000-8000-000000000001'

/** A fake clock: every sleep moves it on at once. */
function clock() {
  const c = { t: 1_000_000, slept: 0 }
  return {
    c,
    sleep: async (ms: number) => {
      c.t += ms
      c.slept += ms
    },
    now: () => c.t
  }
}

/** Every text the run wrote anywhere (log lines, job-run outcome/error, row step/error). */
const written: string[] = []

function fakeRun(id = 77): JobRunHandle & { lines: string[]; ended: string[] } {
  const lines: string[] = []
  const ended: string[] = []
  return {
    id,
    lines,
    ended,
    progress() {},
    log(line) {
      lines.push(line)
      written.push(line)
    },
    async complete(outcome) {
      ended.push(`complete:${outcome ?? ''}`)
      written.push(outcome ?? '')
    },
    async fail(err) {
      const t = err instanceof Error ? err.message : String(err)
      ended.push(`fail:${t}`)
      written.push(t)
    }
  }
}

/** A Redis with SET NX PX, GET, DEL, EXISTS and the runner's two Lua scripts. */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    async set(key: string, value: string, ...args: Array<string | number>) {
      if (args.includes('NX') && store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    async get(key: string) {
      return store.get(key) ?? null
    },
    async del(...keys: string[]) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n++
      return n
    },
    async exists(key: string) {
      return store.has(key) ? 1 : 0
    },
    async eval(script: string, _n: number, key: string, token: string) {
      if (store.get(key) !== token) return 0
      if (script.includes("'del'")) store.delete(key)
      return 1
    }
  }
}

function env(over: Partial<HubEnvironmentRow>): HubEnvironmentRow {
  return {
    id: 2,
    app_id: 1,
    key: 'production',
    position: 2,
    status: 'active',
    base_url: 'https://efp.example.com',
    hostnames: [],
    placement_id: 5,
    version_pin: null,
    hub_token: null,
    hub_managed: true,
    ...over
  }
}

const apiComp: HubComponent = {
  id: 11,
  placement_id: 5,
  position: 1,
  name: 'api',
  kind: 'api',
  driver_id: 1,
  source_branch: 'main',
  target_branch: null,
  before_job: 'build_extension',
  deploy_job: null,
  verify_url: API_URL,
  verify_field: 'version'
}
const feComp: HubComponent = {
  id: 12,
  placement_id: 5,
  position: 2,
  name: 'frontend',
  kind: 'frontend',
  driver_id: 2,
  source_branch: 'main',
  target_branch: 'production',
  before_job: 'build_production',
  deploy_job: 'deploy_production',
  verify_url: FE_URL,
  verify_field: 'version'
}

const PROJECTS: Record<number, string> = { 1: 'efp/deploy', 2: 'efp/portal' }

interface World {
  gl: Fake
  apiSource: string
  feServed: string
  feFull: string
}

/** EFP-shaped GitLab: the deploy repo (main → production, pin file) and the portal. */
function world(
  opts: { apiDeploy?: Partial<{ statuses: string[]; onPlay: string[] }> } = {}
): World {
  const gl = new FakeGitLab()
  gl.project('efp/deploy', () => [
    { name: 'build_extension', statuses: ['running', 'success'] },
    {
      name: 'deploy_production',
      statuses: opts.apiDeploy?.statuses ?? ['manual'],
      onPlay: opts.apiDeploy?.onPlay ?? ['pending', 'running', 'success']
    }
  ])
  const base = gl.commit('efp/deploy', 'main', 'initial', { '.docker/nivaro-version': '0.3.9\n' })
  gl.branch('efp/deploy', 'production', base)
  gl.commit('efp/deploy', 'main', 'feat: something')
  const apiSource = gl.commit('efp/deploy', 'main', 'chore: deploy nivaro 0.3.10')

  gl.project('efp/portal', () => [
    { name: 'build_production', statuses: ['success'] },
    { name: 'deploy_production', statuses: ['manual'], onPlay: ['running', 'success'] }
  ])
  const feBase = gl.commit('efp/portal', 'main', 'portal initial')
  gl.branch('efp/portal', 'production', feBase)
  const feFull = gl.commit('efp/portal', 'main', 'feat: portal change')
  return { gl, apiSource, feServed: feFull.slice(0, 8), feFull }
}

function input(w: World, over: Partial<PlanInput> = {}): PlanInput {
  return {
    app: { id: 1, key: 'efp', name: 'EFP', signin_mode: 'direct', adopted: true, extensions: [] },
    target: env({}),
    previous: env({ id: 1, key: 'staging', position: 1, base_url: 'https://staging.example.com' }),
    components: [apiComp, feComp],
    kind: 'promote',
    version: '0.3.10',
    targetVersion: '0.3.9',
    previousVersion: '0.3.10',
    previousDeployedVersions: ['0.3.10'],
    targetDeployedVersions: [],
    sources: { 1: { sha: w.apiSource, subject: 'chore: deploy nivaro 0.3.10' } },
    frontendServed: { 2: w.feServed },
    frontendOnSource: { 2: true },
    sourceOnTarget: { 1: false },
    digest: DIGEST,
    slimDigest: SLIM,
    running: false,
    targetState: 'ok',
    drivers: {
      1: {
        branch: 'production',
        deploy_job: 'deploy_production',
        pin_file: '.docker/nivaro-version'
      },
      2: { branch: 'production', deploy_job: 'deploy_production', pin_file: 'unused' }
    },
    ...over
  }
}

function ctxFor(w: World, deployId = 1) {
  return {
    deployId,
    version: '0.3.10',
    kind: 'promote' as const,
    targetKey: 'production',
    gitCtx: async (driverId: number) => w.gl.ctx(PROJECTS[driverId])
  }
}

/** Both verify URLs answer the new release from the first read. */
function serveNew(w: World) {
  w.gl.served.set(API_URL, [{ version: '0.3.10' }])
  w.gl.served.set(FE_URL, [{ version: w.feServed }])
}

async function execute(
  w: World,
  plan: PromotionPlan,
  extra: Parameters<typeof run.executePlan>[2] = {}
) {
  const k = clock()
  const events: Array<{ kind: string; step?: string; line?: string }> = []
  const outcome = await run.executePlan(plan, ctxFor(w), {
    ...extra,
    onEvent: (e) => {
      events.push(e)
      if (e.kind === 'log') written.push(e.line)
      else written.push(e.step)
    },
    deps: { sleep: k.sleep, now: k.now, ...extra.deps }
  })
  if (outcome.error) written.push(outcome.error)
  return { outcome, events, steps: events.filter((e) => e.kind === 'step').map((e) => e.step), k }
}

let fetchSpy: ReturnType<typeof vi.spyOn>
let current: World

beforeAll(async () => {
  await m542.up(db)
  await m543.up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
  })
  await db('nivaro_users').insert({
    id: USER,
    first_name: 'Rita',
    last_name: 'Admin',
    email: 'r@x'
  })
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  written.length = 0
  await db('nivaro_hub_deploys').del()
  await db('nivaro_hub_environments').del()
  await db('nivaro_hub_environments').insert({
    id: 2,
    app_id: 1,
    key: 'production',
    position: 2,
    base_url: 'https://efp.example.com',
    placement_id: 5,
    hub_managed: true
  })
})

afterEach(() => {
  fetchSpy?.mockRestore()
  // The token was handed to GitLab and nowhere else: no line, outcome or row text carries it.
  for (const t of written) expect(t).not.toContain(current.gl.token)
})

function use(w: World) {
  current = w
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(w.gl.fetch as typeof fetch)
  return w
}

describe('executePlan', () => {
  it('pushes, pins and deploys api then frontend, then verifies each answer twice', async () => {
    const w = use(world())
    serveNew(w)
    const plan = buildPromotionPlan(input(w))
    expect(plan.ok).toBe(true)
    const { outcome, steps, events } = await execute(w, plan)

    expect(outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(steps).toEqual(['push api', 'deploy api', 'push frontend', 'deploy frontend', 'verify'])
    // Pin = version + digest + slim digest on production; the merged source is there too.
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toBe(
      `0.3.10\n${DIGEST}\n${SLIM}\n`
    )
    // Temporary branches are gone.
    for (const p of ['efp/deploy', 'efp/portal'])
      expect(
        [...(w.gl.projects.get(p)?.branches.keys() ?? [])].filter((b) => b.startsWith('hub/'))
      ).toEqual([])
    // Both deploy jobs were played (manual), the api's on the pin commit.
    const apiPipes = w.gl.pipelinesOf('efp/deploy')
    const pinned = apiPipes[apiPipes.length - 1]
    expect(pinned.jobs.find((j) => j.name === 'deploy_production')?.plays).toBe(1)
    expect(
      w.gl
        .pipelinesOf('efp/portal')
        .at(-1)
        ?.jobs.find((j) => j.name === 'deploy_production')?.plays
    ).toBe(1)
    // The frontend was pushed only after the api deploy passed.
    const lines = events.filter((e) => e.kind === 'log').map((e) => e.line as string)
    const apiPassed = lines.findIndex((l) => l.startsWith('deploy api: deploy_production passed'))
    const fePush = lines.findIndex((l) => l.startsWith('push frontend: started'))
    expect(apiPassed).toBeGreaterThan(-1)
    expect(fePush).toBeGreaterThan(apiPassed)
    // Each verify URL was read twice (two answers in a row).
    expect(w.gl.servedReads.get(API_URL)).toBe(2)
    expect(w.gl.servedReads.get(FE_URL)).toBe(2)
    // Every GitLab call carried the token in its header and refused redirects.
    expect(w.gl.calls.length).toBeGreaterThan(10)
    for (const c of w.gl.calls) {
      expect(c.token).toBe(w.gl.token)
      expect(c.redirect).toBe('error')
      expect(c.url).not.toContain(w.gl.token)
    }
  })

  it('merge refused: stops before any deploy and deletes the temporary branch', async () => {
    const w = use(world())
    const proj = w.gl.projects.get('efp/deploy')
    if (proj) proj.refuseMerge = true
    const { outcome, steps } = await execute(w, buildPromotionPlan(input(w)))
    expect(outcome.status).toBe('failed')
    expect(outcome.step).toBe('push api')
    expect(outcome.error).toMatch(/conflicts/)
    expect(steps).toEqual(['push api'])
    expect(
      w.gl.calls.some(
        (c) => c.method === 'DELETE' && c.path.startsWith('/repository/branches/hub/')
      )
    ).toBe(true)
    expect([...(proj?.branches.keys() ?? [])].filter((b) => b.startsWith('hub/'))).toEqual([])
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toBe('0.3.9\n')
  })

  it('a merge that changes nothing is success (the branch already holds the commit)', async () => {
    const w = use(world())
    w.gl.branch('efp/deploy', 'production', w.apiSource)
    serveNew(w)
    const { outcome, events } = await execute(
      w,
      buildPromotionPlan(input(w, { components: [apiComp], targetVersion: '0.3.9' }))
    )
    expect(outcome.status).toBe('success')
    expect(w.gl.calls.some((c) => c.path === '/merge_requests')).toBe(false)
    expect(events.some((e) => e.line?.includes('already holds'))).toBe(true)
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toMatch(/^0\.3\.10\n/)
  })

  it('deploy failed: failed at deploy with the job URL', async () => {
    const w = use(world({ apiDeploy: { onPlay: ['running', 'failed'] } }))
    const { outcome, steps } = await execute(w, buildPromotionPlan(input(w)))
    expect(outcome.status).toBe('failed')
    expect(outcome.step).toBe('deploy api')
    expect(steps).toEqual(['push api', 'deploy api'])
    expect(outcome.webUrl).toMatch(/^https:\/\/gitlab\.example\.com\/jobs\/\d+$/)
    expect(outcome.error).toContain(outcome.webUrl)
    expect(w.gl.calls.some((c) => c.url.includes('efp%2Fportal'))).toBe(false)
  })

  it('waits for a deploy job that runs on its own instead of playing it', async () => {
    const w = use(world({ apiDeploy: { statuses: ['pending', 'running', 'running', 'success'] } }))
    serveNew(w)
    const { outcome, events } = await execute(
      w,
      buildPromotionPlan(input(w, { components: [apiComp] }))
    )
    expect(outcome.status).toBe('success')
    expect(w.gl.calls.filter((c) => c.path.endsWith('/play'))).toEqual([])
    expect(events.some((e) => e.line?.includes('runs on its own'))).toBe(true)
  })

  it('verify timeout: failed at verify after 40 reads', async () => {
    const w = use(world())
    w.gl.served.set(API_URL, [{ version: '0.3.9' }])
    const { outcome, k } = await execute(w, buildPromotionPlan(input(w, { components: [apiComp] })))
    expect(outcome.status).toBe('failed')
    expect(outcome.step).toBe('verify')
    expect(outcome.error).toMatch(/never answered version = 0\.3\.10 twice \(last: 0\.3\.9\)/)
    expect(w.gl.servedReads.get(API_URL)).toBe(40)
    expect(k.c.slept).toBeGreaterThanOrEqual(39 * 15_000)
  })

  it('verify needs two answers in a row', async () => {
    const w = use(world())
    w.gl.served.set(API_URL, [{ version: '0.3.10' }, { version: '0.3.9' }, { version: '0.3.10' }])
    const { outcome } = await execute(w, buildPromotionPlan(input(w, { components: [apiComp] })))
    expect(outcome.status).toBe('success')
    expect(w.gl.servedReads.get(API_URL)).toBe(4)
  })

  it('cancel stops at the next step boundary', async () => {
    const w = use(world())
    let stop = false
    const { outcome, steps } = await execute(w, buildPromotionPlan(input(w)), {
      onEvent: () => {},
      deps: {
        stopRequested: () => stop,
        gitlab: {
          runDeployJob: async (...a) => {
            const { runDeployJob } = await import('../../../services/hub/gitlab-write.js')
            const r = await runDeployJob(...a)
            stop = true // asked while the api deploy ran
            return r
          }
        }
      }
    })
    expect(outcome).toEqual({ status: 'cancelled', step: 'deploy api', error: null })
    expect(steps).toEqual(['push api', 'deploy api'])
    expect(w.gl.calls.some((c) => c.url.includes('efp%2Fportal'))).toBe(false)
  })

  it('a cancel asked during the merge still lands the pin commit', async () => {
    const w = use(world())
    let stop = false
    const { outcome, steps } = await execute(w, buildPromotionPlan(input(w)), {
      deps: {
        stopRequested: () => stop,
        gitlab: {
          mergeMergeRequest: async (...a) => {
            const { mergeMergeRequest } = await import('../../../services/hub/gitlab-write.js')
            stop = true
            return mergeMergeRequest(...a)
          }
        }
      }
    })
    expect(outcome.status).toBe('cancelled')
    expect(steps).toEqual(['push api'])
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toMatch(/^0\.3\.10\n/)
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
  })

  it('never puts a token or GitLab answer text in a line, even when GitLab echoes it', async () => {
    const w = use(world())
    const proj = w.gl.projects.get('efp/deploy')
    if (proj) proj.answerAll = { status: 403, body: { message: `token ${w.gl.token} refused` } }
    const { outcome, events } = await execute(w, buildPromotionPlan(input(w)))
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('GitLab refused commitExistsOn (403)')
    for (const e of events) expect(JSON.stringify(e)).not.toContain(w.gl.token)
  })

  it('scrubs an opened token from any line a step writes', async () => {
    const w = use(world())
    const { outcome } = await execute(w, buildPromotionPlan(input(w)), {
      deps: {
        gitlab: {
          commitExistsOn: async () => {
            throw new (await import('../../../services/hub/gitlab-write.js')).GitlabWriteError(
              'GITLAB_REFUSED',
              `refused for ${w.gl.token}`,
              { step: 'commitExistsOn' }
            )
          }
        }
      }
    })
    expect(outcome.error).toBe('refused for ••••••')
  })

  it('refuses a plan with blockers without touching GitLab', async () => {
    const w = use(world())
    const plan = buildPromotionPlan(input(w, { digest: null }))
    const { outcome } = await execute(w, plan)
    expect(outcome.status).toBe('failed')
    expect(w.gl.calls).toEqual([])
  })
})

describe('startPromotion', () => {
  function deps(w: World, redis = fakeRedis(), gather?: () => Promise<PlanInput>) {
    const k = clock()
    const runs: Array<ReturnType<typeof fakeRun>> = []
    return {
      redis,
      runs,
      d: {
        gather: gather ?? (async () => input(w)),
        lock: run.redisPromoteLock(redis),
        startJobRun: async () => {
          const r = fakeRun(70 + runs.length)
          runs.push(r)
          return r
        },
        gitCtx: async (driverId: number) => w.gl.ctx(PROJECTS[driverId]),
        execute: { sleep: k.sleep, now: k.now }
      }
    }
  }
  const req = {
    kind: 'promote' as const,
    version: '0.3.10',
    confirm: 'production',
    user: { id: USER }
  }

  it('runs in the background under a job run and records the deploy', async () => {
    const w = use(world())
    serveNew(w)
    const { d, redis, runs } = deps(w)
    const started = await run.startPromotion(2, req, d)
    expect(started.jobRunId).toBe(70)
    expect(redis.store.has(hubPromoteLockKey(2))).toBe(true)
    await run.awaitPromotion(started.deployId)

    const row = await db('nivaro_hub_deploys').where({ id: started.deployId }).first()
    expect(row).toMatchObject({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version: '0.3.10',
      from_version: '0.3.9',
      status: 'success',
      step: 'verify',
      error: null,
      job_run_id: 70,
      started_by: USER
    })
    expect(JSON.parse(row.plan).ok).toBe(true)
    expect(row.finished_at).not.toBeNull()
    expect(runs[0].ended).toEqual(['complete:promote 0.3.10 on production: done'])
    expect(runs[0].lines.some((l) => l.startsWith('push api: started'))).toBe(true)
    expect(redis.store.has(hubPromoteLockKey(2))).toBe(false)

    const listed = await run.listHubDeploys(2)
    expect(listed[0]).toMatchObject({ id: started.deployId, started_by_name: 'Rita Admin' })
  })

  it('a failed deploy marks the row failed at its step and fails the job run', async () => {
    const w = use(world({ apiDeploy: { onPlay: ['failed'] } }))
    const { d, runs, redis } = deps(w)
    const started = await run.startPromotion(2, req, d)
    await run.awaitPromotion(started.deployId)
    const row = await db('nivaro_hub_deploys').where({ id: started.deployId }).first()
    expect(row.status).toBe('failed')
    expect(row.step).toBe('deploy api')
    expect(row.error).toMatch(
      /deploy_production failed .*https:\/\/gitlab\.example\.com\/jobs\/\d+/
    )
    written.push(row.error)
    expect(runs[0].ended[0]).toMatch(/^fail:promote 0\.3\.10 on production: failed at deploy api/)
    expect(redis.store.size).toBe(0)
  })

  it('refuses without the typed confirm (400 CONFIRM_REQUIRED) and takes no lock', async () => {
    const w = use(world())
    const { d, redis } = deps(w)
    await expect(run.startPromotion(2, { ...req, confirm: 'prod' }, d)).rejects.toMatchObject({
      code: 'CONFIRM_REQUIRED',
      status: 400
    })
    expect(redis.store.size).toBe(0)
  })

  it('refuses with the first blocker (409) and releases the lock', async () => {
    const w = use(world())
    const { d, redis } = deps(w, fakeRedis(), async () =>
      input(w, { digest: null, frontendServed: { 2: null } })
    )
    const err = await run.startPromotion(2, req, d).catch((e) => e)
    expect(err).toMatchObject({ code: 'IMAGE_MISSING', status: 409 })
    expect(err.blockers.map((b: { code: string }) => b.code)).toEqual([
      'IMAGE_MISSING',
      'FRONTEND_UNKNOWN'
    ])
    expect(redis.store.size).toBe(0)
    expect(await db('nivaro_hub_deploys').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('two starts at once: exactly one wins, the other is 409 PROMOTION_RUNNING', async () => {
    const w = use(world())
    serveNew(w)
    const { d } = deps(w)
    const results = await Promise.allSettled([
      run.startPromotion(2, req, d),
      run.startPromotion(2, req, d)
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].reason).toMatchObject({ code: 'PROMOTION_RUNNING', status: 409 })
    expect(lost[0].reason.blockers[0].code).toBe('PROMOTION_RUNNING')
    await run.awaitPromotion(
      (won[0] as PromiseFulfilledResult<{ deployId: number }>).value.deployId
    )
    expect(await db('nivaro_hub_deploys').count({ n: '*' })).toEqual([{ n: 1 }])
  })

  it('a lock already held answers 409 PROMOTION_RUNNING', async () => {
    const w = use(world())
    const redis = fakeRedis()
    redis.store.set(hubPromoteLockKey(2), 'someone-else')
    const { d } = deps(w, redis)
    await expect(run.startPromotion(2, req, d)).rejects.toMatchObject({
      code: 'PROMOTION_RUNNING',
      status: 409
    })
    expect(redis.store.get(hubPromoteLockKey(2))).toBe('someone-else')
  })

  it('cancelPromotion stops the run at the next step boundary', async () => {
    const w = use(world())
    const redis = fakeRedis()
    const { d } = deps(w, redis)
    d.execute = {
      ...d.execute,
      // The cancel arrives while the api is being pushed.
      gitlab: {
        createBranch: async (...a: Parameters<typeof gwCreateBranch>) => {
          const row = await db('nivaro_hub_deploys').where({ status: 'running' }).first('id')
          const r = await run.cancelPromotion(Number(row?.id), { id: USER }, { lock: d.lock })
          expect(r).toEqual({ ok: true })
          return gwCreateBranch(...a)
        }
      }
    } as typeof d.execute
    const started = await run.startPromotion(2, req, d)
    await run.awaitPromotion(started.deployId)
    const row = await db('nivaro_hub_deploys').where({ id: started.deployId }).first()
    expect(row.status).toBe('cancelled')
    expect(row.step).toBe('push api')
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
    expect(redis.store.size).toBe(0)
    expect(await run.cancelPromotion(started.deployId, null, { lock: d.lock })).toEqual({
      ok: false,
      code: 'NOT_RUNNING'
    })
    expect(await run.cancelPromotion(999, null, { lock: d.lock })).toEqual({
      ok: false,
      code: 'NOT_FOUND'
    })
  })
})

describe('recoverInterruptedPromotions', () => {
  it('marks running rows interrupted and frees their locks', async () => {
    current = world()
    const redis = fakeRedis()
    redis.store.set(hubPromoteLockKey(2), 'dead-process')
    await db('nivaro_hub_deploys').insert([
      {
        app_id: 1,
        environment_id: 2,
        kind: 'promote',
        version: '0.3.10',
        status: 'running',
        step: 'deploy api'
      },
      {
        app_id: 1,
        environment_id: 2,
        kind: 'promote',
        version: '0.3.9',
        status: 'success',
        step: 'verify'
      }
    ])
    const n = await run.recoverInterruptedPromotions({ lock: run.redisPromoteLock(redis) })
    expect(n).toBe(1)
    const rows = await db('nivaro_hub_deploys').orderBy('id')
    expect(rows[0]).toMatchObject({
      status: 'interrupted',
      error: 'The Hub restarted during deploy api'
    })
    expect(rows[0].finished_at).not.toBeNull()
    expect(rows[1].status).toBe('success')
    expect(redis.store.has(hubPromoteLockKey(2))).toBe(false)
  })
})
