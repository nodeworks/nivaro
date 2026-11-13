import { STATUS_CODES } from 'node:http'
import fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The error handler's database steps, through a real Fastify app, and the one-issue-per-outage
// counter behind them. The issue writer and the health probe are stand-ins: no database.

const probe = vi.hoisted(() => ({ healthy: true }))
vi.mock('../../../services/db-health.js', () => ({ isDbHealthy: () => probe.healthy }))
vi.mock('../../../services/error-tracking.js', () => ({
  trackGroupedIssue: vi.fn(async () => 1),
  trackError: vi.fn(async () => 1)
}))

import { clientLeft } from '../../../lib/client-left.js'
import { describeDbRefusal, serverFaultMessage } from '../../../lib/db-refusal.js'
import { markNoConnection } from '../../../lib/db-unavailable.js'
import {
  _resetDbOutageForTests,
  answerDbUnavailable,
  DB_OUTAGE_MESSAGE,
  DB_OUTAGE_ROUTE,
  flushDbOutage,
  noteCutStatement,
  noteDbOutage,
  outageReason,
  requestDbFailure
} from '../../../services/db-outage.js'
import { trackError } from '../../../services/error-tracking.js'

const driver = (message: string, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra })
const poolTimeout = () =>
  Object.assign(new Error('Knex: Timeout acquiring a connection. The pool is probably full.'), {
    name: 'KnexTimeoutError'
  })

const THROWN: Record<string, () => unknown> = {
  login: () => driver("Login failed for user 'app_rw'.", 'ELOGIN'),
  refused: () =>
    driver('Failed to connect to db.internal:1433 - connect ECONNREFUSED 10.0.0.5:1433', 'ESOCKET'),
  slow: () => driver('Failed to connect to db.internal:1433 in 15000ms', 'ETIMEOUT'),
  reset: () => driver('Connection lost - socket hang up', 'ESOCKET'),
  starved: () => markNoConnection(poolTimeout(), { pool: 'main', opensFailing: true }),
  gone: () =>
    driver(
      'select [id] from [orders] - Requests can only be made in the LoggedIn state, not the Final state',
      'EINVALIDSTATE'
    ),
  busy: () => markNoConnection(poolTimeout(), { pool: 'main', opensFailing: false }),
  cut: () =>
    driver(
      'update [orders] set [total] = @p0 where [id] = @p1 - Connection closed before request completed.',
      'ECLOSE'
    ),
  timeout: () =>
    driver(
      'select [id] from [orders] - Timeout: Request failed to complete in 15000ms',
      'ETIMEOUT'
    ),
  deadlock: () =>
    driver(
      'update [orders] set [n] = @p0 - Transaction (Process ID 71) was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.',
      'EREQUEST',
      { number: 1205 }
    ),
  duplicate: () =>
    driver(
      "insert into [orders] ([n]) values (@p0) - Violation of UNIQUE KEY constraint 'uq_orders_n'. Cannot insert duplicate key in object 'dbo.orders'.",
      'EREQUEST',
      { number: 2627 }
    ),
  smtp: () => driver('Login failed: 535 5.7.8 Authentication failed', 'EAUTH'),
  bug: () => new TypeError("Cannot read properties of undefined (reading 'id')")
}

/**
 * The database steps of server.ts's error handler, in its order: the client-left return
 * first, then the unreachable database, the busy pool, a data refusal, and the 5xx path
 * where a cut statement is counted for the outage instead of filed per route.
 */
async function app(): Promise<FastifyInstance> {
  const f = fastify()
  f.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (clientLeft(err, reply.raw)) return
    if (answerDbUnavailable(err, req, reply)) return
    if (err.statusCode == null && requestDbFailure(err) === 'busy')
      return reply.code(503).header('Retry-After', '5').send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The server is busy right now. Please try again in a few seconds.',
        code: 'SERVER_BUSY'
      })
    const refusal = err.statusCode == null ? describeDbRefusal(err) : null
    if (refusal)
      return reply.code(refusal.status).send({
        statusCode: refusal.status,
        error: STATUS_CODES[refusal.status],
        message: refusal.message,
        code: refusal.code
      })
    const status = err.statusCode ?? 500
    if (status >= 500 && !noteCutStatement(err, req))
      void trackError({
        source: 'server',
        route: `${req.method} ${req.routeOptions.url}`,
        message: err.message
      })
    return reply.code(status).send({
      statusCode: status,
      error: STATUS_CODES[status],
      message: serverFaultMessage(err)
    })
  })
  f.all('/api/things/:kind', async (req) => {
    throw THROWN[(req.params as { kind: string }).kind]()
  })
  await f.ready()
  return f
}

const filed = vi.fn(async (_report: Record<string, unknown>) => 7 as number | null)
let clock = 1_000_000
let server: FastifyInstance

beforeEach(async () => {
  clock = 1_000_000
  probe.healthy = true
  filed.mockClear()
  filed.mockImplementation(async () => 7)
  vi.mocked(trackError).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  _resetDbOutageForTests({ now: () => clock, file: filed as never })
  server = await app()
})
afterEach(async () => {
  _resetDbOutageForTests()
  await server.close()
  vi.restoreAllMocks()
})

