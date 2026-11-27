import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 11a: providers in Create app and DNS — DNS mode `route53` on Docker drivers and targets
// (config checks, the hosted zone, the record op), the `providers` creation step (Vercel / Auth0
// parts, a route53 name record; carried by the creation, picked up again on a retry), GitHub
// targets and the GitHub creation's repository / variables / deploy steps. SQLite rows + fake
// adapters under the real type keys (hub-providers-hooks-fake.ts).

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
vi.mock('../../../services/hub/db/databases.js', async (orig) => ({
  ...((await orig()) as object),
  getDatabase: vi.fn(async (id: number) => ({
    id,
    engine: 'pg',
    database_name: 'shop_staging',
    status: 'ready',
    created_by_hub: true,
    adopted: false
  })),
  openDatabaseConnection: vi.fn(async () => ({
    engine: 'pg',
    host: 'db.example',
    port: 5432,
    database: 'shop_staging',
    user: 'shop',
    password: 'test-secret-db-password',
    ssl_mode: null,
    trust_server_cert: false
  }))
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const { checkDockerConfig } = await import('../../../services/hub/docker/driver-config.js')
const dns = await import('../../../services/hub/create/dns-route53.js')
const { stepProviders } = await import('../../../services/hub/create/provider-step.js')
const parts = await import('../../../services/hub/create/provider-parts.js')
const ghTarget = await import('../../../services/hub/create/github-target.js')
const ghSteps = await import('../../../services/hub/create/github-steps.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { hostnameFor, baseUrlFor } = await import('../../../services/hub/create/app-config.js')
const { buildCreationPlan } = await import('../../../services/hub/create/plan.js')
const { GITHUB_STEP_ORDER, stepOrderFor } = await import('../../../services/hub/create/types.js')
const { makeFakeWorld } = await import('./hub-providers-hooks-fake.js')

import type { BaseStepContext } from '../../../services/hub/create/steps.js'
import type { CreateAppInput, CreationFacts } from '../../../services/hub/create/types.js'

const MIGRATIONS = [
  '542_hub_tables',
  '543_hub_promotions',
  '544_hub_databases',
  '545_hub_creations',
  '565_hub_release_ops',
  '576_hub_incidents',
  '582_hub_providers',
  '583_hub_provider_hooks'
]

const ADMIN_ID = '0a1b2c3d-0000-4000-8000-0000000000a1'

let world = makeFakeWorld()
let appId: number
let envId: number
let creationId: number
let zoneRow: number
const conn: Record<string, number> = {}

const insertId = async (table: string, row: Record<string, unknown>) => {
  const [id] = await db(table).insert(row)
  return Number(id)
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('status').nullable()
    t.uuid('role').nullable()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.boolean('admin_access').nullable()
  })
  const role = '0a1b2c3d-0000-4000-8000-0000000000f1'
  await db('nivaro_roles').insert({ id: role, admin_access: true })
  await db('nivaro_users').insert({ id: ADMIN_ID, status: 'active', role })
  appId = await insertId('nivaro_hub_apps', {
    key: 'shop',
    name: 'Shop',
    oidc: JSON.stringify({ issuer: 'https://login.example.com/t/v2.0', client_id: 'client-1' }),
    oidc_secret: sealSecret('test-secret-oidc')
  })
  envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'staging',
    position: 0,
    base_url: 'https://shop--staging.apps.example.com',
    hub_token: sealSecret('test-secret-hub-token')
  })
  creationId = await insertId('nivaro_hub_creations', {
    app_id: appId,
    environment_id: envId,
    status: 'running',
    steps: '[]',
    version: '1.4.0',
    first_admin: '{}',
    started_by: ADMIN_ID
  })
  for (const p of ['aws', 'vercel', 'auth0', 'github'])
    conn[p] = (
      await store.createConnection({
        provider: p,
        name: `${p} account`,
        config: {},
        secrets: { token: `test-secret-${p}-token` }
      })
    ).id
  zoneRow = (
    await store.insertResource({
      connection_id: conn.aws,
      provider: 'aws',
      type: 'aws.route53_zone',
      external_id: 'Z1',
      name: 'example.com',
      scope: 'shared',
      observed: {
        type: 'aws.route53_zone',
        externalId: 'Z1',
        name: 'example.com',
        fields: { name: 'example.com' },
        tags: {}
      },
      adopted: true
    } as never)
  ).id
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  world = makeFakeWorld()
  world.seed('aws.route53_zone', 'Z1', { name: 'example.com' })
  registry.resetProvidersForTest()
  for (const a of world.adapters) registry.registerProvider(a)
  locks.resetMemoryResourceLocksForTest()
  deps.resetResourceEngineForTest()
  deps.configureResourceEngine({
    lock: () => locks.memoryResourceLock(),
    inline: true,
    notify: { notify: vi.fn(async () => null), adminBase: () => '', page: null }
  })
  await db('nivaro_hub_resources').whereNot({ id: zoneRow }).del()
  await db('nivaro_hub_resource_changes').del()
  await db('nivaro_hub_deploys').del()
  await db('nivaro_hub_creations').where({ id: creationId }).update({ status: 'running' })
})

