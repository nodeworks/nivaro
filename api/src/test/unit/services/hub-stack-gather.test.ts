import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatherDeps } from '../../../services/hub/promote-gather.js'

// Nivaro Hub phase 4, Task 8: gathering the planner's facts for stack components (Docker
// placements). Real SQLite for apps, environments, placements, drivers, deploy rows and stack
// settings; the Hub agent is a stub (or the real client over a fetch stub); no GitLab at all.

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
const m546 = await import('../../../db/migrations/546_hub_stack_settings.js')
const gather = await import('../../../services/hub/promote-gather.js')
const SG = await import('../../../services/hub/docker/stack-gather.js')
const S = await import('../../../services/hub/docker/stack-settings.js')
const { listImageVersions, releaseTags } = await import(
  '../../../services/hub/docker/image-tags.js'
)
const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
const { buildPromotionPlan } = await import('../../../services/hub/promote-plan.js')
const { openSecret, sealSecret } = await import('../../../services/hub/secrets.js')
const { environmentFromRow } = await import('../../../services/hub/apps.js')

type AgentHealth = import('../../../services/hub/docker/agent-types.js').AgentHealth
type StackStatus = import('../../../services/hub/docker/agent-types.js').StackStatus
type StackGatherDeps = import('../../../services/hub/docker/stack-gather.js').StackGatherDeps
type Env = import('../../../services/hub/promote-types.js').HubEnvironmentRow
type DockerDriverRow = import('../../../services/hub/drivers.js').DockerDriverRow

const KEY = 'd'.repeat(64)
const DIGEST = `sha256:${'a'.repeat(64)}`
const AGENT_TOKEN = 'agent-Token-Value-0123456789-abcdefghij'
const DB_PASS = 'pw-Plain-Value-123'
const PG = {
  DB_CLIENT: 'pg',
  DB_HOST: 'db.internal.acme',
  DB_DATABASE: 'acme_db',
  DB_USER: 'acme_user'
}
const STG_PIN = `nodeworks/efp-ops@sha256:${'1'.repeat(64)}`
const PROD_PIN = `nodeworks/efp-ops@sha256:${'2'.repeat(64)}`
const OLD_PIN = `nodeworks/efp-ops@sha256:${'3'.repeat(64)}`

const driverConfig = {
  agent_url: 'https://agent.example.com',
  dns_mode: 'automatic' as const,
  wildcard_domain: 'apps.example.com',
  edge_target: null
}

function health(over: Partial<AgentHealth> = {}): AgentHealth {
  return {
    api: 1,
    agent_version: '0.1.0',
    engine_api: '1.44',
    swarm: { manager: true, node_id: 'n1' },
    images: ['nodeworks/nivaro', 'nodeworks/efp-ops'],
    host_suffixes: ['apps.example.com'],
    edge: 'traefik',
    publish_ports: null,
    extensions_shared: false,
    redis_bundled: true,
    ...over
  }
}

function status(over: Partial<StackStatus> = {}): StackStatus {
  return {
    name: 'acme-prod',
    owner: { app: 'acme' },
    environment: 'production',
    spec_hash: 'h',
    image: `nodeworks/nivaro@${DIGEST}`,
    state: 'converged',
    published_port: null,
    services: [],
    ...over
  }
}

const versions: Record<number, string | null> = {}
let agent: {
  health: () => Promise<AgentHealth>
  stack: (name: string) => Promise<StackStatus | null>
}
let agentCalls: string[]

function stackDeps(): Partial<StackGatherDeps> {
  return {
    agentHealth: async () => {
      agentCalls.push('health')
      return agent.health()
    },
    agentStack: async (_d, name) => {
      agentCalls.push(`stack ${name}`)
      return agent.stack(name)
    }
  }
}

const noGitlab = () => {
  throw new Error('no GitLab in a stack gather')
}

function deps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    readStatus: async (env) => ({
      state: 'ok',
      version: versions[env.id] ?? null,
      preflight: null,
      checked_at: '2026-11-21T00:00:00.000Z',
      source: 'public'
    }),
    imageDigest: async () => DIGEST,
    ctxFor: noGitlab,
    latestCommitMatching: noGitlab,
    commitExistsOn: noGitlab,
    resolveCommit: noGitlab,
    readServedField: noGitlab,
    gitlabDeployedVersions: async () => [],
    isLocked: async () => false,
    stack: stackDeps(),
    listImageVersions: async () => ['0.3.11', '0.3.10', '0.3.9'],
    ...over
  }
}

let prevKey: string | undefined

beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m546.up(db)
})

afterAll(async () => {
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})

