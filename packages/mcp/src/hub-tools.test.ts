import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createNivaroMcpServer,
  HUB_ADMIN_TOOL_NAMES,
  HUB_TOOL_NAMES,
  PLAN_ONLY_NOTE
} from './index.js'
import { apiError, type Handler, mockClient, textOf } from './test-utils.js'

// Hub enhancement 25: the Hub tools. Read + plan only; listed only on a Hub; the admin three only
// with adminTools; every plan answer links to the page where a person starts it.

let mcp: Client
let calls: Command<unknown>[]

const APP = {
  id: 3,
  key: 'efp',
  name: 'EFP',
  environments: [
    { id: 11, key: 'staging', status: 'active', hub_token: '••••••' },
    { id: 12, key: 'production', status: 'active' }
  ],
  owners: [{ user_id: 'u1', name: 'Olly' }]
}

const answers: Handler = (c) => {
  const p = c._path
  if (p === '/hub/apps')
    return {
      data: [
        { id: 3, key: 'efp', name: 'EFP' },
        { id: 4, key: 'pole', name: 'Pole' }
      ]
    }
  if (p === '/hub/apps/3') return { data: APP }
  if (p.startsWith('/hub/apps/4')) throw apiError(404, { error: 'Not found', code: 'NOT_FOUND' })
  if (p === '/hub/apps/3/status')
    return {
      data: [
        { id: 11, key: 'staging', status: { state: 'ok', version: '0.3.215' } },
        { id: 12, key: 'production', status: { state: 'unreachable', version: null } }
      ]
    }
  if (p.endsWith('/promotable')) return { data: { promote: ['0.3.216'], rollback: [] } }
  if (p === '/hub/connections')
    return {
      data: [
        {
          id: 7,
          provider: 'github',
          name: 'GitHub · acme',
          status: 'ok',
          secret_mask: '••••••',
          secret_fingerprint: 'abc123',
          secret_keys: ['private_key']
        }
      ]
    }
  if (p === '/hub/resources/plan')
    return { data: { changeId: 21, ops: [{ kind: 'create' }], plan_hash: 'h2' } }
  if (p === '/hub/resource-changes/11') return { data: { id: 11, status: 'applied', steps: [] } }
  if (p.endsWith('/plan'))
    return {
      data: {
        ok: true,
        plan_hash: 'h',
        confirm: 'efp/prod',
        lines: ['x'],
        components: [{ name: 'api', image_digest: 'sha256:1' }]
      }
    }
  if (p === '/hub/shared') return { data: [{ id: 2, key: 'pool-a', name: 'Pool A', token: 'x' }] }
  return { data: [] }
}

