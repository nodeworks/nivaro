import knexFactory from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A real SQL Server query compiler with no connection: every statement is handed to the
// (faked) bounded runner, which answers per table and keeps the SQL for the assertions.
const knex = knexFactory({ client: 'mssql' })
Object.defineProperty(knex, 'schema', { get: () => ({ hasTable: async () => true }) })

const statements: Array<{ sql: string; bindings: unknown[] }> = []
const tables: Record<string, Array<Record<string, unknown>>> = {}

vi.mock('../db/index.js', () => ({ db: {}, resolveDb: () => knex }))
vi.mock('../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('./bounded-sql.js', () => ({
  StatementCancelled: class extends Error {},
  boundedRaw: async (sql: string, bindings: unknown[]) => {
    statements.push({ sql, bindings })
    const table = Object.keys(tables).find((t) => sql.includes(`[${t}]`))
    return table ? tables[table] : []
  }
}))

import { readSlowScreens } from './slow-screens.js'

const U = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
const NOW = Date.UTC(2026, 10, 13, 18, 0, 0)
const at = (msAgo: number) => new Date(NOW - msAgo)

beforeEach(() => {
  statements.length = 0
  tables.nivaro_rum_events = [
    // a 9 s record page, measured by a beacon 8 s after it settled
    {
      route: '/collections/orders/42',
      kind: 'route',
      duration_ms: 9000,
      created_at: at(3_600_000 - 17_000),
      browser: 'Edge 130',
      os: 'Windows',
      screen: 'laptop',
      app: 'admin'
    },
    {
      route: '/collections/orders/43',
      kind: 'route',
      duration_ms: 400,
      created_at: at(1_800_000),
      browser: 'Edge 130',
      os: 'Windows',
      screen: 'laptop',
      app: 'admin'
    },
    {
      route: '/',
      kind: 'load',
      lcp_ms: 900,
      duration_ms: 1200,
      ttfb_ms: 80,
      created_at: at(7_200_000),
      browser: 'Edge 130',
      os: 'Windows',
      screen: 'laptop',
      app: 'admin'
    }
  ]
  tables.nivaro_admin_journeys = [
    {
      session_id: 's1',
      path: '/collections/orders/42',
      entered_at: at(3_600_000),
      duration_seconds: 120,
      app: 'admin'
    },
    {
      session_id: 's1',
      path: '/collections/orders/43',
      entered_at: at(1_800_000 + 400),
      duration_seconds: 60,
      app: 'admin'
    }
  ]
  tables.nivaro_api_logs = [
    {
      method: 'GET',
      path: '/api/items/orders/42',
      status: 200,
      latency_ms: 8200,
      created_at: at(3_600_000 - 300)
    },
    {
      method: 'GET',
      path: '/api/items/orders/43',
      status: 200,
      latency_ms: 150,
      created_at: at(1_800_000)
    },
    {
      method: 'GET',
      path: '/api/comments?collection=orders&item=42',
      status: 200,
      latency_ms: 90,
      created_at: at(3_600_000 - 500)
    }
  ]
  tables.nivaro_session_recordings = [
    { id: 'rec-1', started_at: at(4_000_000), ended_at: null, last_event_at: at(3_000_000) }
  ]
})

describe('readSlowScreens', () => {
  it('lists the person’s slowest page with the calls behind it and a replay of the slow visit', async () => {
    const r = await readSlowScreens(U, 7, NOW)
    expect(r.samples).toBe(3)
    expect(r.journeys).toBe(true)
    const page = r.pages[0]
    expect(page).toMatchObject({ page: '/collections/orders/:id', n: 2, worst_ms: 9000, visits: 2 })
    expect(page.calls[0]).toMatchObject({ path: '/api/items/orders/:id', n: 2, worst_ms: 8200 })
    expect(page.calls.map((c) => c.path)).toContain('/api/comments')
    expect(page.slow_visits[0].replay).toEqual({ recording_id: 'rec-1', offset_ms: 398_000 })
    expect(r.devices.screens).toEqual([{ name: 'laptop', n: 3 }])
  })

  it('reads only this person, the request log WITH (NOLOCK) and only the load windows', async () => {
    await readSlowScreens(U, 30, NOW)
    expect(statements.length).toBe(4)
    for (const s of statements) expect(s.bindings).toContain(U)
    const log = statements.find((s) => s.sql.includes('[nivaro_api_logs]'))
    expect(log?.sql).toContain('[nivaro_api_logs] WITH (NOLOCK)')
    expect(log?.sql).toMatch(/\[created_at\] between \? and \?/)
    // never a query string, body, address or agent
    expect(log?.sql).not.toMatch(/\[(query|request_body|ip|user_agent)\]/)
  })

  it('says when there is nothing to show', async () => {
    tables.nivaro_rum_events = []
    tables.nivaro_admin_journeys = []
    const r = await readSlowScreens(U, 7, NOW)
    expect(r).toMatchObject({ no_timings: true, journeys: false, pages: [] })
    // no visits → no request-log read at all
    expect(statements.some((s) => s.sql.includes('[nivaro_api_logs]'))).toBe(false)
  })
})
