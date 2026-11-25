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
