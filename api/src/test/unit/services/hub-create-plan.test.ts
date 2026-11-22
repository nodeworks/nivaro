import { describe, expect, it } from 'vitest'
import { stackName } from '../../../services/hub/create/app-config.js'
import { buildCreationPlan, hubUrlProblem } from '../../../services/hub/create/plan.js'
import type { HubTargetConfig, HubTargetRow } from '../../../services/hub/create/targets.js'
import {
  type CreateAppInput,
  type CreationFacts,
  STEP_ORDER
} from '../../../services/hub/create/types.js'
import type { HubDatabase } from '../../../services/hub/db/databases.js'
import type { HubDbServerRow, SealedAdminSecret } from '../../../services/hub/db/servers.js'

// Nivaro Hub phase 3: the creation planner. Pure: every fact is given, every blocker code is
// proven here, and the preview carries names only.

const OWNER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OIDC_SECRET = 'oidc-Secr3t-value'
const TOKEN_SEALED = 'enc:v1:sealed-gitlab-token'
const ADMIN_SEALED = 'enc:v1:sealed-admin-login' as SealedAdminSecret

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

const target = (config: Partial<HubTargetConfig> = {}, row: Partial<HubTargetRow> = {}) =>
  ({
    id: 5,
    kind: 'gitlab',
    name: 'apps',
    config: { ...targetConfig, ...config },
    secret: TOKEN_SEALED,
    ...row
  }) as HubTargetRow

const manualServer: HubDbServerRow = {
  id: 1,
  name: 'dba-sql',
  engine: 'mssql',
  host: 'sql1.example.com',
  port: null,
  provision_mode: 'manual',
  ssl_mode: null,
  trust_server_cert: false,
  collation: null,
  user_host: null,
  notes: null,
  admin_secret: null
}
const autoServer: HubDbServerRow = {
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
  admin_secret: ADMIN_SEALED
}
const mysqlServer: HubDbServerRow = {
  ...autoServer,
  id: 3,
  name: 'mysql-auto',
  engine: 'mysql2',
  host: 'my1.example.com',
  port: null,
  ssl_mode: null,
  user_host: '%'
}

function input(over: Partial<CreateAppInput> = {}): CreateAppInput {
  return {
    key: 'demo',
    name: 'Demo',
    owners: [OWNER],
    first_admin: { email: 'ada@example.com', first_name: 'Ada' },
    target_id: 5,
    version: '1.2.3',
    signin: {
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      client_id: 'client-123',
      client_secret: OIDC_SECRET
    },
    environments: [
      { key: 'staging', database: { server_id: 1 } },
      { key: 'production', database: { server_id: 2 } }
    ],
    ...over
  }
}

function facts(over: Partial<CreationFacts> = {}): CreationFacts {
  return {
    keyTaken: false,
    unknownOwners: [],
    target: target(),
    servers: { 1: manualServer, 2: autoServer, 3: mysqlServer },
    existing: {},
    recordedNames: [],
    takenHostnames: [],
    takenStackNames: [],
    serverHas: {
      '2:nivaro_demo_production': false,
      '2:nivaro_demo_staging': false,
      '3:nivaro_demo_production': false
    },
    projectExists: false,
    digest: DIGEST,
    slimDigest: null,
    encryptionKey: true,
    hubUrl: 'https://hub.example.com',
    ...over
  }
}

const existingDb = (over: Partial<HubDatabase> = {}): HubDatabase => ({
  id: 40,
  server_id: 2,
  server_name: 'pg-auto',
  engine: 'pg',
  host: 'pg1.example.com',
  port: 5432,
  database_name: 'nivaro_legacy',
  login_name: 'legacy',
  status: 'ready',
  adopted: true,
  created_by_hub: false,
  last_check: null,
  checked_at: null,
  connection: '••••••',
  environment: null,
  server_tls: null,
  ...over
})

const codes = (p: ReturnType<typeof buildCreationPlan>) => p.blockers.map((b) => b.code)

function expectBlocked(
  code: string,
  i: Partial<CreateAppInput> = {},
  f: Partial<CreationFacts> = {},
  env?: string
) {
  const plan = buildCreationPlan(input(i), facts(f))
  expect(plan.ok).toBe(false)
  expect(codes(plan)).toContain(code)
  if (env) expect(plan.blockers.find((b) => b.code === code)?.env).toBe(env)
  return plan
}

