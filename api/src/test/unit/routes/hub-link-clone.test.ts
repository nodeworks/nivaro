import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub enhancement 46, app side: GET /api/hub-link/clone/blueprint answers only the Hub's bearer
// (plugin-scoped onRequest, never judged from the URL), never caches, and answers refusals as
// codes.

const TOKEN = 'h'.repeat(40)

vi.mock('../../../services/hub/mode.js', async (orig) => ({
  ...(await orig<object>()),
  hubLinkToken: () => TOKEN
}))
vi.mock('../../../services/hub-link/clone-export.js', async (orig) => ({
  ...(await orig<object>()),
  exportCloneBlueprint: vi.fn(async () => ({
    package: { type: 'nivaro-blueprint-package' },
    scrubbed: ['flows[A].operations[b].options.headers.Authorization'],
    review: {},
    bytes: 10
  }))
}))

const { hubLinkCloneRoutes } = await import('../../../routes/hub-link-clone.js')
const { CloneExportError, exportCloneBlueprint } = await import(
  '../../../services/hub-link/clone-export.js'
)

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(hubLinkCloneRoutes, { prefix: '/api/hub-link' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('GET /api/hub-link/clone/blueprint', () => {
  it('refuses without the hub token, however the path is spelled', async () => {
    for (const url of [
      '/api/hub-link/clone/blueprint',
      '/api/hub-link//clone/blueprint',
      '/api/hub-link/clone/blueprint/',
      '/api/hub-link/clone/%62lueprint'
    ]) {
      const res = await app.inject({ method: 'GET', url })
      expect([401, 404], url).toContain(res.statusCode)
      if (res.statusCode === 401) expect(res.json().code).toBe('HUB_LINK_REFUSED')
    }
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/hub-link/clone/blueprint',
      headers: { authorization: `Bearer ${'x'.repeat(40)}` }
    })
    expect(wrong.statusCode).toBe(401)
    expect(exportCloneBlueprint).not.toHaveBeenCalled()
  })

  it('answers the structure with the bearer, never cached', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/hub-link/clone/blueprint',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toMatchObject({
      scrubbed: [expect.any(String)],
      version: expect.any(String)
    })
  })

  it('a refusal is a code and a plain sentence', async () => {
    vi.mocked(exportCloneBlueprint).mockRejectedValueOnce(
      new CloneExportError('NOTHING_TO_CLONE', 'This app has no collections of its own.')
    )
    const res = await app.inject({
      method: 'GET',
      url: '/api/hub-link/clone/blueprint',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('NOTHING_TO_CLONE')
  })
})
