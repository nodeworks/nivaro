import { describe, expect, it } from 'vitest'
import { buildCreationPlan } from '../../../services/hub/create/plan.js'
import {
  type CreateAppInput,
  type CreationFacts,
  creationKindOf,
  DOCKER_STEP_ORDER,
  type DockerCreationFacts,
  gitlabTargetIdOf,
  SHARED_STEP_ORDER,
  type SharedCreationFacts,
  STEP_ORDER,
  stepOrderFor
} from '../../../services/hub/create/types.js'
import type { HubDatabase } from '../../../services/hub/db/databases.js'
import type { HubDbServerRow, SealedAdminSecret } from '../../../services/hub/db/servers.js'
import type { AgentHealth } from '../../../services/hub/docker/agent-types.js'
import type { DockerDriverRow } from '../../../services/hub/drivers.js'
import type { SharedDeployment } from '../../../services/hub/shared/store.js'

// Gap `create` (0.3.215): the planner for a Docker creation (the Hub agent deploys the stack) and
// a shared one (place-shared). Pure: every fact is given. Each agent limit and shared rule has its
// own refusal code, and the plan carries names only.

const OWNER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OIDC_SECRET = 'oidc-Secr3t-value'
const PIN = `nodeworks/efp-ops@sha256:${'c'.repeat(64)}`

const server: HubDbServerRow = {
  id: 2,
  name: 'pg-auto',
  engine: 'pg',
  host: 'pg1.example.com',
  port: 5432,
  provision_mode: 'automatic',
  ssl_mode: 'require',
  trust_server_cert: false,
  collation: null,
  user_host: null,
  notes: null,
  admin_secret: 'enc:v1:sealed' as SealedAdminSecret
}

const driver: DockerDriverRow = {
  id: 9,
  kind: 'docker',
  name: 'swarm-a',
  config: {
    agent_url: 'https://agent.example.com',
    dns_mode: 'automatic',
    wildcard_domain: 'apps.example.com',
    edge_target: null
  },
  secret: 'enc:v1:agent-token'
}

const health = (over: Partial<AgentHealth> = {}): AgentHealth => ({
  api: 1,
  agent_version: '0.2.2',
  engine_api: '1.45',
  swarm: { manager: true, node_id: 'n1', nodes: 1 },
  images: ['nodeworks/nivaro', 'nodeworks/efp-ops'],
  host_suffixes: ['.apps.example.com'],
  edge: 'traefik',
  publish_ports: null,
  extensions_shared: false,
  redis_bundled: true,
  env_prefixes: ['EFP_'],
  ...over
})

const dockerFacts = (over: Partial<DockerCreationFacts> = {}): DockerCreationFacts => ({
  driver,
  health: health(),
  agentState: 'ok',
  imageRepo: 'nodeworks/nivaro',
  stacks: { 'demo--staging': 'none', 'demo--production': 'none' },
  placementStacks: [],
  settings: {
    ok: true,
    row: {
      fields: {
        size: 'small',
        redis: 'bundled',
        publish_port: null,
        settings: { MAIL_FROM: 'a@example.com' },
        secrets: 'enc:v1:sealed-map'
      },
      extension_pins: {}
    }
  },
  secretKeys: [],
  ...over
})

const shared = (over: Partial<SharedDeployment> = {}): SharedDeployment => ({
  id: 4,
  key: 'pool-a',
  name: 'Pool A',
  mode: 'docker',
  driver_id: 9,
  stack: 'pool-a',
  version_pin: '0.3.215',
  extensions: ['efp-ops'],
  extension_pins: {},
  host_pattern: '*.shared.example.com',
  link_url: 'https://pool-a.example.com',
  pool_budget: 40,
  status: 'active',
  settings: {},
  token: null,
  last_seen_at: null,
  created_at: null,
  updated_at: null,
  ...over
})

