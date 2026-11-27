import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub providers, gap G-C: `expo.android_push_credentials` uploads a Firebase FCM key to EAS.
// Real SQLite rows (connections, apps, Firebase resources, a sealed output) + recorded (fake) EAS
// answers from expo/__fixtures__/eas-push-answers.json. The key never leaves the sealed output
// except inside the one GraphQL variable, and never appears in a result, a plan or an error.

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
const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { expoAdapter } = await import('../../../services/hub/providers/expo/index.js')
const { ensureCoreProviders } = await import('../../../services/hub/providers/index.js')
const { resetProvidersForTest } = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const bindings = await import('../../../services/hub/providers/engine/bindings.js')

import type { DesiredResource, Observed, PlannedOp } from '../../../services/hub/providers/types.js'
import { ProviderError } from '../../../services/hub/providers/types.js'

const FIX = JSON.parse(
  readFileSync(
    new URL(
      '../../../services/hub/providers/expo/__fixtures__/eas-push-answers.json',
      import.meta.url
    ),
    'utf8'
  )
) as Record<string, any>

const MIGRATIONS = ['542_hub_tables', '582_hub_providers', '584_hub_provider_bindings']

const TOKEN = 'test-secret-expo-robot-token'
const PK_LINE_1 = 'test-secret-fake-private-key-line-0001-abcdef'
const PK_LINE_2 = 'test-secret-fake-private-key-line-0002-abcdef'
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${PK_LINE_1}\n${PK_LINE_2}\n-----END PRIVATE KEY-----\n`
const PRIVATE_KEY_ID = 'fedcba9876543210fedcba9876543210fedcba98'
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'fake-project',
  private_key_id: PRIVATE_KEY_ID,
  private_key: PRIVATE_KEY,
  client_email: 'fcm-send@fake-project.iam.gserviceaccount.com'
})
const APP_ID = 'app-1'
const APPLICATION = 'com.acme.fieldapp'

let shopApp: number
let blogApp: number
let fbConn: number
let fbOtherConn: number
let expoConn: number
let fcmOk: number
let fcmOtherApp: number
let fcmOtherConn: number
let fcmNoOutput: number
let fcmDeleted: number
let fcmBadJson: number

type Handler = (op: string, vars: Record<string, any>) => unknown
interface Sent {
  op: string
  vars: Record<string, any>
}

function setup(over: { handler?: Handler; config?: Record<string, unknown> } = {}) {
  const sent: Sent[] = []
  const ctx = makeProviderContext({
    adapter: expoAdapter,
    connectionId: expoConn,
    config: { account: 'acme-mobile', firebase_connection_id: fbConn, ...(over.config ?? {}) },
    secrets: { token: TOKEN },
    fetch: {
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body))
        const op = /(?:query|mutation) (\w+)/.exec(body.query)![1]
        sent.push({ op, vars: body.variables })
        const out = over.handler?.(op, body.variables)
        const payload = out === undefined ? { data: FIX[op] } : out
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    }
  })
  return { ctx, sent }
}

function desired(over: Partial<DesiredResource> = {}): DesiredResource {
  return {
    resourceId: 40,
    externalId: null,
    type: 'expo.android_push_credentials',
    scope: 'app',
    appId: shopApp,
    environmentId: null,
    fields: { application_id: APPLICATION, fcm_key_resource_id: fcmOk },
    refs: { project: APP_ID },
    tags: {},
    ...over
  }
}

const NO_KEY_ROWS = {
  data: {
    app: {
      byId: {
        id: APP_ID,
        androidAppCredentials: [
          {
            id: 'cred-2',
            applicationIdentifier: APPLICATION,
            googleServiceAccountKeyForFcmV1: null
          }
        ]
      }
    }
  }
}
const NO_ROWS = { data: { app: { byId: { id: APP_ID, androidAppCredentials: [] } } } }
const everywhere = (x: unknown) => JSON.stringify(x)

async function create(ctx: ReturnType<typeof setup>['ctx'], d = desired()) {
  const op = expoAdapter.plan(ctx, d, null)[0] as PlannedOp
  return { op, result: await expoAdapter.apply(ctx, op, d) }
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  ensureCoreProviders()
  shopApp = Number((await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' }))[0])
  blogApp = Number((await db('nivaro_hub_apps').insert({ key: 'blog', name: 'Blog' }))[0])
  const mk = async (provider: string, name: string, config = {}) =>
    (await store.createConnection({ provider, name, config, secrets: {} })).id
  fbConn = await mk('firebase', 'Firebase A', { projectId: 'fake-project' })
  fbOtherConn = await mk('firebase', 'Firebase B', { projectId: 'other-project' })
  expoConn = await mk('expo', 'Expo', { account: 'acme-mobile' })
  await store.setAppAllowedConnections(shopApp, [fbConn, expoConn])
  await store.setAppAllowedConnections(blogApp, [fbConn, expoConn])
  const fcm = async (over: Record<string, unknown>) =>
    (
      await store.insertResource({
        connection_id: fbConn,
        provider: 'firebase',
        type: 'firebase.fcm_service_account',
        scope: 'app',
        app_id: shopApp,
        ...over
      } as Parameters<typeof store.insertResource>[0])
    ).id
  fcmOk = await fcm({ external_id: 'fcm-send@fake-project/ok', name: 'ok' })
  fcmOtherApp = await fcm({ external_id: 'fcm-send@fake-project/blog', app_id: blogApp })
  fcmOtherConn = await fcm({ external_id: 'fcm-send@other-project/k', connection_id: fbOtherConn })
  fcmNoOutput = await fcm({ external_id: 'fcm-send@fake-project/none' })
  fcmDeleted = await fcm({ external_id: 'fcm-send@fake-project/del' })
  fcmBadJson = await fcm({ external_id: 'fcm-send@fake-project/bad' })
  await db('nivaro_hub_resources').where({ id: fcmDeleted }).update({ deleted_at: new Date() })
  for (const id of [fcmOk, fcmOtherApp, fcmOtherConn, fcmDeleted])
    await bindings.storeOutputs(id, { service_account_json: KEY_JSON })
  await bindings.storeOutputs(fcmBadJson, { service_account_json: 'not json at all' })
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(() => {
  resetProvidersForTest()
  ensureCoreProviders()
})

describe('expo push credentials: spec and connection', () => {
  it('is an app-scoped type with no secret field, a project ref and delete/replace risk', () => {
    const spec = expoAdapter.types.find((t) => t.key === 'expo.android_push_credentials')!
    expect(spec.scope).toBe('app')
    expect(spec.fields.some((f) => f.kind === 'secret')).toBe(false)
    expect(spec.refs).toEqual([{ field: 'project', type: 'expo.project' }])
    expect(spec.costClass).toBeUndefined()
    const base = { type: spec.key, resourceId: 1, externalId: 'a:b', reason: '', changes: [] }
    const op = (kind: PlannedOp['kind']): PlannedOp => ({
      ...base,
      kind,
      preconditions: {},
      risk: []
    })
    expect(spec.risk(op('delete'), null)).toEqual(['destructive', 'downtime'])
    expect(spec.risk(op('replace'), null)).toEqual(['destructive', 'downtime'])
    expect(spec.risk(op('create'), null)).toEqual([])
    expect(spec.risk(op('update'), null)).toEqual([])
  })

  it('the Firebase connection is an optional number field, validated', () => {
    const f = expoAdapter.connection.fields.find((x) => x.key === 'firebase_connection_id')
    expect(f).toMatchObject({ kind: 'number' })
    expect(f?.required).toBeFalsy()
    const v = expoAdapter.connection.validate!
    expect(v({ account: 'acme', firebase_connection_id: 4 }, { token: 't' })).toEqual([])
    expect(v({ account: 'acme' }, { token: 't' })).toEqual([])
    expect(v({ account: 'acme', firebase_connection_id: 'x' }, { token: 't' })).toHaveLength(1)
    expect(v({ account: 'acme', firebase_connection_id: 0 }, { token: 't' })).toHaveLength(1)
  })
})

describe('expo push credentials: plan', () => {
  it('plans a create carrying only ids, never a key', () => {
    const { ctx } = setup()
    const [op] = expoAdapter.plan(ctx, desired(), null)
    expect(op).toMatchObject({ kind: 'create', action: 'link_fcm' })
    expect(op.changes.map((c) => c.field)).toEqual([
      'project',
      'application_id',
      'fcm_key_resource_id'
    ])
    expect(everywhere(op)).not.toContain('PRIVATE KEY')
  })

  it('is a noop when a key is linked, and an update when none is', () => {
    const { ctx } = setup()
    const linked: Observed = {
      type: 'expo.android_push_credentials',
      externalId: `${APP_ID}:cred-1`,
      name: APPLICATION,
      fields: { project: APP_ID, application_id: APPLICATION, key_linked: true },
      tags: {}
    }
    expect(expoAdapter.plan(ctx, desired(), linked)[0].kind).toBe('noop')
    const bare = { ...linked, fields: { ...linked.fields, key_linked: false } }
    expect(expoAdapter.plan(ctx, desired(), bare)[0]).toMatchObject({
      kind: 'update',
      action: 'link_fcm'
    })
  })

  it('updates when another Firebase key is wanted (echo) or an upload is requested', () => {
    const { ctx } = setup()
    const obs: Observed = {
      type: 'expo.android_push_credentials',
      externalId: `${APP_ID}:cred-1`,
      name: APPLICATION,
      fields: {
        project: APP_ID,
        application_id: APPLICATION,
        key_linked: true,
        fcm_key_resource_id: 999
      },
      tags: {}
    }
    expect(expoAdapter.plan(ctx, desired(), obs)[0].changes).toEqual([
      { field: 'fcm_key_resource_id', from: 999, to: fcmOk }
    ])
    const same = { ...obs, fields: { ...obs.fields, fcm_key_resource_id: fcmOk } }
    expect(expoAdapter.plan(ctx, desired(), same)[0].kind).toBe('noop')
    const d = desired({
      fields: { application_id: APPLICATION, fcm_key_resource_id: fcmOk, upload_key: true }
    })
    expect(expoAdapter.plan(ctx, d, same)[0].changes).toEqual([{ field: 'upload_key', to: true }])
  })

  it('replaces on another application id and plans a delete that says what stops', () => {
    const { ctx } = setup()
    const obs: Observed = {
      type: 'expo.android_push_credentials',
      externalId: `${APP_ID}:cred-1`,
      name: APPLICATION,
      fields: { project: APP_ID, application_id: 'com.acme.old', key_linked: true },
      tags: {}
    }
    expect(expoAdapter.plan(ctx, desired(), obs)[0].kind).toBe('replace')
    const [del] = expoAdapter.plan(ctx, null, obs)
    expect(del.kind).toBe('delete')
    expect(del.reason).toMatch(/stop receiving pushes/)
  })
})

describe('expo push credentials: observe and list', () => {
  it('maps identifiers only, never key material', async () => {
    const { ctx } = setup()
    const o = await expoAdapter.observe(ctx, 'expo.android_push_credentials', `${APP_ID}:cred-1`)
    expect(o).toMatchObject({
      externalId: `${APP_ID}:cred-1`,
      name: APPLICATION,
      status: 'linked',
      fields: {
        project: APP_ID,
        application_id: APPLICATION,
        key_linked: true,
        key_email: 'fcm-send@fake-project.iam.gserviceaccount.com'
      }
    })
    expect(everywhere(o)).not.toMatch(/private_key|PRIVATE KEY/)
    expect(
      await expoAdapter.observe(ctx, 'expo.android_push_credentials', `${APP_ID}:nope`)
    ).toBeNull()
  })

  it('lists only rows that carry a push key', async () => {
    const { ctx } = setup({
      handler: (op) =>
        op === 'HubAccountApps'
          ? {
              data: {
                account: {
                  byName: {
                    apps: [
                      {
                        id: APP_ID,
                        slug: 'field-app',
                        fullName: '@acme-mobile/field-app',
                        privacy: 'UNLISTED'
                      }
                    ]
                  }
                }
              }
            }
          : undefined
    })
    const page = await expoAdapter.list(ctx, 'expo.android_push_credentials')
    expect(page.items.map((i) => i.externalId)).toEqual([`${APP_ID}:cred-1`])
  })
})

describe('expo push credentials: create', () => {
  it('makes the row, uploads the sealed key, links it and echoes only the resource id', async () => {
    const { ctx, sent } = setup({
      handler: (op) => (op === 'HubAndroidCredentials' ? NO_ROWS : undefined)
    })
    const { result } = await create(ctx)
    expect(result.ok).toBe(true)
    expect(result.externalId).toBe(`${APP_ID}:cred-2`)
    expect(sent.map((s) => s.op)).toEqual([
      'HubAppById',
      'HubAndroidCredentials',
      'HubCreateAndroidCredentials',
      'HubAccount',
      'HubCreateServiceAccountKey',
      'HubSetFcmV1Key'
    ])
    const upload = sent.find((s) => s.op === 'HubCreateServiceAccountKey')!
    expect(upload.vars.accountId).toBe('acct-1')
    expect(upload.vars.input.jsonKey.private_key_id).toBe(PRIVATE_KEY_ID)
    expect(sent.find((s) => s.op === 'HubSetFcmV1Key')!.vars).toEqual({
      id: 'cred-2',
      keyId: 'sakey-2'
    })
    expect(result.observed?.fields).toMatchObject({
      application_id: APPLICATION,
      key_linked: true,
      fcm_key_resource_id: fcmOk
    })
    // The key is nowhere in what the engine stores.
    const text = everywhere(result)
    for (const secret of [KEY_JSON, PRIVATE_KEY, PK_LINE_1, PK_LINE_2, PRIVATE_KEY_ID])
      expect(text).not.toContain(secret)
  })

  it('links onto an existing row that has no push key, without making a second row', async () => {
    const { ctx, sent } = setup({
      handler: (op) => (op === 'HubAndroidCredentials' ? NO_KEY_ROWS : undefined)
    })
    const { result } = await create(ctx)
    expect(result.externalId).toBe(`${APP_ID}:cred-2`)
    expect(sent.some((s) => s.op === 'HubCreateAndroidCredentials')).toBe(false)
    expect(sent.some((s) => s.op === 'HubSetFcmV1Key')).toBe(true)
  })

  it('refuses a row that already has someone else’s push key (ALREADY_EXISTS), uploads nothing', async () => {
    const { ctx, sent } = setup()
    const { op } = await create(ctx).catch((e) => ({ op: e as ProviderError, result: null }))
    expect(op).toBeInstanceOf(ProviderError)
    expect((op as unknown as ProviderError).code).toBe('ALREADY_EXISTS')
    expect(sent.some((s) => s.op === 'HubCreateServiceAccountKey')).toBe(false)
  })

  it('findExisting reports that blocker while planning', async () => {
    const { ctx } = setup()
    const hit = await expoAdapter.findExisting!(ctx, 'expo.android_push_credentials', desired())
    expect(hit?.externalId).toBe(`${APP_ID}:cred-1`)
  })

  it('a resumed run whose key is already linked uploads nothing', async () => {
    const same = structuredClone(FIX.HubAndroidCredentials)
    same.app.byId.androidAppCredentials[0].googleServiceAccountKeyForFcmV1.privateKeyIdentifier =
      PRIVATE_KEY_ID
    const { ctx, sent } = setup({
      handler: (op) => (op === 'HubAndroidCredentials' ? { data: same } : undefined)
    })
    const d = desired({ externalId: `${APP_ID}:cred-1` })
    const op = { ...expoAdapter.plan(ctx, d, null)[0] }
    const r = await expoAdapter.apply(ctx, op, d)
    expect(r.answer).toEqual({ existed: true })
    expect(sent.some((s) => s.op === 'HubCreateServiceAccountKey')).toBe(false)
  })

  it('update uploads another key and links it (rotation), checking the credentials row', async () => {
    const { ctx, sent } = setup()
    const d = desired({ externalId: `${APP_ID}:cred-1` })
    const op = expoAdapter.plan(
      ctx,
      desired({
        externalId: `${APP_ID}:cred-1`,
        fields: { application_id: APPLICATION, fcm_key_resource_id: fcmOk, upload_key: true }
      }),
      {
        type: d.type,
        externalId: `${APP_ID}:cred-1`,
        name: APPLICATION,
        fields: { project: APP_ID, application_id: APPLICATION, key_linked: true },
        tags: {}
      }
    )[0]
    expect(op.kind).toBe('update')
    const r = await expoAdapter.apply(ctx, op, d)
    expect(r.ok).toBe(true)
    expect(sent.map((s) => s.op)).toContain('HubSetFcmV1Key')
    expect(sent.some((s) => s.op === 'HubDeleteServiceAccountKey')).toBe(false)
    await expect(
      expoAdapter.apply(ctx, { ...op, externalId: `${APP_ID}:cred-9` }, d)
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })
})

describe('expo push credentials: the key source is proven before it is opened', () => {
  const refused = async (d: DesiredResource, config?: Record<string, unknown>) => {
    const { ctx, sent } = setup({ config })
    const err = await create(ctx, d).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(sent.some((s) => s.op === 'HubCreateServiceAccountKey')).toBe(false)
    return err as ProviderError
  }
  const withKey = (id: number, over: Partial<DesiredResource> = {}) =>
    desired({ fields: { application_id: APPLICATION, fcm_key_resource_id: id }, ...over })

  it('needs the administrator’s Firebase connection on the Expo connection', async () => {
    const e = await refused(desired(), { firebase_connection_id: undefined })
    expect(e.code).toBe('EXPO_FIREBASE_CONNECTION')
  })

  it('refuses a key of another app, another connection, a deleted or a missing resource', async () => {
    for (const id of [fcmOtherApp, fcmOtherConn, fcmDeleted, 987654]) {
      const e = await refused(withKey(id))
      expect(e.code).toBe('EXPO_FIREBASE_KEY')
    }
  })

  it('refuses when the app is not allowed that Firebase connection', async () => {
    await store.setAppAllowedConnections(shopApp, [expoConn])
    try {
      const e = await refused(desired())
      expect(e.code).toBe('EXPO_FIREBASE_KEY')
      expect(e.message).toMatch(/not allowed/)
    } finally {
      await store.setAppAllowedConnections(shopApp, [fbConn, expoConn])
    }
  })

  it('refuses a resource with no app, and a connection that is not Firebase', async () => {
    expect((await refused(desired({ appId: null }))).code).toBe('EXPO_FIREBASE_KEY')
    const e = await refused(desired(), { firebase_connection_id: expoConn })
    expect(e.code).toBe('EXPO_FIREBASE_CONNECTION')
  })

  it('says a lost once-only copy needs a rotation, and refuses a stored value that is no key', async () => {
    expect((await refused(withKey(fcmNoOutput))).code).toBe('EXPO_FIREBASE_KEY_UNAVAILABLE')
    expect((await refused(withKey(fcmBadJson))).code).toBe('EXPO_FIREBASE_KEY_INVALID')
  })

  it('the sealed-output read answers null for the wrong provider, type or key', async () => {
    const ask = (provider: string, type: string, key: string) =>
      bindings.openOutputForCredentialLink(fcmOk, { provider, type, key })
    expect(await ask('firebase', 'firebase.fcm_service_account', 'service_account_json')).toBe(
      KEY_JSON
    )
    expect(await ask('expo', 'firebase.fcm_service_account', 'service_account_json')).toBeNull()
    expect(await ask('firebase', 'firebase.android_app', 'service_account_json')).toBeNull()
    expect(await ask('firebase', 'firebase.fcm_service_account', 'other')).toBeNull()
  })
})

describe('expo push credentials: errors never carry the key', () => {
  it('scrubs the key from an error Expo echoes back', async () => {
    const { ctx } = setup({
      handler: (op) =>
        op === 'HubCreateServiceAccountKey'
          ? {
              errors: [{ message: `Invalid key ${PK_LINE_1} / ${PRIVATE_KEY_ID} / ${KEY_JSON}` }]
            }
          : op === 'HubAndroidCredentials'
            ? NO_ROWS
            : undefined
    })
    const err = (await create(ctx).catch((e) => e)) as ProviderError
    expect(err).toBeInstanceOf(ProviderError)
    for (const s of [PK_LINE_1, PRIVATE_KEY_ID, KEY_JSON, PRIVATE_KEY])
      expect(err.message).not.toContain(s)
  })

  it('removes the uploaded copy again when linking fails', async () => {
    const { ctx, sent } = setup({
      handler: (op) =>
        op === 'HubSetFcmV1Key'
          ? { errors: [{ message: 'cannot link' }] }
          : op === 'HubAndroidCredentials'
            ? NO_KEY_ROWS
            : undefined
    })
    await expect(create(ctx)).rejects.toMatchObject({ code: 'EXPO_GRAPHQL' })
    expect(sent.find((s) => s.op === 'HubDeleteServiceAccountKey')?.vars).toEqual({
      id: 'sakey-2'
    })
  })

  it('a rate limit is retryable', async () => {
    const { ctx } = setup({
      handler: (op) =>
        op === 'HubCreateServiceAccountKey'
          ? { errors: [{ message: 'slow down', extensions: { errorCode: 'RATE_LIMIT_EXCEEDED' } }] }
          : op === 'HubAndroidCredentials'
            ? NO_KEY_ROWS
            : undefined
    })
    const err = (await create(ctx).catch((e) => e)) as ProviderError
    expect(err.code).toBe('EXPO_RATE_LIMITED')
    expect(err.retryable).toBe(true)
  })
})

describe('expo push credentials: delete and replace', () => {
  it('delete removes the linked key from the Expo account', async () => {
    const { ctx, sent } = setup()
    const obs = await expoAdapter.observe(ctx, 'expo.android_push_credentials', `${APP_ID}:cred-1`)
    const [op] = expoAdapter.plan(ctx, null, obs)
    const r = await expoAdapter.apply(ctx, op, null)
    expect(r).toMatchObject({ ok: true, observed: null })
    expect(sent.find((s) => s.op === 'HubDeleteServiceAccountKey')?.vars).toEqual({
      id: 'sakey-1'
    })
  })

  it('delete is a no-op when no key is linked or the project is gone', async () => {
    const a = setup({ handler: (op) => (op === 'HubAndroidCredentials' ? NO_KEY_ROWS : undefined) })
    await expoAdapter.apply(
      a.ctx,
      {
        kind: 'delete',
        type: 'expo.android_push_credentials',
        resourceId: null,
        externalId: `${APP_ID}:cred-2`,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(a.sent.some((s) => s.op === 'HubDeleteServiceAccountKey')).toBe(false)
    const b = setup({
      handler: (op) => (op === 'HubAppById' ? { data: { app: { byId: null } } } : undefined)
    })
    const r = await expoAdapter.apply(
      b.ctx,
      {
        kind: 'delete',
        type: 'expo.android_push_credentials',
        resourceId: null,
        externalId: `${APP_ID}:cred-2`,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(r.ok).toBe(true)
  })

  it('replace removes the old key and uploads for the new application id', async () => {
    const calls: string[] = []
    let rows = FIX.HubAndroidCredentials
    const { ctx, sent } = setup({
      handler: (op) => {
        calls.push(op)
        if (op === 'HubDeleteServiceAccountKey') rows = NO_ROWS.data
        if (op === 'HubAndroidCredentials') return { data: rows }
        if (op === 'HubCreateAndroidCredentials')
          return {
            data: {
              androidAppCredentials: {
                createAndroidAppCredentials: {
                  id: 'cred-3',
                  applicationIdentifier: 'com.acme.newapp',
                  googleServiceAccountKeyForFcmV1: null
                }
              }
            }
          }
        if (op === 'HubSetFcmV1Key')
          return {
            data: {
              androidAppCredentials: {
                setGoogleServiceAccountKeyForFcmV1: {
                  id: 'cred-3',
                  applicationIdentifier: 'com.acme.newapp',
                  googleServiceAccountKeyForFcmV1: { id: 'sakey-2' }
                }
              }
            }
          }
        return undefined
      }
    })
    const d = desired({
      externalId: `${APP_ID}:cred-1`,
      fields: { application_id: 'com.acme.newapp', fcm_key_resource_id: fcmOk }
    })
    const [op] = expoAdapter.plan(ctx, d, {
      type: d.type,
      externalId: `${APP_ID}:cred-1`,
      name: APPLICATION,
      fields: { project: APP_ID, application_id: APPLICATION, key_linked: true },
      tags: {}
    })
    expect(op.kind).toBe('replace')
    const r = await expoAdapter.apply(ctx, op, d)
    expect(r.externalId).toBe(`${APP_ID}:cred-3`)
    const ops = sent.map((s) => s.op)
    expect(ops.indexOf('HubDeleteServiceAccountKey')).toBeLessThan(
      ops.indexOf('HubCreateServiceAccountKey')
    )
  })
})