function stepCtx(made: Record<string, unknown> = {}): BaseStepContext {
  const ctx = {
    creation: { id: creationId, started_by: ADMIN_ID, version: '1.4.0', job_run_id: null },
    app: {
      id: appId,
      key: 'shop',
      name: 'Shop',
      oidc: { issuer: 'https://login.example.com/t/v2.0', client_id: 'client-1' },
      oidc_secret: sealSecret('test-secret-oidc')
    },
    env: {
      id: envId,
      app_id: appId,
      key: 'staging',
      position: 0,
      status: 'provisioning',
      base_url: 'https://shop--staging.apps.example.com',
      hostnames: ['shop--staging.apps.example.com'],
      hub_token: sealSecret('test-secret-hub-token'),
      db_ref: null,
      placement_id: null
    },
    dnsMode: 'automatic',
    made: { database_id: 7, ...made },
    saveMade: async () => undefined,
    doneSha: () => null,
    log: () => undefined,
    secrets: new Set<string>(),
    deps: { sleep: async () => undefined, repoLock: memoryKeyedLock(), now: Date.now }
  }
  return ctx as unknown as BaseStepContext
}

function memoryKeyedLock() {
  const held = new Map<string, string>()
  return {
    take: async (k: string) => {
      if (held.has(k)) return null
      held.set(k, 't')
      return 't'
    },
    renew: async () => true,
    release: async (k: string) => {
      held.delete(k)
    }
  }
}

// ── DNS ──

describe('DNS mode route53', () => {
  const docker = {
    agent_url: 'https://agent.example.com',
    dns_mode: 'route53',
    wildcard_domain: 'apps.example.com',
    edge_target: '203.0.113.9'
  }

  it('a Docker driver names the hosted zone, the domain and the edge', () => {
    expect(checkDockerConfig({ ...docker, dns_zone_resource_id: 5 })).toMatchObject({
      ok: true,
      config: { dns_mode: 'route53', dns_zone_resource_id: 5 }
    })
    expect(checkDockerConfig(docker)).toMatchObject({ ok: false })
    expect(
      checkDockerConfig({ ...docker, dns_zone_resource_id: 5, edge_target: null })
    ).toMatchObject({
      ok: false
    })
    expect(checkDockerConfig({ ...docker, dns_zone_resource_id: 'x' })).toMatchObject({ ok: false })
    // Other modes keep no zone.
    const auto = checkDockerConfig({ ...docker, dns_mode: 'automatic', dns_zone_resource_id: 5 })
    expect(auto.ok && 'dns_zone_resource_id' in auto.config).toBe(false)
    expect(dns.namesAutomatically('route53')).toBe(true)
    expect(dns.namesAutomatically('manual')).toBe(false)
  })

  it('the zone must be a managed shared zone the names are under; the record is A / CNAME', async () => {
    expect(await dns.route53Zone(zoneRow, 'apps.example.com')).toMatchObject({
      ok: true,
      connectionId: conn.aws,
      zoneName: 'example.com'
    })
    expect(await dns.route53Zone(zoneRow, 'apps.other.org')).toMatchObject({ ok: false })
    expect(await dns.route53Zone(999, 'apps.example.com')).toMatchObject({ ok: false })
    expect(dns.recordOp(zoneRow, 'Shop.apps.example.com.', '203.0.113.9').fields).toMatchObject({
      name: 'shop.apps.example.com',
      record_type: 'A',
      values: ['203.0.113.9']
    })
    expect(dns.recordOp(zoneRow, 'shop.apps.example.com', 'edge.example.com').fields).toMatchObject(
      {
        record_type: 'CNAME',
        values: ['edge.example.com']
      }
    )
  })
})

