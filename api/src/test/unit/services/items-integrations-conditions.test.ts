import knexFactory from 'knex'
import { describe, expect, it } from 'vitest'
import { applyConditions, applyIntegrationsFilter } from '../../../services/items.js'

/**
 * `conditions=[{path:['$integrations'],op,value}]` — the collection browser's
 * and queue's own filter pills. Compiled by the same `applyIntegrationsFilter`
 * the `filter={"$integrations":…}` surface uses (applyStateFilter precedent:
 * one implementation, both callers), so these also pin what `filter=` does
 * without needing a second harness to exercise a private function.
 */
const qb = () => knexFactory({ client: 'mssql' })('workflows')
const compile = async (value: unknown) => {
  const q = qb()
  await applyConditions(q as never, [{ path: ['$integrations'], op: '_eq', value }], 'workflows')
  return q.toSQL()
}

describe('applyConditions — $integrations', () => {
  it('danger: overdue/failed/missing, EXISTS', async () => {
    const { sql, bindings } = await compile('danger')
    expect(sql).toMatch(/where exists/i)
    expect(sql).not.toMatch(/not exists/i)
    expect(sql).toContain('nivaro_integration_obligations')
    expect(sql).toContain('CAST([workflows].[id] AS NVARCHAR(255))')
    expect(bindings).toContain('overdue')
    expect(bindings).toContain('failed')
    expect(bindings).toContain('missing')
    // superseded is excluded from every bucket, including danger
    expect(bindings).toContain('superseded')
  })

  it('warning: pending/skipped, EXISTS', async () => {
    const { bindings } = await compile('warning')
    expect(bindings).toContain('pending')
    expect(bindings).toContain('skipped')
    expect(bindings).not.toContain('overdue')
  })

  it('positive: sent only, EXISTS', async () => {
    const { bindings } = await compile('positive')
    expect(bindings).toContain('sent')
    expect(bindings).not.toContain('pending')
    expect(bindings).not.toContain('overdue')
  })

  it('none: NOT EXISTS any non-superseded row', async () => {
    const { sql, bindings } = await compile('none')
    expect(sql).toMatch(/not exists/i)
    expect(sql).not.toMatch(/where exists/i)
    expect(bindings).toContain('superseded')
    // no outcome bucket is bound for 'none' — it is a bare presence check
    expect(bindings).not.toContain('overdue')
    expect(bindings).not.toContain('sent')
  })

  // A value neither surface recognises narrows to nothing rather than
  // quietly widening — the applyStateFilter rule.
  it('narrows to nothing for a value it cannot read', async () => {
    for (const value of ['bogus', null, undefined, 7, []]) {
      const { sql } = await compile(value)
      expect(sql).toContain('1 = 0')
      expect(sql).not.toMatch(/exists/i)
    }
  })

  it('agrees with the filter= surface (applyIntegrationsFilter) on the same request', async () => {
    for (const value of ['danger', 'warning', 'positive', 'none']) {
      const viaCondition = await compile(value)
      const q = qb()
      applyIntegrationsFilter(q as never, 'workflows', value)
      expect(viaCondition.sql).toBe(q.toSQL().sql)
      expect(viaCondition.bindings).toEqual(q.toSQL().bindings)
    }
  })
})