const sharedFacts = (over: Partial<SharedCreationFacts> = {}): SharedCreationFacts => ({
  deployment: shared(),
  poolUsed: 10,
  routed: [],
  ...over
})

function input(over: Partial<CreateAppInput> = {}): CreateAppInput {
  return {
    key: 'demo',
    name: 'Demo',
    owners: [OWNER],
    first_admin: { email: 'ada@example.com' },
    target: { kind: 'docker', driver_id: 9 },
    version: '0.3.215',
    signin: {
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      client_id: 'client-123',
      client_secret: OIDC_SECRET
    },
    environments: [
      { key: 'staging', database: { server_id: 2 } },
      { key: 'production', database: { server_id: 2 } }
    ],
    ...over
  }
}

const sharedInput = (over: Partial<CreateAppInput> = {}): CreateAppInput => {
  const { signin: _s, ...rest } = input({ target: { kind: 'shared', shared_id: 4 }, version: '' })
  return { ...rest, ...over }
}

function facts(over: Partial<CreationFacts> = {}): CreationFacts {
  return {
    keyTaken: false,
    unknownOwners: [],
    target: null,
    servers: { 2: server },
    existing: {},
    recordedNames: [],
    takenHostnames: [],
    takenStackNames: [],
    serverHas: { '2:nivaro_demo_staging': false, '2:nivaro_demo_production': false },
    projectExists: false,
    digest: DIGEST,
    slimDigest: null,
    encryptionKey: true,
    hubUrl: 'https://hub.example.com',
    kind: 'docker',
    docker: dockerFacts(),
    ...over
  }
}

const codes = (p: ReturnType<typeof buildCreationPlan>) => p.blockers.map((b) => b.code)

describe('creation kinds', () => {
  it('reads the kind and the GitLab target id', () => {
    expect(creationKindOf({ target_id: 3 })).toBe('gitlab')
    expect(creationKindOf({ target: { kind: 'docker' } })).toBe('docker')
    expect(creationKindOf({ target: { kind: 'shared' } })).toBe('shared')
    expect(creationKindOf({ target: { kind: 'other' } })).toBe('gitlab')
    expect(gitlabTargetIdOf({ target: { kind: 'gitlab', id: 7 }, target_id: 3 })).toBe(7)
    expect(gitlabTargetIdOf({ target_id: 3 })).toBe(3)
    expect(stepOrderFor('docker')).toEqual(DOCKER_STEP_ORDER)
    expect(stepOrderFor('shared')).toEqual(SHARED_STEP_ORDER)
    expect(stepOrderFor(undefined)).toEqual(STEP_ORDER)
  })
})

