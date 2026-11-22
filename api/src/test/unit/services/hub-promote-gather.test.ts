import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatherDeps } from '../../../services/hub/promote-gather.js'

// Nivaro Hub phase 2: gathering the planner's facts. Real SQLite for apps, environments,
// placements, components, drivers and deploy rows; the real GitLab write client over the
// in-memory GitLab; status readers and the registry are stubbed.

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
const gw = await import('../../../services/hub/gitlab-write.js')
const { buildPromotionPlan } = await import('../../../services/hub/promote-plan.js')
const { FakeGitLab } = await import('./hub-fake-gitlab.js')

const DIGEST = `sha256:${'a'.repeat(64)}`
const STAGING_FE = 'https://staging.example.com/version.json'

let gl: InstanceType<typeof FakeGitLab>
let fetchSpy: ReturnType<typeof vi.spyOn>
const versions: Record<number, string | null> = {}
let locked = false
let gitlabHistory: string[] = []

function deps(): GatherDeps {
  return {
    readStatus: async (env) => ({
      state: 'ok',
      version: versions[env.id] ?? null,
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
    gitlabDeployedVersions: async () => gitlabHistory,
    isLocked: async () => locked
  }
}

const driverConfig = (project: string) =>
  JSON.stringify({
    api: 'https://gitlab.example.com',
    project,
    branch: 'production',
    pin_file: '.docker/nivaro-version',
    deploy_job: 'deploy_production'
  })

beforeAll(async () => {
  await m542.up(db)
  await m543.up(db)
})

afterAll(async () => {
  await db.destroy()
})

let api: Record<string, string>
let feFull: string

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
  locked = false
  gitlabHistory = []
  versions[1] = '0.3.10'
  versions[2] = '0.3.9'
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
    verify: string
  ) => ({
    placement_id: placement,
    position,
    name,
    kind,
    driver_id: driver,
    source_branch: 'main',
    verify_url: verify,
    verify_field: 'version'
  })
  await db('nivaro_hub_components').insert([
    comp(5, 1, 'api', 'api', 1, 'https://efp.example.com/api/version'),
    comp(5, 2, 'frontend', 'frontend', 2, 'https://efp.example.com/version.json'),
    comp(4, 1, 'api', 'api', 1, 'https://staging.example.com/api/version'),
    comp(4, 2, 'frontend', 'frontend', 2, STAGING_FE)
  ])

  gl = new FakeGitLab()
  gl.project('efp/deploy')
  const base = gl.commit('efp/deploy', 'main', 'initial')
  gl.branch('efp/deploy', 'production', base)
  api = {
    '0.3.1': gl.commit('efp/deploy', 'main', 'chore: deploy nivaro 0.3.1'),
    '0.3.10': gl.commit('efp/deploy', 'main', 'chore: deploy nivaro 0.3.10'),
    '0.3.10-note': gl.commit('efp/deploy', 'main', 'chore: deploy nivaro 0.3.10 (efp-ops sync)')
  }
  gl.project('efp/portal')
  const feBase = gl.commit('efp/portal', 'main', 'portal initial')
  gl.branch('efp/portal', 'production', feBase)
  feFull = gl.commit('efp/portal', 'main', 'feat: portal change')
  gl.served.set(STAGING_FE, [{ version: feFull.slice(0, 8) }])
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(gl.fetch as typeof fetch)
})

afterEach(() => {
  fetchSpy?.mockRestore()
})

