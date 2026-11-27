import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import {
  assertPortainerCall,
  baseOf,
  ptCall
} from '../../../services/hub/providers/portainer/client.js'
import { portainerAdapter } from '../../../services/hub/providers/portainer/index.js'
import { getProvider } from '../../../services/hub/providers/registry.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'

// Hub providers Task 37: the Portainer adapter against recorded (fake-valued) answers. The ruling
// under test: Portainer never writes Docker; the Hub agent stays the only Docker writer.

const FIX = join(import.meta.dirname, '../../../services/hub/providers/portainer/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-portainer-token-0001'
const EDGE_KEY = 'test-secret-edge-key-0001'
const REG_PASSWORD = 'test-secret-registry-password-0001'
const HOST = 'portainer.test.example'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
  rawBody: string
  headers: Record<string, string>
  host: string
}
interface Route {
  method: string
  path: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[], config: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const raw = init?.body ? String(init.body) : ''
    let body: any
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = undefined
    }
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname.replace(/^\/api/, ''),
      query: u.searchParams,
      body,
      rawBody: raw,
      headers: init?.headers ?? {},
      host: u.host
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response(JSON.stringify(fx('error-forbidden')), { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: portainerAdapter,
    connectionId: 1,
    config: { baseUrl: `https://${HOST}:9443`, ...config },
    secrets: { token: TOKEN },
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

const noCalls = () => harness([])
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: DesiredResource['refs'] = {},
  externalId: string | null = null
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: 'shared',
    appId: null,
    environmentId: null,
    fields,
    refs,
    tags: {}
  }
}

const op = (
  kind: PlannedOp['kind'],
  type: string,
  externalId: string | null,
  extra: Partial<PlannedOp> = {}
): PlannedOp => ({
  kind,
  type,
  resourceId: 7,
  externalId,
  reason: 'test',
  changes: [],
  preconditions: {},
  risk: [],
  ...extra
})

describe('portainer adapter: registration and connection', () => {
  it('is a core provider on the host the connection names, https only', () => {
    ensureCoreProviders()
    expect(getProvider('portainer')).toBe(portainerAdapter)
    expect(portainerAdapter.connection.hosts({ baseUrl: `https://${HOST}:9443` })).toEqual([HOST])
    expect(portainerAdapter.connection.hosts({ baseUrl: 'http://portainer.test.example' })).toEqual(
      []
    )
    expect(portainerAdapter.connection.hosts({})).toEqual([])
    expect(portainerAdapter.connection.fields.find((f) => f.key === 'token')?.secret).toBe(true)
    expect(portainerAdapter.connection.describe({ baseUrl: `https://${HOST}:9443` })).not.toContain(
      TOKEN
    )
    expect(portainerAdapter.types.map((t) => t.key)).toEqual([
      'portainer.environment',
      'portainer.team',
      'portainer.team_access',
      'portainer.registry',
      'portainer.stack'
    ])
    for (const t of portainerAdapter.types) expect(t.scope).toBe('shared')
  })

  it('validates the address: https, a host name, no login, no path', () => {
    const v = portainerAdapter.connection.validate
    expect(v?.({ baseUrl: `https://${HOST}:9443` }, { token: TOKEN })).toEqual([])
    expect(v?.({ baseUrl: 'http://portainer.test.example' }, {})).not.toEqual([])
    expect(v?.({ baseUrl: 'https://user:pw@portainer.test.example' }, {})).not.toEqual([])
    expect(v?.({ baseUrl: 'https://portainer.test.example/sub' }, {})).not.toEqual([])
    expect(v?.({ baseUrl: 'https://portainer.test.example/../x' }, {})).not.toEqual([])
    expect(v?.({ baseUrl: 'https://localhost' }, {})).not.toEqual([])
    expect(v?.({ baseUrl: '' }, {})).not.toEqual([])
    expect(v?.({ baseUrl: `https://${HOST}` }, { token: ' ' })).not.toEqual([])
    expect(baseOf({ baseUrl: 'https://portainer.test.example:9443/' })?.origin).toBe(
      `https://${HOST}:9443`
    )
  })

  it('refuses a host other than the connection’s own, and sends the key as X-API-Key', async () => {
    const { ctx } = noCalls()
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
    const h = harness([{ method: 'GET', path: /^\/teams\/7$/, body: fx('team') }])
    await portainerAdapter.observe(h.ctx, 'portainer.team', '7')
    expect(h.calls[0]?.host).toBe(`${HOST}:9443`)
    expect(h.calls[0]?.headers['x-api-key']).toBe(TOKEN)
  })
})

