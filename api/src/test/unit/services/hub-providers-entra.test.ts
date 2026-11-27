import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { entraAdapter } from '../../../services/hub/providers/entra/index.js'
import { CORE_PROVIDERS } from '../../../services/hub/providers/index.js'
import { graph, graphAll, graphSegment } from '../../../services/hub/providers/microsoft/graph.js'
import type {
  DesiredResource,
  PlannedOp,
  ProviderContext
} from '../../../services/hub/providers/types.js'
import { ProviderError } from '../../../services/hub/providers/types.js'

// Hub third-party providers, Task 14: the Microsoft Entra ID adapter and the shared Graph client
// against recorded Graph answers (providers/entra/__fixtures__, fake values only).

const FIXTURES = join(import.meta.dirname, '../../../services/hub/providers/entra/__fixtures__')
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const APP_RAW = fixture('application.json')
const PAGES = fixture('applications-pages.json')
const CREATED = fixture('password-created.json')
const SP_RAW = fixture('service-principal.json')
const GROUP_RAW = fixture('group.json')
const ASSIGNMENTS = fixture('assignments.json')
const ERRORS = fixture('errors.json')

const TENANT = 'dddddddd-0000-4000-8000-00000000d0d0'
const OWN_CLIENT = 'cccccccc-0000-4000-8000-00000000c0de'
const SECRET = 'test-secret-entra-connection-abcdef'
const CREATED_SECRET = CREATED.secretText as string

const APP = APP_RAW.id as string
const CLIENT = APP_RAW.appId as string
const ROLE_ID = APP_RAW.appRoles[0].id as string
const KEY_ID = APP_RAW.passwordCredentials[0].keyId as string
const SP = SP_RAW.id as string
const GROUP = GROUP_RAW.id as string
const ASSIGNMENT = ASSIGNMENTS.value[0].id as string
const GRAPH_APP = '00000003-0000-0000-c000-000000000000'