describe('gatherPlanInput', () => {
  it('collects a promotion that plans clean', async () => {
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    expect(input.target.key).toBe('production')
    expect(input.previous?.key).toBe('staging')
    expect(input.components.map((c) => c.name)).toEqual(['api', 'frontend'])
    expect(input.targetVersion).toBe('0.3.9')
    expect(input.previousVersion).toBe('0.3.10')
    expect(input.sources[1]).toEqual({ sha: api['0.3.10'], subject: 'chore: deploy nivaro 0.3.10' })
    expect(input.sourceOnTarget).toEqual({ 1: false })
    expect(input.frontendServed).toEqual({ 2: feFull.slice(0, 8) })
    expect(input.frontendOnSource).toEqual({ 2: true })
    expect(input.drivers[1]).toEqual({
      branch: 'production',
      deploy_job: 'deploy_production',
      pin_file: '.docker/nivaro-version'
    })
    expect(input.digest).toBe(DIGEST)
    expect(input.running).toBe(false)
    expect(buildPromotionPlan(input).ok).toBe(true)
  })

  it('end-anchors the version: 0.3.1 never matches a 0.3.10 commit', async () => {
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.1' }, deps())
    expect(input.sources[1]?.sha).toBe(api['0.3.1'])
    expect(gather.sourceSubjectRe('0.3.1').test('chore: deploy nivaro 0.3.10')).toBe(false)
    expect(gather.sourceSubjectRe('0.3.1').test('chore: deploy nivaro 0.3.1')).toBe(true)
    expect(gather.sourceSubjectRe('0.3.1').test('chore: deploy nivaro 0x3y1')).toBe(false)
  })

  it('resolves the served short sha to the full one before checking its branch', async () => {
    const stray = gl.commit('efp/portal', 'feature', 'wip')
    gl.served.set(STAGING_FE, [{ version: stray.slice(0, 8) }])
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    expect(input.frontendServed[2]).toBe(stray.slice(0, 8))
    expect(input.frontendOnSource[2]).toBe(false)
    const refs = gl.calls.filter((c) => c.path.endsWith('/refs'))
    expect(refs.some((c) => c.path === `/repository/commits/${stray}/refs`)).toBe(true)
    expect(buildPromotionPlan(input).blockers.map((b) => b.code)).toContain(
      'FRONTEND_NOT_ON_SOURCE'
    )
  })

  it('previous ran it = the Hub deploys there UNION what it answers now', async () => {
    versions[1] = '0.3.11'
    await db('nivaro_hub_deploys').insert([
      { app_id: 1, environment_id: 1, kind: 'promote', version: '0.3.10', status: 'success' },
      { app_id: 1, environment_id: 1, kind: 'promote', version: '0.3.8', status: 'failed' }
    ])
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    expect(input.previousDeployedVersions.sort()).toEqual(['0.3.10', '0.3.11'])
    expect(buildPromotionPlan(input).blockers.map((b) => b.code)).not.toContain(
      'PREVIOUS_NEVER_RAN'
    )
  })

  /** A successful Hub run of `version` here; steps carry what each deploy ran on. */
  const recordedRun = (
    version: string,
    steps: Array<Record<string, unknown>>,
    status = 'success'
  ) =>
    db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version,
      status,
      plan: JSON.stringify({ steps })
    })

  it('B2: a rollback redeploys the commit the deploy job ran on (the merge commit) and its pipeline', async () => {
    versions[2] = '0.3.10'
    const merged = gl.commit('efp/portal', 'production', 'Merge into production')
    const build = gl.pipeline('efp/portal', 'production', merged, [
      { name: 'deploy_production', statuses: ['success'] }
    ])
    await recordedRun('0.3.1', [
      { kind: 'api', component: 'api', position: 1, deployedSha: 'f00d', deployedPipelineId: 9 },
      {
        kind: 'frontend',
        component: 'frontend',
        position: 2,
        sourceSha: feFull.slice(0, 8),
        deployedSha: merged,
        deployedPipelineId: build.id
      }
    ])
    const input = await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.1' }, deps())
    expect(input.frontendServed).toEqual({ 2: merged })
    expect(input.frontendOnSource).toEqual({ 2: true })
    expect(input.frontendRollbackBuild).toEqual({ 2: { pipelineId: build.id, problem: null } })
    expect(input.targetDeployedVersions).toEqual(['0.3.1'])
    const plan = buildPromotionPlan(input)
    expect(plan.ok).toBe(true)
    expect(plan.steps[1]).toMatchObject({ sourceSha: merged, buildPipelineId: build.id })
    // B8: the plan says it redeploys that build, never "serves" or "merge".
    expect(plan.lines).toContain(`Frontend: redeploy frontend's build ${merged.slice(0, 7)}`)
    expect(plan.lines.join('\n')).not.toMatch(/staging serves|merge [0-9a-f]{7} into/)
  })

  it('B2: a rollback whose frontend build cannot be rerun is refused at plan time', async () => {
    versions[2] = '0.3.10'
    const merged = gl.commit('efp/portal', 'production', 'Merge into production')
    const build = gl.pipeline('efp/portal', 'production', merged, [
      { name: 'deploy_production', statuses: ['manual'] }
    ])
    await recordedRun('0.3.1', [
      { kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' },
      { kind: 'frontend', component: 'frontend', position: 2, deployedSha: merged }
    ])
    const plan = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.1' }, deps())
    )
    expect(plan.blockers).toEqual([
      {
        code: 'FRONTEND_ROLLBACK_NO_BUILD',
        text: "frontend: the earlier build can't be rerun (job is manual)"
      }
    ])
    expect(build.jobs[0].plays).toBe(0)
    // No pipeline at all for the commit: refused the same way.
    gl.pipelinesOf('efp/portal').length = 0
    const none = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.1' }, deps())
    )
    expect(none.blockers.map((b) => b.code)).toEqual(['FRONTEND_ROLLBACK_NO_BUILD'])
    expect(none.blockers[0].text).toMatch(/has no pipeline for .* no build of that commit/)
  })

  it('a rollback whose recorded build is no longer on the target branch is refused at plan time', async () => {
    versions[2] = '0.3.10'
    // Recorded, with a pipeline, but production no longer holds the commit (force-pushed away).
    const gone = gl.commit('efp/portal', 'elsewhere', 'Merge into production')
    const build = gl.pipeline('efp/portal', 'production', gone, [
      { name: 'deploy_production', statuses: ['success'] }
    ])
    await recordedRun('0.3.1', [
      { kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' },
      {
        kind: 'frontend',
        component: 'frontend',
        position: 2,
        deployedSha: gone,
        deployedPipelineId: build.id
      }
    ])
    const plan = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.1' }, deps())
    )
    expect(plan.blockers).toEqual([
      {
        code: 'FRONTEND_ROLLBACK_NO_BUILD',
        text: `frontend: ${gone.slice(0, 8)} is no longer on production — that build can't be redeployed`
      }
    ])
  })

  it('a held frontend: the plan reads the target head it will deploy', async () => {
    gl.branch('efp/portal', 'production', feFull)
    const head = gl.commit('efp/portal', 'production', 'feat: newer on production')
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    expect(input.frontendHeld).toEqual({ 2: true })
    expect(input.frontendHead).toEqual({ 2: head })
    const plan = buildPromotionPlan(input)
    expect(plan.steps[1].expectHead).toBe(head)
    expect(plan.lines).toContain(
      `Frontend: production already holds ${feFull.slice(0, 7)} — deploy production's current head ${head.slice(0, 7)}`
    )
  })

  it('a same-version run whose image changed is refused with PIN_CHANGED', async () => {
    versions[2] = '0.3.10'
    gl.branch('efp/deploy', 'production', api['0.3.10'])
    gl.commit('efp/deploy', 'production', 'pin', {
      '.docker/nivaro-version': `0.3.10\nsha256:${'c'.repeat(64)}\n`
    })
    await recordedRun(
      '0.3.10',
      [{ kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' }],
      'cancelled'
    )
    const plan = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    )
    expect(plan.blockers.map((b) => b.code)).toEqual(['PIN_CHANGED'])
    expect(plan.blockers[0].text).toMatch(
      /^api: the image for 0\.3\.10 changed since it was deployed — production pins 0\.3\.10 image cccccccccccc, the registry now has 0\.3\.10 image aaaaaaaaaaaa/
    )
  })

  it('B3: rollback offers only Hub runs with every deployed commit recorded; GitLab history only without a frontend', async () => {
    versions[2] = '0.3.10'
    gitlabHistory = ['0.3.8', '0.3.9']
    // A run before deployed commits were recorded, and one stopped after the api.
    await recordedRun('0.3.5', [
      { kind: 'api', component: 'api', position: 1, sourceSha: 'aaa' },
      { kind: 'frontend', component: 'frontend', position: 2, sourceSha: 'bbbbbbb' }
    ])
    await recordedRun(
      '0.3.6',
      [{ kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' }],
      'cancelled'
    )
    await recordedRun('0.3.7', [
      { kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' },
      { kind: 'frontend', component: 'frontend', position: 2, deployedSha: feFull }
    ])
    const input = await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.9' }, deps())
    expect(input.targetDeployedVersions).toEqual(['0.3.7'])
    const plan = buildPromotionPlan(input)
    expect(plan.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['NOT_DEPLOYED_BEFORE', 'FRONTEND_UNKNOWN'])
    )
    expect(plan.blockers.find((b) => b.code === 'FRONTEND_UNKNOWN')?.text).toBe(
      'frontend: the Hub has no record of the build production deployed with 0.3.9'
    )
    expect(plan.lines.join('\n')).not.toContain('serves')

    // An API-only placement: GitLab's own history (deploys before the Hub) counts.
    await db('nivaro_hub_components').where({ placement_id: 5, kind: 'frontend' }).del()
    const apiOnly = await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.9' }, deps())
    expect(apiOnly.targetDeployedVersions).toEqual(['0.3.7', '0.3.8', '0.3.9'])
  })

  it('B5: a promote of the version the target runs reads what is recorded and what the target serves', async () => {
    versions[2] = '0.3.10'
    // The api release commit and its pin are on production; the portal is not.
    gl.branch('efp/deploy', 'production', api['0.3.10'])
    gl.commit('efp/deploy', 'production', 'pin', {
      '.docker/nivaro-version': `0.3.10\n${DIGEST}\n${DIGEST}\n`
    })
    gl.served.set('https://efp.example.com/version.json', [{ version: 'feba5e1' }])
    await recordedRun(
      '0.3.10',
      [{ kind: 'api', component: 'api', position: 1, deployedSha: 'f00d' }],
      'cancelled'
    )
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    expect(input.recordedDeploys).toEqual({ 1: ['f00d'] })
    expect(input.pinOnTarget).toEqual({ 1: `0.3.10\n${DIGEST}\n${DIGEST}\n` })
    expect(input.frontendOnTarget).toEqual({ 2: 'feba5e1' })
    expect(input.frontendHeld).toEqual({ 2: false })
    const plan = buildPromotionPlan(input)
    expect(plan.ok).toBe(true)
    expect(plan.steps.map((st) => [st.component, !!st.noop])).toEqual([
      ['api', true],
      ['frontend', false]
    ])
  })

  it('running: a held lock, or a running row whose lock is held; a stale row is interrupted', async () => {
    const plan = (lockHeld?: boolean) =>
      gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10', lockHeld }, deps())
    locked = true
    expect((await plan()).running).toBe(true)
    expect((await plan(true)).running).toBe(false)
    const row = (step: string) => ({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version: '0.3.10',
      status: 'running',
      step
    })
    // Someone else holds the lock: their running row stands.
    const [live] = (await db('nivaro_hub_deploys').insert(row('deploy api'))) as number[]
    expect((await plan()).running).toBe(true)
    expect((await db('nivaro_hub_deploys').where({ id: live }).first()).status).toBe('running')
    // Nobody holds it: the row is stale, interrupted before planning.
    locked = false
    expect((await plan()).running).toBe(false)
    expect(await db('nivaro_hub_deploys').where({ id: live }).first()).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during deploy api'
    })
    // We hold it (start): any running row is stale.
    locked = true
    const [other] = (await db('nivaro_hub_deploys').insert(row('verify'))) as number[]
    expect((await plan(true)).running).toBe(false)
    expect((await db('nivaro_hub_deploys').where({ id: other }).first()).status).toBe('interrupted')
  })

  it('a stale row healed by a plan read loses its temporary branches', async () => {
    const [id] = (await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version: '0.3.10',
      status: 'running',
      step: 'push frontend',
      plan: JSON.stringify({ steps: [{ position: 2, driverId: 2 }] })
    })) as number[]
    gl.branch('efp/portal', `hub/promote-${id}-2`, feFull)
    const input = await gather.gatherPlanInput(
      2,
      { kind: 'promote', version: '0.3.10' },
      {
        ...deps(),
        heal: { gitCtx: async () => gl.ctx('efp/portal'), logger: null }
      }
    )
    expect(input.running).toBe(false)
    expect((await db('nivaro_hub_deploys').where({ id }).first()).status).toBe('interrupted')
    expect(gl.projects.get('efp/portal')?.branches.has(`hub/promote-${id}-2`)).toBe(false)
  })

  it('an unknown lock (Redis down) is a plan line, not PROMOTION_RUNNING', async () => {
    const input = await gather.gatherPlanInput(
      2,
      { kind: 'promote', version: '0.3.10' },
      {
        ...deps(),
        isLocked: async () => 'unknown'
      }
    )
    expect(input.running).toBe(false)
    expect(input.lockUnknown).toBe(true)
    const plan = buildPromotionPlan(input)
    expect(plan.blockers.map((b) => b.code)).not.toContain('PROMOTION_RUNNING')
    expect(plan.lines).toContain(
      'Could not check whether a promotion is running — starting checks again'
    )
  })

  it('a phase-1 placement deploys its implicit api to the placement branch', async () => {
    await db('nivaro_hub_components').where({ placement_id: 5 }).del()
    await db('nivaro_hub_placements').where({ id: 5 }).update({ target: '{"branch":"release"}' })
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    expect(input.components).toHaveLength(1)
    expect(input.components[0]).toMatchObject({
      kind: 'api',
      implicit: true,
      target_branch: 'release'
    })
  })

  it('an unknown environment is 404', async () => {
    await expect(
      gather.gatherPlanInput(99, { kind: 'promote', version: '0.3.10' }, deps())
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })
})