async function saveSettings(envId: number, body: Record<string, unknown>) {
  const env = environmentFromRow(
    await db('nivaro_hub_environments').where({ id: envId }).first()
  ) as Env
  const v = await S.validateStackSettings(body, await S.readStackSettings(envId), {
    driver: driverConfig,
    env
  })
  if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
  return S.saveStackSettings(envId, v.row.fields, v.row.extension_pins)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_components',
    'nivaro_hub_deploys',
    'nivaro_hub_stack_settings'
  ])
    await db(t).del()
  versions[1] = '0.3.10'
  versions[2] = '0.3.9'
  agentCalls = []
  agent = { health: async () => health(), stack: async () => status() }
  await db('nivaro_hub_apps').insert({
    id: 1,
    key: 'acme',
    name: 'Acme',
    extensions: JSON.stringify(['efp-ops'])
  })
  await db('nivaro_hub_drivers').insert({
    id: 3,
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify(driverConfig),
    secret: sealSecret(AGENT_TOKEN)
  })
  await db('nivaro_hub_placements').insert([
    { id: 4, kind: 'dedicated', driver_id: 3, target: JSON.stringify({ stack: 'acme-stg' }) },
    { id: 5, kind: 'dedicated', driver_id: 3, target: JSON.stringify({ stack: 'acme-prod' }) }
  ])
  await db('nivaro_hub_environments').insert([
    {
      id: 1,
      app_id: 1,
      key: 'staging',
      position: 1,
      base_url: 'https://acme-stg.apps.example.com',
      placement_id: 4,
      hub_managed: true,
      extension_pins: JSON.stringify({ 'efp-ops': STG_PIN })
    },
    {
      id: 2,
      app_id: 1,
      key: 'production',
      position: 2,
      base_url: 'https://acme.apps.example.com',
      placement_id: 5,
      hub_managed: true,
      extension_pins: JSON.stringify({ 'efp-ops': PROD_PIN })
    }
  ])
  await saveSettings(2, { size: 'medium', settings: PG, secrets: { DB_PASSWORD: DB_PASS } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every plaintext value the fixture stored: settings, opened secrets, tokens. */
async function secretValues(): Promise<string[]> {
  const opened = S.openStackSecrets(await S.readStackSettings(2))
  const hub = openSecret((await db('nivaro_hub_environments').where({ id: 2 }).first()).hub_token)
  return [...Object.values(PG), ...Object.values(opened), DB_PASS, AGENT_TOKEN, String(hub)].filter(
    (v) => v.length >= 6
  )
}

describe('gatherPlanInput — stack components', () => {
  it('a docker promote staging → production plans clean with the PREVIOUS environment’s pins', async () => {
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    expect(input.components).toMatchObject([{ kind: 'stack', implicit: true, driver_id: 3 }])
    expect(input.drivers[3]).toEqual({
      kind: 'docker',
      branch: '',
      deploy_job: '',
      pin_file: '',
      dns_mode: 'automatic'
    })
    expect(input.digest).toBe(DIGEST)
    expect(input.registryVersions).toBeUndefined()
    const f = input.stacks?.[input.components[0].position]
    expect(f).toMatchObject({
      stackName: 'acme-prod',
      agent: 'ok',
      imageAllowed: true,
      stackState: 'hub',
      size: 'medium',
      settingsMissing: [],
      hostnameProblems: [],
      hostnameTaken: [],
      edge: 'traefik',
      extensions: { 'efp-ops': STG_PIN },
      missingExtensions: [],
      agentOrigin: 'https://agent.example.com'
    })
    const plan = buildPromotionPlan(input)
    expect(plan.blockers).toEqual([])
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({
      driver: 'docker',
      verifyUrl: 'https://acme.apps.example.com/api/version',
      want: '0.3.10',
      stack: {
        name: 'acme-prod',
        image: `nodeworks/nivaro@${DIGEST}`,
        size: 'medium',
        extensions: { 'efp-ops': STG_PIN },
        agentOrigin: 'https://agent.example.com'
      }
    })
    // Reads only: health + the stack's status, never a write.
    expect(agentCalls).toEqual(['health', 'stack acme-prod'])
  })

  it('neither the gathered input nor the plan holds a setting or secret value', async () => {
    const input = await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    const plan = buildPromotionPlan(input)
    const text = JSON.stringify(plan) + JSON.stringify(input.stacks)
    for (const v of await secretValues()) expect(text).not.toContain(v)
    // Also with a blocker naming the missing settings.
    await db('nivaro_hub_stack_settings').where({ environment_id: 2 }).del()
    await saveSettings(2, { settings: { DB_CLIENT: 'pg', DB_HOST: 'db.internal.acme' } })
    const p2 = buildPromotionPlan(
      await gather.gatherPlanInput(2, { kind: 'promote', version: '0.3.10' }, deps())
    )
    expect(p2.blockers.map((b) => b.code)).toEqual(['STACK_SETTINGS_MISSING'])
    expect(p2.blockers[0].text).toBe(
      "production's stack settings are missing DB_DATABASE, DB_USER, DB_PASSWORD"
    )
    expect(JSON.stringify(p2)).not.toContain('db.internal.acme')
  })

  it('a rollback installs the pins of that version’s successful deploy', async () => {
    versions[2] = '0.3.10'
    const stackStep = (pin: string) =>
      JSON.stringify({
        steps: [{ kind: 'stack', driver: 'docker', stack: { extensions: { 'efp-ops': pin } } }]
      })
    await db('nivaro_hub_deploys').insert([
      {
        app_id: 1,
        environment_id: 2,
        kind: 'promote',
        version: '0.3.9',
        status: 'success',
        plan: stackStep(OLD_PIN)
      },
      {
        app_id: 1,
        environment_id: 2,
        kind: 'promote',
        version: '0.3.9',
        status: 'failed',
        plan: stackStep(STG_PIN)
      },
      {
        app_id: 1,
        environment_id: 2,
        kind: 'promote',
        version: '0.3.10',
        status: 'success',
        plan: stackStep(PROD_PIN)
      }
    ])
    const input = await gather.gatherPlanInput(2, { kind: 'rollback', version: '0.3.9' }, deps())
    expect(input.stacks?.[1]?.extensions).toEqual({ 'efp-ops': OLD_PIN })
    const plan = buildPromotionPlan(input)
    expect(plan.blockers).toEqual([])
    expect(plan.steps[0].stack?.extensions).toEqual({ 'efp-ops': OLD_PIN })
  })

  it('the first environment of an all-stack app plans from the published releases', async () => {
    await db('nivaro_hub_environments').where({ id: 1 }).del()
    versions[2] = null
    const asked: string[] = []
    const input = await gather.gatherPlanInput(
      2,
      { kind: 'promote', version: '0.3.11' },
      deps({
        listImageVersions: async (image) => {
          asked.push(image)
          return ['0.3.11', '0.3.10']
        }
      })
    )
    expect(asked).toEqual(['nodeworks/nivaro'])
    expect(input.previous).toBeNull()
    expect(input.registryVersions).toEqual(['0.3.11', '0.3.10'])
    // The first environment installs its own pins.
    expect(input.stacks?.[1]?.extensions).toEqual({ 'efp-ops': PROD_PIN })
    const plan = buildPromotionPlan(input)
    expect(plan.blockers).toEqual([])
    expect(plan.steps).toHaveLength(1)
    const missing = buildPromotionPlan({ ...input, version: '0.3.12' })
    expect(missing.blockers.map((b) => b.code)).toEqual(['IMAGE_MISSING'])
  })

  it('an unreachable agent (real client): facts say so and only GET /v1/health was sent', async () => {
    const sent: Array<{ url: string; method: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? 'GET' })
      throw new TypeError('fetch failed')
    }) as typeof fetch)
    const input = await gather.gatherPlanInput(
      2,
      { kind: 'promote', version: '0.3.10' },
      deps({ stack: {} })
    )
    const f = input.stacks?.[1]
    expect(f?.agent).toBe('unreachable')
    expect(f?.stackState).toBe('unknown')
    expect(sent).toEqual([{ url: 'https://agent.example.com/v1/health', method: 'GET' }])
    expect(buildPromotionPlan(input).blockers.map((b) => b.code)).toEqual(['AGENT_UNREACHABLE'])
  })

  it('a refused token and another agent API read as refused / incompatible', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ error: 'no', code: 'UNAUTHORIZED' }), {
          status: 401
        })) as typeof fetch
    )
    const refused = await gather.gatherPlanInput(
      2,
      { kind: 'promote', version: '0.3.10' },
      deps({ stack: {} })
    )
    expect(refused.stacks?.[1]?.agent).toBe('refused')
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ...health(), api: 2 }), { status: 200 })) as typeof fetch
    )
    const other = await gather.gatherPlanInput(
      2,
      { kind: 'promote', version: '0.3.10' },
      deps({ stack: {} })
    )
    expect(other.stacks?.[1]?.agent).toBe('incompatible')
    expect(buildPromotionPlan(other).blockers.map((b) => b.code)).toEqual(['AGENT_INCOMPATIBLE'])
  })

  it('a phase-2 GitLab placement gathers no stack facts and no releases', async () => {
    await db('nivaro_hub_drivers').insert({
      id: 9,
      kind: 'gitlab',
      name: 'deploy',
      config: JSON.stringify({
        api: 'https://gitlab.example.com',
        project: 'acme/deploy',
        branch: 'production',
        pin_file: 'PIN',
        deploy_job: 'deploy'
      })
    })
    await db('nivaro_hub_placements').where({ id: 5 }).update({ driver_id: 9, target: '{}' })
    const input = await gather.gatherPlanInput(
      2,
      { kind: 'promote', version: 'x' },
      deps({ listImageVersions: noGitlab })
    )
    expect(input.stacks).toBeUndefined()
    expect(input.registryVersions).toBeUndefined()
    expect(agentCalls).toEqual([])
  })
})