describe('buildCreationPlan — a clean two-environment plan', () => {
  const plan = buildCreationPlan(input(), facts())

  it('has no blockers', () => {
    expect(plan.blockers).toEqual([])
    expect(plan.ok).toBe(true)
    expect(plan.app).toEqual({ key: 'demo', name: 'Demo', project_path: 'apps/demo-deploy' })
  })

  it('staging on a manual server: a DBA request with its checklist', () => {
    const s = plan.environments[0]
    expect(s).toMatchObject({
      key: 'staging',
      position: 0,
      hostname: 'demo--staging.apps.example.com',
      base_url: 'https://demo--staging.apps.example.com',
      dns_mode: 'automatic',
      ticket: null,
      redirect_uri: 'https://demo--staging.apps.example.com/api/auth/callback',
      branch: 'staging',
      source_branch: 'staging',
      stack_name: 'demo--staging'
    })
    expect(s.database).toMatchObject({
      mode: 'manual',
      server_name: 'dba-sql',
      database_name: 'nivaro_demo_staging',
      login_name: 'demo_staging',
      engine: 'mssql'
    })
    expect(s.database.checklist?.some((c) => c.value === 'nivaro_demo_staging')).toBe(true)
  })

  it('production on an automatic server: names, hostname, redirect URI, source branch', () => {
    const p = plan.environments[1]
    expect(p).toMatchObject({
      key: 'production',
      position: 1,
      hostname: 'demo.apps.example.com',
      base_url: 'https://demo.apps.example.com',
      redirect_uri: 'https://demo.apps.example.com/api/auth/callback',
      branch: 'production',
      source_branch: 'staging',
      stack_name: 'demo--production'
    })
    expect(p.database).toEqual({
      mode: 'automatic',
      server_name: 'pg-auto',
      database_name: 'nivaro_demo_production',
      login_name: 'demo_production',
      engine: 'pg',
      checklist: null
    })
  })

  it('carries no secret: no client secret, token, sealed value or password', () => {
    const text = JSON.stringify(plan)
    expect(text).not.toContain(OIDC_SECRET)
    expect(text).not.toContain(TOKEN_SEALED)
    expect(text).not.toContain(ADMIN_SEALED)
    expect(text).not.toContain('enc:')
    expect(text).not.toContain('admin_secret')
    expect(text).not.toContain('client_secret')
    expect(plan.lines.length).toBeGreaterThan(3)
    expect(plan.lines.join('\n')).toContain('nivaro_demo_production')
  })

  it('a blocked plan carries no secret either', () => {
    const bad = buildCreationPlan(
      input({ signin: { issuer: 'ftp://x', client_id: 'a b', client_secret: OIDC_SECRET } }),
      facts({ target: null })
    )
    expect(JSON.stringify(bad)).not.toContain(OIDC_SECRET)
  })

  it('names the step order', () => {
    expect(STEP_ORDER).toEqual([
      'database',
      'repository',
      'variables',
      'config',
      'deploy',
      'name',
      'link',
      'admin'
    ])
  })
})