describe('portainer adapter: testConnection lists missing permissions', () => {
  it('has nothing missing for an administrator', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/users\/me$/, body: fx('me-admin') },
      { method: 'GET', path: /^\/system\/status$/, body: fx('status') }
    ])
    const r = await portainerAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('test-admin')
    expect(r.identity).toContain('2.21.4')
    expect(r.missing).toEqual([])
  })

  it('lists the write rights a non-administrator lacks, and never asks for stack writes', async () => {
    const { ctx } = harness([{ method: 'GET', path: /^\/users\/me$/, body: fx('me-standard') }])
    const r = await portainerAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.missing).toContain('write portainer.environment (an administrator’s token)')
    expect(r.missing.some((m) => m.startsWith('read '))).toBe(false)
    expect(r.missing.some((m) => m.includes('portainer.stack') && m.startsWith('write'))).toBe(
      false
    )
  })

  it('answers not ok for a token Portainer refuses, without the token in the text', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/users\/me$/, status: 401, body: { message: `bad ${TOKEN}` } }
    ])
    const r = await portainerAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(r.missing.length).toBeGreaterThan(0)
  })

  it('answers not ok for an invalid address without a call', async () => {
    const { ctx, calls } = harness([], { baseUrl: 'http://portainer.test.example' })
    const r = await portainerAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('portainer adapter: observe maps provider fields', () => {
  it('environment: no edge key in observed; stack: no env values', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/endpoints\/3$/, body: fx('environment') },
      { method: 'GET', path: /^\/stacks\/11$/, body: fx('stack') },
      { method: 'GET', path: /^\/registries\/5$/, body: fx('registry') }
    ])
    const env = await portainerAdapter.observe(ctx, 'portainer.environment', '3')
    expect(env).toMatchObject({
      externalId: '3',
      name: 'test-docker-host',
      status: 'up',
      fields: {
        name: 'test-docker-host',
        publicUrl: 'docker1.test.example',
        groupId: 1,
        edgeCheckinInterval: 5,
        kind: 'edge'
      }
    })
    expect(JSON.stringify(env)).not.toContain(EDGE_KEY)
    const stack = await portainerAdapter.observe(ctx, 'portainer.stack', '11')
    expect(stack?.fields).toEqual({
      name: 'test-web',
      environment: '3',
      kind: 'compose',
      status: 'active'
    })
    expect(JSON.stringify(stack)).not.toContain('test-secret-stack-env')
    const reg = await portainerAdapter.observe(ctx, 'portainer.registry', '5')
    expect(reg?.fields).toEqual({
      name: 'test-registry',
      type: 'custom',
      url: 'registry.test.example:5000',
      authentication: true,
      username: 'test-puller'
    })
    expect(Object.keys(reg?.fields ?? {})).not.toContain('password')
  })

  it('team access: read from the environment’s policy map; absent = null', async () => {
    const { ctx } = harness([{ method: 'GET', path: /^\/endpoints\/3$/, body: fx('environment') }])
    const a = await portainerAdapter.observe(ctx, 'portainer.team_access', '3/7')
    expect(a?.fields).toEqual({ environment: '3', team: '7', role: 'readonly' })
    const b = await portainerAdapter.observe(ctx, 'portainer.team_access', '3/9')
    expect(b?.fields.role).toBe('standard')
    expect(await portainerAdapter.observe(ctx, 'portainer.team_access', '3/99')).toBeNull()
  })

  it('answers null for a missing resource and refuses ids that cannot sit in a path', async () => {
    const { ctx } = noCalls()
    expect(await portainerAdapter.observe(ctx, 'portainer.team', '404')).toBeNull()
    for (const bad of ['', '..', '1/2', 'a', '1;x', '-1', '1%2f2'])
      await expect(portainerAdapter.observe(ctx, 'portainer.team', bad)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    await expect(portainerAdapter.observe(ctx, 'portainer.team_access', '3')).rejects.toMatchObject(
      { code: 'BAD_EXTERNAL_ID' }
    )
  })

  it('lists every type in one page, including each team’s access', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/endpoints$/, body: [fx('environment')] },
      { method: 'GET', path: /^\/teams$/, body: [fx('team')] },
      { method: 'GET', path: /^\/registries$/, body: [fx('registry')] },
      { method: 'GET', path: /^\/stacks$/, body: [fx('stack')] }
    ])
    expect((await portainerAdapter.list(ctx, 'portainer.environment')).items).toHaveLength(1)
    expect((await portainerAdapter.list(ctx, 'portainer.team')).cursor).toBeNull()
    expect((await portainerAdapter.list(ctx, 'portainer.registry')).items[0]?.externalId).toBe('5')
    expect((await portainerAdapter.list(ctx, 'portainer.stack')).items[0]?.externalId).toBe('11')
    const access = await portainerAdapter.list(ctx, 'portainer.team_access')
    expect(access.items.map((i) => i.externalId)).toEqual(['3/7', '3/9'])
  })
})

