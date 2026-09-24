import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same route-harness idiom as transition-role-gating.test.ts /
// integration-obligations.test.ts: mock the admin gate + db module before
// importing the route so `/integration-partners/:id`'s id-validation branch
// is reachable with no real auth/DB stack. `db` is a bare stub — the
// validation tests below reject before `buildCards()` ever calls it.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  type CallLogListRow,
  healthWord,
  hourBuckets,
  integrationPartnersRoutes,
  mergeCallHistory,
  type OutboundListRow,
  pathFromUrl,
  percentile
} from '../../../routes/integration-partners.js'
import type { FactUser } from '../../../services/submission-detail.js'

describe('percentile', () => {
  it('nearest-rank on a sorted list', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20)
    expect(percentile([10, 20, 30, 40], 95)).toBe(40)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('healthWord', () => {
  const t = (m: number) => new Date(Date.now() - m * 60_000)
  it('healthy needs a success after the last failure', () => {
    expect(
      healthWord({
        calls24: 10,
        failures24: 1,
        lastOkAt: t(1),
        lastFailAt: t(5),
        authFailing: false
      })
    ).toBe('healthy')
    expect(
      healthWord({
        calls24: 10,
        failures24: 1,
        lastOkAt: t(5),
        lastFailAt: t(1),
        authFailing: false
      })
    ).toBe('failing')
  })
  it('degraded when failures are frequent but it still lands; idle with no calls; auth wins', () => {
    expect(
      healthWord({
        calls24: 10,
        failures24: 4,
        lastOkAt: t(1),
        lastFailAt: t(2),
        authFailing: false
      })
    ).toBe('degraded')
    expect(
      healthWord({
        calls24: 0,
        failures24: 0,
        lastOkAt: null,
        lastFailAt: null,
        authFailing: false
      })
    ).toBe('idle')
    expect(
      healthWord({ calls24: 5, failures24: 1, lastOkAt: t(1), lastFailAt: t(2), authFailing: true })
    ).toBe('failing')
  })
})

describe('hourBuckets', () => {
  it('fills every hour, oldest first', () => {
    const now = new Date('2026-09-23T12:30:00Z')
    const b = hourBuckets(
      [
        { created_at: new Date('2026-09-23T12:05:00Z'), ok: true },
        { created_at: new Date('2026-09-23T11:10:00Z'), ok: false }
      ],
      now,
      3
    )
    expect(b.map((x) => [x.hour, x.ok, x.failed])).toEqual([
      ['2026-09-23T10', 0, 0],
      ['2026-09-23T11', 0, 1],
      ['2026-09-23T12', 1, 0]
    ])
  })
})

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(integrationPartnersRoutes)
  return app
}

afterEach(() => {
  vi.clearAllMocks()
})

// Review round 1: `Number(params.id)` was never validated, so a non-numeric
// id (NaN) or `0` — both falsy — made `buildCards`'s old `if (onlyId)` filter
// checks skip entirely, silently returning the FIRST partner's card as a 200
// instead of rejecting the request. Every case here resolves before
// `buildCards()` ever touches the mocked `db` stub, so these are true
// isolated unit tests of the validation branch, not integration tests of the
// query path.
describe('GET /integration-partners/:id — id validation', () => {
  it('rejects a non-numeric id with 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/abc' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid id' })
  })

  it('rejects id=0 with 400 — 0 is falsy but not a valid id', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/0' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a negative id with 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/-1' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a non-integer id with 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/1.5' })
    expect(res.statusCode).toBe(400)
  })
})

