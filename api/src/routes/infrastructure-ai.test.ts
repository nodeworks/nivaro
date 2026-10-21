import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDockerFetchForTests } from '../services/docker-source.js'
import { infrastructureAiRoutes } from './infrastructure-ai.js'

const saved = { ...process.env }

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.DOCKER_HOSTS
  delete process.env.DOCKER_API_URL
})
afterEach(() => {
  process.env = { ...saved }
  setDockerFetchForTests(null)
})

async function app() {
  const f = Fastify()
  f.decorate('redis', null as never)
  await f.register(infrastructureAiRoutes, { prefix: '/infrastructure' })
  return f
}

describe('GET /infrastructure/summary/:tool', () => {
  it('answers a not-configured note when no Docker host is connected', async () => {
    const f = await app()
    const res = await f.inject({ url: '/infrastructure/summary/infra_stacks' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ configured: false })
    await f.close()
  })
  it('404s a tool that is not an infrastructure summary', async () => {
    const f = await app()
    const res = await f.inject({ url: '/infrastructure/summary/delete_item' })
    expect(res.statusCode).toBe(404)
    await f.close()
  })
  it('400s an unknown host', async () => {
    process.env.DOCKER_API_URL = 'http://docker.test'
    setDockerFetchForTests(async () => new Response('[]', { status: 200 }))
    const f = await app()
    const res = await f.inject({ url: '/infrastructure/summary/infra_stacks?host=nope' })
    expect(res.statusCode).toBe(400)
    await f.close()
  })
})
