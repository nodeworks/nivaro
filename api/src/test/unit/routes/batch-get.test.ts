import { readFileSync } from 'node:fs'
import Fastify, { type FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// POST /api/batch-get must answer each part exactly as the plain GET answers the same
// caller: it runs the real route in-process with the caller's own headers, so whatever the
// route judges (who is signed in, their role, workspace, tenant host, address) is judged
// the same way. These routes stand in for real ones with a judgement of their own.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: FastifyRequest & { user?: unknown; isAdmin?: boolean }) => {
    const auth = req.headers.authorization
    if (auth === 'Bearer admin') {
      req.user = { id: 'admin' } as never
      req.isAdmin = true
    } else if (auth === 'Bearer viewer') {
      req.user = { id: 'viewer' } as never
      req.isAdmin = false
    }
  })
}))

import { authenticate } from '../../../middleware/authenticate.js'
import { batchGetRoutes } from '../../../routes/batch-get.js'
import {
  BATCH_GET_MAX,
  BATCHABLE_GET,
  batchGetPath,
  partHeaders
} from '../../../services/batch-get.js'

type Req = FastifyRequest & { user?: { id: string }; isAdmin?: boolean }

const seen: Array<Record<string, unknown>> = []

function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true })
  app.register(
    async (api) => {
      await api.register(batchGetRoutes)
      // Admins only.
      api.get('/roles', { preHandler: authenticate }, async (req: Req, reply) => {
        if (!req.user) return reply.code(401).send({ error: 'Sign in first' })
        if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
        return { data: ['Admin', 'User'] }
      })
      // Open to anyone; signed-in callers get more.
      api.get('/settings', { preHandler: authenticate }, async (req: Req) => ({
        data: req.user ? { who: req.user.id, all: true } : { public: true }
      }))
      // Per record, per caller; 404 for a record they cannot see.
      api.get('/sla/status/:c/:id', { preHandler: authenticate }, async (req: Req, reply) => {
        const { c, id } = req.params as { c: string; id: string }
        if (id === '404') return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        return { data: { c, id, viewer: req.user?.id ?? null, q: req.query } }
      })
      // Echoes what the caller sent, as the route sees it.
      api.get('/pinned', { preHandler: authenticate }, async (req: Req) => {
        seen.push({ ...req.headers, ip: req.ip })
        return {
          data: {
            workspace: req.headers['x-workspace'] ?? null,
            host: req.headers.host,
            ip: req.ip
          }
        }
      })
      // A JSON 429 with a Retry-After.
      api.get('/my-jobs', async (_req, reply) =>
        reply
          .code(429)
          .header('retry-after', '7')
          .send({ error: 'Slow down', code: 'RATE_LIMITED' })
      )
      // Not JSON.
      api.get('/tasks', async (_req, reply) => reply.type('text/plain').send('plain'))
      // Not on the list.
      api.get('/efp/workflow-actuals/:id', async () => ({ data: 'heavy' }))
    },
    { prefix: '/api' }
  )
  return app
}

async function batch(
  app: ReturnType<typeof buildApp>,
  paths: string[],
  headers: Record<string, string> = {}
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/batch-get',
    headers: { 'content-type': 'application/json', ...headers },
    payload: { reads: paths.map((path, i) => ({ key: `k${i}`, path })) }
  })
  return res
}

async function single(
  app: ReturnType<typeof buildApp>,
  path: string,
  headers: Record<string, string> = {}
) {
  const res = await app.inject({ method: 'GET', url: `/api${path}`, headers })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined }
}