describe('readServedField / resolveCommit', () => {
  it('reads a field without a token and names a failure plainly', async () => {
    gl.served.set('https://x.example.com/v', [{ version: '1.2.3' }])
    expect(await gather.readServedField('https://x.example.com/v', 'version')).toEqual({
      value: '1.2.3',
      error: null
    })
    gl.served.set('https://x.example.com/e', [503])
    expect(await gather.readServedField('https://x.example.com/e', 'version')).toEqual({
      value: null,
      error: 'HTTP 503'
    })
    const call = fetchSpy.mock.calls.find(
      (c: unknown[]) => String(c[0]) === 'https://x.example.com/v'
    )
    expect(JSON.stringify(call?.[1] ?? {})).not.toContain('PRIVATE-TOKEN')
  })

  it('resolves a short sha; unknown = null; refuses without a token', async () => {
    const ctx = gl.ctx('efp/portal')
    expect(await gather.resolveCommit(ctx, feFull.slice(0, 8))).toBe(feFull)
    expect(await gather.resolveCommit(ctx, 'deadbeef')).toBeNull()
    await expect(gather.resolveCommit({ ...ctx, token: null }, 'abc')).rejects.toMatchObject({
      code: 'GITLAB_NO_TOKEN'
    })
    const last = gl.calls.at(-1)
    expect(last?.redirect).toBe('error')
  })
})
