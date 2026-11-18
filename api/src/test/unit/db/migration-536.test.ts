import { describe, expect, it, vi } from 'vitest'

const longSql = vi.hoisted(() => [] as string[])
vi.mock('../../../services/run-long.js', () => ({
  runLongSql: vi.fn(async (sql: string) => {
    longSql.push(sql)
  })
}))

import { config, down, up } from '../../../db/migrations/536_mail_log_retry.js'

/** Fake knex: which columns nivaro_mail_log has, and what each alter did. */
function fakeKnex(columns: string[], opts: { table?: boolean; client?: string } = {}) {
  const have = new Set(columns)
  const ops: string[] = []
  const schema = {
    hasTable: vi.fn(async () => opts.table ?? true),
    hasColumn: vi.fn(async (_t: string, c: string) => have.has(c)),
    alterTable: vi.fn(async (_t: string, cb: (t: unknown) => void) => {
      const col = (type: string) => (name: string) => {
        ops.push(`${type} ${name}`)
        have.add(name)
        return { nullable: () => ops.push(`nullable ${name}`) }
      }
      cb({
        integer: col('int'),
        datetime: col('datetime'),
        index: (cols: string[], name: string) => ops.push(`index ${cols.join(',')} ${name}`),
        dropIndex: (cols: string[], name: string) =>
          ops.push(`dropIndex ${cols.join(',')} ${name}`),
        dropColumn: (name: string) => {
          ops.push(`drop ${name}`)
          have.delete(name)
        }
      })
    })
  }
  const raw = vi.fn(async (sql: string) => ops.push(`raw ${sql.trim().split('\n')[0]}`))
  return {
    knex: { schema, raw, client: { config: { client: opts.client ?? 'mssql' } } } as never,
    schema,
    ops,
    have
  }
}

describe('migration 536 — nivaro_mail_log.retry_at / retry_count', () => {
  it('runs outside the batch transaction (the index is a long request)', () => {
    expect(config).toEqual({ transaction: false })
  })

  it('adds two nullable columns once and a FILTERED index on SQL Server', async () => {
    longSql.length = 0
    const f = fakeKnex(['id', 'to', 'status', 'created_at'])
    await up(f.knex)
    expect(f.ops).toEqual([
      'datetime retry_at',
      'nullable retry_at',
      'int retry_count',
      'nullable retry_count'
    ])
    expect(longSql).toHaveLength(1)
    expect(longSql[0]).toContain('IF NOT EXISTS')
    expect(longSql[0]).toContain('WHERE [retry_at] IS NOT NULL')
    await up(f.knex)
    expect(f.ops).toHaveLength(4)
  })

  it('a plain index on other databases', async () => {
    longSql.length = 0
    const f = fakeKnex(['id'], { client: 'pg' })
    await up(f.knex)
    expect(f.ops).toContain('index retry_at ix_nivaro_mail_log_retry_at')
    expect(longSql).toHaveLength(0)
  })

  it('does nothing without the table', async () => {
    const f = fakeKnex([], { table: false })
    await up(f.knex)
    await down(f.knex)
    expect(f.schema.alterTable).not.toHaveBeenCalled()
  })

  it('down drops the index and both columns, only when they are there', async () => {
    const f = fakeKnex(['id', 'retry_at', 'retry_count'])
    await down(f.knex)
    expect(f.ops[0]).toMatch(/^raw IF EXISTS/)
    expect(f.ops.slice(1)).toEqual(['drop retry_at', 'drop retry_count'])
    const g = fakeKnex(['id'])
    await down(g.knex)
    expect(g.ops.filter((o) => o.startsWith('drop '))).toEqual([])
  })
})