describe('portainer adapter: plan diff per type', () => {
  const obsEnv: Observed = {
    type: 'portainer.environment',
    externalId: '3',
    name: 'test-docker-host',
    fields: {
      name: 'test-docker-host',
      publicUrl: 'docker1.test.example',
      groupId: 1,
      edgeCheckinInterval: 5
    },
    tags: {}
  }

  it('environment: create, update only what moved, noop, delete', () => {
    const { ctx } = noCalls()
    const want = {
      name: 'test-docker-host',
      publicUrl: 'docker1.test.example',
      groupId: 1,
      edgeCheckinInterval: 5
    }
    expect(portainerAdapter.plan(ctx, desired('portainer.environment', want), null)[0]?.kind).toBe(
      'create'
    )
    expect(
      portainerAdapter.plan(ctx, desired('portainer.environment', want, {}, '3'), obsEnv)[0]?.kind
    ).toBe('noop')
    const up = portainerAdapter.plan(
      ctx,
      desired('portainer.environment', { ...want, edgeCheckinInterval: 30 }, {}, '3'),
      obsEnv
    )
    expect(up).toHaveLength(1)
    expect(up[0]?.kind).toBe('update')
    expect(up[0]?.changes).toEqual([{ field: 'edgeCheckinInterval', from: 5, to: 30 }])
    expect(up[0]?.reason).toContain('Portainer environment')
    expect(portainerAdapter.plan(ctx, null, obsEnv)[0]?.kind).toBe('delete')
  })

  it('registry: a new password is a secret change that never carries the value', () => {
    const { ctx } = noCalls()
    const obs: Observed = {
      type: 'portainer.registry',
      externalId: '5',
      name: 'test-registry',
      fields: {
        name: 'test-registry',
        type: 'custom',
        url: 'registry.test.example:5000',
        authentication: true,
        username: 'test-puller'
      },
      tags: {}
    }
    const want = {
      name: 'test-registry',
      type: 'custom',
      url: 'registry.test.example:5000',
      authentication: true,
      username: 'test-puller',
      password: { fingerprint: 'fp', changed: true }
    }
    const [p] = portainerAdapter.plan(ctx, desired('portainer.registry', want, {}, '5'), obs)
    expect(p?.kind).toBe('update')
    expect(p?.changes).toEqual([{ field: 'password', secret: true }])
    expect(JSON.stringify(p)).not.toContain(REG_PASSWORD)
    const same = portainerAdapter.plan(
      ctx,
      desired(
        'portainer.registry',
        { ...want, password: { fingerprint: 'fp', changed: false } },
        {},
        '5'
      ),
      obs
    )
    expect(same[0]?.kind).toBe('noop')
  })

  it('team access: a role change is an update', () => {
    const { ctx } = noCalls()
    const obs: Observed = {
      type: 'portainer.team_access',
      externalId: '3/7',
      name: 'x',
      fields: { environment: '3', team: '7', role: 'readonly' },
      tags: {}
    }
    const [p] = portainerAdapter.plan(
      ctx,
      desired(
        'portainer.team_access',
        { role: 'operator' },
        { environment: '3', team: '7' },
        '3/7'
      ),
      obs
    )
    expect(p?.kind).toBe('update')
    expect(p?.changes).toEqual([{ field: 'role', from: 'readonly', to: 'operator' }])
  })

  it('stack: every write plans a blocker, an unchanged stack plans nothing', () => {
    const { ctx } = noCalls()
    const obs: Observed = {
      type: 'portainer.stack',
      externalId: '11',
      name: 'test-web',
      fields: { name: 'test-web', environment: '3', kind: 'compose', status: 'active' },
      tags: {}
    }
    const create = portainerAdapter.plan(ctx, desired('portainer.stack', { name: 'new' }), null)[0]
    const update = portainerAdapter.plan(
      ctx,
      desired('portainer.stack', { name: 'renamed' }, {}, '11'),
      obs
    )[0]
    const del = portainerAdapter.plan(ctx, null, obs)[0]
    for (const p of [create, update, del])
      expect((p?.data as any)?.$blocker?.code).toBe('DOCKER_WRITE_NOT_ALLOWED')
    expect(
      portainerAdapter.plan(ctx, desired('portainer.stack', { name: 'test-web' }, {}, '11'), obs)[0]
        ?.kind
    ).toBe('noop')
    const stack = portainerAdapter.types.find((t) => t.key === 'portainer.stack')
    expect(stack?.capabilities).toMatchObject({
      create: false,
      update: false,
      delete: false,
      adopt: true
    })
  })
})

