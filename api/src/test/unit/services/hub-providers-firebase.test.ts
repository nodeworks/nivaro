import { createVerify, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 42: the Firebase adapter against recorded (fake-valued) answers. The
// service-account key is a throwaway RSA key made here; nothing real is ever used.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders, CORE_PROVIDERS } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { firebaseAdapter } = await import('../../../services/hub/providers/firebase/index.js')

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/firebase/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const PROJECT = 'demo-app-12345'
const OWN_KEY_ID = 'cccccccccccccccccccccccc33333333'
const SA_EMAIL = `hub-manager@${PROJECT}.iam.gserviceaccount.com`
const FCM_EMAIL = `fcm-send@${PROJECT}.iam.gserviceaccount.com`
const ACCESS_TOKEN = 'test-secret-google-access-token-0001'
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: PROJECT,
  private_key_id: OWN_KEY_ID,
  private_key: privateKey,
  client_email: SA_EMAIL
})
const PK_LINE = privateKey
  .split('\n')
  .find((l) => l.length > 20 && !l.startsWith('-----')) as string

const T_PROJECT = 'firebase.project'
const T_ANDROID = 'firebase.android_app'
const T_IOS = 'firebase.ios_app'
const T_WEB = 'firebase.web_app'
const T_FCM = 'firebase.fcm_service_account'
const APP_ID = '1:123456789012:android:abc123def456'
const KEY1 = `${FCM_EMAIL}/aaaaaaaaaaaaaaaaaaaaaaaa11111111`

interface Call {
  method: string
  host: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
}
interface Route {
  method: string
  host?: RegExp
  path: RegExp
  status?: number
  body?: unknown
}

function harness(routes: Route[], opts: { json?: string; projectId?: string } = {}) {
  const calls: Call[] = []
  const all: Route[] = [
    ...routes,
    {
      method: 'POST',
      host: /oauth2/,
      path: /^\/token$/,
      body: { access_token: ACCESS_TOKEN, expires_in: 3600 }
    }
  ]
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const raw = init?.body ? String(init.body) : ''
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      host: u.host,
      path: decodeURIComponent(u.pathname),
      query: u.searchParams,
      body: u.host.startsWith('oauth2') ? raw : raw ? JSON.parse(raw) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = all.find(
      (r) =>
        r.method === call.method && r.path.test(call.path) && (!r.host || r.host.test(call.host))
    )
    if (!hit) return new Response('{"error":{"message":"not found"}}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), { status })
  }
  const ctx = makeProviderContext({
    adapter: firebaseAdapter,
    connectionId: Math.floor(Math.random() * 1e9),
    config: { projectId: opts.projectId ?? PROJECT },
    secrets: { serviceAccountJson: opts.json ?? SA_JSON },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  externalId: string | null = null
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: type === T_PROJECT ? 'shared' : 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs: {},
    tags: {}
  }
}

const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type,
  resourceId: 7,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const typeSpec = (key: string) => firebaseAdapter.types.find((t) => t.key === key)!

const projObs = (): Observed => ({
  type: T_PROJECT,
  externalId: PROJECT,
  name: 'Demo app',
  fields: { project_id: PROJECT, display_name: 'Demo app', project_number: '123456789012' },
  tags: {}
})

const appObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_ANDROID,
  externalId: APP_ID,
  name: 'Demo Android',
  fields: {
    display_name: 'Demo Android',
    package_name: 'com.example.demo',
    app_id: APP_ID,
    state: 'ACTIVE',
    ...over
  },
  tags: {}
})

const keyObs = (): Observed => ({
  type: T_FCM,
  externalId: KEY1,
  name: `${FCM_EMAIL} (aaaaaaaa)`,
  fields: { service_account: FCM_EMAIL, key_id: 'aaaaaaaaaaaaaaaaaaaaaaaa11111111' },
  tags: {}
})

const APP_ROUTES: Route[] = [
  {
    method: 'GET',
    path: /androidApps\/1:123456789012:android:abc123def456\/config$/,
    body: fx('android-config')
  },
  {
    method: 'GET',
    path: /androidApps\/1:123456789012:android:abc123def456$/,
    body: fx('android-app')
  },
  { method: 'GET', path: /androidApps$/, body: fx('android-apps') }
]

beforeEach(() => {
  registry.resetProvidersForTest?.()
  ensureCoreProviders()
})

