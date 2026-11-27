import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 33 (Wave 2 flow hooks), against real SQLite rows (Hub migrations up to 584) and fake
// adapters under the real type keys (sentry.project, entra.app_registration / client_secret) plus
// two fake senders (one that mails people, one that threads):
//  - a promotion records a Sentry release on the app's projects, carried by the promotion;
//  - Create app's Entra part makes the registration + its secret and binds them to the stack
//    (OIDC_CLIENT_ID setting, OIDC_CLIENT_SECRET secret), written once the stack settings exist;
//  - a successful run that applied a rotated secret fires the one-shot `remove_older`;
//  - notify: route audience for email senders (own list wins), durable thread memory, incident
//    updates and deploy failures under their dedup keys (a later success resolves the failure).

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const bindings = await import('../../../services/hub/providers/engine/bindings.js')
const notify = await import('../../../services/hub/providers/notify.js')
const { hubNotifyDeployClosed } = await import('../../../services/hub/providers/notify-hook.js')
const { notifyIncidentUpdate } = await import('../../../services/hub/incident/incidents.js')
const release = await import('../../../services/hub/providers/hooks/promote-release.js')
const cleanup = await import('../../../services/hub/providers/hooks/secret-cleanup.js')
const parts = await import('../../../services/hub/create/provider-parts.js')
const { stepProviders } = await import('../../../services/hub/create/provider-step.js')
const { pushEnvBindings } = await import('../../../services/hub/create/docker-steps.js')
const stack = await import('../../../services/hub/docker/stack-settings.js')
const { sealSecret, openSecret } = await import('../../../services/hub/secrets.js')

import type { BaseStepContext } from '../../../services/hub/create/steps.js'
import type {
  DesiredResource,
  FieldSpec,
  Observed,
  OpResult,
  OutboundMessage,
  PlannedOp,
  ProviderAdapter,
  ResourceTypeSpec
} from '../../../services/hub/providers/types.js'

const MIGRATIONS = [
  '542_hub_tables',
  '543_hub_promotions',
  '544_hub_databases',
  '545_hub_creations',
  '546_hub_stack_settings',
  '565_hub_release_ops',
  '570_hub_people_owner_policy',
  '576_hub_incidents',
  '582_hub_providers',
  '583_hub_provider_hooks',
  '584_hub_provider_bindings'
]

const ADMIN_ID = '0a1b2c3d-0000-4000-8000-0000000000a1'
const ADMIN2_ID = '0a1b2c3d-0000-4000-8000-0000000000a2'
const OWNER_ID = '0a1b2c3d-0000-4000-8000-0000000000b1'
const MACHINE_ID = '0a1b2c3d-0000-4000-8000-0000000000c1'
const ADMIN = { id: ADMIN_ID, isAdmin: true }
const ENTRA_SECRET_VALUE = 'test-secret-entra-client-secret-1'

// ── Fakes ──

interface Thing {
  type: string
  fields: Record<string, unknown>
}
interface Call {
  kind: string
  type: string
  action?: string
  ext: string | null
  fields: Record<string, unknown>
}

const f = (key: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  key,
  label: key,
  kind: 'string',
  ...extra
})
const caps = {
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false
}
const spec = (key: string, fields: FieldSpec[], over: Partial<ResourceTypeSpec> = {}) =>
  ({
    key,
    label: key,
    scope: 'app',
    fields,
    capabilities: caps,
    reversible: true,
    refs: [],
    risk: (op: PlannedOp) =>
      op.kind === 'delete' || op.action === 'remove_older' ? ['destructive'] : [],
    ...over
  }) as ResourceTypeSpec

const TRIGGERS = new Set(['record_release', 'remove_older', 'rotate_outputs'])