describe('Docker creation plan', () => {
  it('plans a clean creation: names under the wildcard, stacks, no repository', () => {
    const p = buildCreationPlan(input(), facts())
    expect(p.blockers).toEqual([])
    expect(p.ok).toBe(true)
    expect(p.target).toEqual({ kind: 'docker', name: 'swarm-a' })
    expect(p.app.project_path).toBe('')
    expect(p.environments.map((e) => [e.hostname, e.stack_name])).toEqual([
      ['demo--staging.apps.example.com', 'demo--staging'],
      ['demo.apps.example.com', 'demo--production']
    ])
    expect(p.environments[0].stack).toEqual({ size: 'small', redis: 'bundled', publish_port: null })
    expect(p.lines.join('\n')).toMatch(/Hub agent of swarm-a/)
    expect(p.lines.join('\n')).not.toMatch(/Fork|deploy repository/)
    // Names only: no secret, no sealed value.
    const text = JSON.stringify(p)
    expect(text).not.toContain(OIDC_SECRET)
    expect(text).not.toContain('enc:v1')
  })

  it('refuses a missing driver or one without a token', () => {
    expect(
      codes(buildCreationPlan(input(), facts({ docker: dockerFacts({ driver: null }) })))
    ).toContain('BAD_TARGET')
    expect(
      codes(
        buildCreationPlan(
          input(),
          facts({ docker: dockerFacts({ driver: { ...driver, secret: null } }) })
        )
      )
    ).toContain('BAD_TARGET')
  })

  it('names the agent state', () => {
    for (const [state, code] of [
      ['unreachable', 'AGENT_UNREACHABLE'],
      ['refused', 'AGENT_REFUSED'],
      ['incompatible', 'AGENT_INCOMPATIBLE']
    ] as const)
      expect(
        codes(
          buildCreationPlan(
            input(),
            facts({ docker: dockerFacts({ health: null, agentState: state }) })
          )
        )
      ).toContain(code)
  })

  it('respects the image allow-list for Nivaro and the extensions', () => {
    const noImage = facts({ docker: dockerFacts({ health: health({ images: ['other/repo'] }) }) })
    expect(codes(buildCreationPlan(input(), noImage))).toContain('IMAGE_NOT_ALLOWED')
    const pinned = dockerFacts({
      health: health({ images: ['nodeworks/nivaro'] }),
      settings: {
        ok: true,
        row: {
          fields: {
            size: 'small',
            redis: 'bundled',
            publish_port: null,
            settings: {},
            secrets: null
          },
          extension_pins: { 'efp-ops': PIN }
        }
      }
    })
    expect(codes(buildCreationPlan(input(), facts({ docker: pinned })))).toEqual([
      'EXTENSION_NOT_ALLOWED'
    ])
  })

  it('respects the host suffixes and the wildcard', () => {
    const f = facts({ docker: dockerFacts({ health: health({ host_suffixes: ['.other.com'] }) }) })
    const p = buildCreationPlan(input(), f)
    expect(codes(p)).toEqual(['HOSTNAME_NOT_ALLOWED', 'HOSTNAME_NOT_ALLOWED'])
    expect(p.blockers[0].env).toBe('staging')
  })

  it('passes a stack settings refusal through with its code (env allow-list)', () => {
    const f = facts({
      docker: dockerFacts({
        settings: { ok: false, code: 'SETTING_INVALID', message: 'FOO_BAR is not a Nivaro setting' }
      })
    })
    expect(codes(buildCreationPlan(input(), f))).toEqual(['SETTING_INVALID'])
  })

  it('refuses bundled Redis the agent does not offer, and external Redis without REDIS_URL', () => {
    const f = facts({ docker: dockerFacts({ health: health({ redis_bundled: false }) }) })
    expect(codes(buildCreationPlan(input(), f))).toEqual(['REDIS_NOT_OFFERED'])
    const ext = (secretKeys: string[]) =>
      facts({
        docker: dockerFacts({
          secretKeys,
          settings: {
            ok: true,
            row: {
              fields: {
                size: 'small',
                redis: 'external',
                publish_port: null,
                settings: {},
                secrets: null
              },
              extension_pins: {}
            }
          }
        })
      })
    expect(codes(buildCreationPlan(input(), ext([])))).toEqual(['STACK_SETTINGS_MISSING'])
    expect(codes(buildCreationPlan(input(), ext(['REDIS_URL'])))).toEqual([])
  })

  it('refuses a stack the swarm already runs, or another placement of the driver deploys', () => {
    const p1 = buildCreationPlan(
      input(),
      facts({
        docker: dockerFacts({ stacks: { 'demo--staging': 'other', 'demo--production': 'none' } })
      })
    )
    expect(codes(p1)).toEqual(['STACK_EXISTS'])
    const p2 = buildCreationPlan(
      input(),
      facts({ docker: dockerFacts({ placementStacks: ['demo--production'] }) })
    )
    expect(codes(p2)).toEqual(['STACK_NAME_TAKEN'])
  })

  it('needs a publish port in the range on a published-port edge, one per environment', () => {
    const f = facts({
      docker: dockerFacts({ health: health({ edge: 'publish', publish_ports: [20000, 20100] }) })
    })
    expect(codes(buildCreationPlan(input(), f))).toEqual([
      'PUBLISH_PORT_NOT_ALLOWED',
      'PUBLISH_PORT_NOT_ALLOWED'
    ])
    const ports = (a: number, b: number) =>
      input({
        environments: [
          { key: 'staging', publish_port: a, database: { server_id: 2 } },
          { key: 'production', publish_port: b, database: { server_id: 2 } }
        ]
      })
    expect(codes(buildCreationPlan(ports(20001, 20002), f))).toEqual([])
    expect(codes(buildCreationPlan(ports(20001, 20001), f))).toEqual(['PUBLISH_PORT_NOT_ALLOWED'])
    expect(codes(buildCreationPlan(ports(30000, 20002), f))).toEqual(['PUBLISH_PORT_NOT_ALLOWED'])
    // A port another stack on the driver already publishes (review L3).
    const taken = facts({
      docker: dockerFacts({
        health: health({ edge: 'publish', publish_ports: [20000, 20100] }),
        takenPorts: [20002]
      })
    })
    const p = buildCreationPlan(ports(20001, 20002), taken)
    expect(codes(p)).toEqual(['PUBLISH_PORT_NOT_ALLOWED'])
    expect(p.blockers[0].text).toMatch(/already published by another stack/)
  })

  it('has no stack template before 0.3.0', () => {
    expect(codes(buildCreationPlan(input({ version: '0.2.9' }), facts()))).toContain(
      'TEMPLATE_NONE'
    )
  })

  it('refuses `extensions` (pins carry them) and still needs the Hub URL and sign-in', () => {
    expect(codes(buildCreationPlan(input({ extensions: ['x'] }), facts()))).toEqual([
      'EXTENSIONS_UNSUPPORTED'
    ])
    expect(codes(buildCreationPlan(input(), facts({ hubUrl: null })))).toEqual(['NO_HUB_URL'])
    const { signin: _s, ...noSignin } = input()
    expect(codes(buildCreationPlan(noSignin as CreateAppInput, facts()))).toEqual(['BAD_SIGNIN'])
  })

  it('warns about per-node volumes on a swarm of several nodes', () => {
    const f = facts({
      docker: dockerFacts({ health: health({ swarm: { manager: true, node_id: 'n', nodes: 3 } }) })
    })
    expect(buildCreationPlan(input(), f).warnings.join(' ')).toMatch(/3 nodes/)
  })

  it('a manual-DNS driver needs each hostname and gives a ticket pointing at its edge', () => {
    const manual: DockerDriverRow = {
      ...driver,
      config: {
        ...driver.config,
        dns_mode: 'manual',
        wildcard_domain: null,
        edge_target: 'lb.example.com'
      }
    }
    const f = facts({ docker: dockerFacts({ driver: manual }) })
    expect(codes(buildCreationPlan(input(), f))).toEqual(['HOSTNAME_REQUIRED', 'HOSTNAME_REQUIRED'])
    const named = input({
      environments: [
        { key: 'staging', hostname: 'demo-stg.apps.example.com', database: { server_id: 2 } },
        { key: 'production', hostname: 'demo.apps.example.com', database: { server_id: 2 } }
      ]
    })
    const p = buildCreationPlan(named, f)
    expect(p.blockers).toEqual([])
    expect(p.environments[0].ticket).toMatch(/lb\.example\.com/)
  })
})

