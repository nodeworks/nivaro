import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 4, Task 9: the runner's docker step — deploy through the Hub agent, verify,
// heal. Real SQLite for apps, environments, placements, drivers, deploy rows and stack
// settings; the agent is a fake (scripted swarm states); a fake clock makes every wait instant.

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
// Phase 3's name check flips waiting_for_name only for an environment no creation walks.
const m544 = await import('../../../db/migrations/544_hub_databases.js')
const m545 = await import('../../../db/migrations/545_hub_creations.js')
const m546 = await import('../../../db/migrations/546_hub_stack_settings.js')
// X-4: hub tokens are written with their app-link lookup (551 adds the column).
const m551 = await import('../../../db/migrations/551_hub_signins.js')
const run = await import('../../../services/hub/promote-run.js')
const RS = await import('../../../services/hub/docker/run-step.js')
const S = await import('../../../services/hub/docker/stack-settings.js')
const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
const { openSecret, sealSecret, HUB_MASK } = await import('../../../services/hub/secrets.js')
const { environmentFromRow } = await import('../../../services/hub/apps.js')
const { strictPinMap } = await import('../../../services/hub/docker/stack-gather.js')

type AgentHealth = import('../../../services/hub/docker/agent-types.js').AgentHealth
type StackSpec = import('../../../services/hub/docker/agent-types.js').StackSpec
type StackState = import('../../../services/hub/docker/agent-types.js').StackState
type StackStatus = import('../../../services/hub/docker/agent-types.js').StackStatus
type Env = import('../../../services/hub/promote-types.js').HubEnvironmentRow
type PromotionStep = import('../../../services/hub/promote-types.js').PromotionStep
type PromotionPlan = import('../../../services/hub/promote-types.js').PromotionPlan
type HubEnvStatus = import('../../../services/hub/status.js').HubEnvStatus
type NameState = import('../../../services/hub/docker/name-check.js').NameState

const KEY = 'e'.repeat(64)
const DIGEST = `sha256:${'a'.repeat(64)}`
const IMAGE = `nodeworks/nivaro@${DIGEST}`
const HASH = 'f'.repeat(64)
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
const BASE = 'https://acme.apps.example.com'
const ORIGIN = 'https://agent.example.com'

const automatic = {
  agent_url: ORIGIN,
  dns_mode: 'automatic' as const,
  wildcard_domain: 'apps.example.com',
  edge_target: null
}
const manual = {
  agent_url: ORIGIN,
  dns_mode: 'manual' as const,
  wildcard_domain: null,
  edge_target: 'edge.example.com'
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

function status(state: StackState): StackStatus {
  return {
    name: 'acme-prod',
    owner: { app: 'acme' },
    environment: 'production',
    spec_hash: HASH,
    image: IMAGE,
    state,
    published_port: null,
    services: [
      {
        name: 'acme-prod_web',
        role: 'web',
        image: IMAGE,
        replicas: { desired: 2, running: state === 'converged' ? 2 : 1 },
        update: state === 'converged' ? 'completed' : 'updating',
        message: null
      }
    ]
  }
}

const STEP: PromotionStep = {
  position: 1,
  component: 'stack',
  kind: 'stack',
  driverId: 3,
  driver: 'docker',
  sourceSha: null,
  targetBranch: '',
  pinText: null,
  pinFile: null,
  beforeJob: null,
  deployJob: '',
  verifyUrl: `${BASE}/api/version`,
  verifyField: 'version',
  want: '0.3.10',
  stack: {
    name: 'acme-prod',
    image: IMAGE,
    size: 'medium',
    extensions: { 'efp-ops': STG_PIN },
    agentOrigin: ORIGIN
  }
}

const planOf = (steps: PromotionStep[] = [STEP]): PromotionPlan => ({
  ok: true,
  blockers: [],
  lines: [],
  steps: structuredClone(steps),
  plan_hash: ''
})

/** Every text the run wrote anywhere (log lines, steps, the outcome, the row). */
const written: string[] = []

type Poll = StackState | 'unreachable' | 'missing'

/** The Hub agent, scripted: health, one apply, then the swarm states polls see in order. */
function fakeAgent(polls: Poll[], h: () => AgentHealth = () => health()) {
  const a = {
    calls: [] as string[],
    applied: [] as StackSpec[],
    applyError: null as InstanceType<typeof AgentError> | null,
    onApply: () => {},
    agent: {
      agentHealth: async () => {
        a.calls.push('health')
        return h()
      },
      agentApply: async (_d: unknown, name: string, spec: StackSpec) => {
        a.calls.push(`apply ${name}`)
        a.applied.push(spec)
        a.onApply()
        if (a.applyError) throw a.applyError
        return { spec_hash: HASH, changed: ['acme-prod_web', 'acme-prod_worker'], unchanged: [] }
      },
      agentStack: async (_d: unknown, name: string, expect?: string) => {
        a.calls.push(`stack ${name} ${expect ?? ''}`)
        const p = polls.length > 1 ? (polls.shift() as Poll) : polls[0]
        if (p === 'unreachable')
          throw new AgentError(
            'AGENT_UNREACHABLE',
            0,
            `the Hub agent at ${ORIGIN} could not be reached for the status of ${name}`
          )
        if (p === 'missing') return null
        return status(p)
      }
    }
  }
  return a
}

function clock() {
  const c = { t: 1_000_000 }
  return {
    c,
    sleep: async (ms: number) => {
      c.t += ms
    },
    now: () => c.t
  }
}

interface Opts {
  polls?: Poll[]
  health?: () => AgentHealth
  served?: Array<string | null>
  preflight?: HubEnvStatus['preflight']
  failing?: string[]
  name?: NameState
  stopRequested?: () => Promise<boolean>
  lockLost?: () => Promise<boolean>
  ctxEnvId?: number | null
  plan?: PromotionPlan
  deployId?: number
  onApply?: () => void
  openDatabase?: (id: number) => Promise<{ client: string; url: string }>
}

async function execute(o: Opts = {}) {
  const k = clock()
  const a = fakeAgent(o.polls ?? ['updating', 'updating', 'converged'], o.health)
  if (o.onApply) a.onApply = o.onApply
  const servedReads: string[] = []
  const served = [...(o.served ?? ['0.3.10'])]
  const statusReads: unknown[] = []
  const nameChecks: Array<{ base_url: string; version: string | null }> = []
  const docker = RS.defaultDockerOps({
    sleep: k.sleep,
    now: k.now,
    agent: a.agent as never,
    readServedField: async (url) => {
      servedReads.push(url)
      const v = served.length > 1 ? (served.shift() ?? null) : (served[0] ?? null)
      return { value: v, error: v ? null : 'no answer' }
    },
    readStatus: async (env) => {
      statusReads.push(env)
      return {
        state: 'ok',
        version: '0.3.10',
        preflight: o.preflight === undefined ? 'ok' : o.preflight,
        checked_at: '2026-11-21T00:00:00.000Z',
        source: 'hub-link',
        ...(o.failing ? { failing: o.failing } : {})
      }
    },
    lookName: async (env, version) => {
      nameChecks.push({ base_url: env.base_url, version })
      return o.name ?? 'serving'
    },
    ...(o.openDatabase ? { openDatabase: o.openDatabase } : {})
  })
  const events: Array<{ kind: string; step?: string; line?: string; level?: string }> = []
  const outcome = await run.executePlan(
    o.plan ?? planOf(),
    {
      deployId: o.deployId ?? deployId,
      version: '0.3.10',
      kind: 'promote',
      targetKey: 'production',
      gitCtx: async () => {
        throw new Error('no GitLab in a docker step')
      },
      ...(o.ctxEnvId === null ? {} : { envId: o.ctxEnvId ?? 2 })
    },
    {
      onEvent: (e) => {
        events.push(e)
        written.push(e.kind === 'log' ? e.line : e.kind === 'step' ? e.step : '')
      },
      deps: {
        sleep: k.sleep,
        now: k.now,
        docker,
        stopRequested: o.stopRequested,
        lockLost: o.lockLost
      }
    }
  )
  written.push(JSON.stringify(outcome))
  const lines = events.filter((e) => e.kind === 'log').map((e) => e.line as string)
  const steps = events.filter((e) => e.kind === 'step').map((e) => e.step)
  return { outcome, a, lines, events, steps, servedReads, statusReads, nameChecks, k }
}

let deployId = 0
let prevKey: string | undefined

beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m544.up(db)
  await m545.up(db)
  await m546.up(db)
  await m551.up(db)
})