function world() {
  const things = new Map<string, Thing>()
  const calls: Call[] = []
  let n = 0
  const observedOf = (id: string): Observed | null => {
    const t = things.get(id)
    return t
      ? {
          type: t.type,
          externalId: id,
          name: String(t.fields.name ?? id),
          fields: { ...t.fields },
          tags: {}
        }
      : null
  }
  const plain = (d: DesiredResource) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(d.fields))
      if (!TRIGGERS.has(k) && k !== 'application') out[k] = v
    return out
  }
  function adapter(key: string, types: ResourceTypeSpec[], extra: Partial<ProviderAdapter> = {}) {
    const a: ProviderAdapter = {
      key,
      label: key,
      connection: {
        fields: [{ key: 'token', label: 'Token', kind: 'string', secret: true }],
        hosts: () => [`api.${key}.example`],
        describe: () => key
      },
      types,
      testConnection: async () => ({ ok: true, identity: key, permissions: [], missing: [] }),
      observe: async (_c, _t, id) => observedOf(id),
      list: async () => ({ items: [], cursor: null }),
      plan(_ctx, desired, observed): PlannedOp[] {
        const base = (o: Partial<PlannedOp>): PlannedOp => ({
          kind: 'noop',
          type: (desired?.type ?? observed?.type) as string,
          resourceId: desired?.resourceId ?? null,
          externalId: observed?.externalId ?? null,
          reason: 'x',
          changes: [],
          preconditions: {},
          risk: [],
          ...o
        })
        if (!desired) return observed ? [base({ kind: 'delete' })] : []
        if (!observed) return [base({ kind: 'create' })]
        if (desired.fields.record_release === true)
          return [
            base({
              kind: 'update',
              action: 'release',
              changes: [{ field: 'record_release', from: false, to: true }],
              data: {
                version: desired.fields.release_version,
                environment: desired.fields.release_environment
              }
            })
          ]
        if (desired.fields.remove_older === true)
          return [
            base({
              kind: 'update',
              action: 'remove_older',
              changes: [{ field: 'remove_older', to: true }],
              data: { $oneShot: ['remove_older'] }
            })
          ]
        return []
      },
      async apply(_ctx, op, desired): Promise<OpResult> {
        calls.push({
          kind: op.kind,
          type: op.type,
          ...(op.action ? { action: op.action } : {}),
          ext: op.externalId,
          fields: { ...(desired?.fields ?? {}) }
        })
        if (op.kind === 'create') {
          const id = `${op.type}-${++n}`
          const fields = plain(desired as DesiredResource)
          if (op.type === 'entra.client_secret') fields.older_secrets = []
          things.set(id, { type: op.type, fields })
          const outputs: Record<string, string> | undefined =
            op.type === 'entra.app_registration'
              ? { client_id: `cid-${n}`, tenant_id: 'tenant-1' }
              : op.type === 'entra.client_secret'
                ? { client_secret: ENTRA_SECRET_VALUE }
                : undefined
          return {
            ok: true,
            externalId: id,
            observed: observedOf(id),
            ...(outputs ? { outputs } : {})
          }
        }
        const id = op.externalId as string
        const t = things.get(id)
        if (t && op.action === 'remove_older') t.fields.older_secrets = []
        return { ok: true, externalId: id, observed: observedOf(id) }
      },
      ...extra
    }
    return a
  }
  return { things, calls, adapter }
}

let w = world()
const sent: Array<{ resource: string; msg: OutboundMessage }> = []

