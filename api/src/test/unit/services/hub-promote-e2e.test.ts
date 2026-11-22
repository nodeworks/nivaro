import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatherDeps } from '../../../services/hub/promote-gather.js'
import type { StartDeps } from '../../../services/hub/promote-run.js'
import type { JobRunHandle } from '../../../services/job-runs.js'

// Nivaro Hub phase 2, end to end over the in-memory GitLab: real gather, real planner, real runner,
// real deploy rows (SQLite). Shaped like the EFP repos: merge_method merge (every merge makes a
// merge commit), deploy_production runs automatically on every push to production, and each app
// answers what its newest successful production deploy built.

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
const gather = await import('../../../services/hub/promote-gather.js')
const run = await import('../../../services/hub/promote-run.js')
const gw = await import('../../../services/hub/gitlab-write.js')
const { buildPromotionPlan } = await import('../../../services/hub/promote-plan.js')
const { FakeGitLab } = await import('./hub-fake-gitlab.js')

const DIGEST = `sha256:${'a'.repeat(64)}`
const PIN = '.docker/nivaro-version'
const STAGING_FE = 'https://staging.example.com/version.json'
const PROD_API = 'https://efp.example.com/api/version'
const PROD_FE = 'https://efp.example.com/version.json'
const PROJECTS: Record<number, string> = { 1: 'efp/deploy', 2: 'efp/portal' }

let gl: InstanceType<typeof FakeGitLab>
let fetchSpy: ReturnType<typeof vi.spyOn>
let stagingVersion = '0.3.10'
let stagingPortal = ''

/** Production's auto deploy: build, then deploy_production on its own. */
const prodJobs = (ref: string) =>
  ref === 'production'
    ? [
        { name: 'build', statuses: ['running', 'success'] },
        { name: 'deploy_production', statuses: ['pending', 'running', 'success'] }
      ]
    : []

/** The commit the newest successful deploy_production of a project built (what the app runs). */
function deployedCommit(project: string): string | null {
  let best: { id: number; sha: string } | null = null
  for (const p of gl.pipelinesOf(project)) {
    if (p.ref !== 'production') continue
    for (const j of p.jobs as Array<{ id: number; name: string; statuses: string[]; at: number }>)
      if (j.name === 'deploy_production' && j.statuses[j.at] === 'success')
        if (!best || j.id > best.id) best = { id: j.id, sha: p.sha }
  }
  return best?.sha ?? null
}

function prodApiVersion(): string | null {
  const sha = deployedCommit('efp/deploy')
  const tree = sha ? gl.projects.get('efp/deploy')?.commits.get(sha)?.tree : null
  return tree?.get(PIN)?.split('\n')[0] ?? null
}
const prodPortal = () => deployedCommit('efp/portal')?.slice(0, 8) ?? ''

const prodPipelines = (project: string) =>
  gl.pipelinesOf(project).filter((p) => p.ref === 'production').length

function gatherDeps(): GatherDeps {
  return {
    readStatus: async (env) => ({
      state: 'ok',
      version: env.id === 1 ? stagingVersion : prodApiVersion(),
      preflight: null,
      checked_at: '2026-11-21T00:00:00.000Z',
      source: 'public'
    }),
    imageDigest: async () => DIGEST,
    ctxFor: (driver) => gl.ctx(driver.config.project),
    latestCommitMatching: gw.latestCommitMatching,
    commitExistsOn: gw.commitExistsOn,
    readFile: gw.readFile,
    findPipeline: gw.findPipeline,
    jobNamed: gw.jobNamed,
    resolveCommit: gather.resolveCommit,
    readServedField: (url, field) => gather.readServedField(url, field),
    gitlabDeployedVersions: async () => [],
    isLocked: async () => false
  }
}

function fakeRun(): JobRunHandle & { lines: string[] } {
  const lines: string[] = []
  return {
    id: 70,
    lines,
    progress() {},
    log(line) {
      lines.push(line)
    },
    async complete() {},
    async fail() {}
  }
}

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
    async eval(script: string, _n: number, ...args: Array<string | number>) {
      const [key, token] = args.map(String)
      if (store.get(key) !== token) return 0
      if (script.includes("'del'")) store.delete(key)
      return 1
    }
  }
}

