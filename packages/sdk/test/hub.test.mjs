// nivaro.hub.* (Hub mode only): calls /api/hub/*, asks GET /api/app-info once per client whether
// the server is a Hub, and fails with HUB_MODE_OFF (not a bare 404) on one that is not.
// Runs against the built dist: `pnpm run build && pnpm test`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNivaro, hubCommands, isNivaroError } from '../dist/index.js'

function server(features, routes = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method, body: init.body })
    const json = (status, body) => ({
      ok: status < 400,
      status,
      statusText: String(status),
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body)
    })
    if (path === '/api/app-info') return json(200, { name: 'X', features })
    const hit = routes[`${init.method} ${path}`]
    if (hit) return json(hit.status ?? 200, hit.body)
    return json(404, { error: 'Not found' })
  }
  return { fetch, calls }
}

describe('nivaro.hub', () => {
  it('reads apps from a Hub and unwraps data', async () => {
    const { fetch, calls } = server(['hub'], {
      'GET /api/hub/apps': { body: { data: [{ id: 1, key: 'efp', name: 'EFP' }] } }
    })
    const n = createNivaro('http://hub', { fetch, token: 'nvk_x' })
    const apps = await n.hub.listApps()
    assert.deepEqual(apps, [{ id: 1, key: 'efp', name: 'EFP' }])
    assert.deepEqual(
      calls.map((c) => c.path),
      ['/api/app-info', '/api/hub/apps']
    )
  })

  it('asks app-info once per client', async () => {
    const { fetch, calls } = server(['hub'], {
      'GET /api/hub/apps': { body: { data: [] } },
      'GET /api/hub/drivers': { body: { data: [] } }
    })
    const n = createNivaro('http://hub', { fetch })
    await n.hub.listApps()
    await n.hub.listDrivers()
    assert.equal(calls.filter((c) => c.path === '/api/app-info').length, 1)
    assert.equal(await n.hub.isHub(), true)
  })

  it('fails with HUB_MODE_OFF on a server that is not a Hub, without calling /api/hub', async () => {
    const { fetch, calls } = server(['chat'])
    const n = createNivaro('http://plain', { fetch })
    await assert.rejects(n.hub.listApps(), (err) => {
      assert.ok(isNivaroError(err))
      assert.equal(err.code, 'HUB_MODE_OFF')
      assert.equal(err.path, '/hub/apps')
      return true
    })
    assert.equal(
      calls.some((c) => c.path.startsWith('/api/hub')),
      false
    )
    assert.equal(await n.hub.isHub(), false)
  })

  it('sends plans as POST bodies and keeps the server refusal', async () => {
    const { fetch, calls } = server(['hub'], {
      'POST /api/hub/environments/7/promote/plan': {
        status: 403,
        body: { error: 'This API key needs the hub:read scope', code: 'HUB_SCOPE_MISSING' }
      }
    })
    const n = createNivaro('http://hub', { fetch })
    await assert.rejects(n.hub.planPromotion(7, { kind: 'promote', version: '0.3.215' }), (err) => {
      assert.equal(err.status, 403)
      assert.equal(err.code, 'HUB_SCOPE_MISSING')
      return true
    })
    const sent = calls.find((c) => c.path === '/api/hub/environments/7/promote/plan')
    assert.equal(sent.method, 'POST')
    assert.deepEqual(JSON.parse(sent.body), { kind: 'promote', version: '0.3.215' })
  })

  it('exposes the raw commands for nivaro.request', () => {
    const c = hubCommands.planMove(3, { kind: 'shared', shared_deployment_id: 2 })
    assert.equal(c._method, 'POST')
    assert.equal(c._path, '/hub/environments/3/move/plan')
    assert.deepEqual(c._body, { to: { kind: 'shared', shared_deployment_id: 2 } })
  })
})