// ── providers step ──

describe('Create app: the providers step', () => {
  it('checks the parts a request names', () => {
    expect(parts.providerPartsOf(undefined)).toEqual({ ok: true, parts: [] })
    expect(parts.providerPartsOf([{ connection_id: 1, type: 'aws.vpc' }])).toMatchObject({
      ok: false
    })
    expect(parts.providerPartsOf('x')).toMatchObject({ ok: false })
    expect(
      parts.partFields(
        { connection_id: 1, type: 'auth0.application', fields: { name: 'a' } },
        'https://x.example.com/'
      )
    ).toEqual({
      name: 'a',
      callbacks: ['https://x.example.com/api/auth/callback'],
      allowed_logout_urls: ['https://x.example.com'],
      web_origins: ['https://x.example.com'],
      allowed_origins: ['https://x.example.com']
    })
  })

  it('makes the parts and a route53 name record, once, carried by the creation', async () => {
    const list = [
      { connection_id: conn.vercel, type: 'vercel.project', fields: { name: 'shop-web' } },
      { connection_id: conn.auth0, type: 'auth0.application', fields: { name: 'shop-staging' } }
    ]
    const made: Record<string, unknown> = {
      planned: {
        hostname: 'shop--staging.apps.example.com',
        providers_sealed: sealSecret(JSON.stringify(list))
      }
    }
    const naming = {
      dns_mode: 'route53',
      dns_zone_resource_id: zoneRow,
      wildcard_domain: 'apps.example.com',
      edge: '203.0.113.9'
    }
    const ctx = stepCtx(made)
    const out = await stepProviders(ctx, naming)
    expect(out.status).toBe('done')
    expect(world.calls.map((c) => [c.kind, c.type]).sort()).toEqual([
      ['create', 'auth0.application'],
      ['create', 'aws.route53_record'],
      ['create', 'vercel.project']
    ])
    const auth0 = world.things.get(
      (await store.listResources({ type: 'auth0.application' }))[0].external_id as string
    )
    expect(auth0?.fields.callbacks).toEqual([
      'https://shop--staging.apps.example.com/api/auth/callback'
    ])
    const record = (await store.listResources({ type: 'aws.route53_record' }))[0]
    expect(record).toMatchObject({ app_id: appId, environment_id: envId })
    expect(Object.keys(ctx.made.provider_changes ?? {}).sort()).toEqual(
      [String(conn.vercel), String(conn.auth0), String(conn.aws)].sort()
    )
    // A retry makes nothing twice.
    world.calls.length = 0
    expect((await stepProviders(ctx, naming)).status).toBe('done')
    expect(world.calls).toEqual([])
    const plans = await store.listChanges({})
    expect(plans.every((c) => c.plan?.origin?.kind === 'creation')).toBe(true)
  })

  it('a creation that is not running cannot carry a change', async () => {
    await db('nivaro_hub_creations').where({ id: creationId }).update({ status: 'failed' })
    const ctx = stepCtx({
      planned: {
        hostname: 'shop--staging.apps.example.com',
        providers_sealed: sealSecret(
          JSON.stringify([
            { connection_id: conn.vercel, type: 'vercel.project', fields: { name: 'p' } }
          ])
        )
      }
    })
    await expect(stepProviders(ctx, null)).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
    expect(world.calls).toEqual([])
  })
})

// ── GitHub targets and creations ──