function adapters() {
  const sentry = w.adapter('sentry', [
    spec('sentry.project', [
      f('name', { required: true }),
      f('release_version'),
      f('release_environment'),
      f('release_url'),
      f('record_release', { kind: 'boolean', trigger: true })
    ])
  ])
  const entra = w.adapter('entra', [
    spec(
      'entra.app_registration',
      [
        f('name', { required: true }),
        f('web_redirect_uris', { kind: 'list', items: f('u') }),
        f('logout_url')
      ],
      {
        outputs: [
          { key: 'client_id', label: 'Client id', secret: false },
          { key: 'tenant_id', label: 'Tenant', secret: false }
        ]
      }
    ),
    spec(
      'entra.client_secret',
      [
        f('application', { kind: 'ref', refType: 'entra.app_registration', required: true }),
        f('name', { required: true }),
        f('valid_months', { kind: 'number' }),
        f('remove_older', { kind: 'boolean', trigger: true }),
        f('older_secrets', { kind: 'list', items: f('k'), readOnly: true })
      ],
      {
        refs: [{ field: 'application', type: 'entra.app_registration', required: true }],
        outputs: [{ key: 'client_secret', label: 'Client secret', secret: true, onceOnly: true }],
        reversible: false
      }
    )
  ])
  const notifyImpl =
    (thread: boolean) =>
    async (_ctx: unknown, resource: { external_id: string | null }, msg: OutboundMessage) => {
      sent.push({ resource: String(resource.external_id), msg })
      const ts = `17000000${sent.length}.0001`
      return {
        ok: true,
        externalId: resource.external_id,
        observed: null,
        answer:
          thread && msg.dedupKey && msg.action !== 'resolve'
            ? { threadRef: msg.threadRef ?? ts }
            : {}
      } as OpResult
    }
  const mail = w.adapter(
    'fakemail',
    [
      spec('fakemail.sender', [f('name'), f('recipients', { kind: 'list', items: f('e') })], {
        sends: true,
        audience: 'email'
      })
    ],
    { notify: notifyImpl(false) as never }
  )
  const chat = w.adapter('fakechat', [spec('fakechat.channel', [f('name')], { sends: true })], {
    notify: notifyImpl(true) as never
  })
  const cloudflare = w.adapter('cloudflare', [
    spec('cloudflare.zone', [f('name')], { scope: 'shared' }),
    spec(
      'cloudflare.dns_record',
      [
        f('zone', { kind: 'ref', refType: 'cloudflare.zone', required: true }),
        f('name', { required: true }),
        f('type'),
        f('content'),
        f('ttl', { kind: 'number' }),
        f('proxied', { kind: 'boolean' })
      ],
      { refs: [{ field: 'zone', type: 'cloudflare.zone', required: true }] }
    )
  ])
  const neon = w.adapter('neon', [
    spec('neon.branch', [f('name')], {
      outputs: [
        { key: 'host', label: 'Host', secret: false },
        { key: 'password', label: 'Password', secret: true }
      ]
    })
  ])
  const aws = w.adapter('aws', [spec('aws.ecr_repository', [f('name')])])
  return [sentry, entra, mail, chat, cloudflare, neon, aws]
}

let appId: number
let otherApp: number
let staging: number
let production: number
let creationId: number
const conn: Record<string, number> = {}

const insertId = async (table: string, row: Record<string, unknown>) => {
  const [id] = await db(table).insert(row)
  return Number(id)
}

async function resource(
  provider: string,
  type: string,
  ext: string,
  o: {
    appId?: number | null
    envId?: number | null
    desired?: Record<string, unknown>
    observed?: Record<string, unknown>
  } = {}
): Promise<number> {
  const appScoped = o.appId !== null
  // The fake provider has it too (observe answers it).
  w.things.set(ext, { type, fields: { ...(o.observed ?? { name: ext }) } })
  return (
    await store.insertResource({
      connection_id: conn[provider],
      provider,
      type,
      external_id: ext,
      name: ext,
      scope: appScoped ? 'app' : 'shared',
      app_id: appScoped ? (o.appId ?? appId) : null,
      environment_id: o.envId ?? null,
      ...(o.desired ? { desired: o.desired } : {}),
      observed: { type, externalId: ext, name: ext, fields: o.observed ?? { name: ext }, tags: {} }
    } as never)
  ).id
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('status').nullable()
    t.uuid('role').nullable()
    t.string('email').nullable()
    t.string('account_kind').nullable()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.boolean('admin_access').nullable()
  })
  await db.schema.createTable('nivaro_extension_settings', (t) => {
    t.increments('id')
    t.string('extension_id', 100).notNullable()
    t.string('key', 100).notNullable()
    t.text('value').nullable()
    t.datetime('updated_at').notNullable()
    t.unique(['extension_id', 'key'])
  })
  const admin = '0a1b2c3d-0000-4000-8000-0000000000f1'
  const plainRole = '0a1b2c3d-0000-4000-8000-0000000000f2'
  await db('nivaro_roles').insert([
    { id: admin, admin_access: true },
    { id: plainRole, admin_access: false }
  ])
  await db('nivaro_users').insert([
    { id: ADMIN_ID, status: 'active', role: admin, email: 'ada@example.com' },
    { id: ADMIN2_ID, status: 'suspended', role: admin, email: 'gone@example.com' },
    { id: OWNER_ID, status: 'active', role: plainRole, email: 'owen@example.com' },
    {
      id: MACHINE_ID,
      status: 'active',
      role: admin,
      email: 'bot@example.com',
      account_kind: 'service'
    }
  ])
  appId = await insertId('nivaro_hub_apps', { key: 'shop', name: 'Shop' })
  otherApp = await insertId('nivaro_hub_apps', { key: 'blog', name: 'Blog' })
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER_ID })
  staging = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'staging',
    position: 0,
    base_url: 'https://shop--staging.example.com',
    hub_token: sealSecret('test-secret-hub-token')
  })
  production = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'production',
    position: 1,
    base_url: 'https://shop.example.com'
  })
  creationId = await insertId('nivaro_hub_creations', {
    app_id: appId,
    environment_id: staging,
    status: 'running',
    steps: '[]',
    version: '1.4.0',
    first_admin: '{}',
    started_by: ADMIN_ID
  })
  for (const p of ['sentry', 'entra', 'fakemail', 'fakechat', 'cloudflare', 'neon', 'aws'])
    conn[p] = (
      await store.createConnection({
        provider: p,
        name: `${p} account`,
        config:
          p === 'entra'
            ? { tenant_id: 'contoso.onmicrosoft.com' }
            : p === 'aws'
              ? { region: 'us-east-1' }
              : {},
        secrets: { token: `test-secret-${p}-token` }
      })
    ).id
})