describe('buildCreationPlan — app blockers', () => {
  it('BAD_KEY (shape, and no "--" inside a key)', () => {
    expectBlocked('BAD_KEY', { key: 'Demo!' })
    expectBlocked('BAD_KEY', { key: 'my--app' })
    expectBlocked('BAD_KEY', { key: 'app-' })
  })
  it('KEY_TAKEN', () => expectBlocked('KEY_TAKEN', {}, { keyTaken: true }))
  it('BAD_NAME', () => {
    expectBlocked('BAD_NAME', { name: '  ' })
    expectBlocked('BAD_NAME', { name: 'x'.repeat(201) })
  })
  it('BAD_OWNER', () => {
    expectBlocked('BAD_OWNER', {}, { unknownOwners: [OWNER] })
    expectBlocked('BAD_OWNER', { owners: 'me' as unknown as string[] })
  })
  it('BAD_EMAIL', () => {
    expectBlocked('BAD_EMAIL', { first_admin: { email: 'not-an-email' } })
    expectBlocked('BAD_EMAIL', {
      first_admin: undefined as unknown as CreateAppInput['first_admin']
    })
  })
  it('BAD_TARGET (missing, wrong id, no token, bad template ref)', () => {
    expectBlocked('BAD_TARGET', {}, { target: null })
    expectBlocked('BAD_TARGET', { target_id: 6 })
    expectBlocked('BAD_TARGET', {}, { target: target({}, { secret: null }) })
    expectBlocked('BAD_TARGET', {}, { target: target({ template_ref: 'main' }) })
  })
  it('BAD_TARGET when the manager host keys do not cover the deploy host', () => {
    const plan = expectBlocked(
      'BAD_TARGET',
      {},
      {
        target: target({
          manager_known_hosts: `other.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`
        })
      }
    )
    expect(plan.blockers.find((b) => b.code === 'BAD_TARGET')?.text).toMatch(/host key/i)
    expectBlocked('BAD_TARGET', {}, { target: target({ manager_known_hosts: '' }) })
  })
  it('BAD_VERSION', () => expectBlocked('BAD_VERSION', { version: 'latest' }))
  it('IMAGE_MISSING / IMAGE_NO_DIGEST', () => {
    expectBlocked('IMAGE_MISSING', {}, { digest: null })
    expectBlocked('IMAGE_NO_DIGEST', {}, { digest: 'present' })
  })
  it('BAD_SIGNIN', () => {
    const s = input().signin
    expectBlocked('BAD_SIGNIN', { signin: { ...s, issuer: 'http://login.example.com/t' } })
    expectBlocked('BAD_SIGNIN', { signin: { ...s, client_id: 'a b' } })
    expectBlocked('BAD_SIGNIN', { signin: { ...s, client_secret: '' } })
    expectBlocked('BAD_SIGNIN', { signin: undefined as unknown as CreateAppInput['signin'] })
  })
  it('EXTENSIONS_UNSUPPORTED', () =>
    expectBlocked('EXTENSIONS_UNSUPPORTED', { extensions: ['efp-ops'] }))
  it('NO_ENVIRONMENTS / TOO_MANY_ENVIRONMENTS', () => {
    expectBlocked('NO_ENVIRONMENTS', { environments: [] })
    const seven = ['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1'].map((key) => ({
      key,
      database: { server_id: 1 }
    }))
    expectBlocked('TOO_MANY_ENVIRONMENTS', { environments: seven })
  })
  it('PROJECT_EXISTS / GITLAB_UNREACHABLE', () => {
    expectBlocked('PROJECT_EXISTS', {}, { projectExists: true })
    expectBlocked('GITLAB_UNREACHABLE', {}, { projectExists: 'unreachable' })
  })
  it('NEEDS_ENCRYPTION_KEY', () =>
    expectBlocked('NEEDS_ENCRYPTION_KEY', {}, { encryptionKey: false }))
  it('NO_HUB_URL (none, plain http elsewhere, a local Hub for remote apps)', () => {
    expectBlocked('NO_HUB_URL', {}, { hubUrl: null })
    expectBlocked('NO_HUB_URL', {}, { hubUrl: 'http://hub.example.com' })
    expectBlocked('NO_HUB_URL', {}, { hubUrl: 'http://localhost:3056' })
    // X-7: the words name what the Hub reads now (X-5: HUB_URL, else PUBLIC_URL).
    for (const t of [hubUrlProblem(null, []), hubUrlProblem('not a url', [])]) {
      expect(t).toContain('HUB_URL, else PUBLIC_URL')
      expect(t).not.toContain('ADMIN_URL')
    }
  })
})

