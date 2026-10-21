import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDockerFetchForTests } from '../services/docker-source.js'
import {
  configs,
  managerInfo,
  nodes,
  services,
  tasks
} from '../services/infra-swarm/fixtures.test-data.js'
import { infrastructureSwarmRoutes } from './infrastructure-swarm.js'

const saved = { ...process.env }

async function build() {
  const app = Fastify()
  const lists = new Map<string, string[]>()
  app.decorate('redis', {
    lindex: async (k: string, i: number) => lists.get(k)?.[i] ?? null,
    lpush: async (k: string, v: string) => lists.set(k, [v, ...(lists.get(k) ?? [])]).size,
    ltrim: async () => 'OK',
    expire: async () => 1,
    lrange: async (k: string) => lists.get(k) ?? []
  } as never)
  await app.register(infrastructureSwarmRoutes)
  return app
}

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.DOCKER_HOSTS = 'staging=http://proxy:2375,production=http://down:2375'
  setDockerFetchForTests(async (url) => {
    const u = new URL(url)
    if (u.hostname === 'down') throw new Error('connect ECONNREFUSED')
    const body: Record<string, unknown> = {
      '/info': managerInfo,
      '/services': services,
      '/tasks': tasks,
      '/nodes': nodes,
      '/secrets': [],
      '/configs': configs
    }
    if (!(u.pathname in body)) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(body[u.pathname]), { status: 200 })
  })
})
afterEach(() => {
  process.env = { ...saved }
  setDockerFetchForTests(null)
})

describe('/infrastructure swarm routes', () => {
  it('reports each host separately: one down, one answering', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/secrets' })
    expect(res.statusCode).toBe(200)
    const hosts = res.json().data.hosts
    expect(hosts[0]).toMatchObject({ host: 'staging', error: null })
    expect(hosts[0].data.counts.configs).toBe(2)
    expect(hosts[1].host).toBe('production')
    expect(hosts[1].error).toContain('did not answer')
    expect(res.body).not.toContain('cGFzc3dvcmQ9aHVudGVyMg==')
  })

  it('health detail: unknown host 404, bad id 400, engine 404 passed through', async () => {
    const app = await build()
    expect((await app.inject({ method: 'GET', url: '/health/nope/abc' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/health/staging/a%20b' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/health/staging/abc123' })).statusCode).toBe(
      404
    )
  })
})