afterAll(async () => {
  notify.configureNotifyForTest(null)
  await db.destroy()
})

beforeEach(async () => {
  w = world()
  sent.length = 0
  registry.resetProvidersForTest()
  for (const a of adapters()) registry.registerProvider(a)
  locks.resetMemoryResourceLocksForTest()
  deps.resetResourceEngineForTest()
  deps.configureResourceEngine({
    lock: () => locks.memoryResourceLock(),
    inline: true,
    notify: { notify: vi.fn(async () => null), adminBase: () => '', page: null }
  })
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_resource_outputs',
    'nivaro_hub_resource_bindings',
    'nivaro_hub_notify_routes',
    'nivaro_hub_deploys',
    'nivaro_hub_stack_settings',
    'nivaro_extension_settings'
  ])
    await db(t).del()
})

const deployRow = (o: Record<string, unknown>) =>
  insertId('nivaro_hub_deploys', {
    app_id: appId,
    environment_id: staging,
    kind: 'promote',
    version: '1.5.0',
    status: 'running',
    started_by: ADMIN_ID,
    ...o
  })

// ── Sentry ──

describe('promote → Sentry release', () => {
  it('records the release on the app’s projects, carried by the promotion', async () => {
    const mine = await resource('sentry', 'sentry.project', 'shop-web', {
      desired: { name: 'shop-web' }
    })
    const here = await resource('sentry', 'sentry.project', 'shop-staging', {
      envId: staging,
      desired: { name: 'shop-staging' }
    })
    // Another environment's project and another app's project are left alone.
    await resource('sentry', 'sentry.project', 'shop-prod', {
      envId: production,
      desired: { name: 'shop-prod' }
    })
    await resource('sentry', 'sentry.project', 'blog-web', {
      appId: otherApp,
      desired: { name: 'blog-web' }
    })
    const deployId = await deployRow({})
    const log: string[] = []
    const out = await release.recordPromotionReleases({
      deployId,
      envId: staging,
      envKey: 'staging',
      version: '1.5.0',
      log: (l) => log.push(l)
    })
    expect(out.skipped).toEqual([])
    expect(out.applied.length).toBe(2)
    const rel = w.calls.filter((c) => c.action === 'release')
    expect(rel.map((c) => c.ext).sort()).toEqual(['shop-staging', 'shop-web'])
    for (const c of rel)
      expect(c.fields).toMatchObject({
        release_version: '1.5.0',
        release_environment: 'staging',
        release_url: 'https://shop--staging.example.com'
      })
    const changes = await store.listChanges({})
    expect(changes.every((c) => c.plan?.origin?.kind === 'promotion')).toBe(true)
    expect(changes.flatMap((c) => c.plan?.resourceIds ?? []).sort()).toEqual([mine, here].sort())

    // A promotion that is no longer running records nothing.
    w.calls.length = 0
    const done = await deployRow({ status: 'success' })
    await release.recordPromotionReleases({
      deployId: done,
      envId: staging,
      envKey: 'staging',
      version: '1.5.1',
      log: () => undefined
    })
    expect(w.calls).toEqual([])
  })

  it('release fields: an https address only', () => {
    expect(release.releaseFields('1.0.0', 'prod', 'http://x.example.com')).toEqual({
      record_release: true,
      release_version: '1.0.0',
      release_environment: 'prod'
    })
  })
})

