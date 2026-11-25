import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub-driven upgrades of a shared deployment GitLab runs (registered mode + a GitLab driver +
// settings.gitlab): the store's validation, the plan (services/hub/shared/upgrade-plan.ts +
// gitlab-upgrade.ts) and the run (upgrade-run.ts through promote-run's executePlan). Real SQLite
// with the hub tables; GitLab, the registry, the deployment link, the sightings, the public names
// and the clock are fakes.

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
const activity = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (r: Record<string, unknown>) => {
    activity.rows.push(r)
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
const Store = await import('../../../services/hub/shared/store.js')
const Plan = await import('../../../services/hub/shared/upgrade-plan.js')
const Run = await import('../../../services/hub/shared/upgrade-run.js')
const Sightings = await import('../../../services/hub/shared/sightings.js')
const { SHARED_GITLAB_POSITION } = await import('../../../services/hub/shared/gitlab-upgrade.js')
const { sharedLock, memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { GitlabWriteError } = await import('../../../services/hub/gitlab-write.js')

type Sighting = import('../../../services/hub/shared/sightings.js').Sighting

const HUB_KEY = 'e'.repeat(64)
const DIGEST = `sha256:${'a'.repeat(64)}`
const SLIM = `sha256:${'b'.repeat(64)}`
const PIN = `0.3.210\n${DIGEST}\n${SLIM}\n`
const SRC = 'c'.repeat(40)
const TIP = 'd'.repeat(40)
const START = Date.parse('2026-11-22T10:00:00Z')
const GL_TOKEN = 'glpat-SharedDeployToken-0123456789'
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

let t = START
const now = () => t
let onSleep: (() => Promise<void> | void) | null = null
const sleep = vi.fn(async (ms: number) => {
  t += ms
  if (onSleep) await onSleep()
})
const locks = { shared: sharedLock(null), env: memoryPromoteLock }

let seq = 0
let gitlabDriver = 0
let dockerDriver = 0
async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

const GITLAB = { source_branch: 'release' }

/** A registered deployment the Hub upgrades through GitLab (or watches only, `watch: true`). */
async function newShared(
  o: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
  watch = false
): Promise<number> {
  const key = `gl${++seq}`
  const v = Store.validateSharedInput(
    {
      key,
      name: key,
      link_url: `https://${key}.internal.example.com`,
      mode: 'registered',
      ...(watch ? {} : { driver_id: gitlabDriver, settings: { gitlab: GITLAB } }),
      ...input
    },
    undefined,
    { driverKind: watch ? undefined : 'gitlab' }
  )
  if (!v.ok) throw new Error(v.code)
  const id = (await Store.createShared(v.row, null)).row.id
  await db('nivaro_hub_shared_deployments')
    .where({ id })
    .update({ version_pin: '0.3.209', status: 'active', ...o })
  return id
}

async function newApp(
  sharedId: number,
  envs: Array<{ key: string; placed: boolean }>
): Promise<{ appId: number; appKey: string; envIds: number[] }> {
  const appKey = `app${++seq}`
  const appId = await insertId('nivaro_hub_apps', { key: appKey, name: appKey })
  const envIds: number[] = []
  let pos = 0
  for (const e of envs) {
    let placementId: number | null = null
    if (e.placed)
      placementId = await insertId('nivaro_hub_placements', {
        kind: 'shared',
        shared_deployment_id: sharedId,
        target: JSON.stringify({ pool_max: 5 })
      })
    envIds.push(
      await insertId('nivaro_hub_environments', {
        app_id: appId,
        key: e.key,
        position: ++pos,
        status: 'active',
        base_url: `https://${appKey}-${e.key}.apps.example.com`,
        hostnames: '[]',
        placement_id: placementId,
        version_pin: e.placed ? '0.3.209' : null
      })
    )
  }
  return { appId, appKey, envIds }
}

interface Repo {
  /** The release commit on `release`; null = none. */
  source: string | null
  /** Commits on the target branch. */
  onTarget: Set<string>
  /** The pin file on the target branch (null = none). */
  pin: string | null
  /** What the deploy job ends as. */
  deploy: 'success' | 'failed'
  /** The status of a recorded build's deploy job (rollback). */
  buildJob: string
  calls: string[]
}

function repo(over: Partial<Repo> = {}): Repo {
  return {
    source: SRC,
    onTarget: new Set(),
    pin: '0.3.209\n',
    deploy: 'success',
    buildJob: 'success',
    calls: [],
    ...over
  }
}

function gitlabRead(r: Repo) {
  return {
    latestCommitMatching: vi.fn(async (_c: unknown, branch: string, re: RegExp) => {
      if (re.source === '^') return { sha: TIP, subject: 'head' }
      return branch === 'release' && r.source && re.test('chore: release nivaro 0.3.210')
        ? { sha: r.source, subject: 'chore: release nivaro 0.3.210' }
        : null
    }),
    commitExistsOn: vi.fn(async (_c: unknown, sha: string) => r.onTarget.has(sha)),
    readFile: vi.fn(async () => r.pin),
    jobNamed: vi.fn(async (_c: unknown, pipelineId: number, name: string) => ({
      id: pipelineId * 10,
      name,
      status: r.buildJob,
      web_url: `https://gitlab.example.com/jobs/${pipelineId * 10}`
    }))
  }
}

function gitlabWrite(r: Repo) {
  const job = (id: number, status: string) => ({
    id,
    name: 'deploy_production',
    status,
    web_url: `https://gitlab.example.com/jobs/${id}`
  })
  let iid = 0
  return {
    ...gitlabRead(r),
    createBranch: vi.fn(async (_c: unknown, name: string, ref: string) => {
      r.calls.push(`branch ${name} at ${/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref}`)
    }),
    deleteBranch: vi.fn(async (_c: unknown, name: string) => {
      r.calls.push(`delete ${name}`)
    }),
    openMergeRequest: vi.fn(async (_c: unknown, source: string, target: string) => {
      r.calls.push(`mr ${source} -> ${target}`)
      return { iid: ++iid, sha: 'e'.repeat(40) }
    }),
    mergeMergeRequest: vi.fn(async () => {
      r.calls.push('merge')
      return { mergeSha: TIP }
    }),
    commitFile: vi.fn(async (_c: unknown, branch: string, path: string, content: string) => {
      r.calls.push(`pin ${path} on ${branch}`)
      r.pin = content
      return { sha: 'f'.repeat(40), changed: true }
    }),
    runDeployJob: vi.fn(
      async (
        _c: unknown,
        ref: string,
        sha: string,
        opts: { onEvent?: (e: Record<string, unknown>) => void }
      ) => {
        r.calls.push(`deploy ${ref} at ${sha.slice(0, 8)}`)
        opts.onEvent?.({
          kind: 'pipeline',
          id: 555,
          web_url: 'https://gitlab.example.com/pipelines/555',
          message: 'pipeline 555'
        })
        if (r.deploy !== 'success')
          throw new GitlabWriteError(
            'DEPLOY_FAILED',
            'deploy_production failed — the deploy script rolled back (https://gitlab.example.com/jobs/9)',
            { step: 'runDeployJob', webUrl: 'https://gitlab.example.com/jobs/9' }
          )
        return { status: 'success' as const, job: job(9, 'success') }
      }
    ),
    retryJob: vi.fn(async (_c: unknown, id: number) => {
      r.calls.push(`retry ${id}`)
      return job(id + 1, 'pending')
    }),
    waitJob: vi.fn(async (_c: unknown, id: number) => job(id, 'success')),
    playJob: vi.fn(async (_c: unknown, id: number) => job(id, 'running')),
    findPipeline: vi.fn(async () => null),
    resolveCommit: vi.fn(async (_c: unknown, sha: string) => sha)
  }
}

interface Fakes {
  sightings: Sighting[]
  schema: Record<string, { state: string; error: string | null }>
  served: Record<string, string>
  statusVersion: string
}

const fakes = (): Fakes => ({
  sightings: [
    { instance: 'i1', version: '0.3.210', etag: null, at: new Date(START).toISOString() }
  ],
  schema: {},
  served: {},
  statusVersion: '0.3.210'
})

function deps(r: Repo, f: Fakes = fakes(), over: Record<string, unknown> = {}) {
  const lines: string[] = []
  const out = { completed: null as string | null, failed: null as string | null }
  const agentHealth = vi.fn(async () => {
    throw new Error('the agent is never asked for a GitLab-run deployment')
  })
  const d = {
    agentHealth,
    agentApply: vi.fn(async () => {
      throw new Error('never applied through the agent')
    }),
    imageDigest: vi.fn(async (_i: string, tag: string) => (tag.endsWith('-slim') ? SLIM : DIGEST)),
    client: () => ({
      appStatus: async (id: string) => ({
        id,
        version: '0.3.209',
        preflight: { status: 'ok', failing: [] as string[] },
        readiness_score: 100,
        busy: { imports: 0, exports: 0, renders: 0 },
        files: { count: 0, bytes: 0, local: 0 },
        key_fp: null,
        maintenance: false
      })
    }),
    sharedLock: locks.shared,
    envLock: locks.env,
    hubPublicUrl: () => 'https://hub.example.com',
    hubUrlWarning: () => null,
    gitlabRead: gitlabRead(r),
    gitlabWrite: gitlabWrite(r),
    liveSightings: vi.fn(async () => f.sightings),
    status: vi.fn(async () => ({
      version: f.statusVersion,
      instance: 'i1',
      registry: { count: 0, loaded_at: null, etag: null, stale: false, dropped: [] },
      apps: Object.entries(f.schema).map(([id, s]) => ({
        id,
        schema: { state: s.state as 'ok', version: f.statusVersion, error: s.error }
      })),
      extensions: [],
      oidc: null,
      process: {}
    })),
    readServedField: vi.fn(async (url: string) => ({ value: f.served[url] ?? null, error: null })),
    sleep,
    now,
    startJobRun: vi.fn(async () => ({
      id: 91,
      progress: () => undefined,
      log: (l: string) => {
        lines.push(l)
      },
      complete: async (o?: string) => {
        out.completed = o ?? 'done'
      },
      fail: async (e: unknown) => {
        out.failed = (e as Error).message
      }
    })),
    renewMs: 3_600_000,
    ...over
  }
  return { deps: d, lines, out, agentHealth }
}

async function start(
  id: number,
  d: ReturnType<typeof deps>['deps'],
  kind: 'upgrade' | 'rollback' = 'upgrade',
  version = '0.3.210',
  extra: Record<string, unknown> = {}
) {
  const plan = await Plan.planSharedUpgrade(id, version, kind, d as never)
  const key = (await Store.getShared(id))?.key as string
  const out = await Run.startSharedUpgrade(
    id,
    { version, kind, plan_hash: plan.plan_hash, confirm: key, ...extra },
    'admin-1',
    d as never
  )
  await Run.awaitSharedUpgrade(out.shared_deploy_id)
  return { plan, out, row: await Run.readSharedDeploy(out.shared_deploy_id) }
}

const codes = (xs: { code: string }[]) => xs.map((x) => x.code)

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const m of migrations) await m.up(db)
  gitlabDriver = await insertId('nivaro_hub_drivers', {
    kind: 'gitlab',
    name: 'shared-gitlab',
    config: JSON.stringify({
      api: 'https://gitlab.example.com/api/v4',
      project: 'ops/shared-one',
      branch: 'production',
      pin_file: '.docker/nivaro-version',
      deploy_job: 'deploy_production'
    }),
    secret: sealSecret(GL_TOKEN)
  })
  dockerDriver = await insertId('nivaro_hub_drivers', {
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
  for (const [k, v] of Object.entries({ HUB: saved.HUB, ENCRYPTION_KEY: saved.KEY }))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  await db.destroy()
})

beforeEach(() => {
  t = START
  onSleep = null
  sleep.mockClear()
  activity.rows = []
})

describe('a registered deployment names its GitLab driver (store)', () => {
  const base = { key: 'gx', name: 'gx', link_url: 'https://gx.example.com', mode: 'registered' }

  it('driver + settings.gitlab together; normalised; sharedGitlab reads them', () => {
    const v = Store.validateSharedInput(
      {
        ...base,
        driver_id: 4,
        settings: { gitlab: { source_branch: ' release ', deploy_job: 'deploy_shared' } }
      },
      undefined,
      { driverKind: 'gitlab' }
    )
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.row.driver_id).toBe(4)
    expect(v.row.settings.gitlab).toEqual({
      source_branch: 'release',
      target_branch: null,
      pin_file: null,
      before_job: null,
      deploy_job: 'deploy_shared'
    })
    expect(Store.sharedGitlab({ ...v.row })).toMatchObject({ source_branch: 'release' })
    // Watched only: no driver, no settings.gitlab.
    const w = Store.validateSharedInput(base)
    expect(w.ok && w.row.driver_id === null && Store.sharedGitlab(w.row) === null).toBe(true)
  })

  it('refuses half a GitLab setup, a Docker driver, a Docker deployment and bad names', () => {
    const code = (input: Record<string, unknown>, driverKind?: string) => {
      const v = Store.validateSharedInput({ ...base, ...input }, undefined, { driverKind })
      return v.ok ? 'ok' : v.code
    }
    expect(code({ driver_id: 4 }, 'gitlab')).toBe('BAD_GITLAB')
    expect(code({ settings: { gitlab: GITLAB } })).toBe('DRIVER_NOT_GITLAB')
    expect(code({ driver_id: 4, settings: { gitlab: GITLAB } }, 'docker')).toBe('DRIVER_NOT_GITLAB')
    expect(
      code({ mode: 'docker', driver_id: 4, stack: 'gx', settings: { gitlab: GITLAB } }, 'docker')
    ).toBe('BAD_GITLAB')
    for (const g of [
      { source_branch: 'has space' },
      { source_branch: '-x' },
      { source_branch: 'a..b' },
      { source_branch: 'release', pin_file: '../etc/passwd' },
      { source_branch: 'release', pin_file: '/abs' },
      { source_branch: 'release', other: 1 },
      { target_branch: 'production' }
    ])
      expect(code({ driver_id: 4, settings: { gitlab: g } }, 'gitlab')).toBe('BAD_GITLAB')
  })

  it('createShared checks the driver kind itself', async () => {
    const v = Store.validateSharedInput({
      ...base,
      key: `gx${++seq}`,
      driver_id: dockerDriver,
      settings: { gitlab: GITLAB }
    })
    if (!v.ok) throw new Error(v.code)
    await expect(Store.createShared(v.row, null)).rejects.toMatchObject({
      code: 'DRIVER_NOT_GITLAB'
    })
  })
})

describe('the plan of a GitLab-run deployment', () => {
  it('a watched-only registered deployment still says SHARED_NOT_HUB_DEPLOYED', async () => {
    const id = await newShared({}, {}, true)
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps(repo()).deps as never)
    expect(codes(plan.blockers)).toContain('SHARED_NOT_HUB_DEPLOYED')
    expect(plan.runner).toBe('agent')
    expect(plan.gitlab).toBeNull()
  })

  it('clean: runner gitlab, the release commit and pin named, no agent check', async () => {
    const id = await newShared({}, { extensions: ['reports'] })
    const a = await newApp(id, [{ key: 'production', placed: true }])
    const d = deps(repo())
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', d.deps as never)
    expect(plan.blockers).toEqual([])
    expect(plan.runner).toBe('gitlab')
    expect(plan.gitlab).toMatchObject({
      driver_id: gitlabDriver,
      project: 'ops/shared-one',
      source_branch: 'release',
      target_branch: 'production',
      pin_file: '.docker/nivaro-version',
      deploy_job: 'deploy_production',
      commit: SRC,
      pin: PIN
    })
    expect(plan.image).toBeNull()
    expect(plan.stack).toBeNull()
    expect(plan.roles).toEqual([])
    expect(plan.apps.map((x) => x.env_id)).toEqual([a.envIds[0]])
    expect(d.agentHealth).not.toHaveBeenCalled()
    // An extension without an image pin is the pipeline's business here (no EXTENSION_UNPINNED).
    expect(codes(plan.blockers)).not.toContain('EXTENSION_UNPINNED')
  })

  it('per-app checks are the Docker ones: PREFLIGHT_FAILING and ORDER', async () => {
    const id = await newShared()
    const app = await newApp(id, [
      { key: 'staging', placed: false },
      { key: 'production', placed: true }
    ])
    const d = deps(repo())
    d.deps.client = () => ({
      appStatus: async (tid: string) => ({
        id: tid,
        version: '0.3.209',
        preflight: { status: 'fail', failing: ['db'] },
        readiness_score: 10,
        busy: { imports: 0, exports: 0, renders: 0 },
        files: { count: 0, bytes: 0, local: 0 },
        key_fp: null,
        maintenance: false
      })
    })
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', d.deps as never)
    const row = plan.apps.find((x) => x.env_id === app.envIds[1])
    expect(row?.blockers).toEqual(['ORDER', 'PREFLIGHT_FAILING'])
  })

  it('each GitLab blocker fires on its input', async () => {
    const id = await newShared()
    const block = async (r: Repo, over: Record<string, unknown> = {}, version = '0.3.210') =>
      codes(
        (await Plan.planSharedUpgrade(id, version, 'upgrade', deps(r, fakes(), over).deps as never))
          .blockers
      )
    expect(await block(repo({ source: null }))).toEqual(['NO_SOURCE_COMMIT'])
    expect(await block(repo(), { imageDigest: vi.fn(async () => null) })).toEqual([
      'VERSION_UNKNOWN'
    ])
    const down = repo()
    const read = gitlabRead(down)
    read.latestCommitMatching.mockRejectedValue(
      new GitlabWriteError('GITLAB_UNAUTHORIZED', 'GitLab refused the token (401)', {
        status: 401,
        step: 'latestCommitMatching'
      })
    )
    expect(await block(down, { gitlabRead: read })).toEqual(['GITLAB_UNREACHABLE'])
    // The same version again (the pin the Hub recorded): never rewritten, never created.
    await db('nivaro_hub_shared_deployments').where({ id }).update({ version_pin: '0.3.210' })
    expect(await block(repo({ pin: null }))).toEqual(['PIN_CHANGED'])
    expect(await block(repo({ pin: '0.3.210\nsha256:other\n' }))).toEqual(['PIN_CHANGED'])
    expect(await block(repo({ pin: PIN, onTarget: new Set([SRC]) }))).toEqual(['ALREADY_RUNS'])
    // Restamped: the same version with a release commit not yet there runs, pin must exist.
    expect(await block(repo({ pin: PIN }))).toEqual([])
  })

  it('a driver that is gone is NO_DRIVER; an older version needs the downgrade confirm', async () => {
    const lone = await insertId('nivaro_hub_drivers', {
      kind: 'gitlab',
      name: 'gone-soon',
      config: JSON.stringify({
        api: 'https://gitlab.example.com/api/v4',
        project: 'ops/x',
        branch: 'production',
        pin_file: '.docker/nivaro-version',
        deploy_job: 'deploy_production'
      }),
      secret: sealSecret(GL_TOKEN)
    })
    const id = await newShared({}, { driver_id: lone })
    await db('nivaro_hub_drivers').where({ id: lone }).del()
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps(repo()).deps as never)
    expect(codes(plan.blockers)).toEqual(['NO_DRIVER'])

    const old = await newShared({ version_pin: '0.3.211' })
    const p2 = await Plan.planSharedUpgrade(old, '0.3.210', 'upgrade', deps(repo()).deps as never)
    expect(p2.downgrade).toBe(true)
    expect(codes(p2.warnings)).toContain('DOWNGRADE')
  })

  it('a rollback needs a build the Hub recorded; an observed version is not one', async () => {
    const id = await newShared()
    await insertId('nivaro_hub_shared_deploys', {
      shared_deployment_id: id,
      kind: 'observed',
      version: '0.3.208',
      status: 'success',
      started_at: new Date(START)
    })
    const p = await Plan.planSharedUpgrade(id, '0.3.208', 'rollback', deps(repo()).deps as never)
    expect(codes(p.blockers)).toEqual(['NOT_DEPLOYED_BEFORE'])
  })
})