describe('gatherStackFacts', () => {
  let env: Env
  let prev: Env
  let driver: DockerDriverRow
  const app = {
    id: 1,
    key: 'acme',
    name: 'Acme',
    signin_mode: 'direct' as const,
    adopted: false,
    extensions: ['efp-ops']
  }
  const comp = {
    id: null,
    placement_id: 5,
    position: 1,
    name: 'stack',
    kind: 'stack' as const,
    driver_id: 3,
    source_branch: '',
    target_branch: null,
    before_job: null,
    deploy_job: null,
    verify_url: null,
    verify_field: 'version'
  }

  beforeEach(async () => {
    env = environmentFromRow(await db('nivaro_hub_environments').where({ id: 2 }).first()) as Env
    prev = environmentFromRow(await db('nivaro_hub_environments').where({ id: 1 }).first()) as Env
    driver = {
      id: 3,
      kind: 'docker',
      name: 'swarm',
      config: { ...driverConfig },
      secret: sealSecret(AGENT_TOKEN)
    }
  })

  const facts = (
    over: Partial<StackGatherDeps> = {},
    ctx: Partial<Parameters<typeof SG.gatherStackFacts>[1]> = {}
  ) =>
    SG.gatherStackFacts(
      comp,
      { env, previous: prev, app, kind: 'promote', version: '0.3.10', driver, ...ctx },
      { ...SG.defaultStackGatherDeps(), ...stackDeps(), ...over }
    )

  it('an image or an extension outside the agent allow-list', async () => {
    agent.health = async () => health({ images: ['nodeworks/efp-ops'] })
    expect((await facts()).imageAllowed).toBe(false)
    agent.health = async () => health({ images: ['nodeworks/nivaro'] })
    const f = await facts()
    expect(f.imageAllowed).toBe(true)
    expect(f.disallowedExtensions).toEqual(['efp-ops'])
  })

  it('an extension the app needs with no pin', async () => {
    await db('nivaro_hub_environments').where({ id: 1 }).update({ extension_pins: null })
    const f = await facts()
    expect(f.extensions).toEqual({})
    expect(f.missingExtensions).toEqual(['efp-ops'])
  })

  it('no settings row, a missing secret, unreadable secrets', async () => {
    await db('nivaro_hub_stack_settings').del()
    expect((await facts()).settingsMissing).toEqual(['(no settings)'])
    await saveSettings(2, { settings: PG })
    expect((await facts()).settingsMissing).toEqual(['DB_PASSWORD'])
    process.env.ENCRYPTION_KEY = 'e'.repeat(64)
    expect((await facts()).settingsMissing[0]).toBe('(stack secrets cannot be opened)')
  })

  it('traefik edge: names outside the agent suffixes; names another environment claims', async () => {
    agent.health = async () => health({ host_suffixes: ['other.example.net'] })
    const f = await facts()
    expect(f.hostnameProblems).toEqual([
      "acme.apps.example.com is outside the agent's allowed domains (other.example.net)."
    ])
    agent.health = async () => health()
    await db('nivaro_hub_environments')
      .where({ id: 1 })
      .update({
        hostnames: JSON.stringify(['acme.apps.example.com'])
      })
    const taken = await facts()
    expect(taken.hostnameProblems).toEqual([])
    expect(taken.hostnameTaken).toEqual([
      'acme.apps.example.com already belongs to another Hub environment.'
    ])
  })

  it('automatic DNS: a name outside the wildcard domain, even with the agent down', async () => {
    agent.health = async () => {
      throw new AgentError('AGENT_UNREACHABLE', 0, 'down')
    }
    env = { ...env, hostnames: ['acme.example.org'] }
    const f = await facts()
    expect(f.agent).toBe('unreachable')
    expect(f.hostnameProblems).toEqual([
      'acme.example.org is not under apps.example.com: automatic DNS only serves names ending in .apps.example.com'
    ])
    expect(agentCalls).toEqual(['health'])
  })

  it('publish edge: publish_port must be set and inside the agent range', async () => {
    agent.health = async () => health({ edge: 'publish', publish_ports: [8000, 8010] })
    expect((await facts()).publishPortProblem).toBe(
      'publish_port is not set — the agent publishes stacks on 8000–8010'
    )
    await db('nivaro_hub_stack_settings').update({ publish_port: 9000 })
    expect((await facts()).publishPortProblem).toBe(
      "publish_port 9000 is outside the agent's range 8000–8010"
    )
    await db('nivaro_hub_stack_settings').update({ publish_port: 8005 })
    const ok = await facts()
    expect(ok.publishPortProblem).toBeNull()
    expect(ok.edge).toBe('publish')
    // The publish edge routes no base host, so the suffix rule does not apply.
    expect(ok.hostnameProblems).toEqual([])
    agent.health = async () => health({ edge: 'publish', publish_ports: null })
    expect((await facts()).publishPortProblem).toBe(
      'the agent publishes stacks on a port but has no publish port range set'
    )
  })

  it('stack state: none, Hub, another owner, not the Hub’s', async () => {
    agent.stack = async () => null
    expect((await facts()).stackState).toBe('none')
    agent.stack = async () => status({ environment: 'staging' })
    expect((await facts()).stackState).toBe('other_owner')
    agent.stack = async () => {
      throw new AgentError('STACK_NOT_HUB', 409, 'not hub')
    }
    expect((await facts()).stackState).toBe('not_hub')
    agent.stack = async () => {
      throw new AgentError('STACK_OWNER_MISMATCH', 409, 'owner')
    }
    expect((await facts()).stackState).toBe('other_owner')
    agent.stack = async () => {
      throw new AgentError('AGENT_UNREACHABLE', 0, 'blip')
    }
    expect((await facts()).stackState).toBe('unknown')
  })

  it('no stack name on the placement', async () => {
    await db('nivaro_hub_placements').where({ id: 5 }).update({ target: '{}' })
    const f = await facts()
    expect(f.stackName).toBeNull()
    expect(agentCalls).toEqual(['health'])
  })

  it('a version older than every template; a secret that clashes with a rendered env key', async () => {
    const old = await facts({}, { version: '0.2.9' })
    expect(old.renderProblem?.code).toBe('TEMPLATE_NONE')
    expect(old.roles).toBeNull()
    const ok = await facts()
    expect(ok.renderProblem).toBeNull()
    expect(ok.roles?.map((r) => `${r.role} ×${r.replicas}`)).toEqual(['web ×2', 'worker ×1'])
    // A row written around the settings checks: a secret named like an env key the Hub sets.
    const sealed = JSON.stringify({
      DB_PASSWORD: sealSecret(DB_PASS),
      SESSION_SECRET: sealSecret('s'.repeat(64)),
      ENCRYPTION_KEY: sealSecret('k'.repeat(64)),
      TRUST_PROXY: sealSecret('2')
    })
    await db('nivaro_hub_stack_settings').update({ secrets: sealSecret(sealed) })
    const clash = await facts()
    expect(clash.renderProblem?.code).toBe('ENV_SECRET_CLASH')
    expect(JSON.stringify(clash)).not.toContain(DB_PASS)
  })
})

