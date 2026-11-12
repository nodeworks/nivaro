import knexLib from 'knex'
import { describe, expect, it, vi } from 'vitest'

// The services below import the live `db`; these tests only build SQL on a knex with no connection.
vi.mock('../../../db/index.js', () => ({ db: {} }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/collections.js', () => ({
  getRelations: vi.fn(async () => []),
  listCollections: vi.fn(async () => [])
}))

import { apiLogSource } from '../../../services/api-log-source.js'
import { requestLogCounts } from '../../../services/command-center/system.js'
import { dependencyLogReads, logBodiesById } from '../../../services/partner-dependencies.js'

const mssql = knexLib({ client: 'mssql' })
const pg = knexLib({ client: 'pg' })
const SINCE = new Date('2026-11-01T00:00:00Z')

// Production 2026-11-09 to 11-12: ten deadlocks between a dashboard read of the request log
// (page S locks) and the logger's batched insert; the read lost every time.
describe('apiLogSource', () => {
  it('reads the request log without shared locks on SQL Server', () => {
    expect(apiLogSource(mssql, 'l').select('l.id').toString()).toBe(
      'select [l].[id] from [nivaro_api_logs] AS [l] WITH (NOLOCK)'
    )
    expect(apiLogSource(mssql).select('id').toString()).toBe(
      'select [id] from [nivaro_api_logs] WITH (NOLOCK)'
    )
  })

  it('is the plain table on other databases', () => {
    expect(apiLogSource(pg, 'l').select('l.id').toString()).toBe(
      'select "l"."id" from "nivaro_api_logs" as "l"'
    )
    expect(apiLogSource(pg).select('id').toString()).toBe('select "id" from "nivaro_api_logs"')
  })
})

describe('partner dependency map: request-log reads', () => {
  it('the per-caller usage scan takes no shared locks', () => {
    const { groups } = dependencyLogReads(mssql, SINCE, { hasQuery: true, hasGql: true })
    const sql = groups.toString()
    expect(sql).toContain('from [nivaro_api_logs] AS [l] WITH (NOLOCK)')
    // Still the same read: token / API-key callers since the window start, grouped per endpoint.
    expect(sql).toContain("[l].[auth] in ('token', 'api_key')")
    expect(sql).toContain('([l].[user] is not null or [l].[api_key_id] is not null)')
    expect(sql).toMatch(
      /group by \[l\]\.\[auth\], \[l\]\.\[user\], \[l\]\.\[api_key_id\], \[l\]\.\[method\], \[l\]\.\[path\], \[l\]\.\[query\], \[l\]\.\[graphql_operation\], \[l\]\.\[graphql_kind\]/
    )
  })

  it('the distinct-body scan and the body fetch take no shared locks', () => {
    const { bodies } = dependencyLogReads(mssql, SINCE, { hasQuery: false, hasGql: false })
    expect(bodies.toString()).toContain('from [nivaro_api_logs] AS [l] WITH (NOLOCK)')
    expect(bodies.toString()).toContain('CHECKSUM(l.request_body)')
    expect(logBodiesById(mssql, [1, 2]).toString()).toBe(
      'select [id], [request_body] from [nivaro_api_logs] WITH (NOLOCK) where [id] in (1, 2)'
    )
  })

  it('leaves out the columns an older log table does not have', () => {
    const sql = dependencyLogReads(mssql, SINCE, {
      hasQuery: false,
      hasGql: false
    }).groups.toString()
    expect(sql).not.toContain('[l].[query]')
    expect(sql).not.toContain('graphql_operation')
  })
})

describe('command center system health: request-log counts', () => {
  it('counts the last hour without shared locks', () => {
    const { errors, all } = requestLogCounts(mssql, SINCE)
    expect(errors.toString()).toMatch(
      /^select top \(1\) count\(\*\) as \[n\] from \[nivaro_api_logs\] WITH \(NOLOCK\) where \[created_at\] > .+ and \[status\] >= 500$/
    )
    expect(all.toString()).toMatch(
      /^select top \(1\) count\(\*\) as \[n\] from \[nivaro_api_logs\] WITH \(NOLOCK\) where \[created_at\] > [^ ]+( [^ ]+)?$/
    )
  })

  it('reads the plain table on other databases', () => {
    expect(requestLogCounts(pg, SINCE).all.toString()).toContain('from "nivaro_api_logs" where')
  })
})
