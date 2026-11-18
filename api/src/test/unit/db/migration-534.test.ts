import { describe, expect, it, vi } from 'vitest'
import { down, up } from '../../../db/migrations/534_mail_log_resends.js'

/** Fake knex schema: which columns nivaro_mail_log has, and what each alter did. */
function fakeKnex(columns: string[], table = true) {
  const have = new Set(columns)
  const ops: string[] = []
  const schema = {
    hasTable: vi.fn(async () => table),
    hasColumn: vi.fn(async (_t: string, c: string) => have.has(c)),
    alterTable: vi.fn(async (_t: string, cb: (t: unknown) => void) => {
      const col = (type: string) => (name: string) => {
        ops.push(`${type} ${name}`)
        have.add(name)
        return { nullable: () => ops.push(`nullable ${name}`) }
      }
      cb({
        integer: col('int'),
        uuid: col('uuid'),
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
  return { knex: { schema } as never, schema, ops, have }
}

describe('migration 534 — nivaro_mail_log.resend_of / resent_by', () => {
  it('adds a nullable indexed int and a nullable uuid, once', async () => {
    const f = fakeKnex(['id', 'to', 'status'])
    await up(f.knex)
    expect(f.ops).toEqual([
      'int resend_of',
      'nullable resend_of',
      'index resend_of nivaro_mail_log_resend_of_index',
      'uuid resent_by',
      'nullable resent_by'
    ])
    await up(f.knex)
    expect(f.ops).toHaveLength(5)
  })

  it('does nothing without the table', async () => {
    const f = fakeKnex([], false)
    await up(f.knex)
    await down(f.knex)
    expect(f.schema.alterTable).not.toHaveBeenCalled()
  })

  it('down drops the index and both columns, only when they are there', async () => {
    const f = fakeKnex(['id', 'resend_of', 'resent_by'])
    await down(f.knex)
    expect(f.ops).toEqual([
      'dropIndex resend_of nivaro_mail_log_resend_of_index',
      'drop resend_of',
      'drop resent_by'
    ])
    await down(f.knex)
    expect(f.ops).toHaveLength(3)
  })
})