describe('registration and the connection form', () => {
  it('is a core provider with the five types and no costs', () => {
    expect(CORE_PROVIDERS).toContain(firebaseAdapter)
    expect(registry.getProvider('firebase')).toBe(firebaseAdapter)
    expect(firebaseAdapter.types).toHaveLength(5)
    for (const t of firebaseAdapter.types) expect(t.costClass).toBeUndefined()
    expect(firebaseAdapter.connection.hosts({})).toEqual([
      'firebase.googleapis.com',
      'oauth2.googleapis.com',
      'iam.googleapis.com',
      'fcm.googleapis.com'
    ])
  })

  it('validates the pin and that the key belongs to it', () => {
    const v = firebaseAdapter.connection.validate!
    expect(v({ projectId: PROJECT }, { serviceAccountJson: SA_JSON })).toEqual([])
    expect(v({ projectId: 'Bad Id' }, {})).toHaveLength(1)
    expect(v({ projectId: PROJECT }, { serviceAccountJson: '{"nope":1}' })).toHaveLength(1)
    expect(v({ projectId: 'other-project-99' }, { serviceAccountJson: SA_JSON })).toHaveLength(1)
  })

  it('the connection secret is the sealed JSON field', () => {
    const f = firebaseAdapter.connection.fields.find((x) => x.key === 'serviceAccountJson')
    expect(f?.secret).toBe(true)
  })
})

describe('firebase signs a token with the key and never sends it elsewhere', () => {
  it('posts an RS256 assertion to the fixed Google token address and caches the token', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v1beta1\/projects\/demo-app-12345$/, body: fx('project') }
    ])
    await firebaseAdapter.observe(h.ctx, T_PROJECT, PROJECT)
    await firebaseAdapter.observe(h.ctx, T_PROJECT, PROJECT)
    const tokenCalls = h.calls.filter((c) => c.host === 'oauth2.googleapis.com')
    expect(tokenCalls).toHaveLength(1)
    const form = new URLSearchParams(tokenCalls[0].body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [head, claims, sig] = (form.get('assertion') ?? '').split('.')
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toMatchObject({
      alg: 'RS256',
      kid: OWN_KEY_ID
    })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: SA_EMAIL,
      aud: 'https://oauth2.googleapis.com/token'
    })
    expect(
      createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, sig, 'base64url')
    ).toBe(true)
    expect(h.calls.find((c) => c.host === 'firebase.googleapis.com')?.headers.authorization).toBe(
      `Bearer ${ACCESS_TOKEN}`
    )
  })

  it('a refused key fails with AUTH_FAILED and none of the key in the text', async () => {
    const h = harness([
      {
        method: 'POST',
        host: /oauth2/,
        path: /^\/token$/,
        status: 400,
        body: { error: 'invalid_grant', error_description: `bad key ${OWN_KEY_ID} ${PK_LINE}` }
      }
    ])
    const err = await firebaseAdapter.observe(h.ctx, T_PROJECT, PROJECT).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.code).toBe('AUTH_FAILED')
    expect(err.message).not.toContain(OWN_KEY_ID)
    expect(err.message).not.toContain(PK_LINE)
  })
})

describe('firebase testConnection lists missing permissions', () => {
  it('probes project, apps, keys and the FCM dry run', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v1beta1\/projects\/demo-app-12345$/, body: fx('project') },
      { method: 'GET', path: /androidApps$/, body: fx('android-apps') },
      { method: 'GET', host: /iam/, path: /keys$/, status: 403, body: fx('error-permission') },
      {
        method: 'POST',
        host: /fcm/,
        path: /messages:send$/,
        status: 400,
        body: { error: { message: 'invalid token' } }
      }
    ])
    const t = await firebaseAdapter.testConnection(h.ctx)
    expect(t.ok).toBe(true)
    expect(t.identity).toContain(SA_EMAIL)
    expect(t.permissions.find((p) => p.type === T_FCM)?.has).toBe(false)
    expect(t.permissions.find((p) => p.type === '*')?.has).toBe(true)
    expect(t.missing).toHaveLength(1)
    expect(h.calls.find((c) => c.host === 'fcm.googleapis.com')?.body.validate_only).toBe(true)
  })

  it('refuses a key of another project', async () => {
    const other = JSON.stringify({ ...JSON.parse(SA_JSON), project_id: 'other-project-99' })
    const t = await firebaseAdapter.testConnection(harness([], { json: other }).ctx)
    expect(t.ok).toBe(false)
  })
})