describe('the run through GitLab', () => {
  it('upgrade: pin + one merge, the deploy job, replicas, schema, names; pins moved', async () => {
    const id = await newShared()
    const a = await newApp(id, [{ key: 'production', placed: true }])
    const tenant = Store.tenantIdFor({ key: a.appKey }, { id: a.envIds[0] })
    const f = fakes()
    f.schema = { [tenant]: { state: 'ok', error: null } }
    f.served = { [`https://${a.appKey}-production.apps.example.com/api/version`]: '0.3.210' }
    const r = repo()
    const d = deps(r, f)
    const { row, plan } = await start(id, d.deps)

    expect(d.out.failed).toBeNull()
    expect(row?.status).toBe('success')
    expect(plan.runner).toBe('gitlab')
    const temp = `hub/promote-${row?.id}-${SHARED_GITLAB_POSITION}`
    expect(r.calls).toEqual([
      `branch ${temp} at production`,
      `branch ${temp}-src at ${SRC.slice(0, 8)}`,
      `mr ${temp}-src -> ${temp}`,
      'merge',
      `pin .docker/nivaro-version on ${temp}`,
      `mr ${temp} -> production`,
      'merge',
      `delete ${temp}-src`,
      `delete ${temp}`,
      `deploy production at ${TIP.slice(0, 8)}`
    ])
    expect(r.pin).toBe(PIN)
    expect(d.agentHealth).not.toHaveBeenCalled()
    const shared = await Store.getShared(id)
    expect(shared).toMatchObject({ version_pin: '0.3.210', status: 'active' })
    expect(
      (await db('nivaro_hub_environments').where({ id: a.envIds[0] }).first()).version_pin
    ).toBe('0.3.210')
    // The build is recorded for a later rollback; the run log reads its GitLab lines.
    const stored = JSON.parse(
      (await db('nivaro_hub_shared_deploys').where({ id: row?.id }).first()).plan
    )
    expect(stored.gitlab_build).toEqual({ sha: TIP, pipeline_id: 555 })
    expect(d.lines.some((l) => l.startsWith('1. push nivaro 0.3.210 to production'))).toBe(true)
    expect(d.lines.some((l) => l.startsWith('2. run deploy_production'))).toBe(true)
    expect(d.lines.some((l) => l.startsWith('GitLab: deploy api: deploy_production passed'))).toBe(
      true
    )
    expect(d.lines.join('\n')).not.toContain(GL_TOKEN)
    expect(d.lines.some((l) => /^GitLab: verify:/.test(l))).toBe(false)

    // Rollback to the recorded build: the deploy job of pipeline 555 is rerun; nothing merged.
    await db('nivaro_hub_shared_deployments').where({ id }).update({ version_pin: '0.3.211' })
    r.calls = []
    r.onTarget.add(TIP)
    const back = await start(id, deps(r, f).deps, 'rollback')
    expect(back.row?.status).toBe('success')
    expect(back.plan.gitlab).toMatchObject({ commit: TIP, build_pipeline_id: 555, pin: null })
    expect(back.plan.warnings.map((w) => w.code)).toContain('ROLLBACK_SCHEMA_AHEAD')
    expect(r.calls).toEqual(['retry 5550'])
    expect((await Store.getShared(id))?.version_pin).toBe('0.3.210')
  })

  it('the deploy job fails: failed, named, pins and status back as they were', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const d = deps(repo({ deploy: 'failed' }))
    const { row } = await start(id, d.deps)
    expect(row?.status).toBe('failed')
    expect(row?.step).toBe('deploy')
    expect(row?.error).toMatch(/^DEPLOY_FAILED: .*deploy_production failed/)
    expect(row?.apps.every((x) => x.status === 'failed')).toBe(true)
    expect(await Store.getShared(id)).toMatchObject({ version_pin: '0.3.209', status: 'active' })
    expect(await locks.shared.holder(id)).toBeNull()
  })

  it('cancel before the merge into the target branch: nothing merged there, cancelled', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const r = repo()
    const d = deps(r)
    // Cancel as the pin is committed on the temporary branch (before the merge into production).
    const write = d.deps.gitlabWrite
    const commit = write.commitFile.getMockImplementation()
    write.commitFile.mockImplementation(async (...args: unknown[]) => {
      const running = await db('nivaro_hub_shared_deploys')
        .where({ shared_deployment_id: id, status: 'running' })
        .first('id')
      await Run.cancelSharedUpgrade(Number(running.id), 'admin-2', d.deps as never)
      return (commit as (...a: unknown[]) => Promise<{ sha: string; changed: boolean }>)(...args)
    })
    const { row } = await start(id, d.deps)
    expect(row?.status).toBe('cancelled')
    expect(r.calls.some((c) => c.endsWith('-> production'))).toBe(false)
    expect(r.calls.some((c) => c.startsWith('deploy '))).toBe(false)
    expect((await Store.getShared(id))?.version_pin).toBe('0.3.209')
  })

  it('wait_version needs every live replica on the version (no swarm here)', async () => {
    const id = await newShared()
    const f = fakes()
    f.sightings = [
      { instance: 'i1', version: '0.3.209', etag: null, at: new Date(START).toISOString() }
    ]
    let polls = 0
    onSleep = () => {
      if (++polls === 3)
        f.sightings = [
          { instance: 'i1', version: '0.3.210', etag: null, at: new Date(START).toISOString() }
        ]
    }
    const d = deps(repo(), f)
    const { row } = await start(id, d.deps)
    expect(row?.status).toBe('success')
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(d.lines.some((l) => l === '3. 0/1 replicas run 0.3.210')).toBe(true)
  })
})

