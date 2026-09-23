import knexFactory from 'knex'
import { describe, expect, it } from 'vitest'
import { applyConditions } from '../../../services/items.js'

/**
 * `conditions=[{path:['$state'],op,value}]` — the surface the collection
 * browser sends. It used to ignore `op` entirely and compile every $state
 * condition as an include, so exclude was wrong here while `filter=` got it
 * right; these pin the two together.
 */
const qb = () => knexFactory({ client: 'mssql' })('workflows')
const compile = async (op: string, value: unknown) => {
  const q = qb()
  await applyConditions(q as never, [{ path: ['$state'], op, value }], 'workflows')
  return q.toSQL()
}

describe('applyConditions — $state', () => {
  it('_in includes: EXISTS over the instance, keys bound', async () => {
    const { sql, bindings } = await compile('_in', ['started', 'waiting_on_po'])
    expect(sql).toMatch(/where exists/i)
    expect(sql).not.toMatch(/not exists/i)
    expect(sql).toContain('nivaro_workflow_instances')
    expect(sql).toContain('CAST([workflows].[id] AS NVARCHAR(255))')
    expect(bindings).toContain('started')
    expect(bindings).toContain('waiting_on_po')
  })

  it('_eq includes a single key', async () => {
    const { sql, bindings } = await compile('_eq', 'started')
    expect(sql).toMatch(/where exists/i)
    expect(sql).not.toMatch(/not exists/i)
    expect(bindings).toContain('started')
  })

  // NOT EXISTS, which keeps records that run no pipeline at all — the
  // SQL-natural reading, and the one `filter={"$state":{"_nin":…}}` already
  // had. Before this, `_nin` compiled as an INCLUDE of the listed states:
  // the exact opposite of what was asked for.
  it('_nin excludes with NOT EXISTS', async () => {
    const { sql, bindings } = await compile('_nin', ['completed', 'canceled'])
    expect(sql).toMatch(/not exists/i)
    expect(sql).not.toMatch(/where exists/i)
    expect(bindings).toContain('completed')
    expect(bindings).toContain('canceled')
  })

  it('_neq excludes a single key', async () => {
    const { sql } = await compile('_neq', 'completed')
    expect(sql).toMatch(/not exists/i)
    expect(sql).not.toMatch(/where exists/i)
  })

  it('defaults to include when no operator is given', async () => {
    const { sql, bindings } = await compile('', ['started'])
    expect(sql).toMatch(/where exists/i)
    expect(bindings).toContain('started')
  })

  // A state filter that fails to narrow returns every record in the
  // collection, so an unreadable one narrows to nothing instead — unlike a
  // plain column op, where an unknown operator is a no-op.
  it('narrows to nothing for a value or operator it cannot read', async () => {
    for (const [op, value] of [
      ['_in', []],
      ['_in', [null]],
      ['_gt', 'started'],
      ['_in', null]
    ] as Array<[string, unknown]>) {
      const { sql } = await compile(op, value)
      expect(sql).toContain('1 = 0')
      expect(sql).not.toMatch(/exists/i)
    }
  })

  it('agrees with the filter= surface on the same request', async () => {
    const { applyStateFilter } = await import('../../../services/record-state.js')
    for (const op of ['_in', '_nin']) {
      const viaCondition = await compile(op, ['completed'])
      const q = qb()
      applyStateFilter(q, 'workflows', { [op]: ['completed'] })
      expect(viaCondition.sql).toBe(q.toSQL().sql)
      expect(viaCondition.bindings).toEqual(q.toSQL().bindings)
    }
  })
})