describe('portainer adapter: risk flags per type', () => {
  const spec = (k: string) => portainerAdapter.types.find((t) => t.key === k)!
  const o = (kind: PlannedOp['kind'], type: string) => op(kind, type, '1')

  it('team access above read-only is public_exposure, judged on what is sent', () => {
    const t = spec('portainer.team_access')
    const d = (role: string) => desired('portainer.team_access', { role })
    expect(t.risk(o('create', t.key), d('readonly'))).toEqual([])
    for (const role of ['helpdesk', 'operator', 'standard', 'admin'])
      expect(t.risk(o('create', t.key), d(role))).toEqual(['public_exposure'])
    expect(t.risk(o('update', t.key), d('admin'))).toEqual(['public_exposure'])
    expect(t.risk(o('delete', t.key), null)).toEqual([])
  })

  it('deleting an environment, team or registry is destructive; creating is not', () => {
    for (const k of ['portainer.environment', 'portainer.team', 'portainer.registry']) {
      expect(spec(k).risk(o('delete', k), null)).toEqual(['destructive'])
      expect(spec(k).risk(o('create', k), desired(k, {}))).toEqual([])
    }
    expect(
      spec('portainer.stack').risk(o('update', 'portainer.stack'), desired('portainer.stack', {}))
    ).toEqual([])
  })

  it('no type is costed: Portainer is licensed per node, not per resource', () => {
    for (const t of portainerAdapter.types) expect(t.costClass).toBeUndefined()
  })
})

describe('portainer adapter: outputs', () => {
  it('declares the edge key as a secret output and none leaks into observed or desired', async () => {
    const env = portainerAdapter.types.find((t) => t.key === 'portainer.environment')!
    expect(env.outputs).toEqual([{ key: 'edge_key', label: 'Edge key', secret: true }])
    const { ctx } = harness([
      { method: 'GET', path: /^\/endpoints$/, body: [] },
      { method: 'POST', path: /^\/endpoints$/, body: fx('environment-created') },
      { method: 'GET', path: /^\/endpoints\/4$/, body: fx('environment-created') }
    ])
    const r = await portainerAdapter.apply(
      ctx,
      op('create', 'portainer.environment', null),
      desired('portainer.environment', {
        name: 'test-new-host',
        groupId: 1,
        edgeCheckinInterval: 5
      })
    )
    expect(r.outputs).toEqual({ edge_key: 'test-secret-edge-key-0002' })
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('test-secret-edge-key')
    expect(env.fields.some((f) => /key|secret/i.test(f.key))).toBe(false)
  })

  it('readOutputs re-reads the edge key; other types have none', async () => {
    const { ctx } = harness([{ method: 'GET', path: /^\/endpoints\/3$/, body: fx('environment') }])
    expect(await portainerAdapter.readOutputs?.(ctx, 'portainer.environment', '3')).toEqual({
      edge_key: EDGE_KEY
    })
    expect(await portainerAdapter.readOutputs?.(ctx, 'portainer.team', '7')).toEqual({})
  })
})