describe('around the run', () => {
  it('an observed version is never recorded while the Hub upgrades the deployment', async () => {
    const id = await newShared({ status: 'upgrading' })
    Sightings._setSightingsDepsForTests({ redis: null, now })
    try {
      await Sightings.recordSighting(id, {
        instance: 'i1',
        version: '0.3.210',
        etag: null,
        at: new Date(START).toISOString()
      })
      const shared = await Store.getShared(id)
      expect(await Sightings.noteObservedVersion(shared as never, [])).toBeNull()
      await db('nivaro_hub_shared_deployments').where({ id }).update({ status: 'active' })
      expect(await Sightings.noteObservedVersion((await Store.getShared(id)) as never, [])).toBe(
        '0.3.210'
      )
    } finally {
      Sightings._setSightingsDepsForTests()
    }
  })

  it('heal of a stale GitLab run deletes its temporary branches', async () => {
    const id = await newShared({ status: 'upgrading' })
    const old = new Date(START - 10 * 60_000)
    const sdId = await insertId('nivaro_hub_shared_deploys', {
      shared_deployment_id: id,
      kind: 'upgrade',
      version: '0.3.210',
      from_version: '0.3.209',
      status: 'running',
      step: 'push',
      plan: JSON.stringify({
        prior_status: 'active',
        plan: { kind: 'upgrade', runner: 'gitlab', gitlab: { driver_id: gitlabDriver } }
      }),
      started_at: old,
      heartbeat_at: old
    })
    const deleted: string[] = []
    const n = await Run.healSharedDeploys({
      sharedId: id,
      deps: {
        now,
        sharedLock: locks.shared,
        deleteBranch: vi.fn(async (_c: unknown, b: string) => {
          deleted.push(b)
        })
      } as never
    })
    expect(n).toBe(1)
    expect(deleted).toEqual([
      `hub/promote-${sdId}-${SHARED_GITLAB_POSITION}`,
      `hub/promote-${sdId}-${SHARED_GITLAB_POSITION}-src`
    ])
    expect((await Store.getShared(id))?.status).toBe('active')
  })
})