describe('POST /api/batch-get', () => {
  it('answers every part exactly as its own GET answers the same caller', async () => {
    const app = buildApp()
    const paths = ['/roles', '/settings', '/sla/status/workflows/7?x=1&y=two', '/sla/status/w/404']
    for (const who of ['Bearer admin', 'Bearer viewer']) {
      const headers = { authorization: who }
      const res = await batch(app, paths, headers)
      expect(res.statusCode).toBe(200)
      const { results } = res.json() as {
        results: Array<{ key: string; status: number; body?: unknown }>
      }
      for (const [i, path] of paths.entries()) {
        const own = await single(app, path, headers)
        expect(results[i].key).toBe(`k${i}`)
        expect({ status: results[i].status, body: results[i].body }, `${who} ${path}`).toEqual(own)
      }
    }
    // The viewer is refused the admin-only list, as on its own GET.
    const viewer = (
      await batch(app, ['/roles', '/settings'], { authorization: 'Bearer viewer' })
    ).json() as { results: Array<{ status: number }> }
    expect(viewer.results.map((r) => r.status)).toEqual([403, 200])
  })

  it('refuses a caller who is not signed in, as a whole', async () => {
    const res = await batch(buildApp(), ['/settings'])
    expect(res.statusCode).toBe(401)
  })

  it('runs each part with the caller headers: workspace, tenant host, address', async () => {
    seen.length = 0
    const res = await batch(buildApp(), ['/pinned'], {
      authorization: 'Bearer viewer',
      'x-workspace': 'ws-9',
      host: 'acme.nivaro.dev',
      'x-forwarded-for': '203.0.113.5',
      'if-none-match': '"abc"'
    })
    const part = (res.json() as { results: Array<{ body: { data: Record<string, string> } }> })
      .results[0].body.data
    expect(part).toEqual({ workspace: 'ws-9', host: 'acme.nivaro.dev', ip: '203.0.113.5' })
    // Never the batch body's framing or a conditional header (a part never answers 304).
    expect(seen[0]['content-length']).toBeUndefined()
    expect(seen[0]['content-type']).toBeUndefined()
    expect(seen[0]['if-none-match']).toBeUndefined()
    expect(seen[0]['accept-encoding']).toBe('identity')
  })

  it('carries a refusal body, the request id and Retry-After; non-JSON parts carry no body', async () => {
    const res = await batch(buildApp(), ['/my-jobs', '/tasks'], { authorization: 'Bearer viewer' })
    const { results } = res.json() as { results: Array<Record<string, unknown>> }
    expect(results[0]).toMatchObject({
      status: 429,
      retry_after: '7',
      body: { error: 'Slow down', code: 'RATE_LIMITED' }
    })
    expect(results[1]).toEqual({ key: 'k1', status: 200 })
  })

  it('answers 400 for a part outside the list, and runs nothing for it', async () => {
    const res = await batch(buildApp(), ['/efp/workflow-actuals/1', '/settings', '/../roles'], {
      authorization: 'Bearer admin'
    })
    const { results } = res.json() as { results: Array<{ status: number; body?: unknown }> }
    expect(results.map((r) => r.status)).toEqual([400, 200, 400])
    expect(results[0].body).toBeUndefined()
  })

  it('refuses a malformed or oversized body', async () => {
    const app = buildApp()
    const empty = await app.inject({
      method: 'POST',
      url: '/api/batch-get',
      headers: { authorization: 'Bearer viewer' },
      payload: { reads: [] }
    })
    expect(empty.statusCode).toBe(400)
    const big = await batch(
      app,
      Array.from({ length: BATCH_GET_MAX + 1 }, () => '/settings'),
      { authorization: 'Bearer viewer' }
    )
    expect(big.statusCode).toBe(400)
  })
})

describe('batchGetPath', () => {
  it('keeps listed paths with their query strings', () => {
    expect(batchGetPath('/field-rules?collection=workflows')).toBe(
      '/field-rules?collection=workflows'
    )
    expect(batchGetPath('/pipelines/instances/workflows?ids=1')).toBe(
      '/pipelines/instances/workflows?ids=1'
    )
  })

  it('refuses identity reads, record reads, encoded slashes, dot segments and other routes', () => {
    for (const p of [
      '/users/me',
      '/auth/me',
      '/auth/ws-token',
      '/items/workflows/1',
      '/collections/workflows',
      '/batch-get',
      '/sla/status/a%2Fb/1',
      '/field-config/..',
      '/field-config/./x',
      '//settings',
      'settings',
      '/settings#x',
      null,
      42
    ])
      expect(batchGetPath(p), String(p)).toBeNull()
  })

  it('drops framing and conditional headers from the caller headers', () => {
    const h = partHeaders({
      headers: {
        cookie: 'sid=1',
        'content-length': '10',
        'content-type': 'application/json',
        'if-none-match': 'x',
        'x-nivaro-app': 'efp'
      }
    } as unknown as FastifyRequest)
    expect(h).toEqual({ cookie: 'sid=1', 'x-nivaro-app': 'efp', 'accept-encoding': 'identity' })
  })
})

describe('BATCHABLE_GET twin', () => {
  it('is byte-identical to packages/shared lib/batch-gets.ts', () => {
    const shared = readFileSync(
      new URL('../../../../../packages/shared/src/lib/batch-gets.ts', import.meta.url),
      'utf8'
    )
    const m = /export const BATCHABLE_GET =\s*(\/.*\/)\n/.exec(shared)
    expect(m?.[1]).toBe(String(BATCHABLE_GET))
  })
})