describe('portainer adapter: apply is idempotent (read-before-write)', () => {
  it('environment create posts a form with the Edge type; an existing name is refused unless resumed', async () => {
    const routes: Route[] = [
      { method: 'GET', path: /^\/endpoints$/, body: [fx('environment')] },
      { method: 'POST', path: /^\/endpoints$/, body: fx('environment-created') },
      { method: 'GET', path: /^\/endpoints\/4$/, body: fx('environment-created') }
    ]
    const taken = harness(routes)
    await expect(
      portainerAdapter.apply(
        taken.ctx,
        op('create', 'portainer.environment', null),
        desired('portainer.environment', { name: 'test-docker-host' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes(taken.calls)).toEqual([])

    const resumed = harness(routes)
    await portainerAdapter.apply(
      resumed.ctx,
      op('create', 'portainer.environment', null),
      desired('portainer.environment', { name: 'test-docker-host' }, {}, '3')
    )
    const post = writes(resumed.calls)[0]
    expect(post?.rawBody).toContain('name="EndpointCreationType"\r\n\r\n4')
    expect(post?.rawBody).toContain('name="Name"\r\n\r\ntest-docker-host')
    expect(post?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
  })

  it('environment update writes only the changed fields; delete of a gone one is a no-op', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/endpoints\/3$/, body: fx('environment') },
      { method: 'PUT', path: /^\/endpoints\/3$/, body: fx('environment') }
    ])
    await portainerAdapter.apply(
      ctx,
      op('update', 'portainer.environment', '3', {
        changes: [{ field: 'edgeCheckinInterval', from: 5, to: 30 }]
      }),
      desired(
        'portainer.environment',
        { name: 'test-docker-host', edgeCheckinInterval: 30 },
        {},
        '3'
      )
    )
    expect(writes(calls)).toHaveLength(1)
    expect(writes(calls)[0]?.body).toEqual({ EdgeCheckinInterval: 30 })

    const gone = harness([])
    const r = await portainerAdapter.apply(
      gone.ctx,
      op('delete', 'portainer.environment', '3'),
      null
    )
    expect(r.ok).toBe(true)
    expect(writes(gone.calls)).toEqual([])
  })

  it('team: create reads first and refuses a name it did not make; delete removes once', async () => {
    const taken = harness([{ method: 'GET', path: /^\/teams$/, body: [fx('team')] }])
    await expect(
      portainerAdapter.apply(
        taken.ctx,
        op('create', 'portainer.team', null),
        desired('portainer.team', { name: 'test-viewers' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(taken.calls)).toEqual([])

    const fresh = harness([
      { method: 'GET', path: /^\/teams$/, body: [] },
      { method: 'POST', path: /^\/teams$/, body: { Id: 8, Name: 'test-new' } },
      { method: 'GET', path: /^\/teams\/8$/, body: { Id: 8, Name: 'test-new' } }
    ])
    const made = await portainerAdapter.apply(
      fresh.ctx,
      op('create', 'portainer.team', null),
      desired('portainer.team', { name: 'test-new' })
    )
    expect(made.externalId).toBe('8')
    expect(writes(fresh.calls)[0]?.body).toEqual({ Name: 'test-new' })

    const del = harness([
      { method: 'GET', path: /^\/teams\/7$/, body: fx('team') },
      { method: 'DELETE', path: /^\/teams\/7$/, status: 204 }
    ])
    await portainerAdapter.apply(del.ctx, op('delete', 'portainer.team', '7'), null)
    expect(writes(del.calls).map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /teams/7'])
  })

  it('registry create sends the password once and never lets it into an error', async () => {
    const ok = harness([
      { method: 'GET', path: /^\/registries$/, body: [] },
      { method: 'POST', path: /^\/registries$/, body: fx('registry') },
      { method: 'GET', path: /^\/registries\/5$/, body: fx('registry') }
    ])
    const d = desired('portainer.registry', {
      name: 'test-registry',
      type: 'custom',
      url: 'registry.test.example:5000',
      authentication: true,
      username: 'test-puller',
      password: { fingerprint: 'fp', changed: true, plain: REG_PASSWORD }
    })
    const r = await portainerAdapter.apply(ok.ctx, op('create', 'portainer.registry', null), d)
    expect(r.externalId).toBe('5')
    expect(writes(ok.calls)[0]?.body).toMatchObject({
      Name: 'test-registry',
      Type: 3,
      Password: REG_PASSWORD
    })
    expect(JSON.stringify(r)).not.toContain(REG_PASSWORD)

    const bad = harness([
      { method: 'GET', path: /^\/registries$/, body: [] },
      {
        method: 'POST',
        path: /^\/registries$/,
        status: 400,
        body: { message: `invalid login ${REG_PASSWORD}` }
      }
    ])
    let caught: any
    try {
      await portainerAdapter.apply(bad.ctx, op('create', 'portainer.registry', null), d)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProviderError)
    expect(caught.message).not.toContain(REG_PASSWORD)
    expect(caught.retryable).toBe(false)

    const noLogin = harness([{ method: 'GET', path: /^\/registries$/, body: [] }])
    await expect(
      portainerAdapter.apply(
        noLogin.ctx,
        op('create', 'portainer.registry', null),
        desired('portainer.registry', {
          name: 'x',
          url: 'a.example',
          authentication: true,
          username: 'u'
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
  })

  it('registry update sends the password only when it changed', async () => {
    const routes: Route[] = [
      { method: 'GET', path: /^\/registries\/5$/, body: fx('registry') },
      { method: 'PUT', path: /^\/registries\/5$/, body: fx('registry') }
    ]
    const a = harness(routes)
    await portainerAdapter.apply(
      a.ctx,
      op('update', 'portainer.registry', '5', { changes: [{ field: 'url', from: 'a', to: 'b' }] }),
      desired(
        'portainer.registry',
        {
          name: 'test-registry',
          url: 'b.example',
          username: 'test-puller',
          password: { fingerprint: 'fp', changed: false }
        },
        {},
        '5'
      )
    )
    expect(writes(a.calls)[0]?.body).toEqual({ URL: 'b.example' })
    const b = harness(routes)
    await portainerAdapter.apply(
      b.ctx,
      op('update', 'portainer.registry', '5', { changes: [{ field: 'password', secret: true }] }),
      desired(
        'portainer.registry',
        {
          name: 'test-registry',
          username: 'test-puller',
          password: { fingerprint: 'fp2', changed: true, plain: REG_PASSWORD }
        },
        {},
        '5'
      )
    )
    expect(writes(b.calls)[0]?.body).toEqual({ Username: 'test-puller', Password: REG_PASSWORD })
  })

  it('team access: merges one team into the policy map and leaves the others', async () => {
    const env = fx('environment')
    const routes: Route[] = [
      { method: 'GET', path: /^\/teams\/8$/, body: { Id: 8, Name: 'test-new' } },
      { method: 'GET', path: /^\/endpoints\/3$/, body: env },
      { method: 'PUT', path: /^\/endpoints\/3$/, body: env }
    ]
    const h = harness(routes)
    const d = desired(
      'portainer.team_access',
      { role: 'readonly' },
      { environment: '3', team: '8' }
    )
    const r = await portainerAdapter.apply(h.ctx, op('create', 'portainer.team_access', null), d)
    expect(r.externalId).toBe('3/8')
    expect(writes(h.calls)[0]?.body).toEqual({
      TeamAccessPolicies: { '7': { RoleId: 4 }, '8': { RoleId: 4 }, '9': { RoleId: 3 } }
    })

    // A team that already has access is refused unless this resource recorded it.
    const exists = harness(
      routes.map((x) =>
        x.path.test('/teams/8') ? { ...x, path: /^\/teams\/7$/, body: fx('team') } : x
      )
    )
    await expect(
      portainerAdapter.apply(
        exists.ctx,
        op('create', 'portainer.team_access', null),
        desired('portainer.team_access', { role: 'readonly' }, { environment: '3', team: '7' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(exists.calls)).toEqual([])

    // Remove leaves the others; a second remove writes nothing.
    const del = harness(routes)
    await portainerAdapter.apply(del.ctx, op('delete', 'portainer.team_access', '3/7'), null)
    expect(writes(del.calls)[0]?.body).toEqual({ TeamAccessPolicies: { '9': { RoleId: 3 } } })
    const again = harness([{ method: 'GET', path: /^\/endpoints\/3$/, body: fx('environment') }])
    const gone = await portainerAdapter.apply(
      again.ctx,
      op('delete', 'portainer.team_access', '3/99'),
      null
    )
    expect(gone.ok).toBe(true)
    expect(writes(again.calls)).toEqual([])
  })

  it('team access: a named target that is not the one in the plan is refused', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/endpoints\/3$/, body: fx('environment') }
    ])
    await expect(
      portainerAdapter.apply(
        ctx,
        op('update', 'portainer.team_access', '3/7', {
          changes: [{ field: 'role', from: 'readonly', to: 'admin' }]
        }),
        desired('portainer.team_access', { role: 'admin' }, { environment: '3', team: '9' }, '3/7')
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(writes(calls)).toEqual([])
  })

  it('findExisting names the same-name environment, team and registry', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/endpoints$/, body: [fx('environment')] },
      { method: 'GET', path: /^\/teams$/, body: [fx('team')] },
      { method: 'GET', path: /^\/registries$/, body: [fx('registry')] }
    ])
    expect(
      (
        await portainerAdapter.findExisting?.(
          ctx,
          'portainer.environment',
          desired('portainer.environment', { name: 'TEST-docker-host' })
        )
      )?.externalId
    ).toBe('3')
    expect(
      (
        await portainerAdapter.findExisting?.(
          ctx,
          'portainer.team',
          desired('portainer.team', { name: 'test-viewers' })
        )
      )?.externalId
    ).toBe('7')
    expect(
      (
        await portainerAdapter.findExisting?.(
          ctx,
          'portainer.registry',
          desired('portainer.registry', { name: 'test-registry' })
        )
      )?.externalId
    ).toBe('5')
    expect(
      await portainerAdapter.findExisting?.(
        ctx,
        'portainer.team',
        desired('portainer.team', { name: 'other' })
      )
    ).toBeNull()
  })
})

describe('portainer adapter: health', () => {
  it('shows Portainer’s own view of an environment beside the Hub’s', async () => {
    const down = { ...fx('environment'), Status: 2 }
    const sick = {
      ...fx('environment'),
      Snapshots: [{ RunningContainerCount: 3, UnhealthyContainerCount: 2 }]
    }
    const { ctx } = harness([
      { method: 'GET', path: /^\/endpoints\/3$/, body: fx('environment') },
      { method: 'GET', path: /^\/endpoints\/4$/, body: down },
      { method: 'GET', path: /^\/endpoints\/5$/, body: sick }
    ])
    const ok = await portainerAdapter.health?.(ctx, 'portainer.environment', '3')
    expect(ok?.status).toBe('ok')
    expect(ok?.details).toEqual({
      containersRunning: 12,
      containersStopped: 1,
      containersUnhealthy: 0,
      stacks: 4
    })
    expect((await portainerAdapter.health?.(ctx, 'portainer.environment', '4'))?.status).toBe(
      'down'
    )
    expect((await portainerAdapter.health?.(ctx, 'portainer.environment', '5'))?.status).toBe(
      'warn'
    )
    expect((await portainerAdapter.health?.(ctx, 'portainer.environment', '9'))?.status).toBe(
      'down'
    )
  })
})

describe('portainer adapter: errors', () => {
  it('maps 429 to retryable and scrubs the token from the text', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/teams\/7$/,
        status: 429,
        body: { message: `slow down ${TOKEN}` },
        headers: { 'retry-after': '7' }
      }
    ])
    const err = await portainerAdapter.observe(ctx, 'portainer.team', '7').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.retryable).toBe(true)
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.message).toContain('retry after 7')
    expect(err.message).not.toContain(TOKEN)
  })

  it('does not retry a refusal; a 5xx is retryable', async () => {
    const forbidden = harness([
      { method: 'GET', path: /^\/teams\/7$/, status: 403, body: fx('error-forbidden') }
    ])
    const a = await portainerAdapter.observe(forbidden.ctx, 'portainer.team', '7').catch((e) => e)
    expect(a).toMatchObject({ code: 'FORBIDDEN', retryable: false, status: 403 })
    const down = harness([{ method: 'GET', path: /^\/teams\/7$/, status: 503, body: {} }])
    const b = await portainerAdapter.observe(down.ctx, 'portainer.team', '7').catch((e) => e)
    expect(b).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true })
  })
})

