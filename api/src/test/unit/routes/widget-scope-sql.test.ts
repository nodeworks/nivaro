import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A custom-query widget applies the caller's User Scope values BEFORE the SQL
// text is built: the statement that runs and the cache key it is stored under
// both carry them. Concurrent same-key renders share one run.
vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'test' } }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(async () => null),
  getAiModelSettings: vi.fn(async () => ({}))
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/definition-cache.js', () => ({
  cachedDefinition: vi.fn((_k: string, fn: () => unknown) => fn())
}))
vi.mock('../../../services/query-freshness.js', () => ({
  queryFreshness: vi.fn(async () => null)
}))
vi.mock('../../../services/custom-query-scope.js', () => ({
  applyScopeParams: vi.fn(
    async (_def: unknown, params: Record<string, unknown>, userId?: string) => {
      if (userId === 'restricted') params.zone = 'Z1'
    }
  )
}))

const sql = vi.hoisted(() => ({ ran: [] as string[], hold: null as Promise<void> | null }))
vi.mock('../../../db/index.js', () => {
  class Request {
    private handlers: Record<string, (...a: unknown[]) => void> = {}
    constructor(public text: string) {
      sql.ran.push(text)
    }
    on(ev: string, h: (...a: unknown[]) => void) {
      this.handlers[ev] = h
    }
    once(ev: string, h: (...a: unknown[]) => void) {
      this.handlers[ev] = h
    }
    setTimeout() {}
    fire() {
      this.handlers.row?.([{ metadata: { colName: 'total' }, value: 5 }])
      this.handlers.requestCompleted?.()
    }
  }
  const client = {
    _driver: () => ({ Request }),
    acquireConnection: async () => ({
      execSqlBatch: (r: Request) => {
        void (sql.hold ?? Promise.resolve()).then(() => setTimeout(() => r.fire(), 0))
      }
    }),
    releaseConnection: async () => {}
  }
  const db = Object.assign(
    vi.fn((table: string) => {
      const c: Record<string, unknown> = {}
      c.where = vi.fn(() => c)
      c.first = vi.fn(async () =>
        table === 'nivaro_widgets'
          ? {
              id: 1,
              widget_type: 'custom-query',
              config: JSON.stringify({
                query_id: 9,
                value_field: 'total',
                param_bindings: [{ param: ':year', input_key: 'year' }]
              })
            }
          : {
              id: 9,
              slug: 'spend',
              access: 'authenticated',
              sql_text: 'EXEC dbo.spend :year, :zone',
              scope_params: '{"zone":{"dimension":"zone"}}',
              cache_ttl: 60
            }
      )
      return c
    }),
    { client }
  )
  return { db }
})

import { widgetsInternalRoutes } from '../../../routes/widgets-internal.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

async function render(userId: string) {
  const app = Fastify({ logger: false })
  const redis = {
    get: vi.fn(async (_key: string) => null),
    setex: vi.fn(async (_key: string, _ttl: number, _value: string) => 'OK')
  }
  app.decorate('redis', redis as never)
  app.addHook('onRequest', async (req) => {
    ;(req as { user?: unknown }).user = { id: userId, role: 'R' }
    ;(req as { isAdmin?: boolean }).isAdmin = false
  })
  app.register(widgetsInternalRoutes, { prefix: '/widgets-internal' })
  await app.ready()
  const res = await app.inject({
    method: 'POST',
    url: '/widgets-internal/1/render',
    payload: { inputs: { year: 2026 } }
  })
  return { res, redis }
}

afterEach(() => {
  sql.ran.length = 0
  sql.hold = null
  resetSingleFlight()
})

describe('custom-query widget User Scopes', () => {
  it('a restricted viewer runs SQL carrying the scope value, cached under the scoped key', async () => {
    const { res, redis } = await render('restricted')
    expect(res.statusCode).toBe(200)
    expect(sql.ran).toEqual(["EXEC dbo.spend 2026, 'Z1'"])
    const key = redis.setex.mock.calls[0]?.[0] as string
    expect(key).toBe(`cq:spend:${JSON.stringify({ year: 2026, zone: 'Z1' })}`)
    expect(redis.get).toHaveBeenCalledWith(key)
  })

  it('an unrestricted viewer runs the unscoped statement under the unscoped key', async () => {
    const { res, redis } = await render('free')
    expect(res.statusCode).toBe(200)
    expect(sql.ran).toEqual(['EXEC dbo.spend 2026, NULL'])
    expect(redis.setex.mock.calls[0]?.[0]).toBe(`cq:spend:${JSON.stringify({ year: 2026 })}`)
  })

  it('concurrent renders share one run per final key, never across scope values', async () => {
    let open!: () => void
    sql.hold = new Promise<void>((r) => {
      open = r
    })
    const calls = [
      render('free-a'),
      render('free-b'),
      render('free-c'),
      render('restricted'),
      render('restricted')
    ]
    await new Promise((r) => setTimeout(r, 30))
    open()
    const out = await Promise.all(calls)
    expect(out.map((o) => o.res.statusCode)).toEqual([200, 200, 200, 200, 200])
    expect([...sql.ran].sort()).toEqual(["EXEC dbo.spend 2026, 'Z1'", 'EXEC dbo.spend 2026, NULL'])
    const shared = out.filter((o) =>
      String(o.res.headers['server-timing'] ?? '').includes('shared')
    )
    expect(shared).toHaveLength(3)
  })
})