describe('buildCreationPlan — environment blockers', () => {
  it('BAD_ENV_KEY / DUPLICATE_ENV', () => {
    expectBlocked('BAD_ENV_KEY', {
      environments: [{ key: 'Prod', database: { server_id: 1 } }]
    })
    expectBlocked('BAD_ENV_KEY', {
      environments: [{ key: 'pre--prod', database: { server_id: 1 } }]
    })
    expectBlocked('DUPLICATE_ENV', {
      environments: [
        { key: 'staging', database: { server_id: 1 } },
        { key: 'staging', database: { server_id: 1, database_name: 'nivaro_other' } }
      ]
    })
  })

  it('BAD_SERVER (unknown, automatic without login, bad collation, bad user host)', () => {
    expectBlocked('BAD_SERVER', {
      environments: [{ key: 'production', database: { server_id: 99 } }]
    })
    expectBlocked(
      'BAD_SERVER',
      {},
      { servers: { 1: manualServer, 2: { ...autoServer, admin_secret: null } } },
      'production'
    )
    expectBlocked(
      'BAD_SERVER',
      {},
      { servers: { 1: { ...manualServer, collation: "Latin1'; DROP" }, 2: autoServer } },
      'staging'
    )
    expectBlocked(
      'BAD_SERVER',
      { environments: [{ key: 'production', database: { server_id: 3 } }] },
      { servers: { 3: { ...mysqlServer, user_host: "x'@'%" } } }
    )
  })

  it('SERVER_UNREACHABLE (probe failed, or never probed)', () => {
    expectBlocked(
      'SERVER_UNREACHABLE',
      {},
      { serverHas: { '2:nivaro_demo_production': 'unreachable' } },
      'production'
    )
    expectBlocked('SERVER_UNREACHABLE', {}, { serverHas: {} }, 'production')
  })

  it('DATABASE_NAME_INVALID (unsafe, reserved, login too long for the engine)', () => {
    expectBlocked('DATABASE_NAME_INVALID', {
      environments: [{ key: 'staging', database: { server_id: 1, database_name: "x'; drop" } }]
    })
    expectBlocked('DATABASE_NAME_INVALID', {
      environments: [{ key: 'staging', database: { server_id: 1, database_name: 'master' } }]
    })
    expectBlocked('DATABASE_NAME_INVALID', {
      environments: [
        { key: 'production', database: { server_id: 3, login_name: `l${'x'.repeat(40)}` } }
      ]
    })
    expectBlocked('DATABASE_NAME_INVALID', {
      environments: [{ key: 'staging', database: { server_id: 1, login_name: 'sa' } }]
    })
    // P3-32: names the engine itself reserves are refused in the plan, not at CREATE.
    expectBlocked('DATABASE_NAME_INVALID', {
      environments: [{ key: 'staging', database: { server_id: 1, login_name: 'db_owner' } }]
    })
    expectBlocked('DATABASE_NAME_INVALID', {
      environments: [{ key: 'production', database: { server_id: 2, login_name: 'current_user' } }]
    })
    expectBlocked('DATABASE_NAME_INVALID', {
      environments: [{ key: 'production', database: { server_id: 2, login_name: 'session_user' } }]
    })
  })

  it('a default login an engine reserves is prefixed (app current, env user on Postgres)', () => {
    const plan = buildCreationPlan(
      input({ key: 'current', environments: [{ key: 'user', database: { server_id: 2 } }] }),
      facts({ serverHas: { '2:nivaro_current_user': false } })
    )
    expect(plan.environments[0].database.login_name).toBe('u_current_user')
  })

  it('a default login that would be reserved (app key pg / mysql) is prefixed, not refused', () => {
    const pg = buildCreationPlan(
      input({ key: 'pg', environments: [{ key: 'production', database: { server_id: 2 } }] }),
      facts({ serverHas: { '2:nivaro_pg_production': false } })
    )
    expect(pg.blockers).toEqual([])
    expect(pg.environments[0].database.login_name).toBe('u_pg_production')
    const my = buildCreationPlan(
      input({ key: 'mysql', environments: [{ key: 'production', database: { server_id: 3 } }] }),
      facts({ serverHas: { '3:nivaro_mysql_production': false } })
    )
    expect(my.blockers).toEqual([])
    expect(my.environments[0].database.login_name).toBe('u_mysql_production')
  })

  it('MySQL default logins stay within maxLoginLength', () => {
    const key = `a${'b'.repeat(40)}`
    const plan = buildCreationPlan(
      input({
        key,
        environments: [{ key: 'production', database: { server_id: 3 } }]
      }),
      facts({ serverHas: { [`3:nivaro_${key}_production`]: false } })
    )
    expect(codes(plan)).not.toContain('DATABASE_NAME_INVALID')
    expect(plan.environments[0].database.login_name?.length).toBeLessThanOrEqual(32)
  })

  it('DATABASE_RECORDED (already a Hub row, or twice in this request)', () => {
    expectBlocked(
      'DATABASE_RECORDED',
      {},
      { recordedNames: [{ host: 'PG1.example.com', database_name: 'NIVARO_DEMO_PRODUCTION' }] },
      'production'
    )
    expectBlocked('DATABASE_RECORDED', {
      environments: [
        { key: 'staging', database: { server_id: 1, database_name: 'nivaro_shared' } },
        { key: 'production', database: { server_id: 1, database_name: 'nivaro_shared' } }
      ]
    })
    expectBlocked('DATABASE_RECORDED', {
      environments: [
        { key: 'staging', database: { server_id: 1, login_name: 'demo_app' } },
        { key: 'production', database: { server_id: 1, login_name: 'demo_app' } }
      ]
    })
  })

  it('DATABASE_EXISTS (automatic server already holds the name)', () =>
    expectBlocked(
      'DATABASE_EXISTS',
      {},
      { serverHas: { '2:nivaro_demo_production': true } },
      'production'
    ))

  it('DATABASE_IN_USE / DATABASE_NOT_READY (existing databases)', () => {
    const one = [{ key: 'production', database: { database_id: 40 } }]
    expectBlocked(
      'DATABASE_IN_USE',
      { environments: one },
      {
        existing: {
          40: existingDb({ environment: { id: 1, app_id: 1, app_key: 'x', env_key: 'y' } })
        }
      }
    )
    expectBlocked(
      'DATABASE_IN_USE',
      {
        environments: [
          { key: 'staging', database: { database_id: 40 } },
          { key: 'production', database: { database_id: 40 } }
        ]
      },
      { existing: { 40: existingDb() } }
    )
    expectBlocked(
      'DATABASE_NOT_READY',
      { environments: one },
      { existing: { 40: existingDb({ status: 'requested' }) } }
    )
    expectBlocked('DATABASE_NOT_READY', { environments: one }, { existing: {} })
  })

  it('an existing ready database is planned as existing', () => {
    const plan = buildCreationPlan(
      input({ environments: [{ key: 'production', database: { database_id: 40 } }] }),
      facts({ existing: { 40: existingDb() } })
    )
    expect(plan.blockers).toEqual([])
    expect(plan.environments[0].database).toEqual({
      mode: 'existing',
      server_name: 'pg-auto',
      database_name: 'nivaro_legacy',
      login_name: 'legacy',
      engine: 'pg',
      checklist: null
    })
  })

  it('an existing database holding a Nivaro install is a plain warning, never a blocker (P3-32)', () => {
    const plain = buildCreationPlan(
      input({ environments: [{ key: 'production', database: { database_id: 40 } }] }),
      facts({ existing: { 40: existingDb() } })
    )
    expect(plain.warnings).toEqual([])
    const plan = buildCreationPlan(
      input({ environments: [{ key: 'production', database: { database_id: 40 } }] }),
      facts({
        existing: {
          40: existingDb({
            last_check: {
              state: 'nivaro',
              ok: true,
              version: '16.2',
              migrations: 545,
              last_migration: '545_hub_creations',
              text: 'Connected. The database holds a Nivaro install.',
              at: '2026-11-21T10:00:00.000Z'
            }
          })
        }
      })
    )
    expect(plan.blockers).toEqual([])
    expect(plan.ok).toBe(true)
    expect(plan.warnings).toEqual([
      'production: nivaro_legacy already holds a Nivaro install (545 migrations, last 545_hub_creations): the app starts on that data and its users, and the first administrator is made only if it has none. Make sure no other app still uses it.'
    ])
  })

  it('HOSTNAME_REQUIRED / ticket on a manual target', () => {
    const manualTarget = target({ dns_mode: 'manual', wildcard_domain: null, edge_address: 'lb1' })
    expectBlocked('HOSTNAME_REQUIRED', {}, { target: manualTarget }, 'staging')
    const plan = buildCreationPlan(
      input({
        environments: [
          { key: 'staging', hostname: 'demo-stg.corp.example.com', database: { server_id: 1 } },
          { key: 'production', hostname: 'Demo.Corp.Example.com.', database: { server_id: 2 } }
        ]
      }),
      facts({ target: manualTarget })
    )
    expect(plan.blockers).toEqual([])
    expect(plan.environments[1].hostname).toBe('demo.corp.example.com')
    expect(plan.environments[1].dns_mode).toBe('manual')
    expect(plan.environments[1].ticket).toContain('demo.corp.example.com')
    expect(plan.environments[1].ticket).toContain('lb1')
  })

  it('HOSTNAME_INVALID (not a name; plain http outside localhost / .test)', () => {
    expectBlocked('HOSTNAME_INVALID', {
      environments: [{ key: 'staging', hostname: 'not a host', database: { server_id: 1 } }]
    })
    const httpManual = target({ dns_mode: 'manual', wildcard_domain: null, scheme: 'http' })
    expectBlocked(
      'HOSTNAME_INVALID',
      {
        environments: [
          { key: 'staging', hostname: 'demo.corp.example.com', database: { server_id: 1 } }
        ]
      },
      { target: httpManual }
    )
    expectBlocked('HOSTNAME_INVALID', {}, { target: target({ scheme: 'http' }) }, 'staging')
    const local = buildCreationPlan(
      input(),
      facts({
        target: target({ scheme: 'http', wildcard_domain: 'apps.test' }),
        hubUrl: 'http://hub.test'
      })
    )
    expect(local.blockers).toEqual([])
    expect(local.environments[1].base_url).toBe('http://demo.apps.test')
    const ok = buildCreationPlan(
      input({
        environments: [{ key: 'staging', hostname: 'demo.test', database: { server_id: 1 } }]
      }),
      facts({ target: httpManual, hubUrl: 'http://hub.test' })
    )
    expect(ok.blockers).toEqual([])
    expect(ok.environments[0].base_url).toBe('http://demo.test')
  })

  it('HOSTNAME_OUTSIDE_WILDCARD', () =>
    expectBlocked('HOSTNAME_OUTSIDE_WILDCARD', {
      environments: [{ key: 'staging', hostname: 'demo.other.com', database: { server_id: 1 } }]
    }))

  it('HOSTNAME_TAKEN: another environment, this request, the Hub itself', () => {
    expectBlocked('HOSTNAME_TAKEN', {}, { takenHostnames: ['DEMO.apps.example.com'] }, 'production')
    expectBlocked('HOSTNAME_TAKEN', {
      environments: [
        { key: 'staging', hostname: 'x.apps.example.com', database: { server_id: 1 } },
        { key: 'production', hostname: 'x.apps.example.com', database: { server_id: 2 } }
      ]
    })
    expectBlocked(
      'HOSTNAME_TAKEN',
      {
        environments: [
          { key: 'production', hostname: 'hub.apps.example.com', database: { server_id: 2 } }
        ]
      },
      { hubUrl: 'https://hub.apps.example.com' }
    )
  })

  it('STACK_NAME_TAKEN when another environment already deploys the same stack', () =>
    expectBlocked(
      'STACK_NAME_TAKEN',
      {},
      { takenStackNames: [stackName('demo', 'production')] },
      'production'
    ))
})