// ── Create app: Entra part ──

function stepCtx(made: Record<string, unknown>): BaseStepContext {
  return {
    creation: { id: creationId, started_by: ADMIN_ID, version: '1.4.0', job_run_id: null },
    app: {
      id: appId,
      key: 'shop',
      name: 'Shop',
      oidc: { issuer: '', client_id: '' },
      oidc_secret: null
    },
    env: {
      id: staging,
      app_id: appId,
      key: 'staging',
      position: 0,
      status: 'provisioning',
      base_url: 'https://shop--staging.example.com',
      hostnames: ['shop--staging.example.com'],
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
    deps: { sleep: async () => undefined, now: Date.now }
  } as unknown as BaseStepContext
}

describe('Create app → Entra app registration part', () => {
  it('makes the registration and its secret and binds them to the stack', async () => {
    const list = [
      {
        connection_id: conn.entra,
        type: 'entra.app_registration',
        fields: { name: 'shop-staging' }
      }
    ]
    const ctx = stepCtx({
      planned: {
        hostname: 'shop--staging.example.com',
        providers_sealed: sealSecret(JSON.stringify(list))
      }
    })
    const out = await stepProviders(ctx, null)
    expect(out.status).toBe('done')
    expect(w.calls.map((c) => [c.kind, c.type])).toEqual([
      ['create', 'entra.app_registration'],
      ['create', 'entra.client_secret']
    ])
    // The redirect address defaults to the environment's; the secret points at the new app.
    expect(w.calls[0].fields.web_redirect_uris).toEqual([
      'https://shop--staging.example.com/api/auth/callback'
    ])
    const appRow = (await store.listResources({ type: 'entra.app_registration' }))[0]
    const secretRow = (await store.listResources({ type: 'entra.client_secret' }))[0]
    expect(secretRow.refs.some((r) => r.resourceId === appRow.id)).toBe(true)
    expect((await bindings.listBindings(appRow.id)).map((b) => [b.target, b.target_key])).toEqual([
      ['stack_setting', 'OIDC_CLIENT_ID']
    ])
    expect(
      (await bindings.listBindings(secretRow.id)).map((b) => [b.target, b.target_key])
    ).toEqual([['stack_secret', 'OIDC_CLIENT_SECRET']])
    expect(ctx.made.entra_issuer).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0'
    )

    // A retry makes nothing twice and keeps the bindings.
    w.calls.length = 0
    expect((await stepProviders(ctx, null)).status).toBe('done')
    expect(w.calls).toEqual([])
    expect((await bindings.listBindings(secretRow.id)).length).toBe(1)

    // Once the stack settings exist, the values are written there (never deployed).
    await stack.saveStackSettings(staging, {
      size: 'small',
      redis: 'bundled',
      publish_port: null,
      settings: { OIDC_ISSUER: ctx.made.entra_issuer as string },
      secrets: null
    } as never)
    const pushed = await pushEnvBindings(staging, ADMIN_ID)
    expect(pushed).toEqual({ ok: 2, failed: [] })
    const row = await stack.readStackSettings(staging)
    expect(row?.settings.OIDC_CLIENT_ID).toMatch(/^cid-/)
    const sealed = stack.openSealedMap(row?.secrets ?? null)
    expect(openSecret(sealed.OIDC_CLIENT_SECRET)).toBe(ENTRA_SECRET_VALUE)
  })

  it('parts rules: stack-bound parts need Docker, Redis needs external', () => {
    const entra = { connection_id: 1, type: 'entra.app_registration' as const }
    const redis = { connection_id: 2, type: 'upstash.redis_database' as const }
    expect(parts.partsProblem([entra], { kind: 'gitlab', stackRedis: null })).toMatch(/Docker/)
    expect(parts.partsProblem([entra], { kind: 'docker', stackRedis: 'bundled' })).toBeNull()
    expect(parts.partsProblem([redis], { kind: 'docker', stackRedis: 'bundled' })).toMatch(
      /external/
    )
    expect(parts.partsProblem([redis], { kind: 'docker', stackRedis: 'external' })).toBeNull()
    expect(parts.partsProblem([entra, entra], { kind: 'docker', stackRedis: null })).toMatch(/One/)
    expect(parts.entraIssuerOf('../evil')).toBeNull()
    expect(parts.providerPartsOf([{ connection_id: 1, type: 'sentry.project' }]).ok).toBe(true)
  })
})