afterAll(async () => {
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})

/** P4-32: an earlier deploy here succeeded, so the name served before this one. */
async function servedEarlier() {
  await db('nivaro_hub_deploys').insert({
    app_id: 1,
    environment_id: 2,
    kind: 'promote',
    version: '0.3.9',
    status: 'success',
    plan: JSON.stringify(planOf())
  })
}

async function useDriver(config: typeof automatic | typeof manual) {
  await db('nivaro_hub_drivers')
    .where({ id: 3 })
    .update({ config: JSON.stringify(config) })
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY
  written.length = 0
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
    config: JSON.stringify(automatic),
    secret: sealSecret(AGENT_TOKEN)
  })
  await db('nivaro_hub_placements').insert({
    id: 5,
    kind: 'dedicated',
    driver_id: 3,
    target: JSON.stringify({ stack: 'acme-prod' })
  })
  await db('nivaro_hub_environments').insert({
    id: 2,
    app_id: 1,
    key: 'production',
    position: 2,
    base_url: BASE,
    placement_id: 5,
    hub_managed: true,
    version_pin: '0.3.9',
    extension_pins: JSON.stringify({ 'efp-ops': PROD_PIN })
  })
  const env = environmentFromRow(
    await db('nivaro_hub_environments').where({ id: 2 }).first()
  ) as Env
  const v = await S.validateStackSettings(
    { size: 'medium', settings: PG, secrets: { DB_PASSWORD: DB_PASS } },
    null,
    { driver: automatic, env }
  )
  if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
  await S.saveStackSettings(2, v.row.fields, v.row.extension_pins)
  deployId = Number(
    (
      (await db('nivaro_hub_deploys').insert({
        app_id: 1,
        environment_id: 2,
        kind: 'promote',
        version: '0.3.10',
        status: 'running',
        plan: JSON.stringify(planOf())
      })) as number[]
    )[0]
  )
})

/** Every plaintext secret of the fixture: settings secrets (generated too), hub and agent token. */
async function secretValues(): Promise<string[]> {
  const opened = S.openStackSecrets(await S.readStackSettings(2))
  const hub = openSecret((await db('nivaro_hub_environments').where({ id: 2 }).first()).hub_token)
  return [...Object.values(opened), DB_PASS, AGENT_TOKEN, String(hub)].filter((v) => v.length >= 6)
}

afterEach(async () => {
  const rows = (await db('nivaro_hub_deploys').select('error', 'plan', 'step')) as Array<
    Record<string, unknown>
  >
  const texts = [...written, ...rows.flatMap((r) => [r.error, r.plan, r.step].map(String))]
  const secrets = await secretValues()
  expect(secrets.length).toBeGreaterThanOrEqual(5)
  for (const t of texts) for (const sv of secrets) expect(t).not.toContain(sv)
})

