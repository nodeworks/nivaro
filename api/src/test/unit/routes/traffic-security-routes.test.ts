// api/src/test/unit/routes/traffic-security-routes.test.ts
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every knex chain resolves to [] (no registry, no integrity rows, no keys).
vi.mock('../../../db/index.js', () => {
  const chain: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
      if (prop === 'catch') return () => Promise.resolve([])
      return chain
    },
    apply: () => chain
  })
  return { db: chain }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => false }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))

import { securityRoutes } from '../../../routes/traffic-map-extras/security.js'
import { advanceTo } from '../../../services/traffic-map.js'
import { noteCacheFacts } from '../../../services/traffic-taps/http-cache.js'
import { noteSessionHit, sessionKeyOf } from '../../../services/traffic-taps/session-guard.js'
import { resetTapState } from '../../../services/traffic-taps.js'

const PERSON = 'u4A52933C-0000-4000-8000-000000000001'
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

async function build() {
  const app = Fastify()
  await app.register(securityRoutes)
  return app
}

beforeEach(() => resetTapState())

describe('traffic map security routes', () => {
  it('summary flags the caller of a scripted session', async () => {
    const now = Date.now()
    for (let i = 0; i < 25; i++)
      noteSessionHit({
        sid: sessionKeyOf('s1'),
        caller: PERSON,
        at: now - (25 - i) * 5000,
        route: 'GET /api/items/x',
        ip: '8.8.8.8',
        ua: CHROME,
        fromApp: false,
        native: false
      })
    const app = await build()
    const res = await app.inject({ url: '/security/summary?window=300' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.flags[PERSON][0]).toMatchObject({ kind: 'scripted', tone: 'warn' })
    const caller = await app.inject({ url: `/security/caller?caller=${PERSON}` })
    const d = caller.json().data
    expect(d.sessions[0].scripted.patterns.length).toBeGreaterThan(0)
    expect(d.geo.status.enabled).toBe(false)
    expect(d.sessions[0].id).not.toContain('s1')
    await app.close()
  })
  it('refuses a bad caller key and serves the cache lens', async () => {
    const sec = Math.floor(Date.now() / 1000)
    advanceTo(sec)
    noteCacheFacts({
      route: 'GET /api/version',
      fetchKey: 'u|/api/version',
      sec,
      status: 200,
      conditional: false,
      cacheControl: null,
      etag: null,
      lastModified: null
    })
    const app = await build()
    expect((await app.inject({ url: '/security/caller?caller=drop%20table' })).statusCode).toBe(400)
    const res = await app.inject({ url: '/security/http-cache?window=60' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.routes[0]).toMatchObject({ route: 'GET /api/version', n: 1 })
    const env = await app.inject({ url: '/security/misconfigured' })
    expect(env.json().data.registry.configured).toBe(false)
    await app.close()
  })
})