describe('pathFromUrl', () => {
  it('reduces a full URL to its path + query', () => {
    expect(pathFromUrl('https://partner.example/api/v1/hubs?limit=50')).toBe(
      '/api/v1/hubs?limit=50'
    )
  })
  it('parses a mock:// url (the mock-mode call log shape) as a path too', () => {
    expect(pathFromUrl('mock://PARTNER/api/hubs')).toBe('/api/hubs')
  })
  it('falls back to the raw string when it does not parse as a URL, capped at 300 chars', () => {
    expect(pathFromUrl('not a url')).toBe('not a url')
    expect(pathFromUrl('x'.repeat(400))).toBe(`${'x'.repeat(300)}…`)
  })
  it('null/empty in, null out', () => {
    expect(pathFromUrl(null)).toBeNull()
    expect(pathFromUrl('')).toBeNull()
  })
})

// Task 15e — Recent calls merges the verbose opt-in call log
// (nivaro_external_api_logs) with the always-on outbound counter
// (nivaro_outbound_log): every call-log row appears, PLUS any outbound row
// that has no call-log row landing in the same second (pre-523205cf
// extension calls, or any caller that still passes no `_log`) — those read
// `source: 'outbound'` with no body/trigger/user to open.
describe('mergeCallHistory — Task 15e list merge', () => {
  const LOG: CallLogListRow = {
    id: 1,
    created_at: new Date('2026-09-23T12:00:05.000Z'),
    method: 'POST',
    url: 'https://partner.example/api/v1/update',
    response_status: 200,
    duration_ms: 140,
    error: null,
    triggered_by: 'transition-action',
    user_id: 'U1',
    has_body: 1
  }
  const OUTBOUND: OutboundListRow = {
    id: 100,
    created_at: new Date('2026-09-23T11:00:00.000Z'),
    method: 'GET',
    path: '/api/hubs',
    status: 401,
    ok: false,
    duration_ms: 80,
    error: 'HTTP 401'
  }
  const USER: FactUser = {
    id: 'U1',
    first_name: 'Dana',
    last_name: 'Reyes',
    email: 'dana@example.com',
    status: 'active',
    is_redacted: false,
    account_kind: null
  }

  it('a call-log row carries its resolved user, has_body, and a path derived from the url', () => {
    const merged = mergeCallHistory([LOG], [], [USER])
    expect(merged).toEqual([
      {
        key: 'log:1',
        id: 1,
        source: 'log',
        created_at: '2026-09-23T12:00:05.000Z',
        method: 'POST',
        path: '/api/v1/update',
        status: 200,
        ok: true,
        duration_ms: 140,
        error: null,
        triggered_by: 'transition-action',
        has_body: true,
        user: {
          id: 'U1',
          name: 'Dana Reyes',
          email: 'dana@example.com',
          inactive: null,
          account_kind: null
        }
      }
    ])
  })

  it('resolves a call user the SAME way the push drill-down does — a suspended or machine account carries its facts too', () => {
    const suspended: FactUser = {
      ...USER,
      id: 'U2',
      status: 'suspended',
      is_redacted: false,
      account_kind: null
    }
    const machine: FactUser = {
      ...USER,
      id: 'U3',
      first_name: 'Sync',
      last_name: 'Bot',
      email: null,
      status: 'active',
      account_kind: 'integration'
    }
    const suspendedLog: CallLogListRow = { ...LOG, id: 2, user_id: 'U2' }
    const machineLog: CallLogListRow = { ...LOG, id: 3, user_id: 'U3' }
    const merged = mergeCallHistory([suspendedLog, machineLog], [], [suspended, machine])
    expect(merged.find((c) => c.id === 2)?.user).toEqual({
      id: 'U2',
      name: 'Dana Reyes',
      email: 'dana@example.com',
      inactive: 'suspended',
      account_kind: null
    })
    expect(merged.find((c) => c.id === 3)?.user).toEqual({
      id: 'U3',
      name: 'Sync Bot',
      email: null,
      inactive: null,
      account_kind: 'integration'
    })
  })

  it('an outbound row with no matching call-log second still appears, marked "outbound" with no trigger/body', () => {
    const merged = mergeCallHistory([LOG], [OUTBOUND], [USER])
    const outboundEntry = merged.find((c) => c.source === 'outbound')
    expect(outboundEntry).toMatchObject({
      key: 'outbound:100',
      id: 100,
      source: 'outbound',
      method: 'GET',
      path: '/api/hubs',
      status: 401,
      ok: false,
      triggered_by: null,
      has_body: false,
      user: null
    })
  })

  it('an outbound row sharing the exact second with a call-log row is dropped — the log row already covers it', () => {
    const sameSecondOutbound: OutboundListRow = {
      ...OUTBOUND,
      id: 101,
      created_at: new Date('2026-09-23T12:00:05.400Z')
    }
    const merged = mergeCallHistory([LOG], [sameSecondOutbound], [USER])
    expect(merged).toHaveLength(1)
    expect(merged[0].source).toBe('log')
  })

  it('sorts newest first across both sources', () => {
    const older: OutboundListRow = { ...OUTBOUND, id: 102 }
    const newer: OutboundListRow = {
      ...OUTBOUND,
      id: 103,
      created_at: new Date('2026-09-23T13:00:00.000Z')
    }
    const merged = mergeCallHistory([LOG], [older, newer], [USER])
    expect(merged.map((c) => c.key)).toEqual(['outbound:103', 'log:1', 'outbound:102'])
  })

  it('a call-log row with no user_id (or one that no longer resolves) carries no user', () => {
    const noUser: CallLogListRow = { ...LOG, user_id: null }
    expect(mergeCallHistory([noUser], [], [USER])[0].user).toBeNull()
    const staleUser: CallLogListRow = { ...LOG, user_id: 'GONE' }
    expect(mergeCallHistory([staleUser], [], [USER])[0].user).toBeNull()
  })
})