// ── Rotated secret clean-up ──

describe('Entra secret rotation → remove_older after the run applied it', () => {
  async function rotatedSecret(pushedAt: Date): Promise<number> {
    await resource('entra', 'entra.app_registration', 'app-obj', { envId: staging })
    const id = await resource('entra', 'entra.client_secret', 'app-obj:key-2', {
      envId: staging,
      observed: { name: 'nivaro-shop-staging', application: 'app-obj', older_secrets: ['key-1'] }
    })
    await bindings.storeOutputs(id, { client_secret: ENTRA_SECRET_VALUE })
    const fp = (await bindings.outputMeta(id))[0].fingerprint
    await db('nivaro_hub_resource_bindings').insert({
      resource_id: id,
      output_key: 'client_secret',
      environment_id: staging,
      target: 'stack_secret',
      target_key: 'OIDC_CLIENT_SECRET',
      last_pushed_at: pushedAt,
      last_fingerprint: fp,
      created_at: new Date(),
      updated_at: new Date()
    })
    return id
  }

  it('fires once the stack ran with the new value; keeps them when not applied yet', async () => {
    const id = await rotatedSecret(new Date(Date.now() - 60_000))
    const deployId = await deployRow({ started_at: new Date() })
    const out = await cleanup.removeOlderSecretsAfterRun({
      deployId,
      envId: staging,
      log: () => undefined
    })
    expect(out.skipped).toEqual([])
    expect(out.applied.length).toBe(1)
    expect(w.calls.map((c) => [c.action, c.ext])).toEqual([['remove_older', 'app-obj:key-2']])
    const change = (await store.listChanges({}))[0]
    expect(change.plan?.origin).toMatchObject({ kind: 'promotion', deployId })
    expect(change.plan?.resourceIds).toEqual([id])
  })

  it('keeps the older secrets when the value was written after the run started', async () => {
    await rotatedSecret(new Date(Date.now() + 60_000))
    const deployId = await deployRow({ started_at: new Date() })
    const out = await cleanup.removeOlderSecretsAfterRun({
      deployId,
      envId: staging,
      log: () => undefined
    })
    expect(out.applied).toEqual([])
    expect(out.skipped[0].why).toMatch(/after this run started/)
    expect(w.calls).toEqual([])
  })

  it('keeps them when the binding holds an older value', async () => {
    const id = await rotatedSecret(new Date(Date.now() - 60_000))
    await bindings.storeOutputs(id, { client_secret: 'test-secret-entra-client-secret-2' })
    const deployId = await deployRow({ started_at: new Date() })
    const out = await cleanup.removeOlderSecretsAfterRun({
      deployId,
      envId: staging,
      log: () => undefined
    })
    expect(out.applied).toEqual([])
    expect(out.skipped[0].why).toMatch(/current value/)
  })
})

// ── DNS mode cloudflare, Neon servers, ECR findings ──