const call = (kind: string, method: 'GET' | 'POST' | 'PATCH' = 'GET') =>
  server.inject({ method, url: `/api/things/${kind}` })

describe('what the caller gets', () => {
  it.each([
    'login',
    'refused',
    'slow',
    'reset',
    'starved',
    'gone'
  ])('no connection (%s): 503 DB_UNAVAILABLE, Retry-After, the plain sentence', async (kind) => {
    const res = await call(kind, 'PATCH')
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')
    expect(res.json()).toEqual({
      statusCode: 503,
      error: 'The database is not answering right now.',
      message: 'The database is not answering right now.',
      code: 'DB_UNAVAILABLE'
    })
    // Nothing of the driver's: no login, no address, no code.
    expect(res.body).not.toMatch(/app_rw|db\.internal|10\.0\.0\.5|1433|ELOGIN|ESOCKET|Knex/)
    // Not a per-route issue.
    expect(vi.mocked(trackError)).not.toHaveBeenCalled()
  })

  it('a busy pool keeps its own answer', async () => {
    const res = await call('busy')
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')
    expect(res.json().code).toBe('SERVER_BUSY')
    expect(vi.mocked(trackError)).not.toHaveBeenCalled()
    expect(await flushDbOutage({ force: true })).toBeNull()
  })

  it('a statement cut off mid-run stays a 500: it is not "try again, nothing happened"', async () => {
    const res = await call('cut', 'PATCH')
    expect(res.statusCode).toBe(500)
    expect(res.headers['retry-after']).toBeUndefined()
    expect(res.json().code).toBeUndefined()
    expect(res.json().message).toMatch(/could not finish this request/)
    expect(res.body).not.toMatch(/orders|Connection closed/)
    // Counted with the outage, not filed under its route.
    expect(vi.mocked(trackError)).not.toHaveBeenCalled()
    await flushDbOutage({ force: true })
    expect(filed).toHaveBeenCalledTimes(1)
    expect(filed.mock.calls[0][0]).toMatchObject({ count: 1 })
    expect(String(filed.mock.calls[0][0].note)).toMatch(
      /Cut off while a statement was running .*1× PATCH \/api\/things\/:kind/
    )
  })

  it.each([
    ['timeout', 500],
    ['deadlock', 500],
    ['smtp', 500],
    ['bug', 500]
  ])('an ordinary error is untouched (%s): %i, filed under its own route', async (kind, status) => {
    const res = await call(kind)
    expect(res.statusCode).toBe(status)
    expect(res.headers['retry-after']).toBeUndefined()
    expect(res.json().code).toBeUndefined()
    expect(vi.mocked(trackError)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(trackError).mock.calls[0][0]).toMatchObject({
      route: 'GET /api/things/:kind'
    })
    expect(await flushDbOutage({ force: true })).toBeNull()
    expect(filed).not.toHaveBeenCalled()
  })

  it('a data refusal is still the caller’s 4xx', async () => {
    const res = await call('duplicate', 'POST')
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('DUPLICATE_RECORD')
    expect(vi.mocked(trackError)).not.toHaveBeenCalled()
  })

  it('an error that carries its own status is ours, whatever it looks like', async () => {
    const f = fastify()
    f.setErrorHandler((err, req, reply) => {
      if (answerDbUnavailable(err, req, reply)) return
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ ours: true })
    })
    f.get('/x', async () => {
      throw Object.assign(driver("Login failed for user 'x'.", 'ELOGIN'), { statusCode: 502 })
    })
    const res = await f.inject({ method: 'GET', url: '/x' })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ ours: true })
    await f.close()
  })
})

