import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The app side of the Hub incident banner (routes/hub-link-banner.ts): bearer-only, plain text,
// stored with a TTL, cleared per incident, every open tab told to re-read its banners.

const announced: string[] = []
vi.mock('../../../services/record-events.js', () => ({
  announceToTenant: (e: string) => announced.push(e)
}))

const TOKEN = 't'.repeat(40)
let app: FastifyInstance
let prev: string | undefined

class FakeRedis {
  store = new Map<string, string>()
  ttl = new Map<string, number>()
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async set(k: string, v: string, _m: string, s: number) {
    this.store.set(k, v)
    this.ttl.set(k, s)
    return 'OK'
  }
  async del(k: string) {
    this.store.delete(k)
    return 1
  }
}
const redis = new FakeRedis()

beforeAll(async () => {
  prev = process.env.HUB_TOKEN
  process.env.HUB_TOKEN = TOKEN
  const { hubLinkBannerRoutes } = await import('../../../routes/hub-link-banner.js')
  app = Fastify()
  app.decorate('redis', redis as never)
  await app.register(hubLinkBannerRoutes, { prefix: '/hub-link' })
  // A sibling hub-link plugin's own route still wins over the banner plugin's catch-all.
  await app.register(
    async (f) => {
      f.delete('/retire', async () => ({ sibling: true }))
    },
    { prefix: '/hub-link' }
  )
  await app.ready()
})
afterAll(async () => {
  await app.close()
  if (prev === undefined) delete process.env.HUB_TOKEN
  else process.env.HUB_TOKEN = prev
})
beforeEach(() => {
  redis.store.clear()
  announced.length = 0
})

const auth = { authorization: `Bearer ${TOKEN}` }

describe('PUT / DELETE /api/hub-link/status-banner', () => {
  it('refuses without the hub token', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/hub-link/status-banner',
      payload: { text: 'x', incident_id: 1 }
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().code).toBe('HUB_LINK_REFUSED')
    const bad = await app.inject({
      method: 'PUT',
      url: '/hub-link/status-banner',
      headers: { authorization: 'Bearer nope' },
      payload: { text: 'x', incident_id: 1 }
    })
    expect(bad.statusCode).toBe(401)
    expect(redis.store.size).toBe(0)
  })

  it('every path variant still needs the bearer (no URL-based skip)', async () => {
    for (const url of [
      '/hub-link/status-banner/',
      '/hub-link/%2Fstatus-banner',
      '/hub-link/status-banner;x',
      '/hub-link/STATUS-BANNER',
      '/hub-link/status-banner?x=1'
    ]) {
      const r = await app.inject({ method: 'PUT', url, payload: { text: 'x', incident_id: 1 } })
      expect(r.statusCode, url).toBe(401)
    }
    expect(redis.store.size).toBe(0)
    expect((await app.inject({ method: 'DELETE', url: '/hub-link/retire' })).json()).toEqual({
      sibling: true
    })
  })

  it('stores plain text with a TTL and tells the tabs; clears only its own incident', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/hub-link/status-banner',
      headers: auth,
      payload: { text: '<script>x</script> Orders are slow', tone: 'warn', incident_id: 9 }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().banner).toMatchObject({
      text: 'scriptx/script Orders are slow',
      tone: 'warn',
      incident: 9
    })
    expect(r.headers['cache-control']).toBe('no-store')
    expect([...redis.ttl.values()]).toEqual([7200])
    expect(announced).toEqual(['announcements:changed'])
    const other = await app.inject({
      method: 'DELETE',
      url: '/hub-link/status-banner',
      headers: auth,
      payload: { incident_id: 8 }
    })
    expect(other.json().banner).toMatchObject({ incident: 9 })
    const own = await app.inject({
      method: 'DELETE',
      url: '/hub-link/status-banner',
      headers: auth,
      payload: { incident_id: 9 }
    })
    expect(own.json().banner).toBeNull()
    expect(redis.store.size).toBe(0)
  })

  it('refuses a bad body', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/hub-link/status-banner',
      headers: auth,
      payload: { text: '  ', incident_id: 1 }
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_BANNER')
  })
})