describe('cloudflare DNS, Neon database servers, ECR scan findings', () => {
  it('a cloudflare-mode creation makes the name record in the managed zone', async () => {
    const zone = await resource('cloudflare', 'cloudflare.zone', 'zone-1', {
      appId: null,
      observed: { name: 'example.com' }
    })
    const ctx = stepCtx({ planned: { hostname: 'shop--staging.apps.example.com' } })
    const naming = {
      dns_mode: 'cloudflare',
      dns_zone_resource_id: zone,
      wildcard_domain: 'apps.example.com',
      edge: 'edge.example.net'
    }
    expect((await stepProviders(ctx, naming)).status).toBe('done')
    expect(w.calls.map((c) => [c.kind, c.type])).toEqual([['create', 'cloudflare.dns_record']])
    expect(w.calls[0].fields).toMatchObject({
      name: 'shop--staging.apps.example.com',
      type: 'CNAME',
      content: 'edge.example.net',
      proxied: false
    })
    // A Route 53 zone id named in cloudflare mode (or the other way round) is refused.
    const { route53Zone } = await import('../../../services/hub/create/dns-route53.js')
    expect((await route53Zone(zone, 'apps.example.com', 'route53')).ok).toBe(false)
    expect((await route53Zone(zone, 'other.org', 'cloudflare')).ok).toBe(false)
    // A Docker driver accepts the mode with its zone; without the zone it is refused.
    const { checkDockerConfig } = await import('../../../services/hub/docker/driver-config.js')
    const cfg = {
      agent_url: 'https://agent.example.com',
      dns_mode: 'cloudflare',
      wildcard_domain: 'apps.example.com',
      edge_target: 'edge.example.net'
    }
    expect(checkDockerConfig({ ...cfg, dns_zone_resource_id: zone })).toMatchObject({
      ok: true,
      config: { dns_mode: 'cloudflare', dns_zone_resource_id: zone }
    })
    expect(checkDockerConfig(cfg)).toMatchObject({ ok: false })
  })

  it('a database server may be a Neon branch: Postgres, TLS, host from its output', async () => {
    const servers = await import('../../../services/hub/db/servers.js')
    const branch = await resource('neon', 'neon.branch', 'proj-1/br-1')
    await bindings.storeOutputs(branch, {
      host: 'ep-cool-1.us-east-2.aws.neon.tech',
      password: 'test-secret-neon-password'
    })
    const base = {
      name: 'neon',
      engine: 'pg',
      host: '',
      port: null,
      provision_mode: 'manual',
      ssl_mode: null,
      trust_server_cert: false,
      collation: null,
      user_host: null,
      notes: null,
      admin_secret: null,
      resource_id: branch
    } as never
    expect(await servers.resolveServerResource(base)).toMatchObject({
      host: 'ep-cool-1.us-east-2.aws.neon.tech',
      port: 5432,
      ssl_mode: 'require'
    })
    await expect(
      servers.resolveServerResource({ ...(base as object), engine: 'mysql2' } as never)
    ).rejects.toMatchObject({ code: 'ENGINE_MISMATCH' })
    await expect(
      servers.resolveServerResource({ ...(base as object), ssl_mode: 'disable' } as never)
    ).rejects.toMatchObject({ code: 'BAD_SSL' })
    // A secret output is never handed out this way.
    expect(await bindings.plainOutput(branch, 'password')).toBeNull()
  })

  it('ECR findings: the reader’s repositories only, counts or a scrubbed reason', async () => {
    const ecr = await import('../../../services/hub/providers/hooks/ecr-findings.js')
    await resource('aws', 'aws.ecr_repository', 'shop-api')
    await resource('aws', 'aws.ecr_repository', 'blog-api', { appId: otherApp })
    const summary = vi.fn(async (_ctx: unknown, name: string) => {
      if (name === 'blog-api') throw new Error('denied for test-secret-aws-token')
      return {
        imageTag: '1.5.0',
        digest: 'sha256:abc',
        pushedAt: '2026-11-26T00:00:00.000Z',
        scanStatus: 'COMPLETE',
        counts: { CRITICAL: 1, HIGH: 2 },
        totalImages: 3
      }
    })
    const mine = await ecr.ecrRepositoryFindings([appId], { summary: summary as never })
    expect(mine.map((r) => r.name)).toEqual(['shop-api'])
    expect(mine[0]).toMatchObject({
      source: 'ecr',
      image: '1.5.0',
      counts: { critical: 1, high: 2, low: 0 }
    })
    const all = await ecr.ecrRepositoryFindings(null, { summary: summary as never })
    const blog = all.find((r) => r.name === 'blog-api')
    expect(blog?.counts).toBeNull()
    expect(blog?.error).toContain('denied')
    expect(blog?.error).not.toContain('test-secret-aws-token')
    expect(await ecr.ecrRepositoryFindings([], { summary: summary as never })).toEqual([])
  })
})

// ── Notify ──