describe('listImageVersions', () => {
  it('keeps x.y.z tags only, newest first, numerically', async () => {
    expect(
      releaseTags(['0.3.9', '0.3.10', '0.3.10-slim', 'latest', '0.3.2', '1.0.0-rc1', 7, '0.3.10'])
    ).toEqual(['0.3.10', '0.3.9', '0.3.2'])
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({
            results: [
              { name: '0.3.9' },
              { name: '0.3.10-slim' },
              { name: '0.3.10' },
              { name: 'latest' },
              { name: '0.10.0' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )) as typeof fetch
    )
    expect(await listImageVersions('nodeworks/nivaro')).toEqual(['0.10.0', '0.3.10', '0.3.9'])
    expect(await listImageVersions('nodeworks/nivaro', 2)).toEqual(['0.10.0', '0.3.10'])
    expect(String(spy.mock.calls[0][0])).toBe(
      'https://hub.docker.com/v2/repositories/nodeworks/nivaro/tags?page_size=100&ordering=last_updated'
    )
  })

  it('answers [] on any error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('x', { status: 500 })) as typeof fetch
    )
    expect(await listImageVersions('nodeworks/nivaro')).toEqual([])
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch)
    expect(await listImageVersions('nodeworks/nivaro')).toEqual([])
    expect(await listImageVersions('registry.example.com:5000/a/b')).toEqual([])
  })
})