// ─── GET /integration-partners/:id/calls/:callId ───────────────────────────

type Chain = Record<string, ReturnType<typeof vi.fn>>

function makeChain(overrides: Partial<{ first: unknown; select: unknown[] }> = {}): Chain {
  const chain: Chain = {}
  for (const m of ['where', 'whereIn', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.first = vi.fn((..._cols: string[]) => Promise.resolve(overrides.first ?? undefined))
  chain.select = vi.fn(() => Promise.resolve(overrides.select ?? []))
  return chain
}

const CREATED = new Date('2026-09-23T18:42:03.000Z')

describe('GET /integration-partners/:id/calls/:callId', () => {
  it('rejects a non-numeric id or callId with 400 before ever touching the database', async () => {
    const app = buildApp()
    for (const url of [
      '/integration-partners/abc/calls/1',
      '/integration-partners/1/calls/abc',
      '/integration-partners/0/calls/1',
      '/integration-partners/1/calls/0',
      '/integration-partners/1/calls/-1'
    ]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(400)
    }
    expect(vi.mocked(db)).not.toHaveBeenCalled()
    await app.close()
  })

  it("404s a call id that belongs to a DIFFERENT partner — never leaks another API's call", async () => {
    // The WHERE clause scopes by (id, api_id) together, so a callId that
    // exists but under a different api_id resolves to nothing, same as an
    // unknown id — the row is never fetched and then filtered client-side.
    const logsChain = makeChain({ first: undefined })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return logsChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/9/calls/55' })
    expect(res.statusCode).toBe(404)
    expect(logsChain.where).toHaveBeenCalledWith({ id: 55, api_id: 9 })
    await app.close()
  })

  it('404s an unknown call id', async () => {
    const logsChain = makeChain({ first: undefined })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return logsChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/9/calls/999999' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns the full row with a resolved user, and re-masks stored headers on read', async () => {
    const logsChain = makeChain({
      first: {
        id: 55,
        api_id: 9,
        created_at: CREATED,
        method: 'GET',
        url: 'https://partner-a.example/api/hubs',
        // Written before the write-side masking fix — a raw bearer token
        // that MUST NOT reach the response.
        request_headers: JSON.stringify({ Authorization: 'Bearer super-secret-token' }),
        request_body: null,
        response_status: 200,
        response_headers: JSON.stringify({ 'set-cookie': 'sid=abc123' }),
        response_body: '{"hubs":[]}',
        duration_ms: 210,
        error: null,
        triggered_by: 'cron:inventory-sync',
        user_id: 'U1'
      }
    })
    const usersChain = makeChain({
      first: {
        id: 'U1',
        first_name: 'Dana',
        last_name: 'Reyes',
        email: 'dana@example.com',
        status: 'active',
        is_redacted: false,
        account_kind: null
      }
    })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return logsChain
      if (table === 'nivaro_users') return usersChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/9/calls/55' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.request_headers.Authorization).toBe('Bearer ••••••')
    expect(d.response_headers['set-cookie']).toBe('••••••')
    expect(d.response_body).toBe('{"hubs":[]}')
    expect(d.triggered_by).toBe('cron:inventory-sync')
    expect(d.user).toEqual({
      id: 'U1',
      name: 'Dana Reyes',
      email: 'dana@example.com',
      inactive: null,
      account_kind: null
    })
    await app.close()
  })

  it('masks a raw secret stored in a body on read', async () => {
    const logsChain = makeChain({
      first: {
        id: 58,
        api_id: 9,
        created_at: CREATED,
        method: 'POST',
        url: 'https://partner-a.example/api/orders',
        request_headers: null,
        request_body: JSON.stringify({ token: 'raw-body-token', order: 12 }),
        response_status: 200,
        response_headers: null,
        response_body: JSON.stringify({ session: 'raw-echo' }),
        duration_ms: 90,
        error: null,
        triggered_by: 'erp-submission',
        user_id: null
      }
    })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return logsChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/9/calls/58' })
    const d = res.json().data
    expect(JSON.parse(d.request_body)).toEqual({ token: '••••••', order: 12 })
    expect(JSON.parse(d.response_body)).toEqual({ session: '••••••' })
    await app.close()
  })

  it('resolves a suspended account exactly as the push drill-down does, at the route level', async () => {
    const logsChain = makeChain({
      first: {
        id: 57,
        api_id: 9,
        created_at: CREATED,
        method: 'POST',
        url: 'https://partner-a.example/api/hubs',
        request_headers: null,
        request_body: null,
        response_status: 200,
        response_headers: null,
        response_body: '{}',
        duration_ms: 90,
        error: null,
        triggered_by: 'erp-submission',
        user_id: 'U9'
      }
    })
    const usersChain = makeChain({
      first: {
        id: 'U9',
        first_name: 'Old',
        last_name: 'Integration',
        email: 'old@example.com',
        status: 'suspended',
        is_redacted: false,
        account_kind: null
      }
    })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return logsChain
      if (table === 'nivaro_users') return usersChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/9/calls/57' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.user).toEqual({
      id: 'U9',
      name: 'Old Integration',
      email: 'old@example.com',
      inactive: 'suspended',
      account_kind: null
    })
    await app.close()
  })

  it('a row with no stored user_id carries no user, and null headers stay null', async () => {
    const logsChain = makeChain({
      first: {
        id: 56,
        api_id: 9,
        created_at: CREATED,
        method: 'GET',
        url: 'https://partner-b.example/status',
        request_headers: null,
        request_body: null,
        response_status: 401,
        response_headers: null,
        response_body: '{"error":"unauthorized"}',
        duration_ms: 30,
        error: 'HTTP 401',
        triggered_by: 'extension:ops-toolkit',
        user_id: null
      }
    })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return logsChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/integration-partners/9/calls/56' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.user).toBeNull()
    expect(d.request_headers).toBeNull()
    expect(d.response_headers).toBeNull()
    expect(d.response_status).toBe(401)
    expect(d.error).toBe('HTTP 401')
    await app.close()
  })
})