describe('shared creation plan', () => {
  const sf = (over: Partial<SharedCreationFacts> = {}) =>
    facts({ kind: 'shared', docker: undefined, digest: null, shared: sharedFacts(over) })

  it('plans names under the host pattern, no stack, no image, sign-in optional', () => {
    const p = buildCreationPlan(sharedInput(), sf())
    expect(p.blockers).toEqual([])
    expect(p.target).toEqual({ kind: 'shared', name: 'Pool A' })
    expect(p.environments.map((e) => [e.hostname, e.stack_name, e.pool_max])).toEqual([
      ['demo--staging.shared.example.com', null, 5],
      ['demo.shared.example.com', null, 5]
    ])
    // A shared app has no Hub link of its own: no Hub URL is needed.
    expect(codes(buildCreationPlan(sharedInput(), { ...sf(), hubUrl: null }))).toEqual([])
  })

  it('runs the deployment version only', () => {
    expect(codes(buildCreationPlan(sharedInput({ version: '0.3.215' }), sf()))).toEqual([])
    expect(codes(buildCreationPlan(sharedInput({ version: '0.3.200' }), sf()))).toEqual([
      'VERSION_NOT_SHARED'
    ])
  })

  it('refuses a retired, busy or never-deployed deployment', () => {
    for (const [d, code] of [
      [{ status: 'retired' as const }, 'SHARED_RETIRED'],
      [{ status: 'upgrading' as const }, 'SHARED_BUSY'],
      [{ status: 'new' as const, version_pin: null }, 'NOT_DEPLOYED']
    ] as const)
      expect(codes(buildCreationPlan(sharedInput(), sf({ deployment: shared(d) })))).toContain(code)
    expect(codes(buildCreationPlan(sharedInput(), sf({ deployment: null })))).toEqual([
      'BAD_TARGET'
    ])
  })

  it('judges extensions and the pool budget', () => {
    expect(codes(buildCreationPlan(sharedInput({ extensions: ['nope'] }), sf()))).toEqual([
      'EXTENSION_NOT_ALLOWED'
    ])
    expect(codes(buildCreationPlan(sharedInput({ extensions: ['efp-ops'] }), sf()))).toEqual([])
    expect(codes(buildCreationPlan(sharedInput(), sf({ poolUsed: 35 })))).toEqual(['POOL_BUDGET'])
    const pool = (n: number) =>
      sharedInput({ target: { kind: 'shared', shared_id: 4, pool_max: n } })
    expect(codes(buildCreationPlan(pool(1), sf()))).toEqual(['POOL_TOO_SMALL'])
    expect(codes(buildCreationPlan(pool(99), sf()))).toEqual(['BAD_POOL'])
  })

  it('a typed name on a Docker deployment must be routed', () => {
    const typed = sharedInput({
      environments: [
        { key: 'production', hostname: 'orders.example.com', database: { server_id: 2 } }
      ]
    })
    expect(codes(buildCreationPlan(typed, sf()))).toEqual(['NAME_NOT_ROUTED'])
    expect(codes(buildCreationPlan(typed, sf({ routed: ['orders.example.com'] })))).toEqual([])
    const registered = sf({ deployment: shared({ mode: 'registered', host_pattern: null }) })
    expect(codes(buildCreationPlan(typed, registered))).toEqual([])
    // No pattern: the name must be typed.
    expect(codes(buildCreationPlan(sharedInput(), registered))).toEqual([
      'HOSTNAME_REQUIRED',
      'HOSTNAME_REQUIRED'
    ])
  })

  it('refuses an existing database that already holds a Nivaro install', () => {
    const held: HubDatabase = {
      id: 40,
      server_id: 2,
      server_name: 'pg-auto',
      engine: 'pg',
      host: 'pg1.example.com',
      port: 5432,
      database_name: 'nivaro_old',
      login_name: 'old',
      status: 'ready',
      created_by_hub: false,
      adopted: true,
      environment: null,
      last_check: { state: 'nivaro', migrations: 500 }
    } as unknown as HubDatabase
    const i = sharedInput({
      environments: [{ key: 'production', database: { database_id: 40 } }]
    })
    expect(codes(buildCreationPlan(i, { ...sf(), existing: { 40: held } }))).toEqual([
      'DATABASE_HOLDS_NIVARO'
    ])
  })
})