// ── THE RULING: Portainer never writes Docker ──

const DOCKER_WRITES: Array<[string, string]> = [
  ['POST', '/stacks'],
  ['POST', '/stacks/create/standalone/string'],
  ['POST', '/stacks/11/start'],
  ['POST', '/stacks/11/stop'],
  ['POST', '/stacks/11/git/redeploy'],
  ['PUT', '/stacks/11'],
  ['DELETE', '/stacks/11'],
  ['POST', '/endpoints/3/docker/containers/abc/restart'],
  ['POST', '/endpoints/3/docker/containers/create'],
  ['DELETE', '/endpoints/3/docker/containers/abc'],
  ['POST', '/endpoints/3/docker/services/create'],
  ['POST', '/endpoints/3/docker/services/abc/update'],
  ['DELETE', '/endpoints/3/docker/services/abc'],
  ['POST', '/endpoints/3/docker/containers/abc/exec'],
  ['POST', '/endpoints/3/kubernetes/api/v1/namespaces'],
  ['POST', '/endpoints/3/snapshot'],
  ['POST', '/endpoints/3/forceupdateservice'],
  ['POST', '/endpoints/3/registries/5'],
  ['POST', '/webhooks'],
  ['POST', '/custom_templates'],
  ['POST', '/edge_stacks'],
  ['PATCH', '/endpoints/3'],
  ['PUT', '/endpoints'],
  ['DELETE', '/endpoints'],
  ['POST', '/endpoints/3'],
  ['POST', '/teams/7'],
  ['POST', '/endpoints/../stacks'],
  ['POST', '/users']
]