describe('firebase observe maps provider fields', () => {
  it('maps the project, an app and a key; null when gone or deleted', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v1beta1\/projects\/demo-app-12345$/, body: fx('project') },
      ...APP_ROUTES,
      {
        method: 'GET',
        host: /iam/,
        path: /keys\/aaaaaaaaaaaaaaaaaaaaaaaa11111111$/,
        body: fx('sa-keys').keys[0]
      }
    ])
    expect((await firebaseAdapter.observe(h.ctx, T_PROJECT, PROJECT))?.fields).toMatchObject({
      display_name: 'Demo app'
    })
    expect((await firebaseAdapter.observe(h.ctx, T_ANDROID, APP_ID))?.fields).toMatchObject({
      package_name: 'com.example.demo'
    })
    expect((await firebaseAdapter.observe(h.ctx, T_FCM, KEY1))?.fields.service_account).toBe(
      FCM_EMAIL
    )
    expect(
      await firebaseAdapter.observe(h.ctx, T_ANDROID, '1:123456789012:android:ffff')
    ).toBeNull()
    const gone = harness([
      {
        method: 'GET',
        path: /androidApps\/1:123456789012:android:abc123def456$/,
        body: { ...fx('android-app'), state: 'DELETED' }
      }
    ])
    expect(await firebaseAdapter.observe(gone.ctx, T_ANDROID, APP_ID)).toBeNull()
  })

  it('every read is inside the pinned project', async () => {
    const h = harness([])
    expect(await firebaseAdapter.observe(h.ctx, T_PROJECT, 'other-project-99')).toBeNull()
    await expect(
      firebaseAdapter.observe(
        h.ctx,
        T_FCM,
        `x@other-project-99.iam.gserviceaccount.com/aaaaaaaaaaaaaaaaaaaaaaaa11111111`
      )
    ).rejects.toMatchObject({
      code: 'FIREBASE_OUT_OF_PROJECT'
    })
    await expect(firebaseAdapter.observe(h.ctx, T_ANDROID, '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    const wrongProject = harness([
      {
        method: 'GET',
        path: /androidApps\/1:123456789012:android:abc123def456$/,
        body: { ...fx('android-app'), projectId: 'other-project-99' }
      }
    ])
    expect(await firebaseAdapter.observe(wrongProject.ctx, T_ANDROID, APP_ID)).toBeNull()
    expect(h.calls.filter((c) => c.host !== 'oauth2.googleapis.com')).toHaveLength(0)
  })

  it('lists apps with a page token, and keys without the connection key', async () => {
    const h = harness([
      {
        method: 'GET',
        path: /androidApps$/,
        body: { ...fx('android-apps'), nextPageToken: 'next-1' }
      },
      { method: 'GET', host: /iam/, path: /serviceAccounts$/, body: fx('sa-accounts') },
      {
        method: 'GET',
        host: /iam/,
        path: /keys$/,
        body: {
          keys: [
            ...fx('sa-keys').keys,
            { name: `projects/${PROJECT}/serviceAccounts/${FCM_EMAIL}/keys/${OWN_KEY_ID}` }
          ]
        }
      }
    ])
    const apps = await firebaseAdapter.list(h.ctx, T_ANDROID)
    expect(apps.items).toHaveLength(1)
    expect(apps.cursor).toBe('next-1')
    const keys = await firebaseAdapter.list(h.ctx, T_FCM)
    expect(keys.items.map((k) => k.fields.key_id)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa11111111'])
  })
})