describe('nivaro.hub provider calls', () => {
  it('reads connections, resources and changes with their filters', async () => {
    const { fetch, calls } = server(['hub'], {
      'GET /api/hub/connections': { body: { data: [{ id: 7, provider: 'github' }] } },
      'GET /api/hub/resources': { body: { data: [] } },
      'GET /api/hub/resource-changes/11': { body: { data: { id: 11, status: 'applied' } } },
      'GET /api/hub/connections/7/unmanaged': { body: { data: { items: [], cursor: null } } }
    })
    const n = createNivaro('http://hub', { fetch })
    assert.deepEqual(await n.hub.listConnections('github'), [{ id: 7, provider: 'github' }])
    await n.hub.listResources({ app: 3, drift: 1 })
    assert.equal((await n.hub.readResourceChange(11)).status, 'applied')
    await n.hub.listUnmanaged(7, { type: 'github.repository' })
    const url = (path) => calls.find((c) => c.path === path)
    assert.ok(url('/api/hub/connections'))
    assert.ok(url('/api/hub/resources'))
  })

  it('plans with a POST body; starting a change sends the plan hash', async () => {
    const { fetch, calls } = server(['hub'], {
      'POST /api/hub/resources/plan': { body: { data: { changeId: 5, plan_hash: 'h' } } },
      'POST /api/hub/resource-changes/5/start': { body: { data: { id: 5, status: 'applying' } } }
    })
    const n = createNivaro('http://hub', { fetch })
    const plan = await n.hub.planResources({
      connectionId: 7,
      scope: 'app',
      appId: 3,
      environmentId: 9,
      ops: [{ action: 'create', type: 'github.repository', fields: { name: 'web' } }]
    })
    assert.equal(plan.changeId, 5)
    await n.hub.startResourceChange(5, { planHash: 'h', confirm: 'web' })
    const start = calls.find((c) => c.path === '/api/hub/resource-changes/5/start')
    assert.equal(start.method, 'POST')
    assert.deepEqual(JSON.parse(start.body), { planHash: 'h', confirm: 'web' })
  })

  it('encodes ids and builds the action paths', () => {
    assert.equal(hubCommands.cancelResourceChange(5)._path, '/hub/resource-changes/5/cancel')
    assert.equal(hubCommands.undoResourceChange(5)._path, '/hub/resource-changes/5/undo')
    assert.equal(hubCommands.approveResourceChange(5, { planHash: 'h' })._method, 'POST')
    assert.equal(hubCommands.setAppConnections(3, [1, 2])._method, 'PUT')
    assert.deepEqual(hubCommands.setAppConnections(3, [1, 2])._body, { connection_ids: [1, 2] })
    assert.equal(hubCommands.adoptResource(7, { type: 't', externalId: 'x', scope: 'shared' })._path, '/hub/connections/7/adopt')
  })
})

describe('nivaro.hub provider hooks (Task 11c)', () => {
  it('reads targets, placement components and database servers', async () => {
    const { fetch, calls } = server(['hub'], {
      'GET /api/hub/targets': {
        body: { data: [{ id: 1, kind: 'github', name: 'Repos', connection_id: 7 }] }
      },
      'GET /api/hub/placements/4/components': {
        body: {
          data: [{ id: 9, kind: 'github_actions', resource_id: 12, deploy_job: 'approve:prod' }]
        }
      },
      'GET /api/hub/db-servers': { body: { data: [{ id: 2, name: 'rds', resource_id: 30 }] } }
    })
    const n = createNivaro('http://hub', { fetch })
    assert.equal((await n.hub.listTargets())[0].connection_id, 7)
    assert.equal((await n.hub.listComponents(4))[0].deploy_job, 'approve:prod')
    assert.equal((await n.hub.listDatabaseServers())[0].resource_id, 30)
    assert.ok(calls.find((c) => c.path === '/api/hub/placements/4/components'))
    assert.equal(hubCommands.listComponents(4)._method, 'GET')
  })
})

describe('nivaro.hub through a wrapped client', () => {
  it('a Proxy that replaces request also carries the Hub calls (read-only wrappers refuse them)', async () => {
    const { fetch, calls } = server(['hub'], { 'GET /api/hub/apps': { body: { data: [] } } })
    const base = createNivaro('http://hub', { fetch })
    const refused = []
    const readOnly = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'request')
          return (c) => {
            if (c._method !== 'GET') {
              refused.push(c._path)
              return Promise.reject(new Error('read-only'))
            }
            return target.request(c)
          }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      }
    })
    assert.deepEqual(await readOnly.hub.listApps(), [])
    await assert.rejects(readOnly.hub.updateApp(1, { name: 'x' }), /read-only/)
    assert.deepEqual(refused, ['/hub/apps/1'])
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0)
    assert.equal(base.hub, base.hub)
  })
})