describe('portainer adapter: never writes Docker', () => {
  it('refuses every Docker-writing endpoint before a request is made', async () => {
    for (const [method, path] of DOCKER_WRITES) {
      expect(() => assertPortainerCall(method, path), `${method} ${path}`).toThrowError(
        expect.objectContaining({ code: 'DOCKER_WRITE_NOT_ALLOWED' })
      )
      const { ctx, calls } = noCalls()
      await expect(ptCall(ctx, method, path, { body: {} })).rejects.toMatchObject({
        code: 'DOCKER_WRITE_NOT_ALLOWED'
      })
      expect(calls, `${method} ${path}`).toEqual([])
    }
  })

  it('reads only the paths the adapter needs: no Docker proxy, no logs', () => {
    for (const p of [
      '/endpoints/3/docker/containers/json',
      '/endpoints/3/docker/info',
      '/stacks/11/file',
      '/users',
      '/backup',
      '/settings'
    ])
      expect(() => assertPortainerCall('GET', p), p).toThrowError(
        expect.objectContaining({ code: 'PATH_NOT_ALLOWED' })
      )
    for (const p of [
      '/users/me',
      '/system/status',
      '/endpoints',
      '/endpoints/3',
      '/teams',
      '/teams/7',
      '/registries',
      '/registries/5',
      '/stacks',
      '/stacks/11'
    ])
      expect(() => assertPortainerCall('GET', p), p).not.toThrow()
  })

  it('allows writes only to Portainer’s own environments, teams and registries', () => {
    for (const [m, p] of [
      ['POST', '/endpoints'],
      ['PUT', '/endpoints/3'],
      ['DELETE', '/endpoints/3'],
      ['POST', '/teams'],
      ['PUT', '/teams/7'],
      ['DELETE', '/teams/7'],
      ['POST', '/registries'],
      ['PUT', '/registries/5'],
      ['DELETE', '/registries/5']
    ] as const)
      expect(() => assertPortainerCall(m, p), `${m} ${p}`).not.toThrow()
  })

  it('a stack is read-only: apply of any op on it answers DOCKER_WRITE_NOT_ALLOWED with no call', async () => {
    const stackDesired = desired('portainer.stack', { name: 'x' }, {}, '11')
    for (const kind of ['create', 'update', 'delete', 'replace'] as const) {
      const { ctx, calls } = noCalls()
      await expect(
        portainerAdapter.apply(
          ctx,
          op(kind, 'portainer.stack', '11'),
          kind === 'delete' ? null : stackDesired
        )
      ).rejects.toMatchObject({ code: 'DOCKER_WRITE_NOT_ALLOWED', retryable: false })
      expect(calls).toEqual([])
    }
  })

  it('no op on any type ever calls a Docker-writing endpoint (full sweep with a recording fetch)', async () => {
    const env = fx('environment')
    const routes: Route[] = [
      { method: 'GET', path: /.*/, body: env },
      { method: 'POST', path: /^\/endpoints$/, body: fx('environment-created') },
      { method: 'PUT', path: /.*/, body: env },
      { method: 'POST', path: /^\/teams$/, body: { Id: 8, Name: 'n' } },
      { method: 'POST', path: /^\/registries$/, body: fx('registry') },
      { method: 'DELETE', path: /.*/, status: 204 }
    ]
    // GETs of lists answer arrays so name lookups find nothing.
    const listRoutes: Route[] = ['endpoints', 'teams', 'registries', 'stacks'].map((k) => ({
      method: 'GET',
      path: new RegExp(`^/${k}$`),
      body: []
    }))
    const all = [...listRoutes, ...routes]
    const cases: Array<[PlannedOp, DesiredResource | null]> = []
    const specs: Array<[string, Record<string, unknown>, DesiredResource['refs'], string]> = [
      ['portainer.environment', { name: 'n', groupId: 1, edgeCheckinInterval: 5 }, {}, '3'],
      ['portainer.team', { name: 'n' }, {}, '3'],
      [
        'portainer.registry',
        { name: 'n', type: 'custom', url: 'a.example', authentication: false },
        {},
        '3'
      ],
      ['portainer.team_access', { role: 'admin' }, { environment: '3', team: '8' }, '3/8'],
      ['portainer.stack', { name: 'n' }, {}, '11']
    ]
    for (const [type, fields, refs, ext] of specs) {
      for (const kind of ['create', 'update', 'delete', 'replace', 'noop'] as const) {
        const d =
          kind === 'delete' ? null : desired(type, fields, refs, kind === 'create' ? null : ext)
        cases.push([
          op(kind, type, kind === 'create' ? null : ext, {
            changes: Object.keys(fields).map((field) => ({ field, to: fields[field] }))
          }),
          d
        ])
      }
    }
    const seen: Call[] = []
    for (const [o, d] of cases) {
      const h = harness(all)
      try {
        await portainerAdapter.apply(h.ctx, o, d)
      } catch {
        // refusals are fine; this sweep only cares about which calls went out
      }
      seen.push(...h.calls)
    }
    expect(seen.length).toBeGreaterThan(0)
    const dockerish =
      /\/(stacks|docker|kubernetes|containers|services|webhooks|custom_templates|edge_stacks|snapshot|forceupdateservice)(\/|$)/
    for (const c of seen) {
      if (c.method === 'GET')
        expect(`${c.method} ${c.path}`).toMatch(/^GET \/(endpoints|teams|registries)(\/\d+)?$/)
      else {
        expect(c.path, `${c.method} ${c.path}`).not.toMatch(dockerish)
        expect(`${c.method} ${c.path}`).toMatch(
          /^(POST \/(endpoints|teams|registries)|(PUT|DELETE) \/(endpoints|teams|registries)\/\d+)$/
        )
      }
    }
    // A stack was never read or written by the sweep of writes either.
    expect(seen.filter((c) => /^\/stacks/.test(c.path))).toEqual([])
  })

  it('reading stacks is allowed (observe, list, adopt) and writes nothing', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/stacks\/11$/, body: fx('stack') },
      { method: 'GET', path: /^\/stacks$/, body: [fx('stack')] }
    ])
    await portainerAdapter.observe(ctx, 'portainer.stack', '11')
    await portainerAdapter.list(ctx, 'portainer.stack')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /stacks/11', 'GET /stacks'])
  })
})