describe('buildCreationPlan — review minors (Task 9 fold-in)', () => {
  it('IMAGE_MISSING says Docker Hub may not have answered', () => {
    const plan = expectBlocked('IMAGE_MISSING', {}, { digest: null })
    expect(plan.blockers.find((b) => b.code === 'IMAGE_MISSING')?.text).toBe(
      'The image for 1.2.3 is not on Docker Hub, or Docker Hub did not answer.'
    )
  })

  it('a bad app key: no probe verdict and no default-login refusal, only BAD_KEY', () => {
    // gather.ts never probes with a bad key, so serverHas holds nothing for these names.
    const plan = buildCreationPlan(
      input({
        key: 'Bad Key!',
        environments: [
          { key: 'production', database: { server_id: 2, database_name: 'nivaro_named' } }
        ]
      }),
      facts({ serverHas: {} })
    )
    expect(codes(plan)).toContain('BAD_KEY')
    expect(codes(plan)).not.toContain('SERVER_UNREACHABLE')
    expect(codes(plan)).not.toContain('DATABASE_NAME_INVALID')
  })

  it('a bad app key still checks a login typed for the environment', () => {
    const plan = buildCreationPlan(
      input({
        key: 'Bad Key!',
        environments: [
          {
            key: 'production',
            database: { server_id: 2, database_name: 'nivaro_named', login_name: 'Bad Login' }
          }
        ]
      }),
      facts({ serverHas: {} })
    )
    expect(codes(plan)).toContain('DATABASE_NAME_INVALID')
  })

  it('a stack name past 40 characters is hashed and planned', () => {
    const key = `a${'b'.repeat(30)}`
    const envKey = 'production-eu-west'
    const plan = buildCreationPlan(
      input({ key, environments: [{ key: envKey, database: { server_id: 1 } }] }),
      facts()
    )
    const stack = plan.environments[0].stack_name as string
    expect(`${key}--${envKey}`.length).toBeGreaterThan(40)
    expect(stack).toBe(stackName(key, envKey))
    expect(stack.length).toBeLessThanOrEqual(40)
    expect(stack).toMatch(/-[0-9a-f]{4}$/)
    expect(codes(plan)).not.toContain('STACK_NAME_TAKEN')
  })

  it('the same stack twice in one request is STACK_NAME_TAKEN on the second', () => {
    const plan = buildCreationPlan(
      input({
        environments: [
          { key: 'production', database: { server_id: 1 } },
          { key: 'production', database: { server_id: 1, database_name: 'nivaro_other_name' } }
        ]
      }),
      facts()
    )
    expect(codes(plan)).toContain('DUPLICATE_ENV')
    const stack = plan.blockers.filter((b) => b.code === 'STACK_NAME_TAKEN')
    expect(stack).toHaveLength(1)
    expect(stack[0].env).toBe('production')
  })
})