describe('firebase plan diff per type', () => {
  const ctx = harness([]).ctx

  it('project: add Firebase, rename, never delete, never another project', () => {
    expect(
      firebaseAdapter.plan(ctx, desired(T_PROJECT, { project_id: PROJECT }), null)[0].kind
    ).toBe('create')
    expect(
      firebaseAdapter.plan(
        ctx,
        desired(T_PROJECT, { project_id: PROJECT, display_name: 'Demo app' }, PROJECT),
        projObs()
      )
    ).toEqual([])
    expect(
      firebaseAdapter.plan(
        ctx,
        desired(T_PROJECT, { project_id: PROJECT, display_name: 'New' }, PROJECT),
        projObs()
      )[0].changes
    ).toEqual([{ field: 'display_name', from: 'Demo app', to: 'New' }])
    expect(() => firebaseAdapter.plan(ctx, null, projObs())).toThrow(/cannot be removed/)
    expect(() =>
      firebaseAdapter.plan(ctx, desired(T_PROJECT, { project_id: 'other-project-99' }), null)
    ).toThrow(/pinned/)
    expect(typeSpec(T_PROJECT).capabilities.delete).toBe(false)
  })

  it('app: create, update, replace on a new package, delete', () => {
    const f = { display_name: 'Demo Android', package_name: 'com.example.demo' }
    expect(firebaseAdapter.plan(ctx, desired(T_ANDROID, f), null)[0].kind).toBe('create')
    expect(firebaseAdapter.plan(ctx, desired(T_ANDROID, f, APP_ID), appObs())).toEqual([])
    expect(
      firebaseAdapter.plan(
        ctx,
        desired(T_ANDROID, { ...f, display_name: 'Renamed' }, APP_ID),
        appObs()
      )[0].kind
    ).toBe('update')
    expect(
      firebaseAdapter.plan(
        ctx,
        desired(T_ANDROID, { ...f, package_name: 'com.example.other' }, APP_ID),
        appObs()
      )[0].kind
    ).toBe('replace')
    expect(firebaseAdapter.plan(ctx, null, appObs())[0].kind).toBe('delete')
    expect(() =>
      firebaseAdapter.plan(ctx, desired(T_ANDROID, { display_name: 'X' }), null)
    ).toThrow(ProviderError)
  })

  it('fcm key: create, replace on another account, rotate, delete; never the connection key', () => {
    const f = { service_account: FCM_EMAIL }
    expect(firebaseAdapter.plan(ctx, desired(T_FCM, f), null)[0].kind).toBe('create')
    expect(firebaseAdapter.plan(ctx, desired(T_FCM, f, KEY1), keyObs())).toEqual([])
    expect(
      firebaseAdapter.plan(
        ctx,
        desired(T_FCM, { service_account: `other@${PROJECT}.iam.gserviceaccount.com` }, KEY1),
        keyObs()
      )[0].kind
    ).toBe('replace')
    expect(
      firebaseAdapter.plan(
        ctx,
        desired(T_FCM, { ...f, [ROTATE_OUTPUTS_FIELD]: true }, KEY1),
        keyObs()
      )[0].action
    ).toBe('rotate')
    expect(firebaseAdapter.plan(ctx, null, keyObs())[0].kind).toBe('delete')
    const own: Observed = { ...keyObs(), fields: { ...keyObs().fields, key_id: OWN_KEY_ID } }
    expect(() => firebaseAdapter.plan(ctx, null, own)).toThrow(/connection itself/)
    expect(() =>
      firebaseAdapter.plan(
        ctx,
        desired(T_FCM, { service_account: 'x@other-project-99.iam.gserviceaccount.com' }),
        null
      )
    ).toThrow(/pinned/)
  })
})

