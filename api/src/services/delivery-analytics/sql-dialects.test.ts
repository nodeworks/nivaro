import type { Knex } from 'knex'
import { describe, expect, it, vi } from 'vitest'
import { buildRegistry, type Cond } from './model.js'
import { sqlExecutor } from './query.js'

/**
 * The same executor on Postgres and MySQL: every dimension as group, measure and condition,
 * rows, keyset and percentile reads. No statement may carry a T-SQL-ism, and every `?` has a
 * binding (a mismatch is a runtime error only a real database shows).
 */
function recorder(client: string) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []
  const knex = {
    client: { config: { client } },
    raw: vi.fn(async (sql: string, bindings: unknown[]) => {
      calls.push({ sql, bindings })
      return /COUNT\(\*\) AS total/.test(sql) ? [{ total: 5 }] : []
    })
  }
  return { knex: knex as unknown as Knex, calls }
}

const TSQL = [
  /\[[a-z_]+\]/i,
  /DATEADD\(/,
  /DATEDIFF\(/,
  /CONVERT\(/,
  /ISJSON\(/,
  /JSON_VALUE\(/,
  /TOP \(/,
  /OFFSET \? ROWS/,
  /WITH \(NOLOCK\)/
]
const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length
const span = {
  from: new Date('2026-11-11T00:00:00.000Z'),
  to: new Date('2026-11-18T00:00:00.000Z')
}

for (const [label, client, dialect] of [
  ['postgres', 'pg', 'pg'],
  ['mysql', 'mysql2', 'mysql']
] as const) {
  describe(`delivery analytics SQL on ${label}`, () => {
    const ctx = { asof: new Date('2026-11-18T12:00:00.000Z'), actedHours: 24, dialect }
    const reg = buildRegistry({ resend: true })
    for (const source of ['n', 'm', 'x'] as const) {
      it(`${source}: every dimension builds portable SQL`, async () => {
        const { knex, calls } = recorder(client)
        const exec = sqlExecutor(knex, reg, ctx)
        const sp = source === 'x' ? null : span
        for (const d of reg.dims[source].keys()) {
          const cond: Cond = [d, ['a', 'b']]
          await exec.aggregate({
            source,
            span: sp,
            where: [cond],
            groupBy: [d],
            measures: { all: [], one: [cond] },
            top: { by: 'all', n: 5 }
          })
          await exec.rows({
            source,
            span: sp,
            where: [cond],
            sort: 'time',
            dir: 'desc',
            offset: 10,
            limit: 20
          })
          await exec.rows({
            source,
            span: sp,
            where: [],
            sort: 'time',
            dir: 'asc',
            offset: 0,
            limit: 20,
            after: { t: source === 'x' ? 5 : new Date(), id: 3 },
            count: false
          })
        }
        if (source === 'n') {
          await exec.percentiles({ span: span, where: [], groupBy: ['category'] })
          await exec.percentiles({ span: span, where: [], groupBy: [] })
        }
        expect(calls.length).toBeGreaterThan(0)
        for (const c of calls) {
          for (const re of TSQL) expect(c.sql, c.sql).not.toMatch(re)
          expect(placeholders(c.sql), c.sql).toBe(c.bindings.length)
        }
      })
    }
  })
}
