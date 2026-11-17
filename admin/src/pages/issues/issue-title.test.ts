import { describe, expect, it } from 'vitest'
import { parseIssueTitle } from './issue-title'

describe('parseIssueTitle', () => {
  it('turns a SQL title into the driver message, keeping the route and the SQL apart', () => {
    const t = parseIssueTitle(
      "[server] GET /api/items/:collection: select top (@p0) [id] from [workflows_divisions] - Ambiguous column name 'id'."
    )
    expect(t).toEqual({
      source: 'server',
      where: 'GET /api/items/:collection',
      headline: "Ambiguous column name 'id'.",
      technical: "select top (@p0) [id] from [workflows_divisions] - Ambiguous column name 'id'."
    })
  })

  it('says a query failed when the SQL was cut before the message', () => {
    const t = parseIssueTitle(
      '[server] GET /api/items/:collection/aggregate: select SUM([workflows].[po_amount]) as [sum] from [workflows] where exists (select 1 from'
    )
    expect(t.headline).toBe('A database query failed')
    expect(t.where).toBe('GET /api/items/:collection/aggregate')
    expect(t.technical).toMatch(/^select SUM/)
  })

  it('keeps a job name as where and the sentence as the headline', () => {
    const t = parseIssueTitle(
      '[server] cron/watchdog: Cron "outside-write-watch" tick skipped — the previous tick has been running for 0 minute(s)'
    )
    expect(t.where).toBe('cron/watchdog')
    expect(t.headline).toBe(
      'Cron "outside-write-watch" tick skipped — the previous tick has been running for 0 minute(s)'
    )
    expect(t.technical).toBeNull()
  })

  it('moves a deadlock victim statement out of the headline', () => {
    const t = parseIssueTitle(
      '[server] deadlock-sweep: SQL deadlock at 2026-11-14T12:39:15.825Z — victim statement: Proc [Database Id = 32767]'
    )
    expect(t.where).toBe('deadlock-sweep')
    expect(t.headline).toBe('SQL deadlock at 2026-11-14T12:39:15.825Z')
    expect(t.technical).toBe('victim statement: Proc [Database Id = 32767]')
  })

  it('reads client errors and the non-admin server form', () => {
    expect(
      parseIssueTitle('[client] /collections/project_types/5: nn.find is not a function')
    ).toEqual({
      source: 'client',
      where: '/collections/project_types/5',
      headline: 'Nn.find is not a function',
      technical: null
    })
    expect(parseIssueTitle('A server error on GET /api/items/:collection')).toEqual({
      source: 'server',
      where: 'GET /api/items/:collection',
      headline: 'A server error',
      technical: null
    })
  })

  it('leaves a plain sentence alone and never returns an empty headline', () => {
    const t = parseIssueTitle('Rollup drift: units.total_unit_cost (1/500 rows stale)')
    expect(t).toEqual({
      source: null,
      where: null,
      headline: 'Rollup drift: units.total_unit_cost (1/500 rows stale)',
      technical: null
    })
    expect(parseIssueTitle('').headline).toBe('Untitled issue')
    expect(parseIssueTitle(null).headline).toBe('Untitled issue')
  })
})