const OWNED = ['Application.ReadWrite.OwnedBy', 'AppRoleAssignment.ReadWrite.All', 'Group.Read.All']

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'RS256' })}.${b(claims)}.test-signature`
}

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
  url: string
}
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | undefined
type Routes = Record<string, Answer | ((call: Call) => Answer)>

let nextId = 4000

function setup(
  routes: Routes = {},
  opts: {
    roles?: string[]
    tid?: string
    tokenAnswer?: { status: number; body: unknown }
    secrets?: Record<string, string>
    config?: Record<string, unknown>
    expiresIn?: number
  } = {}
) {
  const calls: Call[] = []
  const state = {
    tokens: 0,
    now: new Date('2026-11-26T12:00:00Z'),
    mint: 0,
    tokenForms: [] as any[]
  }
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const raw = init.body ? String(init.body) : ''
    const isForm = u.hostname === 'login.microsoftonline.com'
    const call: Call = {
      method: String(init.method),
      path: u.pathname.replace(/^\/v1\.0/, ''),
      query: u.searchParams,
      body: raw
        ? isForm
          ? Object.fromEntries(new URLSearchParams(raw))
          : JSON.parse(raw)
        : undefined,
      headers: Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
      ),
      url
    }
    calls.push(call)
    if (isForm) {
      state.tokens++
      state.tokenForms.push({ path: u.pathname, ...call.body })
      const a = opts.tokenAnswer ?? {
        status: 200,
        body: {
          access_token:
            jwt({ roles: opts.roles ?? OWNED, tid: opts.tid ?? TENANT }) +
            (state.mint++ ? `.${state.mint}` : ''),
          expires_in: opts.expiresIn ?? 3600,
          token_type: 'Bearer'
        }
      }
      return new Response(JSON.stringify(a.body), { status: a.status })
    }
    const handler = routes[`${call.method} ${call.path}`]
    const r: NonNullable<Answer> = (typeof handler === 'function' ? handler(call) : handler) ?? {
      status: 404,
      body: ERRORS.notFound
    }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: entraAdapter,
    connectionId: nextId++,
    config: { tenant_id: TENANT, client_id: OWN_CLIENT, ...(opts.config ?? {}) },
    secrets: opts.secrets ?? { client_secret: SECRET },
    now: () => state.now,
    fetch: { fetchImpl }
  })
  return { ctx, calls, state }
}

const graphCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('graph.microsoft.com'))
const writes = (calls: Call[]) => graphCalls(calls).filter((c) => c.method !== 'GET')

function desired(
  type: string,
  fields: Record<string, unknown>,
  over: Partial<DesiredResource> = {}
): DesiredResource {
  return {
    resourceId: 41,
    type,
    externalId: null,
    scope: 'app',
    appId: 7,
    environmentId: 3,
    fields,
    refs: {},
    tags: { 'nivaro-hub:app': '7', 'nivaro-hub:env': '3', 'nivaro-hub:resource': '41' },
    ...over
  } as DesiredResource
}

const appDesired = (over: Record<string, unknown> = {}, extra: Partial<DesiredResource> = {}) =>
  desired(
    'entra.app_registration',
    {
      name: 'Storefront (staging)',
      sign_in_audience: 'AzureADMyOrg',
      web_redirect_uris: ['https://staging.example.com/api/auth/callback'],
      spa_redirect_uris: [],
      logout_url: 'https://staging.example.com/logout',
      ...over
    },
    extra
  )

const secretDesired = (over: Record<string, unknown> = {}, extra: Partial<DesiredResource> = {}) =>
  desired(
    'entra.client_secret',
    { name: 'nivaro-hub', valid_months: 12, ...over },
    { refs: { application: APP }, ...extra }
  )

const roleDesired = (over: Record<string, unknown> = {}, extra: Partial<DesiredResource> = {}) =>
  desired(
    'entra.app_role',
    {
      value: 'editor',
      display_name: 'Editor',
      description: 'Can edit',
      allowed_member_types: ['User'],
      enabled: true,
      ...over
    },
    { refs: { application: APP }, ...extra }
  )

const plan = (d: DesiredResource | null, o: any, ctx?: ProviderContext) =>
  entraAdapter.plan(ctx ?? setup().ctx, d, o)

const op = (over: Partial<PlannedOp> & Pick<PlannedOp, 'kind' | 'type'>): PlannedOp => ({
  resourceId: 41,
  externalId: null,
  reason: 'test',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const appRoute = (raw: any = APP_RAW): Routes => ({
  [`GET /applications/${APP}`]: { status: 200, body: raw }
})

describe('entra registration and connection', () => {
  it('is one entry in CORE_PROVIDERS', () => {
    expect(CORE_PROVIDERS.filter((a) => a.key === 'entra')).toHaveLength(1)
    expect(entraAdapter.types.map((t) => t.key)).toEqual([
      'entra.app_registration',
      'entra.client_secret',
      'entra.service_principal',
      'entra.app_role',
      'entra.group_role_assignment',
      'entra.api_permission',
      'entra.group'
    ])
  })

  it('validates the form: tenant, GUID client id, exactly one credential, thumbprint', () => {
    const v = entraAdapter.connection.validate as NonNullable<
      typeof entraAdapter.connection.validate
    >
    expect(v({ tenant_id: TENANT, client_id: OWN_CLIENT }, { client_secret: SECRET })).toEqual([])
    expect(
      v({ tenant_id: 'contoso.onmicrosoft.com', client_id: OWN_CLIENT }, { client_secret: SECRET })
    ).toEqual([])
    expect(
      v({ tenant_id: 'evil.com/x', client_id: OWN_CLIENT }, { client_secret: SECRET })[0]
    ).toMatch(/tenant/i)
    expect(v({ tenant_id: TENANT, client_id: 'nope' }, { client_secret: SECRET })[0]).toMatch(
      /GUID/
    )
    expect(v({ tenant_id: TENANT, client_id: OWN_CLIENT }, { client_secret: '' })[0]).toMatch(
      /secret or a certificate/
    )
    expect(
      v(
        { tenant_id: TENANT, client_id: OWN_CLIENT },
        { client_secret: SECRET, certificate_key: 'k' }
      )
    ).toContain('Use a client secret or a certificate, not both.')
    expect(
      v({ tenant_id: TENANT, client_id: OWN_CLIENT }, { certificate_key: 'pem' }).join(' ')
    ).toMatch(/thumbprint/)
  })

  it('names exactly Graph and the login host, and describes without secrets', async () => {
    expect(entraAdapter.connection.hosts({ tenant_id: TENANT }).sort()).toEqual([
      'graph.microsoft.com',
      'login.microsoftonline.com'
    ])
    expect(entraAdapter.connection.hosts({ tenant_id: 'bad/host' })).toEqual([])
    const text = entraAdapter.connection.describe({ tenant_id: TENANT, client_id: OWN_CLIENT })
    expect(text).toContain(TENANT)
    expect(text).not.toContain(SECRET)
  })

  it('refuses any other host through ctx.fetch', async () => {
    const { ctx } = setup()
    await expect(ctx.fetch('https://evil.example.com/x')).rejects.toThrow()
    await expect(graph(ctx, 'GET', 'https://evil.example.com/v1.0/x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
  })
})

describe('entra testConnection', () => {
  it('lists missing permissions', async () => {
    const { ctx } = setup({}, { roles: ['Group.Read.All'] })
    const t = await entraAdapter.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.missing).toEqual(
      expect.arrayContaining(['Application.ReadWrite.OwnedBy', 'AppRoleAssignment.ReadWrite.All'])
    )
    expect(t.missing).not.toContain('Group.Read.All')
    expect(t.permissions.find((p) => p.type === 'entra.group')?.has).toBe(true)
    expect(t.permissions.find((p) => p.type === 'entra.app_registration')?.has).toBe(false)
    expect(t.message).toMatch(/admin consent/)
  })

  it('passes with OwnedBy, and warns that ReadWrite.All is broader', async () => {
    const full = await entraAdapter.testConnection(setup({}).ctx)
    expect(full.missing).toEqual([])
    expect(full.message).toBeUndefined()
    expect(full.identity).toContain(TENANT)
    const broad = await entraAdapter.testConnection(
      setup(
        {},
        {
          roles: ['Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Group.Read.All']
        }
      ).ctx
    )
    expect(broad.missing).toEqual([])
    expect(broad.message).toMatch(/OwnedBy is safer/)
  })

  it('answers not ok when the credentials are refused, without the secret', async () => {
    const { ctx } = setup(
      {},
      {
        tokenAnswer: {
          status: 401,
          body: { ...ERRORS.badClient, error_description: `bad ${SECRET}` }
        }
      }
    )
    const t = await entraAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.message).toBeTruthy()
    expect(t.message).not.toContain(SECRET)
  })

  it('refuses a token for another tenant than the pinned one', async () => {
    const { ctx } = setup({}, { tid: 'eeeeeeee-0000-4000-8000-00000000e0e0' })
    const t = await entraAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.message).toMatch(/different tenant/)
  })
})

describe('graph client (shared)', () => {
  it('mints once, caches the token, and mints again after a 401', async () => {
    const seen: string[] = []
    const { ctx, state } = setup({
      'GET /ping': (c) => {
        seen.push(c.headers.authorization ?? '')
        return seen.length === 1
          ? {
              status: 401,
              body: { error: { code: 'InvalidAuthenticationToken', message: 'expired' } }
            }
          : { status: 200, body: { ok: true } }
      }
    })
    await graph(ctx, 'GET', '/ping')
    expect(state.tokens).toBe(2)
    expect(seen[0]).not.toBe(seen[1])
    await graph(ctx, 'GET', '/ping')
    expect(state.tokens).toBe(2)
  })

  it('sends the client credentials grant for the Graph .default scope', async () => {
    const { ctx, state } = setup({ 'GET /ping': { status: 200, body: {} } })
    await graph(ctx, 'GET', '/ping')
    const form = state.tokenForms[0]
    expect(form.path).toBe(`/${TENANT}/oauth2/v2.0/token`)
    expect(form.grant_type).toBe('client_credentials')
    expect(form.scope).toBe('https://graph.microsoft.com/.default')
    expect(form.client_secret).toBe(SECRET)
  })

  it('signs in with a certificate key: an assertion with the thumbprint, no client secret', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const { ctx, state } = setup(
      { 'GET /ping': { status: 200, body: {} } },
      {
        secrets: { certificate_key: pem },
        config: { certificate_thumbprint: 'AB'.repeat(20) }
      }
    )
    await graph(ctx, 'GET', '/ping')
    const form = state.tokenForms[0]
    expect(form.client_secret).toBeUndefined()
    expect(form.client_assertion_type).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    )
    const [h, c] = String(form.client_assertion).split('.')
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
    expect(header.alg).toBe('RS256')
    expect(header.x5t).toBe(Buffer.from('ab'.repeat(20), 'hex').toString('base64url'))
    expect(claims.iss).toBe(OWN_CLIENT)
    expect(claims.aud).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
  })

  it('follows @odata.nextLink and refuses a link to another host', async () => {
    const { ctx, calls } = setup({
      'GET /applications': (c) =>
        c.query.get('$skiptoken') === 'page2'
          ? { status: 200, body: PAGES.page2 }
          : { status: 200, body: PAGES.page1 }
    })
    const all = await graphAll(ctx, '/applications', { query: { $top: 50 } })
    expect(all.map((a: any) => a.displayName)).toEqual(['Storefront (staging)', 'Back office'])
    expect(graphCalls(calls)).toHaveLength(2)
    const evil = setup({
      'GET /applications': {
        status: 200,
        body: { value: [], '@odata.nextLink': 'https://evil.example.com/v1.0/applications?x=1' }
      }
    })
    await expect(graphAll(evil.ctx, '/applications')).rejects.toMatchObject({ code: 'BAD_ID' })
  })

  it('waits for a short Retry-After and retries; a long one is retryable', async () => {
    let n = 0
    const { ctx } = setup({
      'GET /slow': () =>
        ++n === 1
          ? { status: 429, body: ERRORS.throttled, headers: { 'retry-after': '0' } }
          : { status: 200, body: { ok: true } },
      'GET /busy': { status: 429, body: ERRORS.throttled, headers: { 'retry-after': '30' } }
    })
    expect((await graph(ctx, 'GET', '/slow')).status).toBe(200)
    expect(n).toBe(2)
    await expect(graph(ctx, 'GET', '/busy')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      status: 429
    })
  })

  it('refuses ids that are not safe path segments', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\nb'])
      expect(() => graphSegment(bad)).toThrow(ProviderError)
    expect(graphSegment('abc-123')).toBe('abc-123')
  })
})

describe('entra observe maps provider fields', () => {
  it('app registration: whitelisted fields, tags, no credentials', async () => {
    const { ctx, calls } = setup(appRoute())
    const o = await entraAdapter.observe(ctx, 'entra.app_registration', APP)
    expect(o).toMatchObject({
      externalId: APP,
      name: 'Storefront (staging)',
      fields: {
        sign_in_audience: 'AzureADMyOrg',
        web_redirect_uris: ['https://staging.example.com/api/auth/callback'],
        logout_url: 'https://staging.example.com/logout',
        app_id: CLIENT
      },
      tags: { 'nivaro-hub:app': '7', 'nivaro-hub:resource': '41' }
    })
    expect(JSON.stringify(o)).not.toContain('passwordCredentials')
    expect(JSON.stringify(o)).not.toContain('"hint"')
    // The read asks only for the whitelisted properties: never credentials.
    const sel = graphCalls(calls)[0].query.get('$select') ?? ''
    expect(sel).not.toMatch(/passwordCredentials|keyCredentials/)
  })

  it('null for a missing resource, and a bad id is refused before any call', async () => {
    const { ctx, calls } = setup({})
    expect(await entraAdapter.observe(ctx, 'entra.app_registration', APP)).toBeNull()
    await expect(entraAdapter.observe(ctx, 'entra.app_registration', '../x')).rejects.toMatchObject(
      {
        code: 'BAD_ID'
      }
    )
    expect(graphCalls(calls)).toHaveLength(1)
  })

  it('client secret: id, name and dates, older siblings, never the hint or text', async () => {
    const withOld = {
      ...APP_RAW,
      passwordCredentials: [
        ...APP_RAW.passwordCredentials,
        {
          keyId: '55555555-0000-4000-8000-000000000001',
          displayName: 'nivaro-hub (rotated 20261001T000000Z)',
          endDateTime: '2027-10-01T00:00:00Z'
        },
        {
          keyId: '55555555-0000-4000-8000-000000000002',
          displayName: 'other-tool',
          endDateTime: '2027-10-01T00:00:00Z'
        }
      ]
    }
    const { ctx } = setup({ [`GET /applications/${APP}`]: { status: 200, body: withOld } })
    const o = await entraAdapter.observe(ctx, 'entra.client_secret', `${APP}:${KEY_ID}`)
    expect(o).toMatchObject({
      externalId: `${APP}:${KEY_ID}`,
      fields: {
        application: APP,
        name: 'nivaro-hub',
        key_id: KEY_ID,
        expires_at: '2027-11-01T00:00:00Z',
        older_secrets: ['55555555-0000-4000-8000-000000000001']
      },
      status: 'active'
    })
    expect(JSON.stringify(o)).not.toMatch(/hint|secretText/)
  })

  it('app role and API permission come from the application object', async () => {
    const { ctx } = setup(appRoute())
    expect(await entraAdapter.observe(ctx, 'entra.app_role', `${APP}:${ROLE_ID}`)).toMatchObject({
      name: 'admin',
      fields: {
        value: 'admin',
        display_name: 'Administrator',
        enabled: true,
        allowed_member_types: ['User']
      }
    })
    expect(await entraAdapter.observe(ctx, 'entra.app_role', `${APP}:${APP}`)).toBeNull()
    expect(
      await entraAdapter.observe(ctx, 'entra.api_permission', `${APP}:${GRAPH_APP}`)
    ).toMatchObject({
      fields: {
        resource_app_id: GRAPH_APP,
        permissions: [
          { id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' },
          { id: '5b567255-7703-4780-807c-7be8301ae99b', type: 'Role' }
        ]
      }
    })
  })

  it('service principal carries the application object id; a group maps read-only fields', async () => {
    const { ctx } = setup({
      [`GET /servicePrincipals/${SP}`]: { status: 200, body: SP_RAW },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } },
      [`GET /groups/${GROUP}`]: { status: 200, body: GROUP_RAW }
    })
    expect(await entraAdapter.observe(ctx, 'entra.service_principal', SP)).toMatchObject({
      fields: { application: APP, app_id: CLIENT, assignment_required: false, enabled: true }
    })
    expect(await entraAdapter.observe(ctx, 'entra.group', GROUP)).toMatchObject({
      name: 'Storefront admins',
      fields: { security_enabled: true, membership: 'assigned' }
    })
  })

  it('group role assignment: only Group principals, role as app:role id', async () => {
    const { ctx } = setup({
      [`GET /servicePrincipals/${SP}`]: { status: 200, body: SP_RAW },
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: ASSIGNMENTS },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } }
    })
    const hit = await entraAdapter.observe(
      ctx,
      'entra.group_role_assignment',
      `${SP}:${ASSIGNMENT}`
    )
    expect(hit).toMatchObject({
      fields: { service_principal: SP, group: GROUP, app_role: `${APP}:${ROLE_ID}` }
    })
    // A person's assignment is not this type.
    expect(
      await entraAdapter.observe(
        ctx,
        'entra.group_role_assignment',
        `${SP}:${ASSIGNMENTS.value[1].id}`
      )
    ).toBeNull()
  })

  it('lists applications page by page with the next link as cursor', async () => {
    const { ctx } = setup({
      'GET /applications': (c) =>
        c.query.get('$skiptoken') === 'page2'
          ? { status: 200, body: PAGES.page2 }
          : { status: 200, body: PAGES.page1 }
    })
    const p1 = await entraAdapter.list(ctx, 'entra.app_registration')
    expect(p1.items.map((i) => i.name)).toEqual(['Storefront (staging)'])
    expect(p1.cursor).toContain('skiptoken=page2')
    const p2 = await entraAdapter.list(ctx, 'entra.app_registration', p1.cursor)
    expect(p2.items.map((i) => i.name)).toEqual(['Back office'])
    expect(p2.cursor).toBeNull()
  })

  it('lists groups and role assignments of the enterprise applications it walks', async () => {
    const { ctx } = setup({
      'GET /groups': { status: 200, body: { value: [GROUP_RAW] } },
      'GET /servicePrincipals': { status: 200, body: { value: [{ id: SP, appId: CLIENT }] } },
      [`GET /servicePrincipals/${SP}`]: { status: 200, body: SP_RAW },
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: ASSIGNMENTS },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } }
    })
    expect((await entraAdapter.list(ctx, 'entra.group')).items).toHaveLength(1)
    const a = await entraAdapter.list(ctx, 'entra.group_role_assignment')
    expect(a.items).toHaveLength(1)
    expect(a.items[0].externalId).toBe(`${SP}:${ASSIGNMENT}`)
  })
})

describe('entra plan diff per type', () => {
  const observedApp = (over: Record<string, unknown> = {}) => ({
    type: 'entra.app_registration',
    externalId: APP,
    name: 'Storefront (staging)',
    fields: {
      name: 'Storefront (staging)',
      sign_in_audience: 'AzureADMyOrg',
      web_redirect_uris: ['https://staging.example.com/api/auth/callback'],
      spa_redirect_uris: [],
      logout_url: 'https://staging.example.com/logout',
      app_id: CLIENT,
      ...over
    },
    tags: { 'nivaro-hub:app': '7', 'nivaro-hub:env': '3', 'nivaro-hub:resource': '41' }
  })

  it('app registration: create, noop, update and delete', () => {
    expect(plan(appDesired(), null)[0]).toMatchObject({ kind: 'create', externalId: null })
    expect(plan(appDesired(), observedApp())[0].kind).toBe('noop')
    const up = plan(
      appDesired({ name: 'Storefront (prod)', web_redirect_uris: ['https://a.example.com/cb'] }),
      observedApp()
    )[0]
    expect(up.kind).toBe('update')
    expect(up.changes.map((c) => c.field).sort()).toEqual(['name', 'web_redirect_uris'])
    expect(up.preconditions.name).toBe('Storefront (staging)')
    expect(plan(null, observedApp())[0]).toMatchObject({ kind: 'delete', externalId: APP })
    expect(plan(null, null)).toEqual([])
    // A missing resource tag is planned as a tag change, not a field.
    const tagless = { ...observedApp(), tags: {} }
    expect(plan(appDesired(), tagless)[0].changes.map((c) => c.field)).toEqual(['tags'])
  })

  it('client secret: create, rotate and remove_older are named ops; nothing else edits it', () => {
    const o = {
      type: 'entra.client_secret',
      externalId: `${APP}:${KEY_ID}`,
      name: 'nivaro-hub',
      fields: { application: APP, name: 'nivaro-hub', key_id: KEY_ID, older_secrets: ['k2'] },
      tags: {}
    }
    expect(plan(secretDesired(), null)[0].kind).toBe('create')
    expect(plan(secretDesired(), o)[0].kind).toBe('noop')
    const rot = plan(secretDesired({ rotate_outputs: true }), o)[0]
    expect(rot).toMatchObject({ kind: 'update', action: 'rotate' })
    expect(rot.data).toEqual({ $oneShot: ['rotate_outputs'] })
    const rm = plan(secretDesired({ remove_older: true }), o)[0]
    expect(rm).toMatchObject({ kind: 'update', action: 'remove_older' })
    expect(rm.reason).toMatch(/1 older secret/)
    expect(plan(null, o)[0].kind).toBe('delete')
  })

  it('app role, service principal, permissions and assignment', () => {
    const role = {
      type: 'entra.app_role',
      externalId: `${APP}:${ROLE_ID}`,
      name: 'admin',
      fields: {
        application: APP,
        value: 'admin',
        display_name: 'Administrator',
        description: 'Can manage the app',
        allowed_member_types: ['User'],
        enabled: true
      },
      tags: {}
    }
    expect(plan(roleDesired(), null)[0].kind).toBe('create')
    const rd = roleDesired({
      value: 'admin',
      display_name: 'Administrator',
      description: 'Can manage the app'
    })
    expect(plan(rd, role)[0].kind).toBe('noop')
    expect(
      plan(
        roleDesired({ value: 'admin', display_name: 'Boss', description: 'Can manage the app' }),
        role
      )[0].changes.map((c) => c.field)
    ).toEqual(['display_name'])
    expect(plan(null, role)[0].kind).toBe('delete')

    const sp = {
      type: 'entra.service_principal',
      externalId: SP,
      name: 'x',
      fields: { app_id: CLIENT, assignment_required: false, enabled: true },
      tags: { 'nivaro-hub:app': '7', 'nivaro-hub:env': '3', 'nivaro-hub:resource': '41' }
    }
    const spd = desired(
      'entra.service_principal',
      { assignment_required: true, enabled: true },
      { refs: { application: APP } }
    )
    expect(plan(spd, null)[0].kind).toBe('create')
    expect(plan(spd, sp)[0].changes.map((c) => c.field)).toEqual(['assignment_required'])

    const perm = {
      type: 'entra.api_permission',
      externalId: `${APP}:${GRAPH_APP}`,
      name: 'p',
      fields: {
        application: APP,
        resource_app_id: GRAPH_APP,
        permissions: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }]
      },
      tags: {}
    }
    const pd = desired(
      'entra.api_permission',
      {
        resource_app_id: GRAPH_APP,
        permissions: [{ type: 'Scope', id: 'E1FE6DD8-BA31-4D61-89E7-88639DA4683D' }]
      },
      { refs: { application: APP } }
    )
    // Same permission, other order and letter case of the keys: nothing to do.
    expect(
      plan(
        {
          ...pd,
          fields: {
            ...pd.fields,
            permissions: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }]
          }
        },
        perm
      )[0].kind
    ).toBe('noop')
    const more = desired(
      'entra.api_permission',
      {
        resource_app_id: GRAPH_APP,
        permissions: [
          { id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' },
          { id: '5b567255-7703-4780-807c-7be8301ae99b', type: 'Role' }
        ]
      },
      { refs: { application: APP } }
    )
    expect(plan(more, perm)[0].kind).toBe('update')

    const asn = {
      type: 'entra.group_role_assignment',
      externalId: `${SP}:${ASSIGNMENT}`,
      name: 'g',
      fields: { service_principal: SP, group: GROUP, app_role: `${APP}:${ROLE_ID}` },
      tags: {}
    }
    const ad = desired(
      'entra.group_role_assignment',
      {},
      { refs: { service_principal: SP, group: GROUP, app_role: `${APP}:${ROLE_ID}` } }
    )
    expect(plan(ad, null)[0].kind).toBe('create')
    expect(plan(ad, asn)[0].kind).toBe('noop')
    expect(plan({ ...ad, refs: { ...ad.refs, group: 'other' } }, asn)[0].kind).toBe('replace')
    expect(plan(null, asn)[0].kind).toBe('delete')
  })

  it('a group is never planned for create, update or delete', () => {
    const g = { type: 'entra.group', externalId: GROUP, name: 'g', fields: {}, tags: {} }
    expect(plan(desired('entra.group', {}), null)).toEqual([])
    expect(plan(null, g)).toEqual([])
    expect(plan(desired('entra.group', {}), g)[0].kind).toBe('noop')
  })
})

describe('entra risk flags per type', () => {
  const risk = (type: string, o: PlannedOp, d: DesiredResource | null = null) =>
    entraAdapter.types.find((t) => t.key === type)?.risk(o, d) ?? []
  const change = (field: string, from: unknown, to: unknown) => ({ field, from, to })

  it('app registration', () => {
    expect(
      risk('entra.app_registration', op({ kind: 'delete', type: 'entra.app_registration' }))
    ).toEqual(expect.arrayContaining(['destructive', 'downtime']))
    expect(
      risk(
        'entra.app_registration',
        op({
          kind: 'update',
          type: 'entra.app_registration',
          changes: [change('sign_in_audience', 'AzureADMyOrg', 'AzureADMultipleOrgs')]
        })
      )
    ).toEqual(['public_exposure'])
    expect(
      risk(
        'entra.app_registration',
        op({
          kind: 'update',
          type: 'entra.app_registration',
          changes: [change('web_redirect_uris', [], ['http://example.com/cb'])]
        })
      )
    ).toEqual(['public_exposure'])
    expect(
      risk(
        'entra.app_registration',
        op({
          kind: 'update',
          type: 'entra.app_registration',
          changes: [
            change(
              'web_redirect_uris',
              [],
              ['http://localhost:3000/cb', 'https://a.example.com/cb']
            )
          ]
        })
      )
    ).toEqual([])
    expect(
      risk(
        'entra.app_registration',
        op({ kind: 'update', type: 'entra.app_registration', changes: [change('name', 'a', 'b')] })
      )
    ).toEqual([])
  })

  it('client secret, service principal, role, assignment, permissions', () => {
    expect(
      risk('entra.client_secret', op({ kind: 'delete', type: 'entra.client_secret' }))
    ).toEqual(['destructive', 'downtime'])
    expect(
      risk(
        'entra.client_secret',
        op({ kind: 'update', type: 'entra.client_secret', action: 'remove_older' })
      )
    ).toEqual(['destructive'])
    expect(
      risk(
        'entra.client_secret',
        op({ kind: 'update', type: 'entra.client_secret', action: 'rotate' })
      )
    ).toEqual([])
    expect(
      risk(
        'entra.service_principal',
        op({
          kind: 'update',
          type: 'entra.service_principal',
          changes: [change('assignment_required', false, true)]
        })
      )
    ).toEqual(['downtime'])
    expect(
      risk('entra.service_principal', op({ kind: 'delete', type: 'entra.service_principal' }))
    ).toEqual(expect.arrayContaining(['destructive', 'downtime']))
    expect(
      risk(
        'entra.app_role',
        op({ kind: 'update', type: 'entra.app_role', changes: [change('value', 'a', 'b')] })
      )
    ).toEqual(['downtime'])
    expect(risk('entra.app_role', op({ kind: 'delete', type: 'entra.app_role' }))).toEqual(
      expect.arrayContaining(['destructive', 'downtime'])
    )
    expect(
      risk(
        'entra.group_role_assignment',
        op({ kind: 'delete', type: 'entra.group_role_assignment' })
      )
    ).toEqual(['downtime'])
    expect(
      risk(
        'entra.group_role_assignment',
        op({ kind: 'create', type: 'entra.group_role_assignment' })
      )
    ).toEqual([])
    const added = change('permissions', [], [{ id: 'x', type: 'Role' }])
    expect(
      risk(
        'entra.api_permission',
        op({ kind: 'create', type: 'entra.api_permission', changes: [added] })
      )
    ).toEqual(['public_exposure'])
    expect(
      risk(
        'entra.api_permission',
        op({
          kind: 'create',
          type: 'entra.api_permission',
          changes: [change('permissions', [], [{ id: 'x', type: 'Scope' }])]
        })
      )
    ).toEqual([])
    expect(risk('entra.group', op({ kind: 'noop', type: 'entra.group' }))).toEqual([])
  })

  it('marks reversibility and capabilities', () => {
    const spec = (k: string) => entraAdapter.types.find((t) => t.key === k)!
    expect(spec('entra.client_secret').reversible).toBe(false)
    expect(spec('entra.app_registration').reversible).toBe(true)
    expect(spec('entra.group').scope).toBe('shared')
    expect(spec('entra.group').capabilities).toMatchObject({
      create: false,
      update: false,
      delete: false,
      adopt: true
    })
    // Entra app registrations, secrets and roles cost nothing: no costClass, so no estimate needed.
    for (const t of entraAdapter.types) expect(t.costClass).toBeUndefined()
  })
})

describe('entra apply is idempotent (read-before-write)', () => {
  it('creates an app registration with the tag, and answers client_id and tenant_id outputs', async () => {
    const { ctx, calls } = setup({
      'GET /applications': { status: 200, body: { value: [] } },
      'POST /applications': (c) => ({
        status: 201,
        body: { ...APP_RAW, displayName: c.body.displayName, tags: c.body.tags }
      })
    })
    const r = await entraAdapter.apply(
      ctx,
      op({ kind: 'create', type: 'entra.app_registration' }),
      appDesired()
    )
    expect(r.ok).toBe(true)
    expect(r.externalId).toBe(APP)
    expect(r.outputs).toEqual({ client_id: CLIENT, tenant_id: TENANT })
    const post = writes(calls)[0]
    expect(post.body.signInAudience).toBe('AzureADMyOrg')
    expect(post.body.tags).toEqual([
      'nivaro-hub:app=7',
      'nivaro-hub:env=3',
      'nivaro-hub:resource=41'
    ])
    expect(post.body.web).toEqual({
      redirectUris: ['https://staging.example.com/api/auth/callback'],
      logoutUrl: 'https://staging.example.com/logout'
    })
  })

  it('a create rerun finds the app registration by its tag and does not create twice', async () => {
    const { ctx, calls } = setup({
      'GET /applications': { status: 200, body: { value: [APP_RAW] } }
    })
    const r = await entraAdapter.apply(
      ctx,
      op({ kind: 'create', type: 'entra.app_registration' }),
      appDesired()
    )
    expect(r.externalId).toBe(APP)
    expect(writes(calls)).toEqual([])
    const filter = graphCalls(calls)[0].query.get('$filter') ?? ''
    expect(filter).toContain("tags/any(t:t eq 'nivaro-hub:resource=41')")
    expect(graphCalls(calls)[0].headers.consistencylevel).toBe('eventual')
  })

  it('an update patches only the changed fields and keeps other tags', async () => {
    let patched: any
    const { ctx } = setup({
      [`GET /applications/${APP}`]: {
        status: 200,
        body: { ...APP_RAW, tags: ['Custom', 'nivaro-hub:app=1'] }
      },
      [`PATCH /applications/${APP}`]: (c) => {
        patched = c.body
        return { status: 204 }
      }
    })
    await entraAdapter.apply(
      ctx,
      op({ kind: 'update', type: 'entra.app_registration', externalId: APP }),
      appDesired({ name: 'Storefront (prod)' }, { externalId: APP })
    )
    expect(patched.displayName).toBe('Storefront (prod)')
    expect(patched.tags).toEqual(
      expect.arrayContaining([
        'Custom',
        'nivaro-hub:app=7',
        'nivaro-hub:env=3',
        'nivaro-hub:resource=41'
      ])
    )
    expect(patched.web).toBeUndefined()
    expect(patched.signInAudience).toBeUndefined()
  })

  it('an update that is already in place writes nothing; a delete of something gone succeeds', async () => {
    const { ctx, calls } = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW }
    })
    await entraAdapter.apply(
      ctx,
      op({ kind: 'update', type: 'entra.app_registration', externalId: APP }),
      appDesired({}, { externalId: APP })
    )
    expect(writes(calls)).toEqual([])
    const gone = setup({})
    const r = await entraAdapter.apply(
      gone.ctx,
      op({ kind: 'delete', type: 'entra.app_registration', externalId: APP }),
      null
    )
    expect(r.ok).toBe(true)
    expect(writes(gone.calls)).toEqual([])
  })

  it('an update of a vanished resource fails NOT_FOUND', async () => {
    const { ctx } = setup({})
    await expect(
      entraAdapter.apply(
        ctx,
        op({ kind: 'update', type: 'entra.app_registration', externalId: APP }),
        appDesired({}, { externalId: APP })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('never writes the connection’s own app registration (SELF_APP)', async () => {
    const own = { ...APP_RAW, appId: OWN_CLIENT }
    const { ctx, calls } = setup({
      [`GET /applications/${APP}`]: { status: 200, body: own },
      [`GET /servicePrincipals/${SP}`]: { status: 200, body: { ...SP_RAW, appId: OWN_CLIENT } }
    })
    await expect(
      entraAdapter.apply(
        ctx,
        op({ kind: 'update', type: 'entra.app_registration', externalId: APP }),
        appDesired({ name: 'x' }, { externalId: APP })
      )
    ).rejects.toMatchObject({ code: 'SELF_APP' })
    await expect(
      entraAdapter.apply(
        ctx,
        op({ kind: 'delete', type: 'entra.app_registration', externalId: APP }),
        null
      )
    ).rejects.toMatchObject({ code: 'SELF_APP' })
    await expect(
      entraAdapter.apply(ctx, op({ kind: 'create', type: 'entra.client_secret' }), secretDesired())
    ).rejects.toMatchObject({ code: 'SELF_APP' })
    await expect(
      entraAdapter.apply(
        ctx,
        op({ kind: 'delete', type: 'entra.service_principal', externalId: SP }),
        null
      )
    ).rejects.toMatchObject({ code: 'SELF_APP' })
    expect(writes(calls)).toEqual([])
  })

  it('a client secret create returns the value as an output only, once', async () => {
    const { ctx, calls } = setup({
      [`GET /applications/${APP}`]: (c) => ({
        status: 200,
        body: c.query.get('$select')?.includes('passwordCredentials')
          ? { id: APP, appId: CLIENT, passwordCredentials: [] }
          : APP_RAW
      }),
      [`POST /applications/${APP}/addPassword`]: { status: 200, body: CREATED }
    })
    const r = await entraAdapter.apply(
      ctx,
      op({ kind: 'create', type: 'entra.client_secret' }),
      secretDesired()
    )
    expect(r.outputs).toEqual({ client_secret: CREATED_SECRET })
    expect(r.externalId).toBe(`${APP}:${CREATED.keyId}`)
    const rest = JSON.stringify({ ...r, outputs: undefined })
    expect(rest).not.toContain(CREATED_SECRET)
    const post = writes(calls)[0]
    expect(post.body.passwordCredential.displayName).toBe('nivaro-hub')
    expect(post.body.passwordCredential.endDateTime).toBe('2027-11-26T12:00:00.000Z')
  })

  it('a client secret create refuses an existing secret of that name (ALREADY_EXISTS) unless it is the Hub’s own', async () => {
    const routes: Routes = {
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW }
    }
    const a = setup(routes)
    await expect(
      entraAdapter.apply(
        a.ctx,
        op({ kind: 'create', type: 'entra.client_secret' }),
        secretDesired()
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes(a.calls)).toEqual([])
    // A resumed create (the Hub already recorded the id) reads it, writes nothing, shows no value.
    const b = setup(routes)
    const r = await entraAdapter.apply(
      b.ctx,
      op({ kind: 'create', type: 'entra.client_secret' }),
      secretDesired({}, { externalId: `${APP}:${KEY_ID}` })
    )
    expect(r.ok).toBe(true)
    expect(r.outputs).toBeUndefined()
    expect(writes(b.calls)).toEqual([])
  })

  it('rotate makes a new secret next to the current one; remove_older deletes only the Hub’s own older ones', async () => {
    const withOld = {
      ...APP_RAW,
      passwordCredentials: [
        ...APP_RAW.passwordCredentials,
        {
          keyId: '55555555-0000-4000-8000-000000000001',
          displayName: 'nivaro-hub (rotated 20261001T000000Z)',
          endDateTime: '2027-10-01T00:00:00Z'
        },
        {
          keyId: '55555555-0000-4000-8000-000000000002',
          displayName: 'other-tool',
          endDateTime: '2027-10-01T00:00:00Z'
        }
      ]
    }
    const r = setup({
      [`GET /applications/${APP}`]: { status: 200, body: withOld },
      [`POST /applications/${APP}/addPassword`]: (c) => ({
        status: 200,
        body: { ...CREATED, displayName: c.body.passwordCredential.displayName }
      })
    })
    const rot = await entraAdapter.apply(
      r.ctx,
      op({
        kind: 'update',
        type: 'entra.client_secret',
        externalId: `${APP}:${KEY_ID}`,
        action: 'rotate'
      }),
      secretDesired({ rotate_outputs: true }, { externalId: `${APP}:${KEY_ID}` })
    )
    expect(rot.outputs).toEqual({ client_secret: CREATED_SECRET })
    expect(rot.externalId).toBe(`${APP}:${CREATED.keyId}`)
    expect(writes(r.calls)).toHaveLength(1)
    expect(writes(r.calls)[0].body.passwordCredential.displayName).toBe(
      'nivaro-hub (rotated 20261126T120000Z)'
    )

    const removed: string[] = []
    const m = setup({
      [`GET /applications/${APP}`]: { status: 200, body: withOld },
      [`POST /applications/${APP}/removePassword`]: (c) => {
        removed.push(c.body.keyId)
        return { status: 204 }
      }
    })
    const res = await entraAdapter.apply(
      m.ctx,
      op({
        kind: 'update',
        type: 'entra.client_secret',
        externalId: `${APP}:${KEY_ID}`,
        action: 'remove_older'
      }),
      secretDesired({ remove_older: true }, { externalId: `${APP}:${KEY_ID}` })
    )
    expect(removed).toEqual(['55555555-0000-4000-8000-000000000001'])
    expect(res.answer).toMatchObject({ removed: 1 })
  })

  it('remove_older of a secret that is gone removes nothing', async () => {
    const m = setup({
      [`GET /applications/${APP}`]: { status: 200, body: { ...APP_RAW, passwordCredentials: [] } }
    })
    await expect(
      entraAdapter.apply(
        m.ctx,
        op({
          kind: 'update',
          type: 'entra.client_secret',
          externalId: `${APP}:${KEY_ID}`,
          action: 'remove_older'
        }),
        secretDesired({}, { externalId: `${APP}:${KEY_ID}` })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(writes(m.calls)).toEqual([])
  })

  it('a client secret delete removes that key only, and is a success when it is gone', async () => {
    const removed: string[] = []
    const a = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      [`POST /applications/${APP}/removePassword`]: (c) => {
        removed.push(c.body.keyId)
        return { status: 204 }
      }
    })
    await entraAdapter.apply(
      a.ctx,
      op({ kind: 'delete', type: 'entra.client_secret', externalId: `${APP}:${KEY_ID}` }),
      null
    )
    expect(removed).toEqual([KEY_ID])
    const b = setup({
      [`GET /applications/${APP}`]: { status: 200, body: { ...APP_RAW, passwordCredentials: [] } }
    })
    expect(
      (
        await entraAdapter.apply(
          b.ctx,
          op({ kind: 'delete', type: 'entra.client_secret', externalId: `${APP}:${KEY_ID}` }),
          null
        )
      ).ok
    ).toBe(true)
    expect(writes(b.calls)).toEqual([])
  })

  it('a secret created before the app registration is visible is a retryable REPLICATION_PENDING', async () => {
    const { ctx } = setup({
      [`GET /applications/${APP}`]: (c) => ({
        status: 200,
        body: c.query.get('$select')?.includes('passwordCredentials')
          ? { id: APP, appId: CLIENT, passwordCredentials: [] }
          : APP_RAW
      }),
      [`POST /applications/${APP}/addPassword`]: { status: 404, body: ERRORS.notFound }
    })
    await expect(
      entraAdapter.apply(ctx, op({ kind: 'create', type: 'entra.client_secret' }), secretDesired())
    ).rejects.toMatchObject({ code: 'REPLICATION_PENDING', retryable: true })
  })

  it('an app role gets a stable id, is written into appRoles, and a duplicate value is refused', async () => {
    const roles: any[] = []
    const a = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      [`PATCH /applications/${APP}`]: (c) => {
        roles.push(c.body.appRoles)
        return { status: 204 }
      }
    })
    const r1 = await entraAdapter.apply(
      a.ctx,
      op({ kind: 'create', type: 'entra.app_role' }),
      roleDesired()
    )
    const written = roles[0].find((x: any) => x.value === 'editor')
    expect(roles[0]).toHaveLength(2)
    expect(r1.externalId).toBe(`${APP}:${written.id}`)
    expect(written).toMatchObject({
      displayName: 'Editor',
      isEnabled: true,
      allowedMemberTypes: ['User']
    })
    // The same Hub resource asked again gets the same role id (a resumed create finds its own).
    const b = setup({
      [`GET /applications/${APP}`]: {
        status: 200,
        body: { ...APP_RAW, appRoles: [...APP_RAW.appRoles, written] }
      },
      [`PATCH /applications/${APP}`]: { status: 204 }
    })
    await entraAdapter.apply(b.ctx, op({ kind: 'create', type: 'entra.app_role' }), roleDesired())
    expect(writes(b.calls)).toEqual([])
    // A role of that value the Hub did not make is never patched.
    const c = setup({ [`GET /applications/${APP}`]: { status: 200, body: APP_RAW } })
    await expect(
      entraAdapter.apply(
        c.ctx,
        op({ kind: 'create', type: 'entra.app_role' }),
        roleDesired({ value: 'admin' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(c.calls)).toEqual([])
  })

  it('an app role delete switches it off first, then removes it; already gone is a success', async () => {
    const bodies: any[] = []
    const a = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      [`PATCH /applications/${APP}`]: (c) => {
        bodies.push(c.body.appRoles)
        return { status: 204 }
      }
    })
    await entraAdapter.apply(
      a.ctx,
      op({ kind: 'delete', type: 'entra.app_role', externalId: `${APP}:${ROLE_ID}` }),
      null
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[0][0]).toMatchObject({ id: ROLE_ID, isEnabled: false })
    expect(bodies[1]).toEqual([])
    const b = setup({
      [`GET /applications/${APP}`]: { status: 200, body: { ...APP_RAW, appRoles: [] } }
    })
    expect(
      (
        await entraAdapter.apply(
          b.ctx,
          op({ kind: 'delete', type: 'entra.app_role', externalId: `${APP}:${ROLE_ID}` }),
          null
        )
      ).ok
    ).toBe(true)
    expect(writes(b.calls)).toEqual([])
  })

  it('an app role update patches only that role', async () => {
    let patched: any[] = []
    const { ctx } = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      [`PATCH /applications/${APP}`]: (c) => {
        patched = c.body.appRoles
        return { status: 204 }
      }
    })
    await entraAdapter.apply(
      ctx,
      op({ kind: 'update', type: 'entra.app_role', externalId: `${APP}:${ROLE_ID}` }),
      roleDesired(
        { value: 'admin', display_name: 'Boss', description: 'Can manage the app' },
        { externalId: `${APP}:${ROLE_ID}` }
      )
    )
    expect(patched).toHaveLength(1)
    expect(patched[0]).toMatchObject({ id: ROLE_ID, value: 'admin', displayName: 'Boss' })
  })

  it('an enterprise application: created for the app, refused when one exists that the Hub did not make', async () => {
    const created: any[] = []
    const a = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      'GET /servicePrincipals': { status: 200, body: { value: [] } },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } },
      'POST /servicePrincipals': (c) => {
        created.push(c.body)
        return { status: 201, body: SP_RAW }
      }
    })
    const spDesired = desired(
      'entra.service_principal',
      { assignment_required: true },
      { refs: { application: APP } }
    )
    const r = await entraAdapter.apply(
      a.ctx,
      op({ kind: 'create', type: 'entra.service_principal' }),
      spDesired
    )
    expect(r.externalId).toBe(SP)
    expect(created[0]).toMatchObject({ appId: CLIENT, appRoleAssignmentRequired: true })
    expect(created[0].tags).toEqual([
      'nivaro-hub:app=7',
      'nivaro-hub:env=3',
      'nivaro-hub:resource=41'
    ])

    const foreign = { ...SP_RAW, tags: [] }
    const b = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      'GET /servicePrincipals': { status: 200, body: { value: [foreign] } },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } }
    })
    await expect(
      entraAdapter.apply(b.ctx, op({ kind: 'create', type: 'entra.service_principal' }), spDesired)
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(b.calls)).toEqual([])
    // The Hub's own tag on it: an interrupted earlier create, returned unchanged.
    const own = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      'GET /servicePrincipals': {
        status: 200,
        body: { value: [{ ...SP_RAW, tags: ['nivaro-hub:resource=41'] }] }
      },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } }
    })
    expect(
      (
        await entraAdapter.apply(
          own.ctx,
          op({ kind: 'create', type: 'entra.service_principal' }),
          spDesired
        )
      ).externalId
    ).toBe(SP)
    expect(writes(own.calls)).toEqual([])
  })

  it('an enterprise application made before replication finishes is a retryable REPLICATION_PENDING', async () => {
    const { ctx } = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      'GET /servicePrincipals': { status: 200, body: { value: [] } },
      'POST /servicePrincipals': {
        status: 400,
        body: {
          error: {
            code: 'Request_BadRequest',
            message:
              "The appId '2222' of the service principal does not reference a valid application object."
          }
        }
      }
    })
    await expect(
      entraAdapter.apply(
        ctx,
        op({ kind: 'create', type: 'entra.service_principal' }),
        desired('entra.service_principal', {}, { refs: { application: APP } })
      )
    ).rejects.toMatchObject({ code: 'REPLICATION_PENDING', retryable: true })
  })

  it('a group role assignment: created once, refused when it exists, removed idempotently', async () => {
    const base: Routes = {
      [`GET /servicePrincipals/${SP}`]: { status: 200, body: SP_RAW },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } }
    }
    const refs = { service_principal: SP, group: GROUP, app_role: `${APP}:${ROLE_ID}` }
    const ad = desired('entra.group_role_assignment', {}, { refs })
    const made: any[] = []
    const a = setup({
      ...base,
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: { value: [] } },
      [`POST /servicePrincipals/${SP}/appRoleAssignedTo`]: (c) => {
        made.push(c.body)
        return { status: 201, body: { ...ASSIGNMENTS.value[0] } }
      }
    })
    const r = await entraAdapter.apply(
      a.ctx,
      op({ kind: 'create', type: 'entra.group_role_assignment' }),
      ad
    )
    expect(made[0]).toEqual({ principalId: GROUP, resourceId: SP, appRoleId: ROLE_ID })
    expect(r.externalId).toBe(`${SP}:${ASSIGNMENT}`)

    const b = setup({
      ...base,
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: ASSIGNMENTS }
    })
    await expect(
      entraAdapter.apply(b.ctx, op({ kind: 'create', type: 'entra.group_role_assignment' }), ad)
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(b.calls)).toEqual([])

    const removed: string[] = []
    const c = setup({
      ...base,
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: ASSIGNMENTS },
      [`DELETE /servicePrincipals/${SP}/appRoleAssignedTo/${ASSIGNMENT}`]: () => {
        removed.push(ASSIGNMENT)
        return { status: 204 }
      }
    })
    await entraAdapter.apply(
      c.ctx,
      op({
        kind: 'delete',
        type: 'entra.group_role_assignment',
        externalId: `${SP}:${ASSIGNMENT}`
      }),
      null
    )
    expect(removed).toEqual([ASSIGNMENT])
    const d = setup({
      ...base,
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: { value: [] } }
    })
    expect(
      (
        await entraAdapter.apply(
          d.ctx,
          op({
            kind: 'delete',
            type: 'entra.group_role_assignment',
            externalId: `${SP}:${ASSIGNMENT}`
          }),
          null
        )
      ).ok
    ).toBe(true)
    expect(writes(d.calls)).toEqual([])
  })

  it('an assignment without a role is default access', async () => {
    const made: any[] = []
    const { ctx } = setup({
      [`GET /servicePrincipals/${SP}`]: { status: 200, body: SP_RAW },
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: { value: [] } },
      [`POST /servicePrincipals/${SP}/appRoleAssignedTo`]: (c) => {
        made.push(c.body)
        return {
          status: 201,
          body: {
            id: ASSIGNMENT,
            principalId: GROUP,
            appRoleId: c.body.appRoleId,
            principalType: 'Group'
          }
        }
      }
    })
    await entraAdapter.apply(
      ctx,
      op({ kind: 'create', type: 'entra.group_role_assignment' }),
      desired(
        'entra.group_role_assignment',
        {},
        { refs: { service_principal: SP, group: GROUP, app_role: null } }
      )
    )
    expect(made[0].appRoleId).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('API permissions: written into requiredResourceAccess, an existing request is refused, delete removes one entry', async () => {
    const bodies: any[] = []
    const pd = desired(
      'entra.api_permission',
      {
        resource_app_id: '11111111-0000-4000-8000-0000000000aa',
        permissions: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }]
      },
      { refs: { application: APP } }
    )
    const a = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      [`PATCH /applications/${APP}`]: (c) => {
        bodies.push(c.body.requiredResourceAccess)
        return { status: 204 }
      }
    })
    const r = await entraAdapter.apply(
      a.ctx,
      op({ kind: 'create', type: 'entra.api_permission' }),
      pd
    )
    expect(r.externalId).toBe(`${APP}:11111111-0000-4000-8000-0000000000aa`)
    expect(bodies[0]).toHaveLength(2)
    expect(bodies[0][0].resourceAppId).toBe(GRAPH_APP)

    const dup = desired(
      'entra.api_permission',
      { resource_app_id: GRAPH_APP, permissions: [] },
      { refs: { application: APP } }
    )
    const b = setup({ [`GET /applications/${APP}`]: { status: 200, body: APP_RAW } })
    await expect(
      entraAdapter.apply(b.ctx, op({ kind: 'create', type: 'entra.api_permission' }), dup)
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(b.calls)).toEqual([])

    const del: any[] = []
    const c = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      [`PATCH /applications/${APP}`]: (x) => {
        del.push(x.body.requiredResourceAccess)
        return { status: 204 }
      }
    })
    await entraAdapter.apply(
      c.ctx,
      op({ kind: 'delete', type: 'entra.api_permission', externalId: `${APP}:${GRAPH_APP}` }),
      null
    )
    expect(del[0]).toEqual([])
  })

  it('a group is never written', async () => {
    const { ctx } = setup({})
    await expect(
      entraAdapter.apply(
        ctx,
        op({ kind: 'create', type: 'entra.group' }),
        desired('entra.group', {})
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('findExisting (plan time) reads only: secret by name, enterprise application by app, role by value, assignment', async () => {
    const { ctx, calls } = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      'GET /servicePrincipals': { status: 200, body: { value: [SP_RAW] } },
      'GET /applications': { status: 200, body: { value: [{ id: APP }] } },
      [`GET /servicePrincipals/${SP}`]: { status: 200, body: SP_RAW },
      [`GET /servicePrincipals/${SP}/appRoleAssignedTo`]: { status: 200, body: ASSIGNMENTS }
    })
    const f = entraAdapter.findExisting!
    expect((await f(ctx, 'entra.client_secret', secretDesired()))?.externalId).toBe(
      `${APP}:${KEY_ID}`
    )
    expect(
      (
        await f(
          ctx,
          'entra.service_principal',
          desired('entra.service_principal', {}, { refs: { application: APP } })
        )
      )?.externalId
    ).toBe(SP)
    expect((await f(ctx, 'entra.app_role', roleDesired({ value: 'admin' })))?.fields.value).toBe(
      'admin'
    )
    expect(await f(ctx, 'entra.app_role', roleDesired({ value: 'editor' }))).toBeNull()
    expect(
      (
        await f(
          ctx,
          'entra.group_role_assignment',
          desired(
            'entra.group_role_assignment',
            {},
            { refs: { service_principal: SP, group: GROUP, app_role: `${APP}:${ROLE_ID}` } }
          )
        )
      )?.externalId
    ).toBe(`${SP}:${ASSIGNMENT}`)
    expect(await f(ctx, 'entra.app_registration', appDesired())).toBeNull()
    expect(writes(calls)).toEqual([])
  })
})

describe('entra outputs, health and errors', () => {
  it('declares outputs and none leak into observed/desired', async () => {
    const spec = (k: string) => entraAdapter.types.find((t) => t.key === k)!
    expect(spec('entra.client_secret').outputs).toEqual([
      { key: 'client_secret', label: 'Client secret', secret: true, onceOnly: true }
    ])
    expect(
      spec('entra.app_registration').outputs?.map((o) => [o.key, o.secret, !!o.onceOnly])
    ).toEqual([
      ['client_id', false, false],
      ['tenant_id', false, false]
    ])
    // No output key is also a field: outputs never ride the desired / observed shapes.
    for (const t of entraAdapter.types)
      for (const o of t.outputs ?? []) expect(t.fields.some((f) => f.key === o.key)).toBe(false)
    // The secret trigger fields exist for rotation.
    expect(
      spec('entra.client_secret').fields.find((f) => f.key === 'rotate_outputs')
    ).toMatchObject({ kind: 'boolean', trigger: true })
    // Re-reading outputs: ids only, never a once-only secret.
    const { ctx } = setup(appRoute())
    expect(await entraAdapter.readOutputs!(ctx, 'entra.app_registration', APP)).toEqual({
      client_id: CLIENT,
      tenant_id: TENANT
    })
    expect(await entraAdapter.readOutputs!(ctx, 'entra.client_secret', `${APP}:${KEY_ID}`)).toEqual(
      {}
    )
    // Whatever an apply or observe answers, the created secret value is nowhere but in `outputs`.
    const made = setup({
      [`GET /applications/${APP}`]: {
        status: 200,
        body: { id: APP, appId: CLIENT, passwordCredentials: [] }
      },
      [`POST /applications/${APP}/addPassword`]: { status: 200, body: CREATED }
    })
    const res = await entraAdapter.apply(
      made.ctx,
      op({ kind: 'create', type: 'entra.client_secret' }),
      secretDesired()
    )
    expect(JSON.stringify({ ...res, outputs: undefined })).not.toContain(CREATED_SECRET)
  })

  it('client secret health: ok, expires within 30 days, expired, gone', async () => {
    const health = async (end: string | null) => {
      const creds = end ? [{ ...APP_RAW.passwordCredentials[0], endDateTime: end }] : []
      const { ctx } = setup({
        [`GET /applications/${APP}`]: {
          status: 200,
          body: { ...APP_RAW, passwordCredentials: creds }
        }
      })
      return entraAdapter.health!(ctx, 'entra.client_secret', `${APP}:${KEY_ID}`)
    }
    expect((await health('2027-11-01T00:00:00Z')).status).toBe('ok')
    const soon = await health('2026-12-10T00:00:00Z')
    expect(soon.status).toBe('warn')
    expect(soon.message).toMatch(/expires in 14 days/)
    expect((await health('2026-11-01T00:00:00Z')).status).toBe('down')
    expect((await health(null)).status).toBe('down')
  })

  it('API permission health shows consent needed with the consent URL, then ok once granted', async () => {
    const apiSp = {
      id: 'aaaa0000-0000-4000-8000-00000000aaaa',
      appRoles: [],
      oauth2PermissionScopes: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', value: 'User.Read' }]
    }
    const routes = (grants: any[], assignments: any[]): Routes => ({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      'GET /servicePrincipals': (c) =>
        c.query.get('$filter')?.includes(GRAPH_APP)
          ? { status: 200, body: { value: [apiSp] } }
          : { status: 200, body: { value: [{ id: SP }] } },
      [`GET /servicePrincipals/${SP}/appRoleAssignments`]: {
        status: 200,
        body: { value: assignments }
      },
      'GET /oauth2PermissionGrants': { status: 200, body: { value: grants } }
    })
    const needed = setup(routes([], []))
    const h1 = await entraAdapter.health!(needed.ctx, 'entra.api_permission', `${APP}:${GRAPH_APP}`)
    expect(h1.status).toBe('warn')
    expect(h1.message).toContain(
      `https://login.microsoftonline.com/${TENANT}/adminconsent?client_id=${CLIENT}`
    )
    expect(h1.details).toMatchObject({ consent: 'needed', waiting: 2 })
    const done = setup(
      routes(
        [{ scope: 'User.Read' }],
        [{ resourceId: apiSp.id, appRoleId: '5b567255-7703-4780-807c-7be8301ae99b' }]
      )
    )
    const h2 = await entraAdapter.health!(done.ctx, 'entra.api_permission', `${APP}:${GRAPH_APP}`)
    expect(h2.status).toBe('ok')
  })

  it('maps 429 and 5xx to retryable, other refusals to not retryable', async () => {
    for (const [status, code, retryable] of [
      [429, 'RATE_LIMITED', true],
      [503, 'PROVIDER_ERROR', true],
      [403, 'FORBIDDEN', false],
      [400, 'INVALID', false]
    ] as const) {
      const { ctx } = setup({ [`GET /applications/${APP}`]: { status, body: ERRORS.forbidden } })
      await expect(entraAdapter.observe(ctx, 'entra.app_registration', APP)).rejects.toMatchObject({
        code,
        retryable,
        status
      })
    }
  })

  it('a write that hits 429 is retryable', async () => {
    const { ctx } = setup({
      [`GET /applications/${APP}`]: { status: 200, body: APP_RAW },
      [`PATCH /applications/${APP}`]: {
        status: 429,
        body: ERRORS.throttled,
        headers: { 'retry-after': '60' }
      }
    })
    await expect(
      entraAdapter.apply(
        ctx,
        op({ kind: 'update', type: 'entra.app_registration', externalId: APP }),
        appDesired({ name: 'x' }, { externalId: APP })
      )
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
  })

  it('a token endpoint failure is AUTH_FAILED and not retryable', async () => {
    const { ctx } = setup({}, { tokenAnswer: { status: 401, body: ERRORS.badClient } })
    await expect(entraAdapter.observe(ctx, 'entra.app_registration', APP)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false
    })
  })

  it('secrets never appear in errors', async () => {
    const leaky = {
      error: { code: 'Request_BadRequest', message: `bad credential ${SECRET} / ${CREATED_SECRET}` }
    }
    const { ctx } = setup({
      [`GET /applications/${APP}`]: { status: 400, body: leaky },
      'GET /applications': { status: 400, body: leaky }
    })
    const err = await entraAdapter.observe(ctx, 'entra.app_registration', APP).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).not.toContain(SECRET)
    expect(err.message).toContain('••')
    // The connection’s certificate key is scrubbed the same way.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const cert = setup(
      {
        [`GET /applications/${APP}`]: {
          status: 400,
          body: { error: { code: 'x', message: `key ${pem}` } }
        }
      },
      { secrets: { certificate_key: pem }, config: { certificate_thumbprint: 'CD'.repeat(20) } }
    )
    const e2 = await entraAdapter.observe(cert.ctx, 'entra.app_registration', APP).catch((e) => e)
    expect(e2.message).not.toContain('BEGIN PRIVATE KEY')
  })
})