describe('GitHub targets', () => {
  const config = {
    template: 'acme/nivaro-template',
    deploy_workflow: 'deploy.yml',
    dns_mode: 'automatic',
    wildcard_domain: 'apps.example.com'
  }

  it('validates a target against a GitHub connection', async () => {
    const ok = await ghTarget.validateGithubTargetInput({
      kind: 'github',
      name: 'GitHub apps',
      connection_id: conn.github,
      config
    })
    expect(ok).toMatchObject({
      ok: true,
      row: {
        kind: 'github',
        connection_id: conn.github,
        config: { visibility: 'private', source_branch: 'main' }
      }
    })
    expect(
      await ghTarget.validateGithubTargetInput({ name: 'x', connection_id: conn.aws, config })
    ).toMatchObject({ ok: false, code: 'BAD_CONNECTION' })
    expect(
      await ghTarget.validateGithubTargetInput({
        name: 'x',
        connection_id: conn.github,
        config: { ...config, deploy_workflow: '../x.yml' }
      })
    ).toMatchObject({ ok: false, code: 'BAD_CONFIG' })
    expect(
      await ghTarget.validateGithubTargetInput({
        name: 'x',
        connection_id: conn.github,
        config: { ...config, token: 'x' }
      })
    ).toMatchObject({ ok: false, code: 'BAD_CONFIG' })
    expect(stepOrderFor('github')).toEqual(GITHUB_STEP_ORDER)
  })

  it('the creation plan takes a GitHub target and the environments’ provider parts', () => {
    const input = {
      key: 'shop',
      name: 'Shop',
      owners: [],
      first_admin: { email: 'ada@example.com' },
      target: { kind: 'github', id: 41 },
      version: '1.4.0',
      signin: { issuer: 'https://login.example.com/t/v2.0', client_id: 'c', client_secret: 's' },
      environments: [
        {
          key: 'staging',
          database: { database_id: 3 },
          providers: [{ connection_id: conn.vercel, type: 'vercel.project', fields: { name: 'w' } }]
        }
      ]
    } as unknown as CreateAppInput
    const facts = {
      keyTaken: false,
      unknownOwners: [],
      target: null,
      servers: {},
      existing: {
        3: {
          id: 3,
          engine: 'pg',
          database_name: 'shop_staging',
          status: 'ready',
          host: 'db',
          server_id: null,
          environment: null
        }
      },
      recordedNames: [],
      takenHostnames: [],
      takenStackNames: [],
      serverHas: {},
      projectExists: false,
      digest: `sha256:${'a'.repeat(64)}`,
      slimDigest: null,
      encryptionKey: true,
      hubUrl: 'https://hub.example.com',
      kind: 'github',
      github: {
        target: {
          id: 41,
          kind: 'github',
          name: 'GitHub apps',
          connection_id: conn.github,
          config: {
            ...config,
            visibility: 'private',
            source_branch: 'main',
            scheme: 'https',
            port: null,
            edge_address: null,
            cert_note: null
          }
        },
        problem: null
      }
    } as unknown as CreationFacts
    const plan = buildCreationPlan(input, facts)
    expect(
      plan.blockers.filter((b) => b.code === 'BAD_TARGET' || b.code === 'BAD_PROVIDER_PART')
    ).toEqual([])
    expect(plan.target).toEqual({ kind: 'github', name: 'GitHub apps' })
    expect(plan.environments[0].providers).toEqual([
      { type: 'vercel.project', connection_id: conn.vercel }
    ])
    expect(plan.lines.join('\n')).toMatch(/GitHub repository shop from acme\/nivaro-template/)
    const bad = buildCreationPlan(
      {
        ...input,
        environments: [
          { ...input.environments[0], providers: [{ connection_id: 0, type: 'vercel.project' }] }
        ]
      } as unknown as CreateAppInput,
      facts
    )
    expect(bad.blockers.map((b) => b.code)).toContain('BAD_PROVIDER_PART')
    const noTarget = buildCreationPlan(input, {
      ...facts,
      github: { target: null, problem: null }
    } as never)
    expect(noTarget.blockers.map((b) => b.code)).toContain('BAD_TARGET')
  })

  it('repository → variables → deploy through the change engine, leaving a promotable environment', async () => {
    const target = (await ghTarget.createGithubTarget({
      kind: 'github',
      name: 'GitHub apps',
      connection_id: conn.github,
      config: {
        template: 'acme/nivaro-template',
        visibility: 'private',
        deploy_workflow: 'deploy.yml',
        source_branch: 'main',
        dns_mode: 'automatic',
        wildcard_domain: 'apps.example.com',
        edge_address: null,
        scheme: 'https',
        port: null,
        cert_note: null
      }
    })) as Awaited<ReturnType<typeof ghTarget.createGithubTarget>>
    const naming = target.config
    const named = hostnameFor(naming as never, 'shop', 'staging', null)
    if (!named.ok) throw new Error(named.message)
    const base = baseUrlFor(naming as never, named.hostname)
    const ctx = Object.assign(
      stepCtx({
        planned: {
          hostname: named.hostname,
          base_url: base,
          hub_url: 'https://hub.example.com',
          digest: `sha256:${'a'.repeat(64)}`,
          slim_digest: null,
          source_branch: 'main',
          nonce: 'n'
        }
      }),
      { github: target }
    ) as Parameters<typeof ghSteps.stepGithubRepository>[0]
    expect((await ghSteps.stepGithubRepository(ctx)).status).toBe('done')
    const repo = (await store.listResources({ type: 'github.repository' }))[0]
    expect(repo).toMatchObject({ app_id: appId, environment_id: null })
    expect(world.things.get(repo.external_id as string)?.fields).toMatchObject({
      name: 'shop',
      template: 'acme/nivaro-template'
    })
    // A second environment's leg finds it made.
    world.calls.length = 0
    expect((await ghSteps.stepGithubRepository(ctx)).status).toBe('done')
    expect(world.calls).toEqual([])

    expect((await ghSteps.stepGithubVariables(ctx)).status).toBe('done')
    const secretNames = (await store.listResources({ type: 'github.actions_secret' })).map((r) =>
      String(r.desired?.name)
    )
    expect(secretNames.sort()).toEqual([
      'NIVARO_DB_URL_B64',
      'NIVARO_ENCRYPTION_KEY_B64',
      'NIVARO_HUB_TOKEN_B64',
      'NIVARO_OIDC_CLIENT_SECRET_B64',
      'NIVARO_SESSION_SECRET_B64'
    ])
    // No plain secret in any stored row.
    const raw = JSON.stringify([
      await db('nivaro_hub_resources').select('*'),
      await db('nivaro_hub_resource_changes').select('*')
    ])
    for (const s of ['test-secret-db-password', 'test-secret-hub-token', 'test-secret-oidc'])
      expect(raw).not.toContain(s)
    // A retry replaces nothing (the first session / encryption keys stay).
    world.calls.length = 0
    expect((await ghSteps.stepGithubVariables(ctx)).status).toBe('done')
    expect(world.calls).toEqual([])

    world.seed('github.workflow', `${repo.external_id}#deploy.yml`, { workflow: 'deploy.yml' })
    expect((await ghSteps.stepGithubDeploy(ctx)).status).toBe('done')
    expect(world.calls.at(-1)).toMatchObject({
      type: 'github.workflow',
      action: 'dispatch',
      data: { ref: 'main', inputs: JSON.stringify({ version: '1.4.0', environment: 'staging' }) }
    })
    const comp = await db('nivaro_hub_components').first()
    expect(comp).toMatchObject({ kind: 'github_actions', driver_id: 0, name: 'api' })
    const wf = (await store.listResources({ type: 'github.workflow' }))[0]
    expect(Number(comp.resource_id)).toBe(wf.id)
    const deploy = await db('nivaro_hub_deploys').first()
    expect(deploy).toMatchObject({ kind: 'promote', status: 'success', version: '1.4.0' })
    expect(JSON.parse(deploy.plan).steps[0]).toMatchObject({
      deployedSha: 'main',
      driver: 'provider'
    })
  })
})