const envRow = async () => db('nivaro_hub_environments').where({ id: 2 }).first()

describe('docker step — deploy', () => {
  it.each([
    [{ PUBLIC_URL: 'https://hub.example.com/admin' }, 'https://hub.example.com'],
    [
      { HUB_URL: 'https://hub.public.example', PUBLIC_URL: 'https://hub.example.com' },
      'https://hub.public.example'
    ]
  ])("X-5: the stack gets the Hub's one public address as HUB_URL (%o)", async (env, want) => {
    const prev = { HUB_URL: process.env.HUB_URL, PUBLIC_URL: process.env.PUBLIC_URL }
    try {
      delete process.env.HUB_URL
      Object.assign(process.env, env)
      const r = await execute()
      expect(r.a.applied[0].env.HUB_URL).toBe(want)
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it("phase 3 merge: an environment naming a database record gets that record's connection", async () => {
    await db('nivaro_hub_environments').where({ id: 2 }).update({ db_ref: 'hub-db:7' })
    const url = 'postgres://app:pw@db.example.com:5432/acme'
    const opened: number[] = []
    const r = await execute({
      openDatabase: async (id) => {
        opened.push(id)
        return { client: 'pg', url }
      }
    })
    expect(r.outcome.status).toBe('success')
    expect(opened).toEqual([7])
    const spec = r.a.applied[0]
    expect(spec.env.DB_CLIENT).toBe('pg')
    expect(spec.secrets.DB_URL).toBe(url)
    expect(spec.secrets.DB_PASSWORD).toBeUndefined()
    expect(spec.env.DB_HOST).toBeUndefined()
    for (const l of r.lines) expect(l).not.toContain('pw@')
  })

  it('phase 3 merge: a database record that cannot be opened stops the step before any apply', async () => {
    await db('nivaro_hub_environments').where({ id: 2 }).update({ db_ref: 'hub-db:7' })
    const r = await execute({
      openDatabase: async () => {
        throw Object.assign(new Error('The database is not ready yet.'), { code: 'NOT_READY' })
      }
    })
    expect(r.outcome.status).toBe('failed')
    expect(String(r.outcome.error)).toMatch(/database \(record 7\) cannot be used/)
    expect(r.a.calls.filter((c) => c.startsWith('apply'))).toEqual([])
  })

  it('applies, waits for converged, verifies twice + preflight, and pins version + extensions', async () => {
    const r = await execute()
    expect(r.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(r.steps).toEqual(['deploy stack', 'verify'])
    // Health is read again before the render; one apply; polls carry the applied hash.
    expect(r.a.calls[0]).toBe('health')
    expect(r.a.calls.filter((c) => c.startsWith('apply'))).toEqual(['apply acme-prod'])
    expect(r.a.calls.filter((c) => c.startsWith('stack'))).toEqual([
      `stack acme-prod ${HASH}`,
      `stack acme-prod ${HASH}`,
      `stack acme-prod ${HASH}`
    ])
    // The spec the agent got carries the opened secrets and the plan's image + pins.
    const spec = r.a.applied[0]
    expect(spec.image).toBe(IMAGE)
    expect(spec.extensions).toEqual({ 'efp-ops': STG_PIN })
    expect(spec.secrets.DB_PASSWORD).toBe(DB_PASS)
    expect(spec.secrets.HUB_TOKEN).toBe(openSecret((await envRow()).hub_token as string) as string)
    expect(r.lines).toContain('stack acme-prod: applied (2 services changed)')
    // State changes only: updating once (two polls), then converged.
    expect(r.lines.filter((l) => l.startsWith('stack acme-prod: updating'))).toEqual([
      'stack acme-prod: updating (web 1/2)'
    ])
    expect(r.lines).toContain('stack acme-prod: converged (web 2/2)')
    // Two polls 10 s apart, then one 15 s wait between the two verify reads.
    expect(r.k.c.t - 1_000_000).toBe(2 * RS.STACK_POLL_MS + 15_000)
    expect(r.servedReads).toEqual([`${BASE}/api/version`, `${BASE}/api/version`])
    expect(r.lines).toContain('verify: stack answers version = 0.3.10 twice')
    expect(r.lines).toContain('verify: stack preflight ok')
    expect(r.statusReads).toHaveLength(1)

    const env = await envRow()
    expect(env.version_pin).toBe('0.3.10')
    expect(strictPinMap(env.extension_pins)).toEqual({ 'efp-ops': STG_PIN })
    expect(env.status).toBe('active')
    // What the stack runs goes out as the runner's `deployed` event (the runner stores it in the
    // plan, like a GitLab deploy's commit): the spec hash is the step's deployed sha.
    expect(r.events.filter((e) => e.kind === 'deployed')).toEqual([
      {
        kind: 'deployed',
        position: 1,
        sha: HASH,
        pipelineId: null,
        stack: { specHash: HASH, image: IMAGE, extensions: { 'efp-ops': STG_PIN } }
      }
    ])
  })

  it('the environment id comes from the deploy row when the context has none', async () => {
    const r = await execute({ ctxEnvId: null })
    expect(r.outcome.status).toBe('success')
    expect((await envRow()).version_pin).toBe('0.3.10')
  })

  it('swarm rolls back: failed at deploy stack with SWARM_ROLLED_BACK, pins unchanged', async () => {
    const r = await execute({ polls: ['updating', 'rolled_back'] })
    expect(r.outcome).toMatchObject({
      status: 'failed',
      step: 'deploy stack',
      code: 'SWARM_ROLLED_BACK',
      error:
        'swarm rolled acme-prod back to its previous spec — the new tasks did not become healthy'
    })
    const env = await envRow()
    expect(env.version_pin).toBe('0.3.9')
    expect(strictPinMap(env.extension_pins)).toEqual({ 'efp-ops': PROD_PIN })
    expect(r.servedReads).toEqual([])
  })

  it('a paused update fails SWARM_UPDATE_PAUSED; never converging fails STACK_DEPLOY_TIMEOUT', async () => {
    const paused = await execute({ polls: ['updating', 'paused'] })
    expect(paused.outcome).toMatchObject({ status: 'failed', code: 'SWARM_UPDATE_PAUSED' })
    const slow = await execute({ polls: ['updating'] })
    expect(slow.outcome).toMatchObject({
      status: 'failed',
      step: 'deploy stack',
      code: 'STACK_DEPLOY_TIMEOUT'
    })
    expect(slow.outcome.error).toMatch(/did not converge within 30 min \(last: updating\)/)
    expect(slow.k.c.t - 1_000_000).toBe(RS.STACK_DEPLOY_MINUTES * 60_000)
    expect((await envRow()).version_pin).toBe('0.3.9')
  })

  it('one unanswered poll is tolerated; three in a row fail AGENT_UNREACHABLE', async () => {
    const blip = await execute({ polls: ['updating', 'unreachable', 'updating', 'converged'] })
    expect(blip.outcome.status).toBe('success')
    expect(blip.lines).toContain('stack acme-prod: the agent did not answer (1/3)')

    const down = await execute({
      polls: ['updating', 'unreachable', 'updating', 'unreachable', 'unreachable', 'unreachable']
    })
    expect(down.outcome).toMatchObject({
      status: 'failed',
      step: 'deploy stack',
      code: 'AGENT_UNREACHABLE'
    })
    expect(down.a.calls.filter((c) => c.startsWith('apply'))).toHaveLength(1)

    // Three misses that are never in a row: the count starts over after every answer.
    const spread = await execute({
      polls: ['unreachable', 'updating', 'unreachable', 'updating', 'unreachable', 'converged']
    })
    expect(spread.outcome.status).toBe('success')
    expect(spread.lines.filter((l) => l.includes('did not answer'))).toEqual([
      'stack acme-prod: the agent did not answer (1/3)',
      'stack acme-prod: the agent did not answer (1/3)',
      'stack acme-prod: the agent did not answer (1/3)'
    ])
  })

  it('agent refusals pass through with their code in plain words', async () => {
    const cases: Array<[string, number, RegExp, Array<{ field: string; code: string }>?]> = [
      [
        'HOSTNAME_TAKEN',
        409,
        /another stack on the swarm already routes acme\.apps\.example\.com/,
        [{ field: 'hostnames[0]', code: 'HOSTNAME_TAKEN' }]
      ],
      ['STACK_NOT_HUB', 409, /already runs a stack named acme-prod that the Hub did not create/],
      ['STACK_OWNER_MISMATCH', 409, /acme-prod belongs to another Hub app or environment/],
      ['STACK_NAME_INVALID', 400, /does not accept acme-prod as a stack name/],
      ['ENGINE_FORBIDDEN', 500, /own guard refused the Docker Engine call/],
      ['EXPECT_INVALID', 400, /spec hash the Hub sent is not one it accepts/]
    ]
    for (const [code, st, words, fields] of cases) {
      const k = clock()
      const a = fakeAgent(['converged'])
      a.applyError = new AgentError(
        code,
        st,
        `the Hub agent refused apply: ${code} (${st})`,
        fields
      )
      const out = await run.executePlan(
        planOf(),
        {
          deployId,
          version: '0.3.10',
          kind: 'promote',
          targetKey: 'production',
          gitCtx: async () => {
            throw new Error('no GitLab')
          },
          envId: 2
        },
        {
          onEvent: (e) => void written.push(e.kind === 'log' ? e.line : ''),
          deps: {
            sleep: k.sleep,
            now: k.now,
            docker: RS.defaultDockerOps({ sleep: k.sleep, now: k.now, agent: a.agent as never })
          }
        }
      )
      written.push(JSON.stringify(out))
      expect(out).toMatchObject({ status: 'failed', step: 'deploy stack', code })
      expect(out.error).toMatch(words)
    }
    expect((await envRow()).version_pin).toBe('0.3.9')
  })
})

describe('docker step — the agent changed since the plan', () => {
  it('host suffixes no longer cover the name: refused before any write', async () => {
    const r = await execute({ health: () => health({ host_suffixes: ['other.example.net'] }) })
    expect(r.outcome).toMatchObject({
      status: 'failed',
      step: 'deploy stack',
      code: 'HOSTNAME_NOT_ALLOWED'
    })
    expect(r.outcome.error).toMatch(/^The agent's limits no longer allow this stack/)
    expect(r.a.calls).toEqual(['health'])
  })

  it('edge switched to publish with no port in range: refused before any write', async () => {
    const r = await execute({
      health: () => health({ edge: 'publish', publish_ports: [20000, 20010] })
    })
    expect(r.outcome).toMatchObject({ status: 'failed', code: 'PUBLISH_PORT_NOT_ALLOWED' })
    expect(r.outcome.error).toMatch(/publish_port is not set/)
    expect(r.a.calls).toEqual(['health'])
  })

  it('an image or extension the agent no longer allows: refused before any write', async () => {
    const img = await execute({ health: () => health({ images: ['nodeworks/efp-ops'] }) })
    expect(img.outcome).toMatchObject({ status: 'failed', code: 'IMAGE_NOT_ALLOWED' })
    const ext = await execute({ health: () => health({ images: ['nodeworks/nivaro'] }) })
    expect(ext.outcome).toMatchObject({ status: 'failed', code: 'EXTENSION_NOT_ALLOWED' })
    expect([...img.a.calls, ...ext.a.calls].some((c) => c.startsWith('apply'))).toBe(false)
  })

  it('a driver now pointing at another agent, or a renamed stack: refused before any call', async () => {
    await db('nivaro_hub_drivers')
      .where({ id: 3 })
      .update({ config: JSON.stringify({ ...automatic, agent_url: 'https://other.example.com' }) })
    const moved = await execute()
    expect(moved.outcome).toMatchObject({ status: 'failed', code: 'AGENT_CHANGED' })
    expect(moved.a.calls).toEqual([])
    await useDriver(automatic)
    await db('nivaro_hub_placements')
      .where({ id: 5 })
      .update({ target: JSON.stringify({ stack: 'acme-new' }) })
    const renamed = await execute()
    expect(renamed.outcome).toMatchObject({ status: 'failed', code: 'STACK_CHANGED' })
    expect(renamed.a.calls).toEqual([])
  })
})

describe('docker step — verify', () => {
  it('preflight fail: failed at verify with PREFLIGHT_FAILED, no second apply', async () => {
    const r = await execute({ preflight: 'fail', failing: ['db-migrations', 'redis'] })
    expect(r.outcome).toMatchObject({
      status: 'failed',
      step: 'verify',
      code: 'PREFLIGHT_FAILED',
      error: 'preflight fails: db-migrations, redis'
    })
    expect(r.a.calls.filter((c) => c.startsWith('apply'))).toHaveLength(1)
    // The deploy itself converged: the pins say what runs.
    expect((await envRow()).version_pin).toBe('0.3.10')
  })

  it('manual DNS and the name does not resolve yet: success, waiting_for_name, warning', async () => {
    await useDriver(manual)
    const r = await execute({ name: 'not_resolving' })
    expect(r.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(r.nameChecks).toEqual([{ base_url: BASE, version: '0.3.10' }])
    expect(r.servedReads).toEqual([])
    expect(r.statusReads).toEqual([])
    expect((await envRow()).status).toBe('waiting_for_name')
    const warn = r.events.find((e) => e.kind === 'log' && e.level === 'warn')
    expect(warn?.line).toMatch(/acme\.apps\.example\.com does not resolve yet/)
    expect(warn?.line).toMatch(
      /Ask for DNS name acme\.apps\.example\.com pointing at edge\.example\.com/
    )
    expect((await envRow()).version_pin).toBe('0.3.10')
  })

  it('manual DNS + not_resolving on a new environment: waiting_for_name, as before', async () => {
    await useDriver(manual)
    // A never-active environment (phase 3's markWaitingForName moves only active, provisioning
    // or waiting_for_name; 'new' is not an environment status).
    await db('nivaro_hub_environments').where({ id: 2 }).update({ status: 'provisioning' })
    const r = await execute({ name: 'not_resolving' })
    expect(r.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(r.servedReads).toEqual([])
    expect((await envRow()).status).toBe('waiting_for_name')
  })

  it('manual DNS + not_serving on a never-active environment waits for its name', async () => {
    await useDriver(manual)
    // A never-active environment (phase 3's markWaitingForName moves only active, provisioning
    // or waiting_for_name; 'new' is not an environment status).
    await db('nivaro_hub_environments').where({ id: 2 }).update({ status: 'provisioning' })
    const r = await execute({ name: 'not_serving' })
    expect(r.outcome.status).toBe('success')
    expect(r.servedReads).toEqual([])
    expect((await envRow()).status).toBe('waiting_for_name')
  })

  it('manual DNS + not_serving on an environment that served before polls, verifies and runs the preflight', async () => {
    await useDriver(manual)
    await servedEarlier()
    // One bad look (a 502 while the edge refreshes, the old version still up) is not "no name".
    const ok = await execute({ name: 'not_serving', served: ['0.3.9', '0.3.10', '0.3.10'] })
    expect(ok.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(ok.servedReads).toHaveLength(3)
    expect(ok.statusReads).toHaveLength(1)
    expect((await envRow()).status).toBe('active')

    const bad = await execute({
      name: 'not_serving',
      preflight: 'fail',
      failing: ['db-migrations']
    })
    expect(bad.outcome).toMatchObject({
      status: 'failed',
      step: 'verify',
      code: 'PREFLIGHT_FAILED',
      error: 'preflight fails: db-migrations'
    })
    expect((await envRow()).status).toBe('active')
  })

  it('manual DNS on an environment that served before: an old version that keeps answering fails VERIFY_FAILED', async () => {
    await useDriver(manual)
    await servedEarlier()
    const r = await execute({ name: 'not_serving', served: ['0.3.9'] })
    expect(r.outcome).toMatchObject({ status: 'failed', step: 'verify', code: 'VERIFY_FAILED' })
    expect(r.servedReads).toHaveLength(40)
    expect((await envRow()).status).toBe('active')
  })

  it('manual DNS on an environment that served before: a name gone dark after the deploy fails VERIFY_FAILED', async () => {
    await useDriver(manual)
    await servedEarlier()
    const r = await execute({ name: 'not_serving', served: [null] })
    expect(r.outcome).toMatchObject({ status: 'failed', step: 'verify', code: 'VERIFY_FAILED' })
    expect(r.outcome.error).toMatch(/served before this deploy and has not answered since/)
    expect(r.servedReads).toHaveLength(40)
    expect(r.statusReads).toEqual([])
    expect((await envRow()).status).toBe('active')
  })

  it('manual DNS on a never-active environment whose look served: no answer after falls back to waiting_for_name', async () => {
    await useDriver(manual)
    // A never-active environment (phase 3's markWaitingForName moves only active, provisioning
    // or waiting_for_name; 'new' is not an environment status).
    await db('nivaro_hub_environments').where({ id: 2 }).update({ status: 'provisioning' })
    const r = await execute({ name: 'serving', served: [null] })
    expect(r.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(r.servedReads).toHaveLength(40)
    expect((await envRow()).status).toBe('waiting_for_name')
  })
  it('P4-32: a first manual-DNS deploy (status active, nothing served yet) waits for its name', async () => {
    await useDriver(manual)
    expect((await envRow()).status).toBe('active')
    // Name resolves, certificate pending: the look does not serve yet.
    const pending = await execute({ name: 'not_serving', served: [null] })
    expect(pending.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect(pending.servedReads).toEqual([])
    expect((await envRow()).status).toBe('waiting_for_name')
    // A look that served once, then nothing: still "never answered", never "served before".
    await db('nivaro_hub_environments').where({ id: 2 }).update({ status: 'active' })
    const dark = await execute({ name: 'serving', served: [null] })
    expect(dark.outcome).toEqual({ status: 'success', step: 'verify', error: null })
    expect((await envRow()).status).toBe('waiting_for_name')
    for (const l of [...pending.lines, ...dark.lines, JSON.stringify(dark.outcome)])
      expect(l).not.toMatch(/served before/)
  })

  it('the default name look reads through the same reader the step got', async () => {
    await useDriver(manual)
    const k = clock()
    const urls: string[] = []
    const docker = RS.defaultDockerOps({
      sleep: k.sleep,
      now: k.now,
      dnsLookup: async () => ({ address: '10.0.0.1' }),
      readServedField: async (url) => {
        urls.push(url)
        return { value: '0.3.10', error: null }
      },
      readStatus: async () => ({
        state: 'ok',
        version: '0.3.10',
        preflight: 'ok',
        checked_at: '2026-11-21T00:00:00.000Z',
        source: 'hub-link'
      })
    })
    await docker.verify(
      STEP,
      {
        deployId,
        version: '0.3.10',
        kind: 'promote',
        targetKey: 'production',
        gitCtx: async () => {
          throw new Error('no GitLab')
        },
        envId: 2
      },
      async (line) => void written.push(line)
    )
    // One look + two verify reads, all through the injected reader.
    expect(urls).toEqual([`${BASE}/api/version`, `${BASE}/api/version`, `${BASE}/api/version`])
  })

  it('manual DNS and the name serves: verified as usual, a waiting environment becomes active', async () => {
    await useDriver(manual)
    await db('nivaro_hub_environments').where({ id: 2 }).update({ status: 'waiting_for_name' })
    const r = await execute({ name: 'serving' })
    expect(r.outcome.status).toBe('success')
    expect(r.servedReads).toHaveLength(2)
    expect((await envRow()).status).toBe('active')
  })

  it('automatic DNS never skips verify: a name that never serves fails VERIFY_FAILED', async () => {
    const r = await execute({ served: ['0.3.9'] })
    expect(r.outcome).toMatchObject({ status: 'failed', step: 'verify', code: 'VERIFY_FAILED' })
    expect(r.servedReads).toHaveLength(40)
    expect(r.nameChecks).toEqual([])
    expect((await envRow()).status).toBe('active')
  })

  it('verify needs two answers in a row', async () => {
    const r = await execute({ served: ['0.3.10', '0.3.9', '0.3.10', '0.3.10'] })
    expect(r.outcome.status).toBe('success')
    expect(r.servedReads).toHaveLength(4)
  })
})

describe('docker step — cancel and lock', () => {
  it('a cancel asked during the deploy waits for swarm, then stops at the next boundary', async () => {
    let asked = false
    const r = await execute({
      stopRequested: async () => asked,
      onApply: () => {
        asked = true
      }
    })
    expect(r.outcome).toEqual({ status: 'cancelled', step: 'deploy stack', error: null })
    // Swarm was waited for to the end and the pins say what runs; verify never started.
    expect(r.a.calls.filter((c) => c.startsWith('stack'))).toHaveLength(3)
    expect(r.servedReads).toEqual([])
    expect((await envRow()).version_pin).toBe('0.3.10')
  })

  it('a cancel asked before the PUT applies nothing', async () => {
    let n = 0
    // The first ask (the step boundary) says go on, the second (right before the PUT) stop.
    const r = await execute({ stopRequested: async () => ++n >= 2 })
    expect(r.outcome).toEqual({ status: 'cancelled', step: 'deploy stack', error: null })
    expect(r.a.calls).toEqual(['health'])
    expect((await envRow()).version_pin).toBe('0.3.9')
  })

  it('a lost lock stops after the converged deploy as interrupted', async () => {
    let lost = false
    const r = await execute({
      lockLost: async () => lost,
      polls: ['converged'],
      onApply: () => {
        lost = true
      }
    })
    expect(r.outcome).toEqual({
      status: 'interrupted',
      step: 'deploy stack',
      error: 'Lost the promotion lock'
    })
    expect(r.servedReads).toEqual([])
  })
})

describe('prepareStackSpec (restart, ruling P4-16)', () => {
  it('renders the spec a deploy of the same version, image and pins applies', async () => {
    const r = await execute()
    const a = fakeAgent(['converged'])
    const p = await RS.prepareStackSpec(
      2,
      {
        name: 'acme-prod',
        driverId: 3,
        version: '0.3.10',
        image: IMAGE,
        extensions: { 'efp-ops': STG_PIN }
      },
      { agent: a.agent as never }
    )
    expect(p.spec).toEqual(r.a.applied[0])
    expect(a.calls).toEqual(['health'])
  })

  it('refuses malformed pins (fails closed)', async () => {
    await expect(
      RS.prepareStackSpec(2, {
        name: 'acme-prod',
        driverId: 3,
        version: '0.3.10',
        image: IMAGE,
        extensions: { 'efp-ops': 'nodeworks/efp-ops:latest' }
      })
    ).rejects.toMatchObject({ code: 'PLAN_STACK_INVALID' })
  })
})

describe('recovery of a running docker row', () => {
  it('interrupted with what the agent reports; no branch deleted, no GitLab context opened', async () => {
    await db('nivaro_hub_deploys').where({ id: deployId }).update({ step: 'deploy stack' })
    const deleteBranch = vi.fn()
    const gitCtx = vi.fn(async () => {
      throw new Error('driverCtx must not run for a docker row')
    })
    const reads: Array<[number, string]> = []
    const n = await run.recoverInterruptedPromotions({
      lock: run.memoryPromoteLock,
      deleteBranch,
      gitCtx,
      stackState: async (driverId, name) => {
        reads.push([driverId, name])
        return 'updating'
      },
      logger: null
    })
    expect(n).toBe(1)
    const row = await db('nivaro_hub_deploys').where({ id: deployId }).first()
    expect(row.status).toBe('interrupted')
    expect(row.error).toBe(
      'The Hub restarted during deploy stack: the Hub agent reports acme-prod is still updating — nothing was re-applied; the next plan reads the stack as it is'
    )
    expect(reads).toEqual([[3, 'acme-prod']])
    expect(deleteBranch).not.toHaveBeenCalled()
    expect(gitCtx).not.toHaveBeenCalled()
    // Nothing on the stack changed.
    expect((await envRow()).version_pin).toBe('0.3.9')
  })

  it('P4-34: a heal on read (lock lapsed) closes the row AND its job run, not only at boot', async () => {
    await db('nivaro_hub_deploys')
      .where({ id: deployId })
      .update({ step: 'deploy stack', job_run_id: 77, started_at: new Date(Date.now() - 60_000) })
    const failed: Array<[number, number | null, string]> = []
    const { interruptStaleRows } = await import('../../../services/hub/promote-heal.js')
    const healed = await interruptStaleRows(2, false, async () => false, {
      deleteBranch: vi.fn(),
      failJobRun: async (jobRunId, envId, message) => {
        failed.push([jobRunId, envId, message])
      },
      stackState: async () => 'converged',
      logger: null
    })
    expect(healed).toBe(1)
    const row = await db('nivaro_hub_deploys').where({ id: deployId }).first()
    expect(row.status).toBe('interrupted')
    expect(failed).toHaveLength(1)
    expect(failed[0].slice(0, 2)).toEqual([77, 2])
    expect(failed[0][2]).toMatch(/The Hub stopped during deploy stack/)
    expect(row.error).toMatch(/runs a converged spec/)
  })

  it('an agent that does not answer leaves the row interrupted all the same', async () => {
    const n = await run.recoverInterruptedPromotions({
      lock: run.memoryPromoteLock,
      deleteBranch: vi.fn(),
      stackState: async () => {
        throw new AgentError('AGENT_UNREACHABLE', 0, 'down')
      },
      logger: null
    })
    expect(n).toBe(1)
    const row = await db('nivaro_hub_deploys').where({ id: deployId }).first()
    expect(row.status).toBe('interrupted')
    expect(row.error).toMatch(/could not say how acme-prod stands/)
  })
})

const gatherMod = await import('../../../services/hub/promote-gather.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')

describe('P4-30: Apply now', () => {
  const RUNNING = `nodeworks/nivaro@sha256:${'c'.repeat(64)}`

  /** The deploy that put 0.3.9 where it runs, recorded the way the runner records it. */
  async function recordRunning(status = 'success', version = '0.3.9') {
    await db('nivaro_hub_deploys').del()
    await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: 2,
      kind: 'promote',
      version,
      status,
      plan: JSON.stringify(
        planOf([
          {
            ...STEP,
            want: '0.3.9',
            stack: { ...(STEP.stack as NonNullable<PromotionStep['stack']>), image: RUNNING },
            deployedSha: HASH,
            deployedPipelineId: null,
            deployedSpecHash: HASH,
            deployedImage: RUNNING
          }
        ])
      )
    })
  }

  function startDeps(a: ReturnType<typeof fakeAgent>, k: ReturnType<typeof clock>) {
    const docker = RS.defaultDockerOps({
      sleep: k.sleep,
      now: k.now,
      agent: a.agent as never,
      readServedField: async () => ({ value: '0.3.9', error: null }),
      readStatus: async () => ({
        state: 'ok',
        version: '0.3.9',
        preflight: 'ok',
        checked_at: '2026-11-21T00:00:00.000Z',
        source: 'hub-link'
      }),
      lookName: async () => 'serving'
    })
    const job = { lines: [] as string[] }
    return {
      gather: (envId: number, opts: Parameters<typeof gatherMod.gatherPlanInput>[1]) =>
        gatherMod.gatherPlanInput(envId, opts, {
          ...gatherMod.defaultGatherDeps(),
          readStatus: async () => ({
            state: 'ok',
            version: '0.3.9',
            preflight: 'ok',
            checked_at: '2026-11-21T00:00:00.000Z',
            source: 'hub-link'
          }),
          imageDigest: async () => {
            throw new Error('Apply now never reads the registry')
          },
          isLocked: async () => false,
          stack: {
            agentHealth: async () => health(),
            agentStack: async () => status('converged')
          }
        }),
      lock: memoryPromoteLock,
      startJobRun: async () => ({
        id: null,
        progress: () => {},
        log: (line: string) => {
          job.lines.push(line)
          written.push(line)
        },
        complete: async () => {},
        fail: async () => {}
      }),
      gitCtx: async () => {
        throw new Error('no GitLab in Apply now')
      },
      execute: { sleep: k.sleep, now: k.now, docker }
    }
  }

  it('save → Apply now: the agent gets the new settings on the running image; the deploy row records it', async () => {
    await recordRunning()
    // Save changed settings (a new MAIL_FROM) and pins, as the settings editor does.
    const env = environmentFromRow(
      await db('nivaro_hub_environments').where({ id: 2 }).first()
    ) as Env
    const v = await S.validateStackSettings(
      {
        size: 'medium',
        settings: { ...PG, MAIL_FROM: 'new-sender@acme.example' },
        secrets: { DB_PASSWORD: HUB_MASK },
        extension_pins: { 'efp-ops': STG_PIN }
      },
      await S.readStackSettings(2),
      { driver: automatic, env }
    )
    if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
    await S.saveStackSettings(2, v.row.fields, v.row.extension_pins)

    const k = clock()
    const a = fakeAgent(['updating', 'converged'])
    const started = await run.startStackApply(
      2,
      { confirm: 'production', user: { id: 'u1' } },
      startDeps(a, k) as never
    )
    await run.awaitPromotion(started.deployId)

    // The agent got the running version's recorded image, the new setting and the saved pins.
    expect(a.applied).toHaveLength(1)
    const spec = a.applied[0]
    expect(spec.image).toBe(RUNNING)
    expect(spec.env.MAIL_FROM).toBe('new-sender@acme.example')
    expect(spec.extensions).toEqual({ 'efp-ops': STG_PIN })

    const row = await db('nivaro_hub_deploys').where({ id: started.deployId }).first()
    expect(row).toMatchObject({ kind: 'promote', version: '0.3.9', status: 'success' })
    const plan = JSON.parse(row.plan)
    expect(plan.apply).toBe(true)
    expect(plan.steps[0]).toMatchObject({
      driver: 'docker',
      deployedSha: HASH,
      deployedSpecHash: HASH,
      deployedImage: IMAGE,
      stack: { image: RUNNING, extensions: { 'efp-ops': STG_PIN } }
    })
    const env2 = await envRow()
    expect(env2.version_pin).toBe('0.3.9')
    expect(strictPinMap(env2.extension_pins)).toEqual({ 'efp-ops': STG_PIN })
  })

  it('P4-35: after a deploy that converged but failed verify, Apply now redeploys with the saved settings', async () => {
    // The 0.3.9 deploy converged (version_pin, image, pins recorded), then verify failed.
    await recordRunning('failed')
    const env = environmentFromRow(
      await db('nivaro_hub_environments').where({ id: 2 }).first()
    ) as Env
    const v = await S.validateStackSettings(
      {
        size: 'medium',
        settings: { ...PG, MAIL_FROM: 'fixed@acme.example' },
        secrets: { DB_PASSWORD: HUB_MASK }
      },
      await S.readStackSettings(2),
      { driver: automatic, env }
    )
    if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
    await S.saveStackSettings(2, v.row.fields, v.row.extension_pins)

    const a = fakeAgent(['converged'])
    const started = await run.startStackApply(
      2,
      { confirm: 'production', user: { id: 'u1' } },
      startDeps(a, clock()) as never
    )
    await run.awaitPromotion(started.deployId)
    expect(a.applied).toHaveLength(1)
    expect(a.applied[0].image).toBe(RUNNING)
    expect(a.applied[0].env.MAIL_FROM).toBe('fixed@acme.example')
    const row = await db('nivaro_hub_deploys').where({ id: started.deployId }).first()
    expect(row.status).toBe('success')
  })

  it('P4-35: the newest recorded deploy ran another version than version_pin: refused, nothing sent', async () => {
    await recordRunning('failed', '0.3.8')
    const a = fakeAgent(['converged'])
    await expect(
      run.startStackApply(2, { confirm: 'production', user: null }, startDeps(a, clock()) as never)
    ).rejects.toMatchObject({ code: 'STACK_STATE_UNKNOWN' })
    expect(a.calls.filter((c) => c.startsWith('apply'))).toEqual([])
  })

  it('nothing deployed: NOT_DEPLOYED, nothing sent', async () => {
    await db('nivaro_hub_deploys').del()
    await db('nivaro_hub_environments').where({ id: 2 }).update({ version_pin: null })
    const a = fakeAgent(['converged'])
    await expect(
      run.startStackApply(2, { confirm: 'production', user: null }, startDeps(a, clock()) as never)
    ).rejects.toMatchObject({ code: 'NOT_DEPLOYED' })
    // A version pin but no recorded Hub deploy of it: refused by the plan, nothing sent.
    await db('nivaro_hub_environments').where({ id: 2 }).update({ version_pin: '0.3.9' })
    await expect(
      run.startStackApply(2, { confirm: 'production', user: null }, startDeps(a, clock()) as never)
    ).rejects.toMatchObject({ code: 'NOT_DEPLOYED' })
    expect(a.calls.filter((c) => c.startsWith('apply'))).toEqual([])
  })

  it('a wrong confirm: CONFIRM_REQUIRED', async () => {
    await recordRunning()
    const a = fakeAgent(['converged'])
    await expect(
      run.startStackApply(2, { confirm: 'prod', user: null }, startDeps(a, clock()) as never)
    ).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
  })
})
