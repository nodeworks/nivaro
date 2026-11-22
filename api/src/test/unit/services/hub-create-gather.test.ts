import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatherCreationDeps } from '../../../services/hub/create/gather.js'
import type { HubTargetConfig } from '../../../services/hub/create/targets.js'
import type { CreateAppInput } from '../../../services/hub/create/types.js'

// Nivaro Hub phase 3: gathering the creation planner's facts. Real SQLite for apps, environments,
// database servers and rows, targets; the remote looks (Docker Hub, GitLab, the database server)
// are injected.

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
const m544 = await import('../../../db/migrations/544_hub_databases.js')
const m545 = await import('../../../db/migrations/545_hub_creations.js')
const { gatherCreationFacts, hubUrlFrom } = await import('../../../services/hub/create/gather.js')
const { buildCreationPlan, MAX_CREATE_ENVIRONMENTS } = await import(
  '../../../services/hub/create/plan.js'
)
const { stackName } = await import('../../../services/hub/create/app-config.js')

const OWNER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const DIGEST = `sha256:${'a'.repeat(64)}`

const targetConfig: HubTargetConfig = {
  api: 'https://gitlab.example.com',
  namespace: 'apps',
  template_project: 'apps/nivaro-template',
  template_ref: 'v1.0.0',
  pin_file: '.hub/nivaro-version',
  deploy_job: 'deploy',
  deploy_host: 'deploy@swarm1.example.com',
  manager_known_hosts: `swarm1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`,
  proxy_network: 'proxy',
  dns_mode: 'automatic',
  wildcard_domain: 'apps.example.com',
  edge_address: null,
  scheme: 'https',
  port: null,
  cert_note: null
}

let targetId: number
let manualId: number
let autoId: number

const ENV = {
  HUB_URL: 'https://hub.example.com',
  ADMIN_URL: 'https://admin-hub.example.com',
  PUBLIC_URL: 'https://hub.example.com'
} as unknown as NodeJS.ProcessEnv

function input(over: Partial<CreateAppInput> = {}): CreateAppInput {
  return {
    key: 'demo',
    name: 'Demo',
    owners: [OWNER],
    first_admin: { email: 'ada@example.com' },
    target_id: targetId,
    version: '1.2.3',
    signin: { issuer: 'https://login.example.com/t/v2.0', client_id: 'c1', client_secret: 'x' },
    environments: [
      { key: 'staging', database: { server_id: manualId, database_name: 'nivaro_dba_named' } },
      { key: 'production', database: { server_id: autoId } }
    ],
    ...over
  }
}

const insertId = async (table: string, row: Record<string, unknown>) => {
  await db(table).insert(row)
  return Number((await db(table).max('id as id').first())?.id)
}

beforeAll(async () => {
  await m542.up(db)
  await m543.up(db)
  await m544.up(db)
  await m545.up(db)
  if (!(await db.schema.hasTable('nivaro_users')))
    await db.schema.createTable('nivaro_users', (t) => t.uuid('id').primary())
  await db('nivaro_users').insert({ id: OWNER })
  targetId = await insertId('nivaro_hub_targets', {
    kind: 'gitlab',
    name: 'apps',
    config: JSON.stringify(targetConfig),
    secret: 'enc:v1:token'
  })
  manualId = await insertId('nivaro_hub_db_servers', {
    name: 'dba-sql',
    engine: 'mssql',
    host: 'sql1.example.com',
    provision_mode: 'manual'
  })
  autoId = await insertId('nivaro_hub_db_servers', {
    name: 'pg-auto',
    engine: 'pg',
    host: 'pg1.example.com',
    provision_mode: 'automatic',
    admin_secret: 'enc:v1:admin'
  })
  const other = await insertId('nivaro_hub_apps', { key: 'other', name: 'Other' })
  await db('nivaro_hub_environments').insert([
    {
      app_id: other,
      key: 'production',
      position: 0,
      base_url: 'https://other-base.example.com:8443',
      hostnames: JSON.stringify(['Other.apps.example.com', 'alias.example.com'])
    },
    { app_id: other, key: 'staging', position: 1, base_url: 'https://other-stg.example.com' }
  ])
  await db('nivaro_hub_databases').insert({
    server_id: autoId,
    engine: 'pg',
    host: 'pg1.example.com',
    database_name: 'nivaro_other_production',
    status: 'ready'
  })
})

afterAll(async () => {
  await db.destroy()
})

let looks: Array<{ server: string; name: string }>
beforeEach(() => {
  looks = []
})

const deps = (over: Partial<GatherCreationDeps> = {}): GatherCreationDeps => ({
  env: ENV,
  imageDigest: async (_image: string, tag: string) => (tag.endsWith('-slim') ? null : DIGEST),
  projectExists: async () => false,
  databaseExists: async (server: { name: string }, name: string) => {
    looks.push({ server: server.name, name })
    return false
  },
  encryptionKey: () => true,
  timeoutMs: 50,
  ...over
})

