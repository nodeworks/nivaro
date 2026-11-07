import knexFactory from 'knex'
import { describe, expect, it, vi } from 'vitest'

// army6 L34: "%_" in the hand-off person search listed every user — LIKE
// wildcards in the typed text were not escaped.

const seen = vi.hoisted(() => ({ sql: [] as { sql: string; bindings: unknown[] }[] }))

vi.mock('../../../db/index.js', async () => {
  const k = knexFactory({ client: 'mssql' })
  const db = (table: string) => {
    const qb = k(table) as any
    // biome-ignore lint/suspicious/noThenProperty: stands in for awaiting the query
    qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const q = qb.toSQL()
      seen.sql.push({ sql: q.sql, bindings: q.bindings })
      return Promise.resolve(/count\(/i.test(q.sql) ? [{ count: 0 }] : []).then(res, rej)
    }
    return qb
  }
  return { db: Object.assign(db, { raw: k.raw.bind(k) }) }
})

const { listUsers } = await import('../../../services/users.js')

describe('listUsers search', () => {
  it('binds "%_" as literal text, never as wildcards', async () => {
    seen.sql = []
    await listUsers({ search: '%_', directory: true })
    const list = seen.sql.find((q) => !/count\(/i.test(q.sql))!
    expect(list.bindings).toContain('%[%][_]%')
    expect(list.bindings).not.toContain('%%_%')
  })

  it('still matches a plain name anywhere in a column', async () => {
    seen.sql = []
    await listUsers({ search: 'Ann Lee', directory: true })
    const list = seen.sql.find((q) => !/count\(/i.test(q.sql))!
    expect(list.bindings).toEqual(expect.arrayContaining(['%Ann%', '%Lee%']))
  })
})