function startDeps(over: Partial<StartDeps> = {}) {
  const clock = { t: 1_000_000 }
  const runs: Array<ReturnType<typeof fakeRun>> = []
  const deps: StartDeps = {
    gather: (envId, opts) => gather.gatherPlanInput(envId, opts, gatherDeps()),
    lock: run.redisPromoteLock(fakeRedis()),
    startJobRun: async () => {
      const r = fakeRun()
      runs.push(r)
      return r
    },
    gitCtx: async (driverId) => gl.ctx(PROJECTS[driverId]),
    ...over,
    execute: {
      sleep: async (ms) => {
        clock.t += ms
      },
      now: () => clock.t,
      ...over.execute
    }
  }
  return { deps, runs }
}

/** Starts a promotion and waits for it; answers its row with the stored plan parsed. */
async function promote(
  kind: 'promote' | 'rollback',
  version: string,
  over: Partial<StartDeps> = {}
) {
  const { deps, runs } = startDeps(over)
  // The plan the person previewed (POST /plan) carries the hash the start must send.
  const seen = buildPromotionPlan(await gather.gatherPlanInput(2, { kind, version }, gatherDeps()))
  const { deployId } = await run.startPromotion(
    2,
    { kind, version, confirm: 'production', planHash: seen.plan_hash, user: null },
    deps
  )
  await run.awaitPromotion(deployId)
  const row = await db('nivaro_hub_deploys').where({ id: deployId }).first()
  return {
    row,
    plan: JSON.parse(String(row.plan)) as {
      steps: Array<{ component: string; deployedSha?: string; deployedPipelineId?: number }>
    },
    lines: runs[0]?.lines ?? []
  }
}

/** A release lands on the source branches and staging runs it. */
function release(version: string): void {
  gl.commit('efp/deploy', 'main', `chore: deploy nivaro ${version}`)
  stagingPortal = gl.commit('efp/portal', 'main', `feat: portal for ${version}`)
  stagingVersion = version
}

const driverConfig = (project: string) =>
  JSON.stringify({
    api: 'https://gitlab.example.com',
    project,
    branch: 'production',
    pin_file: PIN,
    deploy_job: 'deploy_production'
  })

beforeAll(async () => {
  await m542.up(db)
  await m543.up(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_components',
    'nivaro_hub_deploys'
  ])
    await db(t).del()
  await db('nivaro_hub_apps').insert({ id: 1, key: 'efp', name: 'EFP' })
  await db('nivaro_hub_drivers').insert([
    { id: 1, kind: 'gitlab', name: 'deploy', config: driverConfig('efp/deploy') },
    { id: 2, kind: 'gitlab', name: 'portal', config: driverConfig('efp/portal') }
  ])
  await db('nivaro_hub_placements').insert([
    { id: 4, kind: 'dedicated', driver_id: 1, target: '{}' },
    { id: 5, kind: 'dedicated', driver_id: 1, target: '{}' }
  ])
  await db('nivaro_hub_environments').insert([
    {
      id: 1,
      app_id: 1,
      key: 'staging',
      position: 1,
      base_url: 'https://staging.example.com',
      placement_id: 4,
      hub_managed: false
    },
    {
      id: 2,
      app_id: 1,
      key: 'production',
      position: 2,
      base_url: 'https://efp.example.com',
      placement_id: 5,
      hub_managed: true
    }
  ])
  const comp = (
    placement: number,
    position: number,
    name: string,
    kind: string,
    driver: number,
    verify: string,
    before: string | null
  ) => ({
    placement_id: placement,
    position,
    name,
    kind,
    driver_id: driver,
    source_branch: 'main',
    before_job: before,
    verify_url: verify,
    verify_field: 'version'
  })
  await db('nivaro_hub_components').insert([
    comp(5, 1, 'api', 'api', 1, PROD_API, 'build'),
    comp(5, 2, 'frontend', 'frontend', 2, PROD_FE, 'build'),
    comp(4, 1, 'api', 'api', 1, 'https://staging.example.com/api/version', null),
    comp(4, 2, 'frontend', 'frontend', 2, STAGING_FE, null)
  ])

  gl = new FakeGitLab()
  gl.project('efp/deploy', prodJobs)
  const base = gl.commit('efp/deploy', 'main', 'initial', { 'stack.yml': 'v1\n' })
  gl.branch('efp/deploy', 'production', base)
  // Production pins on its own branch (the laptop script's commits): main never has the file.
  const pinned = gl.commit('efp/deploy', 'production', 'chore: promote nivaro 0.3.9', {
    [PIN]: `0.3.9\n${DIGEST}\n`
  })
  gl.pipeline('efp/deploy', 'production', pinned, [
    { name: 'deploy_production', statuses: ['success'] }
  ])
  gl.project('efp/portal', prodJobs)
  const feBase = gl.commit('efp/portal', 'main', 'portal initial')
  gl.branch('efp/portal', 'production', feBase)
  gl.pipeline('efp/portal', 'production', feBase, [
    { name: 'deploy_production', statuses: ['success'] }
  ])
  gl.served.set(STAGING_FE, [() => ({ version: stagingPortal.slice(0, 8) })])
  gl.served.set(PROD_API, [() => ({ version: prodApiVersion() ?? '' })])
  gl.served.set(PROD_FE, [() => ({ version: prodPortal() })])
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(gl.fetch as typeof fetch)
})

