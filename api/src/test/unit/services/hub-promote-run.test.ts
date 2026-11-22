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

import type { FinishRow } from '../../../services/hub/promote-run.js'
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
  const until = new Map<string, number>()
  const r = {
    store,
    /** The fake's clock (ms); PX keys vanish once it passes their expiry. */
    now: 0,
    expire() {
      for (const [k, t] of until)
        if (t <= r.now) {
          store.delete(k)
          until.delete(k)
        }
    },
    async set(key: string, value: string, ...args: Array<string | number>) {
      r.expire()
      if (args.includes('NX') && store.has(key)) return null
      store.set(key, value)
      const px = args.indexOf('PX')
      if (px >= 0) until.set(key, r.now + Number(args[px + 1]))
      else until.delete(key)
      return 'OK'
    },
    async get(key: string) {
      r.expire()
      return store.get(key) ?? null
    },
    async del(...keys: string[]) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n++
      return n
    },
    async exists(key: string) {
      r.expire()
      return store.has(key) ? 1 : 0
    },
    async eval(script: string, _n: number, ...args: Array<string | number>) {
      const [key, token, ms] = args.map(String)
      r.expire()
      if (store.get(key) !== token) return 0
      if (script.includes("'del'")) store.delete(key)
      else if (ms) until.set(key, r.now + Number(ms))
      return 1
    }
  }
  return r
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