describe('firebase apply is idempotent (read-before-write)', () => {
  it('project create refuses one that already has Firebase, else adds and waits', async () => {
    const had = harness([
      { method: 'GET', path: /^\/v1beta1\/projects\/demo-app-12345$/, body: fx('project') }
    ])
    await expect(
      firebaseAdapter.apply(
        had.ctx,
        op(T_PROJECT, { kind: 'create' }),
        desired(T_PROJECT, { project_id: PROJECT })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(had.calls.some((c) => c.method === 'POST' && c.host.startsWith('firebase'))).toBe(false)

    let made = false
    const fresh = harness([
      {
        method: 'POST',
        host: /firebase/,
        path: /:addFirebase$/,
        body: { name: 'operations/op9', done: true, response: {} }
      }
    ])
    const base = fresh.ctx.fetch
    fresh.ctx.fetch = async (url, init) => {
      if (String(init?.method) === 'POST' && url.includes(':addFirebase')) made = true
      if (
        url.includes('/v1beta1/projects/demo-app-12345') &&
        !url.includes(':') &&
        String(init?.method ?? 'GET') === 'GET' &&
        !made
      )
        return new Response('{}', { status: 404 })
      if (
        url.includes('/v1beta1/projects/demo-app-12345') &&
        String(init?.method ?? 'GET') === 'GET' &&
        made
      )
        return new Response(JSON.stringify(fx('project')), { status: 200 })
      return base(url, init)
    }
    const r = await firebaseAdapter.apply(
      fresh.ctx,
      op(T_PROJECT, { kind: 'create' }),
      desired(T_PROJECT, { project_id: PROJECT })
    )
    expect(r.ok).toBe(true)
    expect(r.answer).toEqual({ created: true })
  })

  it('project resumed create is fine; another project is refused', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v1beta1\/projects\/demo-app-12345$/, body: fx('project') }
    ])
    const r = await firebaseAdapter.apply(
      h.ctx,
      op(T_PROJECT, { kind: 'create' }),
      desired(T_PROJECT, { project_id: PROJECT }, PROJECT)
    )
    expect(r.answer).toEqual({ already: 'exists' })
    await expect(
      firebaseAdapter.apply(
        h.ctx,
        op(T_PROJECT, { kind: 'create' }),
        desired(T_PROJECT, { project_id: 'other-project-99' })
      )
    ).rejects.toMatchObject({ code: 'FIREBASE_OUT_OF_PROJECT' })
    await expect(
      firebaseAdapter.apply(h.ctx, op(T_PROJECT, { kind: 'delete' }), null)
    ).rejects.toMatchObject({
      code: 'NOT_SUPPORTED'
    })
  })

  it('app create refuses a match, registers a new one and answers the config as an output', async () => {
    const f = { display_name: 'Demo Android', package_name: 'com.example.demo' }
    const taken = harness(APP_ROUTES)
    await expect(
      firebaseAdapter.apply(taken.ctx, op(T_ANDROID, { kind: 'create' }), desired(T_ANDROID, f))
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })

    const h = harness([
      { method: 'GET', path: /androidApps$/, body: { apps: [] } },
      { method: 'POST', path: /androidApps$/, body: fx('android-op-done') },
      ...APP_ROUTES.slice(0, 2)
    ])
    const r = await firebaseAdapter.apply(
      h.ctx,
      op(T_ANDROID, { kind: 'create' }),
      desired(T_ANDROID, f)
    )
    expect(r.externalId).toBe(APP_ID)
    expect(r.outputs).toMatchObject({ config_filename: 'google-services.json' })
    expect(r.outputs?.config_file).toContain('demo-app-12345')
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('project_info')
    expect(h.calls.find((c) => c.method === 'POST' && c.host.startsWith('firebase'))?.body).toEqual(
      {
        displayName: 'Demo Android',
        packageName: 'com.example.demo'
      }
    )
  })

  it('app update that matches writes nothing; a change patches with a mask; delete removes', async () => {
    const f = { display_name: 'Demo Android', package_name: 'com.example.demo' }
    const same = harness(APP_ROUTES)
    const r = await firebaseAdapter.apply(
      same.ctx,
      op(T_ANDROID, { externalId: APP_ID }),
      desired(T_ANDROID, f, APP_ID)
    )
    expect(r.answer).toEqual({ already: 'matches' })
    expect(
      same.calls.filter((c) => !c.host.startsWith('oauth2')).every((c) => c.method === 'GET')
    ).toBe(true)

    const patch = harness([
      { method: 'PATCH', path: /androidApps\/1:123456789012:android:abc123def456$/, body: {} },
      ...APP_ROUTES
    ])
    await firebaseAdapter.apply(
      patch.ctx,
      op(T_ANDROID, { externalId: APP_ID, changes: [{ field: 'display_name', to: 'Renamed' }] }),
      desired(T_ANDROID, { ...f, display_name: 'Renamed' }, APP_ID)
    )
    const p = patch.calls.find((c) => c.method === 'PATCH')!
    expect(p.query.get('updateMask')).toBe('displayName')
    expect(p.body).toEqual({ displayName: 'Renamed' })

    const del = harness([{ method: 'POST', path: /:remove$/, body: {} }])
    expect(
      (
        await firebaseAdapter.apply(
          del.ctx,
          op(T_ANDROID, { kind: 'delete', externalId: APP_ID }),
          null
        )
      ).observed
    ).toBeNull()
  })

  it('an operation that is not done in time is retryable', async () => {
    const f = { display_name: 'Demo Android', package_name: 'com.example.demo' }
    const h = harness([
      { method: 'GET', path: /androidApps$/, body: { apps: [] } },
      {
        method: 'POST',
        path: /androidApps$/,
        body: { name: 'projects/demo-app-12345/operations/op2', done: false }
      },
      {
        method: 'GET',
        path: /operations\/op2$/,
        body: { name: 'projects/demo-app-12345/operations/op2', done: false }
      }
    ])
    vi.useFakeTimers()
    const run = firebaseAdapter
      .apply(h.ctx, op(T_ANDROID, { kind: 'create' }), desired(T_ANDROID, f))
      .catch((e) => e)
    await vi.advanceTimersByTimeAsync(30_000)
    const err = await run
    vi.useRealTimers()
    expect(err).toMatchObject({ code: 'OPERATION_PENDING', retryable: true })
  })

  it('web app config is the JSON itself; iOS uses the plist file name', async () => {
    const web = harness([
      {
        method: 'GET',
        path: /webApps\/1:123456789012:web:abc123def456\/config$/,
        body: {
          projectId: PROJECT,
          appId: '1:123456789012:web:abc123def456',
          apiKey: 'fake-client-api-key'
        }
      }
    ])
    const out = await firebaseAdapter.readOutputs!(
      web.ctx,
      T_WEB,
      '1:123456789012:web:abc123def456'
    )
    expect(out.config_filename).toBe('firebase-config.json')
    expect(JSON.parse(out.config_file).projectId).toBe(PROJECT)
    expect(typeSpec(T_IOS).outputs?.some((o) => o.key === 'config_file' && !o.secret)).toBe(true)
  })

  it('fcm key create seals the JSON as an output only; resume and rotate behave', async () => {
    const h = harness([
      { method: 'POST', host: /iam/, path: /keys$/, body: fx('sa-key-create') },
      {
        method: 'GET',
        host: /iam/,
        path: /keys\/aaaaaaaaaaaaaaaaaaaaaaaa11111111$/,
        body: fx('sa-keys').keys[0]
      }
    ])
    const r = await firebaseAdapter.apply(
      h.ctx,
      op(T_FCM, { kind: 'create' }),
      desired(T_FCM, { service_account: FCM_EMAIL })
    )
    expect(r.externalId).toBe(`${FCM_EMAIL}/bbbbbbbbbbbbbbbbbbbbbbbb22222222`)
    expect(r.outputs?.service_account_json).toContain('service_account')
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('TESTFAKEKEYDATA')
    expect(
      h.calls.find((c) => c.method === 'POST' && c.host.startsWith('iam'))?.body
    ).toMatchObject({
      privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE'
    })

    const resumed = await firebaseAdapter.apply(
      h.ctx,
      op(T_FCM, { kind: 'create' }),
      desired(T_FCM, { service_account: FCM_EMAIL }, KEY1)
    )
    expect(resumed.outputs).toBeUndefined()
    expect(resumed.answer).toEqual({ already: 'exists' })

    const rot = await firebaseAdapter.apply(
      h.ctx,
      op(T_FCM, { externalId: KEY1, action: 'rotate' }),
      desired(T_FCM, { service_account: FCM_EMAIL }, KEY1)
    )
    expect(rot.answer).toMatchObject({ rotated: true, previous_key_kept: true })
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('fcm key delete works and never deletes the connection key', async () => {
    const h = harness([{ method: 'DELETE', host: /iam/, path: /keys\//, body: {} }])
    await firebaseAdapter.apply(h.ctx, op(T_FCM, { kind: 'delete', externalId: KEY1 }), null)
    expect(h.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    await expect(
      firebaseAdapter.apply(
        h.ctx,
        op(T_FCM, { kind: 'delete', externalId: `${SA_EMAIL}/${OWN_KEY_ID}` }),
        null
      )
    ).rejects.toMatchObject({ code: 'CONNECTION_KEY' })
  })

  it('refuses a step for a different resource', async () => {
    const h = harness(APP_ROUTES)
    await expect(
      firebaseAdapter.apply(
        h.ctx,
        op(T_ANDROID, { externalId: APP_ID }),
        desired(T_ANDROID, { display_name: 'X', package_name: 'a.b' }, '1:1:android:ff')
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })
})

describe('firebase maps 429 to retryable', () => {
  it('429 and 5xx retry, 400 does not', async () => {
    const limited = harness([
      {
        method: 'GET',
        path: /^\/v1beta1\/projects\/demo-app-12345$/,
        status: 429,
        body: { error: { message: 'quota' } }
      }
    ])
    await expect(firebaseAdapter.observe(limited.ctx, T_PROJECT, PROJECT)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    const down = harness([{ method: 'GET', path: /androidApps$/, status: 503, body: {} }])
    await expect(firebaseAdapter.list(down.ctx, T_ANDROID)).rejects.toMatchObject({
      retryable: true
    })
    const bad = harness([
      { method: 'POST', path: /androidApps$/, status: 400, body: { error: { message: 'bad' } } },
      { method: 'GET', path: /androidApps$/, body: { apps: [] } }
    ])
    await expect(
      firebaseAdapter.apply(
        bad.ctx,
        op(T_ANDROID, { kind: 'create' }),
        desired(T_ANDROID, { display_name: 'X', package_name: 'a.b' })
      )
    ).rejects.toMatchObject({ retryable: false })
  })
})

describe('firebase risk flags per type', () => {
  it('flags removals and key deletion', () => {
    expect(typeSpec(T_ANDROID).risk(op(T_ANDROID, { kind: 'delete' }), null)).toEqual([
      'destructive'
    ])
    expect(typeSpec(T_IOS).risk(op(T_IOS, { kind: 'replace' }), null)).toEqual(['destructive'])
    expect(typeSpec(T_WEB).risk(op(T_WEB, { kind: 'update' }), null)).toEqual([])
    expect(typeSpec(T_PROJECT).risk(op(T_PROJECT, { kind: 'create' }), null)).toEqual([])
    expect(typeSpec(T_FCM).risk(op(T_FCM, { kind: 'delete' }), null)).toEqual([
      'destructive',
      'downtime'
    ])
    expect(typeSpec(T_FCM).risk(op(T_FCM, { kind: 'create' }), null)).toEqual([])
  })
})

describe('firebase secrets never appear in errors', () => {
  it('scrubs the private key, its id and the access token from Google text', async () => {
    const h = harness([
      {
        method: 'GET',
        path: /^\/v1beta1\/projects\/demo-app-12345$/,
        status: 403,
        body: {
          error: { message: `denied ${privateKey} ${OWN_KEY_ID} ${ACCESS_TOKEN} ${PK_LINE}` }
        }
      }
    ])
    const err = await firebaseAdapter.observe(h.ctx, T_PROJECT, PROJECT).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    for (const secret of [privateKey, OWN_KEY_ID, ACCESS_TOKEN, PK_LINE])
      expect(err.message).not.toContain(secret)
  })

  it('does not echo a freshly made key when Google rejects the call', async () => {
    const h = harness([
      {
        method: 'POST',
        host: /iam/,
        path: /keys$/,
        status: 400,
        body: { error: { message: `leak ${OWN_KEY_ID}` } }
      }
    ])
    const err = await firebaseAdapter
      .apply(h.ctx, op(T_FCM, { kind: 'create' }), desired(T_FCM, { service_account: FCM_EMAIL }))
      .catch((e) => e)
    expect(err.message).not.toContain(OWN_KEY_ID)
  })
})

describe('firebase declares outputs and none leak into observed/desired', () => {
  it('declares the app config as plain and the FCM key as a once-only secret', () => {
    for (const t of [T_ANDROID, T_IOS, T_WEB])
      expect(typeSpec(t).outputs).toEqual([
        { key: 'config_file', label: 'App config file', secret: false },
        { key: 'config_filename', label: 'Config file name', secret: false }
      ])
    expect(typeSpec(T_FCM).outputs?.[0]).toMatchObject({
      key: 'service_account_json',
      secret: true,
      onceOnly: true
    })
    for (const t of firebaseAdapter.types)
      for (const o of t.outputs ?? []) expect(t.fields.some((f) => f.key === o.key)).toBe(false)
  })

  it('readOutputs never answers a once-only value; no type sends', async () => {
    const h = harness([])
    expect(await firebaseAdapter.readOutputs!(h.ctx, T_FCM, KEY1)).toEqual({})
    expect(firebaseAdapter.notify).toBeUndefined()
    expect(firebaseAdapter.types.some((t) => t.sends)).toBe(false)
  })
})