afterEach(() => {
  fetchSpy?.mockRestore()
})

describe('hub promotions end to end (merge-commit repos, automatic deploys)', () => {
  it('B1: one API promotion = one new production pipeline per repository', async () => {
    release('0.3.10')
    const before = [prodPipelines('efp/deploy'), prodPipelines('efp/portal')]
    const { row, lines } = await promote('promote', '0.3.10')
    expect(row.status).toBe('success')
    expect([prodPipelines('efp/deploy'), prodPipelines('efp/portal')]).toEqual([
      before[0] + 1,
      before[1] + 1
    ])
    expect(gl.file('efp/deploy', 'production', PIN)).toBe(`0.3.10\n${DIGEST}\n${DIGEST}\n`)
    expect(prodApiVersion()).toBe('0.3.10')
    expect(
      lines.filter((l) => l.includes('deploy_production ran automatically and passed'))
    ).toHaveLength(2)
  })

  it('B2: promote, promote, roll back: the portal answers the build it ran before', async () => {
    release('0.3.10')
    const first = await promote('promote', '0.3.10')
    expect(first.row.status).toBe('success')
    const fe1 = first.plan.steps.find((s) => s.component === 'frontend')
    // Production built the merge commit, not the commit staging served.
    expect(fe1?.deployedSha).toBe(gl.projects.get('efp/portal')?.branches.get('production'))
    expect(fe1?.deployedSha).not.toBe(stagingPortal)
    expect(fe1?.deployedPipelineId).toEqual(expect.any(Number))
    const servedAfterFirst = prodPortal()
    expect(servedAfterFirst).toBe(fe1?.deployedSha?.slice(0, 8))

    release('0.3.11')
    const second = await promote('promote', '0.3.11')
    expect(second.row.status).toBe('success')
    expect(prodPortal()).not.toBe(servedAfterFirst)

    const back = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.10' }, gatherDeps())
    )
    expect(back.blockers).toEqual([])
    const api1 = first.plan.steps.find((s) => s.component === 'api')
    const headsBefore = [
      gl.projects.get('efp/deploy')?.branches.get('production'),
      gl.projects.get('efp/portal')?.branches.get('production')
    ]
    const mrsBefore = gl.calls.filter((c) => c.path === '/merge_requests').length
    const rolled = await promote('rollback', '0.3.10')
    expect(rolled.row).toMatchObject({ status: 'success', step: 'verify', error: null })
    expect(prodApiVersion()).toBe('0.3.10')
    expect(prodPortal()).toBe(servedAfterFirst)
    // P21: both reran their recorded builds — the API's is the commit that carried the 0.3.10
    // pin (old Nivaro + old extension together). Nothing was merged, pinned or committed: the
    // branches keep the newer pin, so the next promotion moves forward from them.
    expect(gl.retries).toHaveLength(2)
    expect(rolled.plan.steps.find((s) => s.component === 'api')?.deployedSha).toBe(
      api1?.deployedSha
    )
    expect([
      gl.projects.get('efp/deploy')?.branches.get('production'),
      gl.projects.get('efp/portal')?.branches.get('production')
    ]).toEqual(headsBefore)
    expect(gl.file('efp/deploy', 'production', PIN)).toMatch(/^0\.3\.11\n/)
    expect(gl.calls.filter((c) => c.path === '/merge_requests').length).toBe(mrsBefore)
    expect(rolled.lines.some((l) => l.includes("redeploying frontend's build"))).toBe(true)
    expect(rolled.lines.some((l) => l.includes("redeploying api's build"))).toBe(true)
    // P22: the portal goes back first, then the API.
    const started = rolled.lines.filter((l) => / started$/.test(l))
    expect(started).toEqual([
      'push frontend: started',
      'deploy frontend: started',
      'push api: started',
      'deploy api: started',
      'verify: started'
    ])
  })

  it('B2: a rollback whose frontend build is gone is refused before the API moves', async () => {
    release('0.3.10')
    await promote('promote', '0.3.10')
    release('0.3.11')
    await promote('promote', '0.3.11')
    // GitLab pruned the 0.3.10 portal pipeline.
    const keep = gl.pipelinesOf('efp/portal')
    const fe = (await db('nivaro_hub_deploys').where({ version: '0.3.10' }).first()).plan
    const pid = JSON.parse(fe).steps[1].deployedPipelineId
    keep.splice(
      keep.findIndex((p) => p.id === pid),
      1
    )
    const deployPipes = prodPipelines('efp/deploy')
    await expect(
      run.startPromotion(
        2,
        {
          kind: 'rollback',
          version: '0.3.10',
          confirm: 'production',
          planHash: 'f'.repeat(64),
          user: null
        },
        startDeps().deps
      )
    ).rejects.toMatchObject({ code: 'FRONTEND_ROLLBACK_NO_BUILD', status: 409 })
    expect(prodPipelines('efp/deploy')).toBe(deployPipes)
    expect(prodApiVersion()).toBe('0.3.11')
  })

  it('the plan hash covers who deploys: a switched driver or an edited repository is PLAN_CHANGED', async () => {
    release('0.3.10')
    const seen = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, gatherDeps())
    )
    expect(seen.ok).toBe(true)
    // The same repository under another path: same commits, same branches, same served commit.
    const portal = gl.projects.get('efp/portal')
    if (portal) gl.projects.set('efp/portal-copy', portal)
    const start = () =>
      run
        .startPromotion(
          2,
          {
            kind: 'promote',
            version: '0.3.10',
            confirm: 'production',
            planHash: seen.plan_hash,
            user: null
          },
          startDeps().deps
        )
        .catch((e) => e)

    // 1. The component is switched to another driver pointing at that repository.
    await db('nivaro_hub_drivers').insert({
      id: 3,
      kind: 'gitlab',
      name: 'portal copy',
      config: driverConfig('efp/portal-copy')
    })
    await db('nivaro_hub_components')
      .where({ placement_id: 5, kind: 'frontend' })
      .update({ driver_id: 3 })
    expect(await start()).toMatchObject({ code: 'PLAN_CHANGED', status: 409 })

    // 2. Back on its driver, but the driver's project is edited in place.
    await db('nivaro_hub_components')
      .where({ placement_id: 5, kind: 'frontend' })
      .update({ driver_id: 2 })
    await db('nivaro_hub_drivers')
      .where({ id: 2 })
      .update({ config: driverConfig('efp/portal-copy') })
    const edited = await start()
    expect(edited).toMatchObject({ code: 'PLAN_CHANGED', status: 409 })
    expect(edited.plan.ok).toBe(true)
    expect(await db('nivaro_hub_deploys').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(gl.calls.some((c) => c.method !== 'GET')).toBe(false)
  })

  it('B5: a promotion stopped after the api finishes when started again: only the portal runs', async () => {
    release('0.3.10')
    let stop = false
    const stopped = await promote('promote', '0.3.10', {
      execute: {
        stopRequested: () => stop,
        gitlab: {
          runDeployJob: async (...a) => {
            const r = await gw.runDeployJob(...a)
            stop = true // the cancel arrives while the api deploys
            return r
          }
        }
      }
    })
    expect(stopped.row).toMatchObject({ status: 'cancelled', step: 'deploy api' })
    expect(prodApiVersion()).toBe('0.3.10')
    expect(stopped.plan.steps[0].deployedSha).toEqual(expect.any(String))
    expect(stopped.plan.steps[1].deployedSha).toBeUndefined()

    const plan = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, gatherDeps())
    )
    expect(plan.blockers).toEqual([])
    const before = [prodPipelines('efp/deploy'), prodPipelines('efp/portal')]
    const again = await promote('promote', '0.3.10')
    expect(again.row.status).toBe('success')
    expect([prodPipelines('efp/deploy'), prodPipelines('efp/portal')]).toEqual([
      before[0],
      before[1] + 1
    ])
    expect(again.lines.some((l) => l.includes('push api:') && l.includes('nothing to do'))).toBe(
      true
    )
    expect(again.lines.some((l) => l.startsWith('deploy api:'))).toBe(false)
    expect(again.plan.steps.every((s) => !!s.deployedSha)).toBe(true)
    // Finished now: the same version again is ALREADY_RUNS.
    const done = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, gatherDeps())
    )
    expect(done.blockers.map((b) => b.code)).toEqual(['ALREADY_RUNS'])
  })
})