function ctxFor(w: World, deployId = 1, kind: 'promote' | 'rollback' = 'promote') {
  return {
    deployId,
    version: '0.3.10',
    kind,
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
  extra: Parameters<typeof run.executePlan>[2] = {},
  kind: 'promote' | 'rollback' = 'promote'
) {
  const k = clock()
  const events: Array<{ kind: string; step?: string; line?: string }> = []
  const outcome = await run.executePlan(plan, ctxFor(w, 1, kind), {
    ...extra,
    onEvent: (e) => {
      events.push(e)
      if (e.kind === 'log') written.push(e.line)
      else if (e.kind === 'step') written.push(e.step)
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
  it('a created app whose CI settings moved stops before its step writes anything', async () => {
    const w = use(world())
    serveNew(w)
    const plan = buildPromotionPlan(input(w))
    const asked: Array<{ component: string; project: string }> = []
    const { GitlabWriteError } = await import('../../../services/hub/gitlab-write.js')
    const { outcome, steps } = await execute(w, plan, {
      deps: {
        verifyCiConfig: async (s, c) => {
          asked.push({ component: s.component, project: c.project })
          if (s.component === 'api')
            throw new GitlabWriteError(
              'CI_CONFIG_REFUSED',
              "The deploy repository's ci_config_path is not what the Hub set",
              { step: 'configureProject' }
            )
        }
      }
    })
    expect(outcome).toMatchObject({ status: 'failed', step: 'push api', code: 'CI_CONFIG_REFUSED' })
    expect(steps).toEqual(['push api'])
    expect(asked).toEqual([{ component: 'api', project: 'efp/deploy' }])
    // Nothing written in GitLab: no branch, commit, merge request or job play.
    expect(w.gl.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('the CI check is asked once per step, before its push', async () => {
    const w = use(world())
    serveNew(w)
    const plan = buildPromotionPlan(input(w))
    const asked: string[] = []
    const { outcome } = await execute(w, plan, {
      deps: {
        verifyCiConfig: async (s) => {
          asked.push(s.component)
        }
      }
    })
    expect(outcome.status).toBe('success')
    expect(asked).toEqual(['api', 'frontend'])
  })

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
    // B8: one "passed" line per deploy (played: said as passed); verify names what it read.
    expect(lines.filter((l) => l.includes('deploy_production passed'))).toEqual([
      expect.stringMatching(/^deploy api: deploy_production passed \(https:/),
      expect.stringMatching(/^deploy frontend: deploy_production passed \(https:/)
    ])
    expect(lines).toContain('verify: api answers version = 0.3.10 twice')
    expect(lines).toContain(`verify: frontend answers version = ${w.feServed} twice`)
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
    expect(outcome.error).toMatch(
      /does not merge cleanly onto production .* production is untouched/
    )
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

  it("Minor 2: a merge GitLab refuses for another reason names GitLab's merge status", async () => {
    const w = use(world())
    const { GitlabWriteError } = await import('../../../services/hub/gitlab-write.js')
    const { outcome } = await execute(w, buildPromotionPlan(input(w)), {
      deps: {
        gitlab: {
          mergeMergeRequest: async () => {
            throw new GitlabWriteError('MERGE_REFUSED', 'GitLab refused to merge !1 (405)', {
              status: 405,
              step: 'mergeMergeRequest',
              mergeStatus: 'not_approved'
            })
          }
        }
      }
    })
    expect(outcome).toMatchObject({ status: 'failed', step: 'push api', code: 'MERGE_REFUSED' })
    expect(outcome.error).toMatch(
      /^api: GitLab refused to merge release commit [0-9a-f]{8} onto production \(on the temporary branch hub\/promote-1-1; GitLab merge status not_approved\) — production is untouched$/
    )
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
    // B8: said once, as what it was.
    const passed = events.filter((e) => e.line?.includes('passed')).map((e) => e.line)
    expect(passed).toEqual([
      expect.stringMatching(/^deploy api: deploy_production ran automatically and passed \(https:/)
    ])
  })

  it('B1: every API promotion moves production once; its pin never conflicts with earlier pins', async () => {
    const w = use(world())
    // EFP: production carries pin commits of its own that main never had.
    w.gl.commit('efp/deploy', 'production', 'chore: promote nivaro 0.3.9 to production', {
      '.docker/nivaro-version': `0.3.9\n${DIGEST}\n`
    })
    const prodPipes = () =>
      w.gl.pipelinesOf('efp/deploy').filter((p) => p.ref === 'production').length
    serveNew(w)
    const before = prodPipes()
    const first = await execute(w, buildPromotionPlan(input(w, { components: [apiComp] })))
    expect(first.outcome.status).toBe('success')
    expect(prodPipes()).toBe(before + 1)
    expect(w.gl.merges('efp/deploy', 'production')).toBe(1)
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toBe(
      `0.3.10\n${DIGEST}\n${SLIM}\n`
    )
    // The deploy ran on the one merge commit, which holds the release commit and the pin.
    const tip = w.gl.projects.get('efp/deploy')?.branches.get('production')
    expect(first.events).toContainEqual({
      kind: 'deployed',
      position: 1,
      sha: tip,
      pipelineId: w.gl.pipelinesOf('efp/deploy').at(-1)?.id
    })

    const next = w.gl.commit('efp/deploy', 'main', 'chore: deploy nivaro 0.3.11')
    w.gl.served.set(API_URL, [{ version: '0.3.11' }])
    const second = await run.executePlan(
      buildPromotionPlan(
        input(w, {
          components: [apiComp],
          version: '0.3.11',
          targetVersion: '0.3.10',
          previousVersion: '0.3.11',
          previousDeployedVersions: ['0.3.11'],
          sources: { 1: { sha: next, subject: 'chore: deploy nivaro 0.3.11' } }
        })
      ),
      { ...ctxFor(w, 2), version: '0.3.11' },
      { deps: { sleep: clock().sleep, now: clock().now } }
    )
    expect(second.status).toBe('success')
    expect(prodPipes()).toBe(before + 2)
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toBe(
      `0.3.11\n${DIGEST}\n${SLIM}\n`
    )
  })

  it('B1: a held release commit gets its pin as one commit on production', async () => {
    const w = use(world())
    w.gl.branch('efp/deploy', 'production', w.apiSource)
    serveNew(w)
    const before = w.gl.pipelinesOf('efp/deploy').length
    const { outcome } = await execute(
      w,
      buildPromotionPlan(input(w, { components: [apiComp], sourceOnTarget: { 1: true } }))
    )
    expect(outcome.status).toBe('success')
    expect(w.gl.pipelinesOf('efp/deploy').length).toBe(before + 1)
    expect(w.gl.calls.some((c) => c.path === '/merge_requests')).toBe(false)
  })

  it('P30: a held promote whose deploy job already passed reruns it only when the environment runs something else', async () => {
    const heldWorld = () => {
      const w = use(world())
      // Production holds the release commit and its pin; that head's pipeline already deployed.
      w.gl.branch('efp/deploy', 'production', w.apiSource)
      const head = w.gl.commit('efp/deploy', 'production', 'pin', {
        '.docker/nivaro-version': `0.3.10\n${DIGEST}\n${SLIM}\n`
      })
      const pl = w.gl.pipeline('efp/deploy', 'production', head, [
        { name: 'build_extension', statuses: ['success'] },
        { name: 'deploy_production', statuses: ['success'] }
      ])
      w.gl.served.set(API_URL, [{ version: '0.3.10' }])
      const plan = buildPromotionPlan(
        input(w, {
          components: [apiComp],
          sourceOnTarget: { 1: true },
          pinOnTarget: { 1: `0.3.10\n${DIGEST}\n${SLIM}\n` }
        })
      )
      return { w, pl, plan }
    }
    // The environment runs what this promotes: not run again.
    const a = heldWorld()
    const same = await execute(a.w, a.plan, { deps: { currentVersion: async () => '0.3.10' } })
    expect(same.outcome.status).toBe('success')
    expect(a.w.gl.retries).toEqual([])
    // A rollback left it on 0.3.9: the passed job is rerun, then verified.
    const b = heldWorld()
    const asked: string[] = []
    const back = await execute(b.w, b.plan, {
      deps: {
        currentVersion: async (st) => {
          asked.push(st.component)
          return '0.3.9'
        }
      }
    })
    expect(back.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(asked).toEqual(['api'])
    expect(b.w.gl.retries).toEqual([{ from: b.pl.jobs[1].id, to: expect.any(Number) }])
    // It cannot tell what runs: rerun too.
    const c = heldWorld()
    await execute(c.w, c.plan, { deps: { currentVersion: async () => null } })
    expect(c.w.gl.retries).toHaveLength(1)
  })

  it('API conflict: a release commit that does not merge onto production fails at push, production untouched', async () => {
    const w = use(world())
    // Production and main changed the same file differently since they last met.
    w.gl.commit('efp/deploy', 'production', 'hotfix on production', { 'stack.yml': 'prod\n' })
    const src = w.gl.commit('efp/deploy', 'main', 'chore: deploy nivaro 0.3.10', {
      'stack.yml': 'main\n'
    })
    const prodBefore = w.gl.projects.get('efp/deploy')?.branches.get('production')
    const { outcome, steps } = await execute(
      w,
      buildPromotionPlan(
        input(w, {
          components: [apiComp],
          sources: { 1: { sha: src, subject: 'chore: deploy nivaro 0.3.10' } }
        })
      )
    )
    expect(outcome).toMatchObject({ status: 'failed', step: 'push api', code: 'MERGE_REFUSED' })
    expect(steps).toEqual(['push api'])
    expect(outcome.error).toBe(
      `api: release commit ${src.slice(0, 8)} does not merge cleanly onto production (on the temporary branch hub/promote-1-1; GitLab merge status conflict) — production is untouched`
    )
    expect(w.gl.merges('efp/deploy', 'production')).toBe(0)
    expect(w.gl.projects.get('efp/deploy')?.branches.get('production')).toBe(prodBefore)
    expect(w.gl.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/repository/branches/hub/promote-1-1-src',
      '/repository/branches/hub/promote-1-1'
    ])
    expect(
      [...(w.gl.projects.get('efp/deploy')?.branches.keys() ?? [])].filter((b) =>
        b.startsWith('hub/')
      )
    ).toEqual([])
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
  })

  it('a cancel on another replica, seen right before the deploy job is read and played (no before job)', async () => {
    const w = use(world())
    // The cancel lands (in Redis) once the runner reads the deploy pipeline's jobs: after the
    // step boundary, with no wait in between.
    let landed = false
    fetchSpy.mockImplementation((async (url: string | URL, init?: RequestInit) => {
      if (/efp%2Fdeploy\/pipelines\/\d+\/jobs/.test(String(url))) landed = true
      return w.gl.fetch(url, init)
    }) as typeof fetch)
    let asked = 0
    const { outcome } = await execute(
      w,
      buildPromotionPlan(input(w, { components: [{ ...apiComp, before_job: null }] })),
      {
        deps: {
          stopRequested: () => {
            asked++
            return landed
          }
        }
      }
    )
    expect(outcome).toEqual({ status: 'cancelled', step: 'deploy api', error: null })
    expect(asked).toBeGreaterThanOrEqual(4)
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
  })

  it('a job the Hub plays on a later pass is logged as played, never "ran automatically"', async () => {
    const w = use(world())
    serveNew(w)
    let reads = 0
    const { outcome, events } = await execute(
      w,
      buildPromotionPlan(input(w, { components: [apiComp] })),
      {
        deps: {
          gitlab: {
            jobNamed: async (...a) => {
              const { jobNamed } = await import('../../../services/hub/gitlab-write.js')
              const j = await jobNamed(...a)
              return ++reads === 1 && j ? { ...j, status: 'running' } : j
            }
          }
        }
      }
    )
    expect(outcome.status).toBe('success')
    const lines = events.map((e) => e.line ?? '')
    expect(lines.some((l) => /^deploy api: deploy_production passed \(https:/.test(l))).toBe(true)
    expect(lines.some((l) => l.includes('ran automatically'))).toBe(false)
    expect(w.gl.calls.filter((c) => c.path.endsWith('/play'))).toHaveLength(1)
  })

  it('a same-version API step never creates a pin that is missing at run time', async () => {
    const w = use(world())
    const bare = w.gl.commit('efp/deploy', 'bare', 'a production without a pin')
    w.gl.branch('efp/deploy', 'production', bare)
    const plan = buildPromotionPlan(input(w, { components: [apiComp], targetVersion: '0.3.10' }))
    expect(plan.ok).toBe(true)
    expect(plan.steps[0].pinMustExist).toBe(true)
    const { outcome } = await execute(w, plan)
    expect(outcome).toMatchObject({ status: 'failed', step: 'push api', code: 'PIN_CHANGED' })
    expect(outcome.error).toBe(
      'api: production has no recorded pin for 0.3.10 (no .docker/nivaro-version) — the Hub never creates a pin for the version that is running; nothing was changed'
    )
    expect(w.gl.calls.some((c) => c.method !== 'GET')).toBe(false)
  })

  it('a job that was not manual at the read and is manual again on the next pass is still asked about', async () => {
    const w = use(world())
    let reads = 0
    let landed = false
    const { outcome } = await execute(w, buildPromotionPlan(input(w)), {
      deps: {
        stopRequested: () => landed,
        gitlab: {
          jobNamed: async (...a) => {
            const { jobNamed } = await import('../../../services/hub/gitlab-write.js')
            const j = await jobNamed(...a)
            // The first read sees it running (a play GitLab then undid); the cancel lands
            // right after, before the next pass would play it.
            if (++reads === 1 && j) {
              landed = true
              return { ...j, status: 'running' }
            }
            return j
          }
        }
      }
    })
    expect(reads).toBe(1)
    expect(outcome).toEqual({ status: 'cancelled', step: 'deploy api', error: null })
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
  })

  describe('B4: a cancel during a deploy', () => {
    it('stops the wait for the build and never plays the manual deploy job', async () => {
      const w = use(world({ apiDeploy: { statuses: ['manual'], onPlay: ['running', 'success'] } }))
      // build_extension keeps running; the cancel arrives during that wait.
      const proj = w.gl.projects.get('efp/deploy')
      if (proj)
        proj.jobs = () => [
          { name: 'build_extension', statuses: ['running', 'running', 'running', 'success'] },
          { name: 'deploy_production', statuses: ['manual'], onPlay: ['running', 'success'] }
        ]
      let polls = 0
      let deploying = false
      const { outcome, events } = await execute(w, buildPromotionPlan(input(w)), {
        onEvent: () => {},
        deps: {
          stopRequested: () => deploying && ++polls >= 2,
          gitlab: {
            runDeployJob: async (...a) => {
              const { runDeployJob } = await import('../../../services/hub/gitlab-write.js')
              deploying = true
              return runDeployJob(...a)
            }
          }
        }
      })
      expect(outcome).toEqual({ status: 'cancelled', step: 'deploy api', error: null })
      expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
      expect(w.gl.calls.some((c) => c.url.includes('efp%2Fportal'))).toBe(false)
      expect(events.some((e) => e.line?.startsWith('cancelled during deploy api'))).toBe(true)
    })

    it('an abort of the run signal right before the play never plays it', async () => {
      const w = use(world())
      const ac = new AbortController()
      // The cancel lands while the deploy job is being read, after the last abort check.
      let jobLists = 0
      fetchSpy.mockImplementation((async (url: string | URL, init?: RequestInit) => {
        const res = await w.gl.fetch(url, init)
        if (/efp%2Fdeploy\/pipelines\/\d+\/jobs/.test(String(url)) && ++jobLists === 2) ac.abort()
        return res
      }) as typeof fetch)
      const { outcome } = await execute(w, buildPromotionPlan(input(w)), { signal: ac.signal })
      expect(jobLists).toBe(2)
      expect(outcome.status).toBe('cancelled')
      expect(outcome.step).toBe('deploy api')
      expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
    })
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
          waitJob: async (...a) => {
            const { waitJob } = await import('../../../services/hub/gitlab-write.js')
            const r = await waitJob(...a)
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

  it('B1: the pin rides the one merge into production; a cancel before that merge changes nothing', async () => {
    const w = use(world())
    let stop = false
    let merges = 0
    const { outcome, steps, events } = await execute(w, buildPromotionPlan(input(w)), {
      deps: {
        stopRequested: () => stop,
        gitlab: {
          mergeMergeRequest: async (...a) => {
            const { mergeMergeRequest } = await import('../../../services/hub/gitlab-write.js')
            merges++
            stop = true // asked while the release commit was merged into the temporary branch
            return mergeMergeRequest(...a)
          }
        }
      }
    })
    expect(outcome).toEqual({ status: 'cancelled', step: 'push api', error: null })
    expect(steps).toEqual(['push api'])
    expect(merges).toBe(1)
    expect(w.gl.merges('efp/deploy', 'production')).toBe(0)
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toBe('0.3.9\n')
    expect(
      [...(w.gl.projects.get('efp/deploy')?.branches.keys() ?? [])].filter((b) =>
        b.startsWith('hub/')
      )
    ).toEqual([])
    expect(events.some((e) => e.line === 'cancelled before merging into production')).toBe(true)
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
  })

  it('B1: a cancel asked during the merge into production lands merge and pin together', async () => {
    const w = use(world())
    let stop = false
    let merges = 0
    const { outcome, steps } = await execute(w, buildPromotionPlan(input(w)), {
      deps: {
        stopRequested: () => stop,
        gitlab: {
          mergeMergeRequest: async (...a) => {
            const { mergeMergeRequest } = await import('../../../services/hub/gitlab-write.js')
            if (++merges === 2) stop = true
            return mergeMergeRequest(...a)
          }
        }
      }
    })
    expect(outcome).toEqual({ status: 'cancelled', step: 'push api', error: null })
    expect(steps).toEqual(['push api'])
    expect(w.gl.merges('efp/deploy', 'production')).toBe(1)
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

  describe('frontend commit already on production, with a newer head', () => {
    function heldWithNewerHead(w: World) {
      w.gl.branch('efp/portal', 'production', w.feFull)
      return w.gl.commit('efp/portal', 'production', 'feat: newer portal')
    }
    const rollbackInput = (w: World) =>
      input(w, {
        kind: 'rollback',
        components: [feComp],
        targetVersion: '0.3.11',
        targetDeployedVersions: ['0.3.10'],
        frontendServed: { 2: w.feServed }
      })

    it('rollback retries the deploy job of the planned commit and verifies that commit', async () => {
      const w = use(world())
      heldWithNewerHead(w)
      const old = w.gl.pipeline('efp/portal', 'production', w.feFull, [
        { name: 'build_production', statuses: ['success'] },
        {
          name: 'deploy_production',
          statuses: ['success'],
          onRetry: ['pending', 'running', 'success']
        }
      ])
      w.gl.served.set(FE_URL, [{ version: w.feServed }])
      const plan = buildPromotionPlan(rollbackInput(w))
      expect(plan.ok).toBe(true)
      const { outcome, steps, events } = await execute(w, plan, {}, 'rollback')
      expect(outcome).toEqual({ status: 'success', step: 'verify', error: null })
      expect(steps).toEqual(['push frontend', 'deploy frontend', 'verify'])
      expect(w.gl.retries).toEqual([{ from: old.jobs[1].id, to: expect.any(Number) }])
      expect(w.gl.calls.some((c) => c.path === '/merge_requests')).toBe(false)
      expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
      expect(events.some((e) => e.line?.includes('retrying deploy_production of pipeline'))).toBe(
        true
      )
      expect(w.gl.servedReads.get(FE_URL)).toBe(2)
    })

    it('rollback without a build of that commit fails at deploy: FRONTEND_ROLLBACK_NO_BUILD', async () => {
      const w = use(world())
      heldWithNewerHead(w)
      const { outcome } = await execute(w, buildPromotionPlan(rollbackInput(w)), {}, 'rollback')
      expect(outcome).toMatchObject({
        status: 'failed',
        step: 'deploy frontend',
        code: 'FRONTEND_ROLLBACK_NO_BUILD'
      })
      expect(outcome.error).toMatch(/has no pipeline for .* no build of that commit to redeploy/)
      expect(w.gl.retries).toEqual([])
    })

    it('rollback whose build has no deploy job fails the same way', async () => {
      const w = use(world())
      heldWithNewerHead(w)
      w.gl.pipeline('efp/portal', 'production', w.feFull, [
        { name: 'build_production', statuses: ['success'] }
      ])
      const { outcome } = await execute(w, buildPromotionPlan(rollbackInput(w)), {}, 'rollback')
      expect(outcome).toMatchObject({ step: 'deploy frontend', code: 'FRONTEND_ROLLBACK_NO_BUILD' })
    })

    it("rollback whose build's deploy job is still manual can't be rerun", async () => {
      const w = use(world())
      heldWithNewerHead(w)
      w.gl.pipeline('efp/portal', 'production', w.feFull, [
        { name: 'deploy_production', statuses: ['manual'] }
      ])
      const { outcome } = await execute(w, buildPromotionPlan(rollbackInput(w)), {}, 'rollback')
      expect(outcome).toMatchObject({
        status: 'failed',
        step: 'deploy frontend',
        code: 'FRONTEND_ROLLBACK_NO_BUILD',
        error: "frontend's earlier build can't be rerun (job is manual)"
      })
      expect(w.gl.retries).toEqual([])
    })

    it('promote refuses, changing nothing, when the head moved since the plan', async () => {
      const w = use(world())
      const planned = heldWithNewerHead(w)
      const plan = buildPromotionPlan(
        input(w, {
          components: [feComp],
          frontendHeld: { 2: true },
          frontendHead: { 2: planned }
        })
      )
      expect(plan.lines).toContain(
        `Frontend: production already holds ${w.feServed.slice(0, 7)} — deploy production's current head ${planned.slice(0, 7)}`
      )
      const moved = w.gl.commit('efp/portal', 'production', 'feat: pushed after the plan')
      const pipes = w.gl.pipelinesOf('efp/portal').length
      const { outcome, steps } = await execute(w, plan)
      expect(outcome).toMatchObject({ status: 'failed', step: 'push frontend', code: 'HEAD_MOVED' })
      expect(outcome.error).toBe(
        `frontend: production moved since the plan (planned head ${planned.slice(0, 8)}, now ${moved.slice(0, 8)}) — nothing was changed; plan again`
      )
      expect(steps).toEqual(['push frontend'])
      expect(w.gl.pipelinesOf('efp/portal').length).toBe(pipes)
      expect(w.gl.calls.some((c) => c.method !== 'GET')).toBe(false)
    })

    it('a plan that saw the commit unheld refuses when it was merged in meanwhile', async () => {
      const w = use(world())
      serveNew(w)
      const plan = buildPromotionPlan(input(w))
      expect(plan.steps[1].expectHead).toBeUndefined()
      // While the API deploys, someone merges the portal commit into production by hand.
      const { outcome, steps } = await execute(w, plan, {
        deps: {
          gitlab: {
            waitJob: async (...a) => {
              const { waitJob } = await import('../../../services/hub/gitlab-write.js')
              w.gl.branch('efp/portal', 'production', w.feFull)
              return waitJob(...a)
            }
          }
        }
      })
      expect(outcome).toMatchObject({ status: 'failed', step: 'push frontend', code: 'HEAD_MOVED' })
      expect(outcome.error).toBe(
        `frontend: production took ${w.feServed} since the plan, which planned a merge (head now ${w.feFull.slice(0, 8)}) — nothing was changed; plan again`
      )
      expect(steps).toEqual(['push api', 'deploy api', 'push frontend'])
      const portalWrites = w.gl.calls.filter(
        (c) => c.url.includes('efp%2Fportal') && c.method !== 'GET'
      )
      expect(portalWrites).toEqual([])
    })

    it('a plan that saw the commit held refuses when it is gone from the branch, never merging', async () => {
      const w = use(world())
      // The plan saw production holding the portal commit; by the run it no longer does.
      const plan = buildPromotionPlan(
        input(w, {
          components: [feComp],
          frontendHeld: { 2: true },
          frontendHead: { 2: w.feFull }
        })
      )
      const { outcome } = await execute(w, plan)
      expect(outcome).toMatchObject({ status: 'failed', step: 'push frontend', code: 'HEAD_MOVED' })
      expect(outcome.error).toBe(
        `frontend: production no longer holds ${w.feFull.slice(0, 8)} (the plan deployed its head ${w.feFull.slice(0, 8)}) — nothing was changed; plan again`
      )
      expect(w.gl.calls.some((c) => c.method !== 'GET')).toBe(false)
    })

    it('a merge refused because the commit arrived meanwhile: production was not changed', async () => {
      const w = use(world())
      const plan = buildPromotionPlan(input(w, { components: [feComp] }))
      const proj = w.gl.projects.get('efp/portal')
      const { outcome } = await execute(w, plan, {
        deps: {
          gitlab: {
            openMergeRequest: async (...a) => {
              const { openMergeRequest } = await import('../../../services/hub/gitlab-write.js')
              // Someone merges the portal commit by hand; GitLab refuses the empty merge.
              w.gl.branch('efp/portal', 'production', w.feFull)
              if (proj) proj.refuseMerge = true
              return openMergeRequest(...a)
            }
          }
        }
      })
      expect(outcome).toMatchObject({ status: 'failed', step: 'push frontend', code: 'HEAD_MOVED' })
      expect(outcome.error).toBe(
        `frontend: production took ${w.feServed} since the plan, which planned a merge (head now ${w.feFull.slice(0, 8)}) — production was not changed; plan again`
      )
      expect([...(proj?.branches.keys() ?? [])].filter((b) => b.startsWith('hub/'))).toEqual([])
      expect(proj?.branches.get('production')).toBe(w.feFull)
    })

    it('P21: an API rollback retries the recorded deploy job — no pin, no merge, no registry', async () => {
      const w = use(world())
      // The 0.3.10 build: production at the commit that pinned 0.3.10, deployed by pipeline 'old'.
      const built = w.gl.commit('efp/deploy', 'production', 'chore: promote nivaro 0.3.10', {
        '.docker/nivaro-version': `0.3.10\n${DIGEST}\n`
      })
      const old = w.gl.pipeline('efp/deploy', 'production', built, [
        { name: 'build_extension', statuses: ['success'] },
        { name: 'deploy_production', statuses: ['success'] }
      ])
      // Production moved on since (a newer pin on top).
      w.gl.commit('efp/deploy', 'production', 'chore: promote nivaro 0.3.11', {
        '.docker/nivaro-version': '0.3.11\n'
      })
      const head = w.gl.projects.get('efp/deploy')?.branches.get('production')
      w.gl.served.set(API_URL, [{ version: '0.3.10' }])
      const plan = buildPromotionPlan(
        input(w, {
          kind: 'rollback',
          components: [apiComp],
          targetVersion: '0.3.11',
          targetDeployedVersions: ['0.3.10'],
          digest: null,
          rollbackBuild: { 1: { sha: built, pipelineId: old.id, problem: null } }
        })
      )
      expect(plan.ok).toBe(true)
      const { outcome, steps } = await execute(w, plan, {}, 'rollback')
      expect(outcome).toEqual({ status: 'success', step: 'verify', error: null })
      expect(steps).toEqual(['push api', 'deploy api', 'verify'])
      expect(w.gl.retries).toEqual([{ from: old.jobs[1].id, to: expect.any(Number) }])
      expect(w.gl.calls.some((c) => c.method !== 'GET' && !c.path.endsWith('/retry'))).toBe(false)
      expect(w.gl.projects.get('efp/deploy')?.branches.get('production')).toBe(head)
    })

    it('P21: GitLab refusing the retry is ROLLBACK_REFUSED_BY_GITLAB and names the setting', async () => {
      const w = use(world())
      heldWithNewerHead(w)
      w.gl.pipeline('efp/portal', 'production', w.feFull, [
        {
          name: 'deploy_production',
          statuses: ['success'],
          onRetry: ['failed'],
          failureReason: 'forward_deployment_failure'
        }
      ])
      const dropped = await execute(w, buildPromotionPlan(rollbackInput(w)), {}, 'rollback')
      expect(dropped.outcome).toMatchObject({
        status: 'failed',
        step: 'deploy frontend',
        code: 'ROLLBACK_REFUSED_BY_GITLAB'
      })
      expect(dropped.outcome.error).toMatch(/Prevent outdated deployment jobs/)

      // A retry GitLab refuses outright (403) is the same refusal.
      const w2 = use(world())
      heldWithNewerHead(w2)
      w2.gl.pipeline('efp/portal', 'production', w2.feFull, [
        { name: 'deploy_production', statuses: ['success'] }
      ])
      const refused = await execute(
        w2,
        buildPromotionPlan(rollbackInput(w2)),
        {
          deps: {
            gitlab: {
              retryJob: async () => {
                const { GitlabWriteError } = await import('../../../services/hub/gitlab-write.js')
                throw new GitlabWriteError(
                  'JOB_RETRY_REFUSED',
                  'GitLab refused to retry job 1 (403)',
                  {
                    status: 403,
                    step: 'retryJob'
                  }
                )
              }
            }
          }
        },
        'rollback'
      )
      expect(refused.outcome).toMatchObject({ code: 'ROLLBACK_REFUSED_BY_GITLAB' })
      expect(refused.outcome.error).toMatch(/HTTP 403.*Prevent outdated deployment jobs/)

      // Any other answer keeps GitLab's own code: a bad token is not that setting.
      const { GitlabWriteError: GWE } = await import('../../../services/hub/gitlab-write.js')
      for (const [thrown, code] of [
        [
          new GWE('JOB_RETRY_REFUSED', 'GitLab refused to retry job 1 (401)', {
            status: 401,
            step: 'retryJob'
          }),
          'GITLAB_UNAUTHORIZED'
        ],
        [
          new GWE('GITLAB_UNREACHABLE', 'GitLab did not answer retryJob', { step: 'retryJob' }),
          'GITLAB_UNREACHABLE'
        ]
      ] as const) {
        const w3 = use(world())
        heldWithNewerHead(w3)
        w3.gl.pipeline('efp/portal', 'production', w3.feFull, [
          { name: 'deploy_production', statuses: ['success'] }
        ])
        const other = await execute(
          w3,
          buildPromotionPlan(rollbackInput(w3)),
          {
            deps: {
              gitlab: {
                retryJob: async () => {
                  throw thrown
                }
              }
            }
          },
          'rollback'
        )
        expect(other.outcome.code).toBe(code)
        expect(other.outcome.error).not.toMatch(/Prevent outdated/)
      }
    })

    it('Minor 2: an API rollback step refused after the portal went back says so', async () => {
      const w = use(world())
      heldWithNewerHead(w)
      w.gl.pipeline('efp/portal', 'production', w.feFull, [
        { name: 'deploy_production', statuses: ['success'] }
      ])
      w.gl.served.set(FE_URL, [{ version: w.feServed }])
      // The API's recorded build is gone from production (force-pushed away).
      const gone = w.gl.commit('efp/deploy', 'elsewhere', 'chore: promote nivaro 0.3.10')
      const plan = buildPromotionPlan(
        input(w, {
          kind: 'rollback',
          targetVersion: '0.3.11',
          targetDeployedVersions: ['0.3.10'],
          frontendServed: { 2: w.feServed },
          rollbackBuild: { 1: { sha: gone, pipelineId: 999, problem: null } }
        })
      )
      expect(plan.ok).toBe(true)
      const { outcome, steps } = await execute(w, plan, {}, 'rollback')
      expect(steps).toEqual(['push frontend', 'deploy frontend', 'push api'])
      expect(outcome).toMatchObject({ status: 'failed', code: 'ROLLBACK_NO_BUILD' })
      expect(outcome.error).toContain(
        'frontend was already rolled back to 0.3.10 by this run and stays there'
      )
      expect(outcome.error).not.toContain('nothing was changed')
    })

    it('rollback of a build no longer on the branch never falls through to a merge', async () => {
      const w = use(world())
      // feFull was never on production: the recorded build is gone from the branch.
      const { outcome } = await execute(w, buildPromotionPlan(rollbackInput(w)), {}, 'rollback')
      expect(outcome).toMatchObject({
        status: 'failed',
        step: 'push frontend',
        code: 'FRONTEND_ROLLBACK_NO_BUILD'
      })
      expect(outcome.error).toMatch(/is no longer on production .* nothing was changed/)
      expect(w.gl.calls.some((c) => c.method !== 'GET')).toBe(false)
    })

    it('promote deploys the head, as the script does, and verifies what was deployed', async () => {
      const w = use(world())
      const head = heldWithNewerHead(w)
      w.gl.pipeline('efp/portal', 'production', head, [
        { name: 'build_production', statuses: ['success'] },
        { name: 'deploy_production', statuses: ['success'] }
      ])
      w.gl.served.set(FE_URL, [{ version: head.slice(0, 8) }])
      const plan = buildPromotionPlan(
        input(w, { components: [feComp], frontendHeld: { 2: true }, frontendHead: { 2: head } })
      )
      expect(plan.lines).toContain(
        `Frontend: production already holds ${w.feServed.slice(0, 7)} — deploy production's current head ${head.slice(0, 7)}`
      )
      const { outcome, steps, events } = await execute(w, plan)
      expect(steps).toEqual(['push frontend', 'deploy frontend', 'verify'])
      expect(outcome).toEqual({ status: 'success', step: 'verify', error: null })
      expect(events.some((e) => e.line?.includes(`current head ${head.slice(0, 8)}`))).toBe(true)
      expect(events).toContainEqual({
        kind: 'deployed',
        position: 2,
        sha: head,
        pipelineId: expect.any(Number)
      })
      // B8: the success line names what the portal actually answered.
      expect(events.map((e) => e.line)).toContain(
        `verify: frontend answers version = ${head.slice(0, 8)} twice`
      )
      // A deploy that had already passed for that commit is said once, never "passed" again.
      expect(events.filter((e) => e.line?.includes('deploy_production passed'))).toEqual([])
      expect(w.gl.servedReads.get(FE_URL)).toBe(2)
    })
  })

  it('verify accepts the merge commit this run made for a frontend', async () => {
    const w = use(world())
    const tipShort = () =>
      (w.gl.projects.get('efp/portal')?.branches.get('production') ?? '').slice(0, 8)
    const { outcome } = await execute(w, buildPromotionPlan(input(w, { components: [feComp] })), {
      deps: { readServedField: async () => ({ value: tipShort(), error: null }) }
    })
    expect(outcome.status).toBe('success')
  })

  it('verify log lines and errors never print the query string', async () => {
    const w = use(world())
    const url = `${API_URL}?key=private-value`
    w.gl.served.set(url, [{ version: '0.3.9' }])
    const { outcome, events } = await execute(
      w,
      buildPromotionPlan(input(w, { components: [{ ...apiComp, verify_url: url }] }))
    )
    expect(outcome.step).toBe('verify')
    expect(outcome.error).toContain(API_URL)
    for (const e of events) expect(JSON.stringify(e)).not.toContain('private-value')
    expect(outcome.error).not.toContain('private-value')
  })

  it('P27: a driver edited to another repository mid-run refuses DRIVER_CHANGED and writes nothing more', async () => {
    const w = use(world())
    serveNew(w)
    const identity = (p: string) => `https://gitlab.example.com|${p}`
    const base = input(w)
    const plan = buildPromotionPlan(
      input(w, {
        drivers: {
          1: { ...base.drivers[1], identity: identity('efp/deploy') },
          2: { ...base.drivers[2], identity: identity('efp/portal') }
        }
      })
    )
    expect(plan.steps.map((st) => st.driverIdentity)).toEqual([
      identity('efp/deploy'),
      identity('efp/portal')
    ])
    // After the API deployed, an admin points the portal's driver at another project.
    const copy = w.gl.projects.get('efp/portal')
    if (copy) w.gl.projects.set('efp/portal-copy', copy)
    const projects: Record<number, string> = { ...PROJECTS }
    const k = clock()
    const outcome = await run.executePlan(
      plan,
      { ...ctxFor(w), gitCtx: async (driverId) => w.gl.ctx(projects[driverId]) },
      {
        onEvent: (e) => {
          if (e.kind === 'deployed' && e.position === 1) projects[2] = 'efp/portal-copy'
        },
        deps: { sleep: k.sleep, now: k.now }
      }
    )
    expect(outcome).toMatchObject({
      status: 'failed',
      step: 'push frontend',
      code: 'DRIVER_CHANGED'
    })
    expect(outcome.error).toMatch(/driver was changed to another repository/)
    const portalWrites = w.gl.calls.filter(
      (c) => c.url.includes('efp%2Fportal') && c.method !== 'GET'
    )
    expect(portalWrites).toEqual([])
  })

  it('refuses a plan with blockers without touching GitLab', async () => {
    const w = use(world())
    const plan = buildPromotionPlan(input(w, { digest: null }))
    const { outcome } = await execute(w, plan)
    expect(outcome.status).toBe('failed')
    expect(w.gl.calls).toEqual([])
  })

  // phase 4: the planner never mixes driver kinds on a placement, but the runner still picks the
  // executor per step — a gitlab step through GitLab, a docker step through the Hub agent.
  it('runs each step with its own executor: gitlab through GitLab, docker through the agent', async () => {
    const w = use(world())
    serveNew(w)
    const plan = buildPromotionPlan(input(w, { components: [apiComp] }))
    expect(plan.ok).toBe(true)
    plan.steps.push({
      position: 2,
      component: 'stack',
      kind: 'stack',
      driverId: 9,
      driver: 'docker',
      sourceSha: null,
      targetBranch: '',
      pinText: null,
      pinFile: null,
      beforeJob: null,
      deployJob: '',
      verifyUrl: 'https://stack.example.com/api/version',
      verifyField: 'version',
      want: '0.3.10',
      stack: {
        name: 'acme-prod',
        image: `nodeworks/nivaro@${DIGEST}`,
        size: 'small',
        extensions: {},
        agentOrigin: 'https://agent.example.com'
      }
    })
    const docker: string[] = []
    const { outcome, steps } = await execute(w, plan, {
      deps: {
        docker: {
          deploy: async (s, ctx) => {
            docker.push(`deploy ${s.component} ${ctx.version}`)
            return null
          },
          verify: async (s) => {
            docker.push(`verify ${s.component}`)
          }
        }
      }
    })
    expect(outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(steps).toEqual(['push api', 'deploy api', 'deploy stack', 'verify'])
    expect(docker).toEqual(['deploy stack 0.3.10', 'verify stack'])
    // GitLab saw only the api step; the docker step's URL was never read by the GitLab verify.
    expect(w.gl.servedReads.get(API_URL)).toBe(2)
    expect(w.gl.servedReads.has('https://stack.example.com/api/version')).toBe(false)
    expect(w.gl.calls.every((c) => c.url.includes('/projects/'))).toBe(true)
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
    user: { id: USER },
    /** The hash of the plan the person saw (the current test world's plan). */
    get planHash() {
      return buildPromotionPlan(input(current)).plan_hash
    }
  }

  it('starts only the plan the person saw: 409 PLAN_CHANGED with the new plan, nothing started', async () => {
    const w = use(world())
    const { d, redis, runs } = deps(w)
    const err = await run.startPromotion(2, { ...req, planHash: 'e'.repeat(64) }, d).catch((e) => e)
    expect(err).toMatchObject({ code: 'PLAN_CHANGED', status: 409 })
    expect(err.plan.plan_hash).toBe(buildPromotionPlan(input(w)).plan_hash)
    expect(err.plan.steps.map((st: { component: string }) => st.component)).toEqual([
      'api',
      'frontend'
    ])
    expect(runs).toEqual([])
    expect(redis.store.size).toBe(0)
    expect(await db('nivaro_hub_deploys').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(w.gl.calls).toEqual([])
    // No hash at all: 400 before the lock.
    const none = await run.startPromotion(2, { ...req, planHash: undefined }, d).catch((e) => e)
    expect(none).toMatchObject({ code: 'PLAN_HASH_REQUIRED', status: 400 })
    expect(redis.store.size).toBe(0)
  })

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

  it.each([
    ['creation', 'CREATION_RUNNING'],
    ['stack', 'STACK_BUSY'],
    ['promotion', 'PROMOTION_RUNNING'],
    ['delete', 'PROMOTION_RUNNING']
  ])('X-6b: a lock held by a %s names it (%s)', async (holder, code) => {
    const w = use(world())
    const redis = fakeRedis()
    redis.store.set(hubPromoteLockKey(2), `${holder}:abc`)
    const { d } = deps(w, redis)
    await expect(run.startPromotion(2, req, d)).rejects.toMatchObject({ code, status: 409 })
    expect(redis.store.get(hubPromoteLockKey(2))).toBe(`${holder}:abc`)
  })

  it('a lost lock stops the run at the next step boundary as interrupted, after the pin', async () => {
    const w = use(world())
    const { d, runs } = deps(w)
    let renewals = 0
    const lock = { ...d.lock, renew: async () => ++renewals < 2 }
    const started = await run.startPromotion(2, req, { ...d, lock })
    await run.awaitPromotion(started.deployId)
    const row = await db('nivaro_hub_deploys').where({ id: started.deployId }).first()
    expect(row).toMatchObject({
      status: 'interrupted',
      step: 'push api',
      error: 'Lost the promotion lock'
    })
    expect(w.gl.file('efp/deploy', 'production', '.docker/nivaro-version')).toMatch(/^0\.3\.10\n/)
    expect(w.gl.calls.some((c) => c.path.endsWith('/play'))).toBe(false)
    expect(runs[0].ended[0]).toMatch(/^fail:promote 0\.3\.10 on production: stopped at push api/)
  })

  it('P24: the Redis lock dropped mid-run — a second start is refused, the first row untouched', async () => {
    const w = use(world())
    serveNew(w)
    const redis = fakeRedis()
    const { d } = deps(w, redis)
    let second: unknown = null
    let rowThen: Record<string, unknown> | undefined
    d.execute = {
      ...d.execute,
      gitlab: {
        createBranch: async (...a: Parameters<typeof gwCreateBranch>) => {
          if (second === null) {
            // Redis restarted without persistence: the lock key is gone, the runner lives on.
            redis.store.delete(hubPromoteLockKey(2))
            second = await run.startPromotion(2, req, d).catch((e) => e)
            rowThen = await db('nivaro_hub_deploys').where({ status: 'running' }).first()
          }
          return gwCreateBranch(...a)
        }
      }
    } as typeof d.execute
    const first = await run.startPromotion(2, req, d)
    await run.awaitPromotion(first.deployId)
    expect(second).toMatchObject({ code: 'PROMOTION_RUNNING', status: 409 })
    // Nothing healed the live row: still running, its own, no error.
    expect(rowThen).toMatchObject({ id: first.deployId, status: 'running', error: null })
    expect(await db('nivaro_hub_deploys').count({ n: '*' })).toEqual([{ n: 1 }])
    // The first run then sees its lock gone at the next boundary and stops on its own.
    expect(await db('nivaro_hub_deploys').where({ id: first.deployId }).first()).toMatchObject({
      status: 'interrupted',
      error: 'Lost the promotion lock'
    })
  })

  it('P24: a running row with a fresh heartbeat (another process, lock gone) is never healed', async () => {
    const w = use(world())
    serveNew(w)
    const { d } = deps(w)
    const now = Date.now()
    const [other] = (await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version: '0.3.10',
      status: 'running',
      step: 'deploy api',
      heartbeat_at: new Date(now - 30_000)
    })) as number[]
    await expect(run.startPromotion(2, req, { ...d, now: () => now })).rejects.toMatchObject({
      code: 'PROMOTION_RUNNING',
      status: 409
    })
    expect(await run.recoverInterruptedPromotions({ lock: d.lock, now: () => now })).toBe(0)
    expect(await db('nivaro_hub_deploys').where({ id: other }).first()).toMatchObject({
      status: 'running',
      error: null
    })
    // Three minutes without a heartbeat: its runner is gone, the next start heals it.
    const later = now + 3 * 60_000
    const started = await run.startPromotion(2, req, { ...d, now: () => later })
    await run.awaitPromotion(started.deployId)
    expect(await db('nivaro_hub_deploys').where({ id: other }).first()).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during deploy api'
    })
  })

  it('P24: a live run writes its heartbeat while it runs', async () => {
    const w = use(world())
    serveNew(w)
    const { d } = deps(w)
    let seen: unknown = null
    d.execute = {
      ...d.execute,
      gitlab: {
        createBranch: async (...a: Parameters<typeof gwCreateBranch>) => {
          seen ??= (await db('nivaro_hub_deploys').where({ status: 'running' }).first())
            ?.heartbeat_at
          return gwCreateBranch(...a)
        }
      }
    } as typeof d.execute
    const started = await run.startPromotion(2, req, d)
    await run.awaitPromotion(started.deployId)
    expect(seen).not.toBeNull()
    expect(seen).not.toBeUndefined()
  })

  it('the closing write is retried once', async () => {
    const w = use(world())
    serveNew(w)
    const { d } = deps(w)
    let calls = 0
    const finishRow: FinishRow = async (id, patch) => {
      if (++calls === 1) throw new Error('deadlock')
      return Number(await db('nivaro_hub_deploys').where({ id, status: 'running' }).update(patch))
    }
    const started = await run.startPromotion(2, req, { ...d, finishRow })
    await run.awaitPromotion(started.deployId)
    expect(calls).toBe(2)
    expect((await db('nivaro_hub_deploys').where({ id: started.deployId }).first()).status).toBe(
      'success'
    )
  })

  it('a closing write that keeps failing is logged with the deploy id; the next start heals the row', async () => {
    const w = use(world())
    serveNew(w)
    const { d, runs, redis } = deps(w)
    const failing: FinishRow = async () => {
      throw new Error('database gone')
    }
    const first = await run.startPromotion(2, req, { ...d, finishRow: failing })
    await run.awaitPromotion(first.deployId)
    const left = await db('nivaro_hub_deploys').where({ id: first.deployId }).first()
    expect(left.status).toBe('running')
    // P24: the runner ended, so it no longer vouches for the row (the next start heals it).
    expect(left.heartbeat_at).toBeNull()
    expect(
      runs[0].lines.some((l) =>
        l.includes(`could not record the final status (success) of deploy #${first.deployId}`)
      )
    ).toBe(true)
    expect(redis.store.size).toBe(0)

    // Planned again as things stand now: both commits are on production already.
    const now = input(w, {
      sourceOnTarget: { 1: true },
      frontendHeld: { 2: true },
      frontendHead: { 2: w.gl.projects.get('efp/portal')?.branches.get('production') ?? null }
    })
    const again = deps(w, redis, async () => now)
    const second = await run.startPromotion(
      2,
      { ...req, planHash: buildPromotionPlan(now).plan_hash },
      again.d
    )
    await run.awaitPromotion(second.deployId)
    expect(await db('nivaro_hub_deploys').where({ id: first.deployId }).first()).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during verify'
    })
    expect((await db('nivaro_hub_deploys').where({ id: second.deployId }).first()).status).toBe(
      'success'
    )
  })

  it('a stale running row (no lock) is interrupted at start, never blocking the environment', async () => {
    const w = use(world())
    serveNew(w)
    const { d } = deps(w)
    const [stale] = (await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version: '0.3.10',
      status: 'running',
      step: 'deploy api'
    })) as number[]
    const started = await run.startPromotion(2, req, d)
    await run.awaitPromotion(started.deployId)
    expect(await db('nivaro_hub_deploys').where({ id: stale }).first()).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during deploy api'
    })
  })

  it('a job run that cannot start leaves no running row and no lock', async () => {
    const w = use(world())
    const { d, redis } = deps(w)
    await expect(
      run.startPromotion(2, req, {
        ...d,
        startJobRun: async () => {
          throw new Error('job runs down')
        }
      })
    ).rejects.toThrow('job runs down')
    expect(await db('nivaro_hub_deploys').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(redis.store.size).toBe(0)
  })

  it("a crashed run's lock expires after 5 min; the next start heals its row and deletes its branches", async () => {
    expect(run.LOCK_TTL_MS).toBe(5 * 60_000)
    const w = use(world())
    serveNew(w)
    const { d, redis } = deps(w)
    // A process took the lock, opened its temporary branch and died mid-deploy.
    await redis.set(hubPromoteLockKey(2), 'dead-process', 'PX', run.LOCK_TTL_MS)
    const [crashed] = (await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version: '0.3.10',
      status: 'running',
      step: 'deploy api',
      plan: JSON.stringify({
        steps: [
          { position: 1, driverId: 1 },
          { position: 2, driverId: 2 }
        ]
      })
    })) as number[]
    w.gl.branch('efp/deploy', `hub/promote-${crashed}-1`, w.apiSource)

    await expect(run.startPromotion(2, req, d)).rejects.toMatchObject({
      code: 'PROMOTION_RUNNING',
      status: 409
    })
    expect(await run.recoverInterruptedPromotions({ lock: d.lock })).toBe(0)

    redis.now += run.LOCK_TTL_MS + 1
    const started = await run.startPromotion(2, req, d)
    expect(await db('nivaro_hub_deploys').where({ id: crashed }).first()).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during deploy api'
    })
    expect(w.gl.projects.get('efp/deploy')?.branches.has(`hub/promote-${crashed}-1`)).toBe(false)
    await run.awaitPromotion(started.deployId)
    expect((await db('nivaro_hub_deploys').where({ id: started.deployId }).first()).status).toBe(
      'success'
    )
  })

  it('the default closing write leaves a row another process moved off running', async () => {
    const w = use(world())
    serveNew(w)
    const { d, runs } = deps(w)
    d.execute = {
      ...d.execute,
      gitlab: {
        createBranch: async (...a: Parameters<typeof gwCreateBranch>) => {
          await db('nivaro_hub_deploys')
            .where({ status: 'running' })
            .update({ status: 'interrupted', error: 'The Hub stopped during push api' })
          return gwCreateBranch(...a)
        }
      }
    } as typeof d.execute
    const started = await run.startPromotion(2, req, d)
    await run.awaitPromotion(started.deployId)
    expect(await db('nivaro_hub_deploys').where({ id: started.deployId }).first()).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during push api'
    })
    expect(runs[0].lines).toContain(
      `deploy #${started.deployId} is no longer running — its status was left as it is`
    )
    // Minor 8: what the deploys ran on is not written over a row that is no longer this run's.
    const stored = JSON.parse(
      (await db('nivaro_hub_deploys').where({ id: started.deployId }).first()).plan
    )
    expect(stored.steps.every((st: { deployedSha?: string }) => !st.deployedSha)).toBe(true)
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

describe('P25: a stopped run is marked on read and cancel', () => {
  const crashed = (over: Record<string, unknown> = {}) => ({
    app_id: 1,
    environment_id: 2,
    kind: 'promote',
    version: '0.3.10',
    status: 'running',
    step: 'deploy api',
    plan: JSON.stringify({ steps: [{ position: 1, driverId: 1 }] }),
    ...over
  })

  it('cancel on a row nobody runs (lock free, heartbeat stale) interrupts it at once', async () => {
    const w = use(world())
    const redis = fakeRedis()
    const [id] = (await db('nivaro_hub_deploys').insert(
      crashed({ heartbeat_at: new Date(Date.now() - 5 * 60_000) })
    )) as number[]
    w.gl.branch('efp/deploy', `hub/promote-${id}-1`, w.apiSource)
    const res = await run.cancelPromotion(id, null, {
      lock: run.redisPromoteLock(redis),
      heal: { gitCtx: async (driverId) => w.gl.ctx(PROJECTS[driverId]), logger: null }
    })
    expect(res).toEqual({ ok: true, interrupted: true })
    expect(await db('nivaro_hub_deploys').where({ id }).first()).toMatchObject({
      status: 'interrupted',
      error: 'The Hub stopped during deploy api'
    })
    expect(w.gl.projects.get('efp/deploy')?.branches.has(`hub/promote-${id}-1`)).toBe(false)
    // No runner would read a cancel flag: none is left behind.
    expect(redis.store.size).toBe(0)
  })

  it('cancel on a row whose runner is alive (lock held, or a fresh heartbeat) only asks', async () => {
    current = world()
    const redis = fakeRedis()
    const lock = run.redisPromoteLock(redis)
    const [fresh] = (await db('nivaro_hub_deploys').insert(
      crashed({ heartbeat_at: new Date() })
    )) as number[]
    expect(await run.cancelPromotion(fresh, null, { lock })).toEqual({ ok: true })
    expect((await db('nivaro_hub_deploys').where({ id: fresh }).first()).status).toBe('running')
    expect(await lock.cancelRequested(fresh)).toBe(true)

    await db('nivaro_hub_deploys').del()
    redis.store.set(hubPromoteLockKey(2), 'another-process')
    const [held] = (await db('nivaro_hub_deploys').insert(crashed())) as number[]
    expect(await run.cancelPromotion(held, null, { lock })).toEqual({ ok: true })
    expect((await db('nivaro_hub_deploys').where({ id: held }).first()).status).toBe('running')
  })

  it('healBeforeRead heals only rows nobody holds the lock of, and never throws', async () => {
    current = world()
    const redis = fakeRedis()
    const lock = run.redisPromoteLock(redis)
    const [id] = (await db('nivaro_hub_deploys').insert(crashed({ plan: null }))) as number[]
    redis.store.set(hubPromoteLockKey(2), 'another-process')
    await run.healBeforeRead(2, { lock })
    expect((await db('nivaro_hub_deploys').where({ id }).first()).status).toBe('running')
    redis.store.delete(hubPromoteLockKey(2))
    await run.healBeforeRead(2, { lock })
    expect((await db('nivaro_hub_deploys').where({ id }).first()).status).toBe('interrupted')
    const broken = { ...lock, held: async () => Promise.reject(new Error('redis down')) }
    await expect(run.healBeforeRead(2, { lock: broken })).resolves.toBeUndefined()
  })
})

const STARTED = new Date('2026-11-21T10:00:00.000Z')

describe('recoverInterruptedPromotions', () => {
  const running = (env: number, plan?: unknown) => ({
    app_id: 1,
    environment_id: env,
    kind: 'promote',
    version: '0.3.10',
    status: 'running',
    step: 'deploy api',
    plan: plan ? JSON.stringify(plan) : null
  })

  it('interrupts a running row nobody holds the lock of and deletes its temporary branches', async () => {
    const w = use(world())
    const redis = fakeRedis()
    const [id] = (await db('nivaro_hub_deploys').insert(
      running(2, {
        steps: [
          { position: 1, driverId: 1 },
          { position: 2, driverId: 2 }
        ]
      })
    )) as number[]
    await db('nivaro_hub_deploys').insert({ ...running(2), status: 'success', step: 'verify' })
    w.gl.branch('efp/deploy', `hub/promote-${id}-1`, w.apiSource)
    const warned: unknown[] = []
    const n = await run.recoverInterruptedPromotions({
      lock: run.redisPromoteLock(redis),
      gitCtx: async (driverId) => w.gl.ctx(PROJECTS[driverId]),
      logger: { warn: (o) => warned.push(o) }
    })
    expect(n).toBe(1)
    const rows = await db('nivaro_hub_deploys').orderBy('id')
    expect(rows[0]).toMatchObject({
      status: 'interrupted',
      error: 'The Hub restarted during deploy api'
    })
    expect(rows[0].finished_at).not.toBeNull()
    expect(rows[1].status).toBe('success')
    // The branch is gone; the portal one never existed (404 = fine, nothing logged).
    expect(w.gl.projects.get('efp/deploy')?.branches.has(`hub/promote-${id}-1`)).toBe(false)
    expect(w.gl.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      `/repository/branches/hub/promote-${id}-1-src`,
      `/repository/branches/hub/promote-${id}-1`,
      `/repository/branches/hub/promote-${id}-2-src`,
      `/repository/branches/hub/promote-${id}-2`
    ])
    expect(warned).toEqual([])
  })

  it('fails the job run of a row it interrupts, with the same message (B6)', async () => {
    const w = use(world())
    await db('nivaro_hub_deploys').insert({ ...running(2), job_run_id: 91, started_at: STARTED })
    const failed: unknown[][] = []
    const n = await run.recoverInterruptedPromotions({
      lock: run.redisPromoteLock(fakeRedis()),
      gitCtx: async (driverId) => w.gl.ctx(PROJECTS[driverId]),
      failJobRun: async (id, envId, message, startedAt) => {
        failed.push([id, envId, message, startedAt])
      }
    })
    expect(n).toBe(1)
    expect(failed).toEqual([[91, 2, 'The Hub restarted during deploy api', expect.anything()]])
    // The healed run keeps the deploy's own start, so its duration is real.
    const started = (failed[0] as unknown[])[3]
    expect(new Date(started as string).getTime()).toBe(STARTED.getTime())
  })

  it('leaves a running row alone while its lock is held, and never deletes the lock', async () => {
    current = world()
    const redis = fakeRedis()
    redis.store.set(hubPromoteLockKey(2), 'another-process')
    await db('nivaro_hub_deploys').insert(running(2))
    const n = await run.recoverInterruptedPromotions({ lock: run.redisPromoteLock(redis) })
    expect(n).toBe(0)
    expect((await db('nivaro_hub_deploys').first()).status).toBe('running')
    expect(redis.store.get(hubPromoteLockKey(2))).toBe('another-process')
  })

  it('an unreadable lock (Redis down) is never treated as free', async () => {
    current = world()
    await db('nivaro_hub_deploys').insert(running(2))
    const down = { ...fakeRedis(), exists: async () => Promise.reject(new Error('ECONNREFUSED')) }
    const lock = run.redisPromoteLock(down)
    expect(await lock.held(2)).toBe('unknown')
    expect(await run.recoverInterruptedPromotions({ lock })).toBe(0)
    expect((await db('nivaro_hub_deploys').first()).status).toBe('running')
  })

  it('P27: heal never deletes branches in a repository the driver was moved to', async () => {
    const w = use(world())
    const [id] = (await db('nivaro_hub_deploys').insert(
      running(2, {
        steps: [{ position: 1, driverId: 1, driverIdentity: 'https://gitlab.example.com|efp/old' }]
      })
    )) as number[]
    w.gl.branch('efp/deploy', `hub/promote-${id}-1`, w.apiSource)
    const warned: unknown[] = []
    const n = await run.recoverInterruptedPromotions({
      lock: run.redisPromoteLock(fakeRedis()),
      gitCtx: async (driverId) => w.gl.ctx(PROJECTS[driverId]),
      logger: { warn: (o) => warned.push(o) }
    })
    expect(n).toBe(1)
    expect(w.gl.projects.get('efp/deploy')?.branches.has(`hub/promote-${id}-1`)).toBe(true)
    expect(w.gl.calls.filter((c) => c.method === 'DELETE')).toEqual([])
    expect(warned).toEqual([expect.objectContaining({ err: 'DRIVER_CHANGED' })])
  })

  it('logs a branch it cannot delete and still interrupts the row', async () => {
    current = world()
    await db('nivaro_hub_deploys').insert(running(2, { steps: [{ position: 1, driverId: 1 }] }))
    const warned: unknown[] = []
    const n = await run.recoverInterruptedPromotions({
      lock: run.redisPromoteLock(fakeRedis()),
      gitCtx: async () => {
        throw new Error('no driver')
      },
      logger: { warn: (o) => warned.push(o) }
    })
    expect(n).toBe(1)
    // Both branches of the step (the temporary branch and its -src twin).
    expect(warned).toHaveLength(2)
    expect((await db('nivaro_hub_deploys').first()).status).toBe('interrupted')
  })
})