describe('one issue per outage', () => {
  // Production 2026-11-12: 26 failing requests on 5 routes became 10 issues.
  it('N failing requests on M routes are ONE report with N occurrences', async () => {
    const routes: Array<[string, number]> = [
      ['POST /api/session-recordings/:id/events', 16],
      ['POST /api/analytics/pageview', 4],
      ['PATCH /api/items/:collection/:id', 3],
      ['GET /api/realtime/build-status', 2],
      ['GET /api/presence/online', 1]
    ]
    for (const [route, n] of routes)
      for (let i = 0; i < n; i++) {
        noteDbOutage({ kind: 'unreachable', route, userId: null, err: THROWN.login() })
        clock += 100
      }
    // Still going on a moment ago: nothing is written yet.
    expect(await flushDbOutage()).toBeNull()
    expect(filed).not.toHaveBeenCalled()

    clock += 5_000
    expect(await flushDbOutage()).toBe(7)
    expect(filed).toHaveBeenCalledTimes(1)
    const report = filed.mock.calls[0][0] as {
      route: string
      message: string
      count: number
      note: string
      hits: Array<{ route: string }>
    }
    expect(report.route).toBe(DB_OUTAGE_ROUTE)
    expect(report.message).toBe(DB_OUTAGE_MESSAGE)
    expect(report.count).toBe(26)
    expect(report.hits).toHaveLength(26)
    expect(new Set(report.hits.map((h) => h.route)).size).toBe(5)
    expect(report.note).toContain('26 requests on 5 routes')
    expect(report.note).toContain('16× POST /api/session-recordings/:id/events')
    expect(report.note).toContain('26× Login failed.')
    // The login name stays out of the issue too.
    expect(report.note).not.toMatch(/app_rw|for user/)

    // Nothing left to say.
    clock += 60_000
    expect(await flushDbOutage()).toBeNull()
    expect(filed).toHaveBeenCalledTimes(1)
  })

  it('through the handler: every failing request counts once, whatever its route or method', async () => {
    await Promise.all([
      call('login', 'POST'),
      call('login', 'POST'),
      call('refused', 'GET'),
      call('starved', 'PATCH'),
      call('cut', 'PATCH')
    ])
    await flushDbOutage({ force: true })
    expect(filed).toHaveBeenCalledTimes(1)
    expect(filed.mock.calls[0][0]).toMatchObject({ count: 5 })
    expect(vi.mocked(trackError)).not.toHaveBeenCalled()
  })

  it('waits while the probe says the database is away, then files once', async () => {
    noteDbOutage({ kind: 'unreachable', route: 'GET /api/a', err: THROWN.slow() })
    probe.healthy = false
    clock += 30_000
    expect(await flushDbOutage()).toBeNull()
    clock += 120_000
    expect(await flushDbOutage()).toBeNull()
    expect(filed).not.toHaveBeenCalled()
    probe.healthy = true
    expect(await flushDbOutage()).toBe(7)
    expect(filed).toHaveBeenCalledTimes(1)
  })

  it('keeps its count when the issue cannot be written yet, and adds what failed meanwhile', async () => {
    filed.mockImplementationOnce(async () => null)
    noteDbOutage({ kind: 'unreachable', route: 'GET /api/a', err: THROWN.login() })
    noteDbOutage({ kind: 'unreachable', route: 'GET /api/a', err: THROWN.login() })
    clock += 6_000
    expect(await flushDbOutage()).toBeNull()
    noteDbOutage({ kind: 'unreachable', route: 'GET /api/b', err: THROWN.refused() })
    clock += 6_000
    expect(await flushDbOutage()).toBe(7)
    expect(filed).toHaveBeenCalledTimes(2)
    expect(filed.mock.calls[1][0]).toMatchObject({ count: 3 })
    expect(String(filed.mock.calls[1][0].note)).toContain('3 requests on 2 routes')
  })

  it('a long outage is filed while it lasts, a minute at a time', async () => {
    for (let i = 0; i < 70; i++) {
      noteDbOutage({ kind: 'unreachable', route: 'GET /api/a', err: THROWN.login() })
      clock += 1_000
    }
    expect(await flushDbOutage()).toBe(7)
    expect(filed.mock.calls[0][0]).toMatchObject({ count: 70 })
    expect((filed.mock.calls[0][0].hits as unknown[]).length).toBe(50)
  })

  it('never holds more than a bounded list of routes', async () => {
    for (let i = 0; i < 400; i++)
      noteDbOutage({ kind: 'unreachable', route: `GET /api/r${i}`, err: THROWN.login() })
    await flushDbOutage({ force: true })
    expect(filed.mock.calls[0][0]).toMatchObject({ count: 400 })
    expect(String(filed.mock.calls[0][0].note)).toContain('(other)')
  })
})

describe('outageReason', () => {
  it('is the driver’s reason without the statement, the login or the address', () => {
    expect(outageReason(THROWN.login())).toBe('Login failed.')
    expect(outageReason(THROWN.refused())).not.toMatch(/db\.internal|10\.0\.0\.5|1433/)
    expect(outageReason(THROWN.cut())).toBe('Connection closed before request completed.')
    expect(
      outageReason(
        driver('select [a] - [b] from [orders] - Connection lost - read ECONNRESET', 'ESOCKET')
      )
    ).toBe('Connection lost - read ECONNRESET')
    expect(outageReason(THROWN.gone())).toBe(
      'Requests can only be made in the LoggedIn state, not the Final state'
    )
    expect(outageReason(poolTimeout())).toBe('No connection could be opened in time')
  })
})

describe('cloud mode', () => {
  it('stays as it was: only the busy pool is told apart, nothing is counted', async () => {
    vi.resetModules()
    vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    try {
      const cloud = await import('../../../services/db-outage.js')
      expect(cloud.requestDbFailure(THROWN.login())).toBeNull()
      expect(cloud.requestDbFailure(THROWN.cut())).toBeNull()
      expect(cloud.requestDbFailure(THROWN.busy())).toBe('busy')
      cloud._resetDbOutageForTests({ now: () => clock, file: filed as never })
      cloud.noteDbOutage({ kind: 'unreachable', route: 'GET /api/a', err: THROWN.login() })
      expect(await cloud.flushDbOutage({ force: true })).toBeNull()
      expect(filed).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