describe('gatherCreationFacts', () => {
  it('collects every environment hostname, base host and the Hub own hosts (lower case)', async () => {
    const f = await gatherCreationFacts(input(), deps())
    expect(f.takenHostnames).toEqual(
      expect.arrayContaining([
        'other.apps.example.com',
        'alias.example.com',
        'other-base.example.com',
        'other-stg.example.com',
        'hub.example.com',
        'admin-hub.example.com'
      ])
    )
    expect(f.takenStackNames).toEqual(
      expect.arrayContaining([stackName('other', 'production'), stackName('other', 'staging')])
    )
    expect(f.recordedNames).toEqual([
      { host: 'pg1.example.com', database_name: 'nivaro_other_production' }
    ])
    expect(f.hubUrl).toBe('https://hub.example.com')
    expect(f.keyTaken).toBe(false)
    expect(f.unknownOwners).toEqual([])
    expect(f.target?.id).toBe(targetId)
    expect(Object.keys(f.servers).map(Number).sort()).toEqual([manualId, autoId].sort())
    expect(f.digest).toBe(DIGEST)
    expect(f.slimDigest).toBeNull()
    expect(f.projectExists).toBe(false)
  })

  it('looks names up only on automatic servers, never a manual or invalid name', async () => {
    const f = await gatherCreationFacts(
      input({
        environments: [
          { key: 'staging', database: { server_id: manualId, database_name: 'nivaro_dba_named' } },
          { key: 'test', database: { server_id: autoId, database_name: "x'; drop database y" } },
          { key: 'production', database: { server_id: autoId } }
        ]
      }),
      deps()
    )
    expect(looks).toEqual([{ server: 'pg-auto', name: 'nivaro_demo_production' }])
    expect(f.serverHas).toEqual({ [`${autoId}:nivaro_demo_production`]: false })
  })

  it('probes at most MAX_CREATE_ENVIRONMENTS + 1 environments', async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({
      key: `env${n}`,
      database: { server_id: autoId }
    }))
    await gatherCreationFacts(input({ environments: many }), deps())
    expect(looks).toHaveLength(MAX_CREATE_ENVIRONMENTS + 1)
  })

  it('a failing or hanging server look is unreachable', async () => {
    const thrown = await gatherCreationFacts(
      input(),
      deps({
        databaseExists: async () => {
          throw new Error('login failed for user hubadmin password Secr3t')
        }
      })
    )
    expect(thrown.serverHas[`${autoId}:nivaro_demo_production`]).toBe('unreachable')
    expect(JSON.stringify(thrown)).not.toContain('Secr3t')
    const hung = await gatherCreationFacts(
      input(),
      deps({ databaseExists: () => new Promise(() => {}) })
    )
    expect(hung.serverHas[`${autoId}:nivaro_demo_production`]).toBe('unreachable')
  })

  it('GitLab failure is unreachable; a project at the path is reported', async () => {
    const down = await gatherCreationFacts(
      input(),
      deps({
        projectExists: async () => {
          throw new Error('ECONNRESET')
        }
      })
    )
    expect(down.projectExists).toBe('unreachable')
    let asked = ''
    const there = await gatherCreationFacts(
      input(),
      deps({
        projectExists: async (_t: unknown, path: string) => {
          asked = path
          return true
        }
      })
    )
    expect(there.projectExists).toBe(true)
    expect(asked).toBe('apps/demo-deploy')
  })

  it('key taken, unknown owners, missing target', async () => {
    const f = await gatherCreationFacts(
      input({
        key: 'other',
        owners: [OWNER, 'not-a-uuid', '00000000-0000-4000-8000-000000000000'],
        target_id: 999
      }),
      deps()
    )
    expect(f.keyTaken).toBe(true)
    expect(f.unknownOwners.sort()).toEqual(['00000000-0000-4000-8000-000000000000', 'not-a-uuid'])
    expect(f.target).toBeNull()
  })

  it('X-5: hubUrlFrom is hubPublicOrigin — HUB_URL by the one rule, else the PUBLIC_URL origin', () => {
    const at = (e: Record<string, string>) => hubUrlFrom(e as never)
    expect(at({ PUBLIC_URL: 'https://p/x', ADMIN_URL: 'https://a' })).toBe('https://p')
    // ADMIN_URL is never what apps are told.
    expect(at({ ADMIN_URL: 'https://a' })).toBe('http://localhost:3055')
    expect(at({ HUB_URL: 'https://hub.example.com/', ADMIN_URL: 'https://a' })).toBe(
      'https://hub.example.com'
    )
    for (const bad of ['https://hub.example.com/hub', 'https://u:p@hub.example.com', 'ftp://hub'])
      expect(at({ HUB_URL: bad, PUBLIC_URL: 'https://p' })).toBe('https://p')
    expect(
      at({ HUB_URL: 'http://localhost:3100', NODE_ENV: 'production', PUBLIC_URL: 'https://p' })
    ).toBe('https://p')
  })

  it('gather + plan: a name another environment or the Hub holds is HOSTNAME_TAKEN', async () => {
    const i = input({
      environments: [
        { key: 'staging', hostname: 'other.apps.example.com', database: { server_id: manualId } },
        { key: 'production', database: { server_id: autoId } }
      ]
    })
    const taken = buildCreationPlan(i, await gatherCreationFacts(i, deps()))
    expect(taken.blockers.map((b) => [b.code, b.env])).toContainEqual(['HOSTNAME_TAKEN', 'staging'])

    const hubHost = input({
      environments: [
        { key: 'production', hostname: 'hub.apps.example.com', database: { server_id: autoId } }
      ]
    })
    const plan = buildCreationPlan(
      hubHost,
      await gatherCreationFacts(
        hubHost,
        deps({ env: { HUB_URL: 'https://hub.apps.example.com' } as never })
      )
    )
    expect(plan.blockers.map((b) => b.code)).toContain('HOSTNAME_TAKEN')
  })

  it('gather + plan: the clean request plans with no blockers', async () => {
    const i = input()
    const plan = buildCreationPlan(i, await gatherCreationFacts(i, deps()))
    expect(plan.blockers).toEqual([])
    expect(plan.environments.map((e) => e.hostname)).toEqual([
      'demo--staging.apps.example.com',
      'demo.apps.example.com'
    ])
  })
})