describe('notify: audience, threads, dedup keys', () => {
  it('email senders get the route audience; the sender’s own list wins; chat senders get no one', async () => {
    const mailHub = await resource('fakemail', 'fakemail.sender', 'mail-hub', { appId: null })
    const mailApp = await resource('fakemail', 'fakemail.sender', 'mail-app')
    const chat = await resource('fakechat', 'fakechat.channel', 'chat-app')
    await notify.createNotifyRoute(
      { scope: 'hub', appId: null, events: ['deploy.failed'], resourceId: mailHub },
      ADMIN
    )
    await notify.createNotifyRoute(
      { scope: 'app', appId, events: ['deploy.failed'], resourceId: mailApp },
      ADMIN
    )
    await notify.createNotifyRoute(
      { scope: 'app', appId, events: ['deploy.failed'], resourceId: chat },
      ADMIN
    )
    await notify.fanOut('deploy.failed', { envId: staging })
    const by = (r: string) => sent.find((s) => s.resource === r)?.msg
    // Hub-wide: active admins only (never a suspended one, never a machine account).
    expect(by('mail-hub')?.recipients).toEqual(['ada@example.com'])
    // App route: the app's owners.
    expect(by('mail-app')?.recipients).toEqual(['owen@example.com'])
    expect(by('chat-app')?.recipients).toBeUndefined()
    // An app with no owners: its Hub administrators.
    expect(await notify.routeAudience({ scope: 'app', app_id: otherApp })).toEqual([
      'ada@example.com'
    ])
  })

  it('a thread survives a restart: the update and the resolve reply in it, then it is forgotten', async () => {
    const chat = await resource('fakechat', 'fakechat.channel', 'chat-app')
    const route = await notify.createNotifyRoute(
      {
        scope: 'app',
        appId,
        events: ['incident.opened', 'incident.updated', 'incident.resolved'],
        resourceId: chat
      },
      ADMIN
    )
    await notify.fanOut('incident.opened', { appId, dedupKey: 'incident:7', action: 'open' })
    expect(sent[0].msg.threadRef).toBeUndefined()
    const first = await notify.readThreadRef(route.id, 'incident:7')
    expect(first).toBe('170000001.0001')
    // "Restart": nothing in any process memory — the row is all there is.
    await notify.fanOut('incident.updated', { appId, dedupKey: 'incident:7', action: 'update' })
    expect(sent[1].msg.threadRef).toBe(first)
    // Another incident never borrows this thread.
    await notify.fanOut('incident.updated', { appId, dedupKey: 'incident:8', action: 'update' })
    expect(sent[2].msg.threadRef).toBeUndefined()
    await notify.fanOut('incident.resolved', { appId, dedupKey: 'incident:7', action: 'resolve' })
    expect(sent[3].msg.threadRef).toBe(first)
    expect(await notify.readThreadRef(route.id, 'incident:7')).toBeNull()
    // Deleting the route drops its threads.
    await notify.deleteNotifyRoute(route.id)
    expect(
      await db('nivaro_extension_settings').where('key', 'like', `notify-thread:${route.id}:%`)
    ).toEqual([])
  })

  it('incident updates and deploy failures go out under their dedup keys', async () => {
    const chat = await resource('fakechat', 'fakechat.channel', 'chat-app')
    await notify.createNotifyRoute(
      {
        scope: 'app',
        appId,
        events: ['incident.updated', 'deploy.failed', 'deploy.finished'],
        resourceId: chat
      },
      ADMIN
    )
    notifyIncidentUpdate(
      {
        id: 4,
        app_id: appId,
        environment_id: staging,
        title: 'Checkout down',
        status: 'open',
        severity: 'sev1'
      },
      'changed Sev 1'
    )
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0].msg).toMatchObject({
      dedupKey: 'incident:4',
      action: 'update',
      severity: 'critical'
    })
    // A resolved incident sends no update.
    notifyIncidentUpdate(
      {
        id: 4,
        app_id: appId,
        environment_id: staging,
        title: 'Checkout down',
        status: 'resolved',
        severity: 'sev1'
      },
      'a note was added'
    )

    const failed = await deployRow({ status: 'failed' })
    hubNotifyDeployClosed({
      deployId: failed,
      envId: staging,
      status: 'failed',
      detail: 'promote 1.5.0 on staging'
    })
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(sent[1].msg).toMatchObject({
      dedupKey: `deploy:${failed}`,
      action: 'open',
      severity: 'critical'
    })

    const ok = await deployRow({ status: 'success' })
    hubNotifyDeployClosed({
      deployId: ok,
      envId: staging,
      status: 'success',
      detail: 'promote 1.5.1 on staging'
    })
    await vi.waitFor(() => expect(sent.length).toBe(4))
    const resolve = sent.find((s) => s.msg.action === 'resolve')?.msg
    expect(resolve).toMatchObject({ dedupKey: `deploy:${failed}`, severity: 'info' })
    expect(resolve?.title).toContain(`#${failed}`)
    // The failure's thread is the one the resolve replies in.
    expect(resolve?.threadRef).toBe('170000002.0001')
  })
})