async function setup(opts: { hub?: boolean; adminTools?: boolean } = {}) {
  const mock = mockClient(answers)
  calls = mock.calls
  const { server } = createNivaroMcpServer({
    url: 'http://nivaro.test',
    client: mock.client,
    adminTools: opts.adminTools,
    hub: opts.hub === false ? null : { adminUrl: 'https://hub.example.com' }
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  mcp = new McpClient({ name: 't', version: '0' })
  await server.connect(b)
  await mcp.connect(a)
}

afterEach(async () => {
  await mcp.close()
})

const names = async () => (await mcp.listTools()).tools.map((t) => t.name)

describe('Hub MCP tools', () => {
  it('are not listed at all without the hub option (an app, not a Hub)', async () => {
    await setup({ hub: false, adminTools: true })
    const n = await names()
    for (const t of [...HUB_TOOL_NAMES, ...HUB_ADMIN_TOOL_NAMES]) expect(n).not.toContain(t)
  })

  it('on a Hub: the ten everyday tools for everyone, the admin three only with adminTools', async () => {
    await setup({ hub: true, adminTools: false })
    const n = await names()
    for (const t of HUB_TOOL_NAMES) expect(n).toContain(t)
    for (const t of HUB_ADMIN_TOOL_NAMES) expect(n).not.toContain(t)
    await mcp.close()
    await setup({ hub: true, adminTools: true })
    const all = await names()
    for (const t of HUB_ADMIN_TOOL_NAMES) expect(all).toContain(t)
  })

  it('every Hub tool is marked read-only', async () => {
    await setup({ hub: true, adminTools: true })
    const tools = (await mcp.listTools()).tools.filter((t) => t.name.startsWith('hub_'))
    expect(tools).toHaveLength(13)
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true)
  })

  it('reads apps and an app, never answering sealed or masked fields', async () => {
    await setup()
    const list = textOf(await mcp.callTool({ name: 'hub_list_apps', arguments: {} }))
    expect(list).toMatchObject({ count: 2, link: 'https://hub.example.com/hub' })
    const app = textOf(await mcp.callTool({ name: 'hub_read_app', arguments: { app_id: 3 } }))
    expect(app.environments).toHaveLength(2)
    expect(JSON.stringify(app)).not.toContain('hub_token')
    expect(app.link).toBe('https://hub.example.com/hub?app=3')
  })

  it('passes the route’s refusal through (an app the caller may not see is not found)', async () => {
    await setup()
    const r = await mcp.callTool({ name: 'hub_read_app', arguments: { app_id: 4 } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('fleet: one status read per app, not-ok environments listed first; refusals per app', async () => {
    await setup()
    const f = textOf(await mcp.callTool({ name: 'hub_fleet_status', arguments: {} }))
    expect(f.attention).toEqual([
      expect.objectContaining({ app: 'efp', environment: 'production', state: 'unreachable' })
    ])
    expect(f.apps.find((a: { key: string }) => a.key === 'pole').error).toBeTruthy()
    expect(calls.every((c) => c._method === 'GET')).toBe(true)
  })

  it('deploy history reads the Hub’s own runs by default, GitLab on request', async () => {
    await setup()
    await mcp.callTool({ name: 'hub_deploy_history', arguments: { environment_id: 11 } })
    await mcp.callTool({
      name: 'hub_deploy_history',
      arguments: { environment_id: 11, source: 'gitlab', limit: 5 }
    })
    expect(calls.map((c) => [c._path, c._params])).toEqual([
      ['/hub/environments/11/deploys/hub', { limit: 20 }],
      ['/hub/environments/11/deploys', { limit: 5 }]
    ])
  })

  it('plan_promote: versions without one; the plan with one — POST to /plan only, link + note', async () => {
    await setup()
    const offered = textOf(
      await mcp.callTool({ name: 'hub_plan_promote', arguments: { app_id: 3, environment_id: 12 } })
    )
    expect(offered.offered.promote).toEqual(['0.3.216'])
    const planned = textOf(
      await mcp.callTool({
        name: 'hub_plan_promote',
        arguments: { app_id: 3, environment_id: 12, version: '0.3.216' }
      })
    )
    expect(planned).toMatchObject({
      plan: { ok: true },
      link: 'https://hub.example.com/hub?app=3',
      note: PLAN_ONLY_NOTE
    })
    // Review L7: nothing that would start the run, no image digests.
    expect(planned.plan).toEqual({ ok: true, lines: ['x'], components: [{ name: 'api' }] })
    const posts = calls.filter((c) => c._method !== 'GET')
    expect(posts.map((c) => [c._path, c._body])).toEqual([
      ['/hub/environments/12/promote/plan', { kind: 'promote', version: '0.3.216' }]
    ])
  })

  it('plan_promote refuses an environment that is not the app’s (no plan asked)', async () => {
    await setup()
    const r = await mcp.callTool({
      name: 'hub_plan_promote',
      arguments: { app_id: 3, environment_id: 99, version: '0.3.216' }
    })
    expect(r.isError).toBe(true)
    expect(calls.some((c) => c._path.endsWith('/plan'))).toBe(false)
  })

  it('admin plans: move and upgrade POST only to their /plan routes and link to the page', async () => {
    await setup({ adminTools: true })
    const move = textOf(
      await mcp.callTool({
        name: 'hub_plan_move',
        arguments: { app_id: 3, environment_id: 11, to: { kind: 'shared', shared_id: 2 } }
      })
    )
    expect(move).toMatchObject({ link: 'https://hub.example.com/hub?app=3', note: PLAN_ONLY_NOTE })
    const up = textOf(
      await mcp.callTool({
        name: 'hub_plan_upgrade',
        arguments: { shared_id: 2, version: '0.3.216' }
      })
    )
    expect(up.link).toBe('https://hub.example.com/hub/shared?shared=2')
    const shared = textOf(await mcp.callTool({ name: 'hub_list_shared', arguments: {} }))
    expect(JSON.stringify(shared)).not.toContain('token')
    const posts = calls.filter((c) => c._method !== 'GET').map((c) => c._path)
    expect(posts).toEqual(['/hub/environments/11/move/plan', '/hub/shared/2/upgrade/plan'])
  })

  it('provider tools: read connections (secrets never answered), resources, a change; plan POSTs only to /plan', async () => {
    await setup()
    const conns = textOf(await mcp.callTool({ name: 'hub_list_connections', arguments: {} }))
    expect(JSON.stringify(conns)).not.toContain('secret')
    await mcp.callTool({
      name: 'hub_list_resources',
      arguments: { app_id: 3, drift_only: true, connection_id: 7 }
    })
    const change = textOf(
      await mcp.callTool({ name: 'hub_read_resource_change', arguments: { change_id: 11 } })
    )
    expect(change.link).toBe('https://hub.example.com/hub/connections?change=11')
    const planned = textOf(
      await mcp.callTool({
        name: 'hub_plan_resources',
        arguments: {
          connection_id: 7,
          scope: 'app',
          app_id: 3,
          environment_id: 11,
          ops: [{ action: 'create', type: 'github.repository', fields: { name: 'web' } }]
        }
      })
    )
    expect(planned.note).toBe(PLAN_ONLY_NOTE)
    expect(planned.link).toBe('https://hub.example.com/hub/connections?change=21')
    expect(JSON.stringify(planned)).not.toContain('plan_hash')
    expect(calls.map((c) => `${c._method} ${c._path}`)).toEqual([
      'GET /hub/connections',
      'GET /hub/resources',
      'GET /hub/resource-changes/11',
      'POST /hub/resources/plan'
    ])
    expect(calls[1]._params).toEqual({ app: 3, connection: 7, drift: 1 })
    expect(calls[3]._body).toEqual({
      connectionId: 7,
      scope: 'app',
      appId: 3,
      environmentId: 11,
      ops: [{ action: 'create', type: 'github.repository', fields: { name: 'web' } }]
    })
  })

  it('no Hub tool ever calls a route that starts, cancels or changes something', async () => {
    await setup({ adminTools: true })
    for (const name of [...HUB_TOOL_NAMES, ...HUB_ADMIN_TOOL_NAMES]) {
      await mcp.callTool({
        name,
        arguments: {
          app_id: 3,
          environment_id: 11,
          shared_id: 2,
          version: '0.3.216',
          to: { kind: 'dedicated', placement_id: 1 }
        }
      })
    }
    for (const c of calls) {
      if (c._method === 'GET') continue
      expect(c._method).toBe('POST')
      expect(c._path).toMatch(/\/plan$/)
    }
  })
})
