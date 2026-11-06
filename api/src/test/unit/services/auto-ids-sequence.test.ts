import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import { nextSequenceValue, peekSequenceValue } from '../../../services/auto-ids.js'

/**
 * A tiny stand-in for knex over two tables: nivaro_sequences (id → next_val,
 * the LAST value handed out) and the target collection's field values.
 */
function fakeDb(opts: {
  seq?: Record<string, number>
  populated?: boolean
  insertFails?: boolean
  /** The error a failing insert throws (default: a PRIMARY KEY violation). */
  insertError?: Error
  /** The column's SQL type (INFORMATION_SCHEMA DATA_TYPE); null = cannot be read. */
  type?: string | null
  onInsert?: (seq: Record<string, number>) => void
}) {
  const seq: Record<string, number> = { ...(opts.seq ?? {}) }
  const sql: string[] = []
  const raw = async (text: string, bindings: unknown[]) => {
    sql.push(text)
    if (text.startsWith('UPDATE nivaro_sequences')) {
      const id = String(bindings[0])
      if (seq[id] == null) return []
      seq[id] += 1
      return [{ next_val: seq[id] }]
    }
    if (text.startsWith('SELECT TOP 1 DATA_TYPE')) {
      if (opts.type === null) throw new Error('metadata read failed')
      return [{ t: opts.type ?? 'varchar' }]
    }
    if (text.startsWith('SELECT TOP 1 1')) return opts.populated ? [{ hit: 1 }] : []
    throw new Error(`unexpected sql ${text}`)
  }
  const table = (name: string) => {
    let where: Record<string, unknown> = {}
    const b = {
      where(w: Record<string, unknown>) {
        where = w
        return b
      },
      async first() {
        const id = String(where.id)
        return name === 'nivaro_sequences' && seq[id] != null ? { next_val: seq[id] } : undefined
      },
      async insert(row: { id: string; next_val: number }) {
        if (opts.insertFails) {
          opts.onInsert?.(seq)
          throw opts.insertError ?? new Error('Violation of PRIMARY KEY constraint')
        }
        seq[row.id] = row.next_val
      }
    }
    return b
  }
  const db = Object.assign(table, { raw }) as unknown as Knex
  return { db, seq, sql }
}

describe('nextSequenceValue', () => {
  it('increments an existing counter (stored = last value handed out)', async () => {
    const { db, seq } = fakeDb({ seq: { 'workflows.workflow_id': 81408 }, populated: true })
    expect(await nextSequenceValue(db, 'workflows', 'workflow_id')).toBe(81409)
    expect(seq['workflows.workflow_id']).toBe(81409)
  })

  it('does not probe the collection when the counter exists', async () => {
    const { db, sql } = fakeDb({ seq: { 'workflows.workflow_id': 5 }, populated: true })
    await nextSequenceValue(db, 'workflows', 'workflow_id')
    expect(sql.some((s) => s.startsWith('SELECT TOP 1'))).toBe(false)
  })

  it('starts a brand-new field at 1, and the next create gets 2', async () => {
    const { db, seq } = fakeDb({ populated: false })
    expect(await nextSequenceValue(db, 'widgets', 'code')).toBe(1)
    expect(seq['widgets.code']).toBe(1)
    expect(await nextSequenceValue(db, 'widgets', 'code')).toBe(2)
  })

  it('refuses SEQUENCE_UNSEEDED when the counter is missing but the field holds ids', async () => {
    const { db, seq } = fakeDb({ populated: true })
    const err = await nextSequenceValue(db, 'workflows', 'workflow_id').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('SEQUENCE_UNSEEDED')
    expect(err.statusCode).toBe(503)
    expect(err.message).toMatch(/not ready yet/i)
    expect(err.message).not.toMatch(/nivaro_sequences|workflow_id/)
    // nothing seeded, nothing issued
    expect(seq['workflows.workflow_id']).toBeUndefined()
  })

  it('probes with TOP 1 on the populated path only', async () => {
    const { db, sql } = fakeDb({ populated: true })
    await nextSequenceValue(db, 'workflows', 'workflow_id').catch(() => {})
    const probe = sql.find((s) => s.startsWith('SELECT TOP 1 1'))
    expect(probe).toBe("SELECT TOP 1 1 AS hit FROM ?? WHERE ?? IS NOT NULL AND ?? <> ''")
  })

  it('a concurrent first use that lost the insert takes the next value, not a second 1', async () => {
    const { db } = fakeDb({
      populated: false,
      insertFails: true,
      onInsert: (s) => {
        s['widgets.code'] = 1 // the other create won and took 1
      }
    })
    expect(await nextSequenceValue(db, 'widgets', 'code')).toBe(2)
  })
})

describe('the unused-field probe by column type (REVIEW-R5 L1)', () => {
  const probeOf = (sql: string[]) => sql.find((s) => s.startsWith('SELECT TOP 1 1'))

  it.each([
    'decimal',
    'numeric',
    'int',
    'bigint',
    'uniqueidentifier'
  ])("a %s field is probed with IS NOT NULL only (no <> '' conversion)", async (type) => {
    const { db, sql } = fakeDb({ populated: false, type })
    expect(await nextSequenceValue(db, 'widgets', 'code')).toBe(1)
    expect(probeOf(sql)).toBe('SELECT TOP 1 1 AS hit FROM ?? WHERE ?? IS NOT NULL')
  })

  it.each([
    'varchar',
    'nvarchar',
    'char',
    'NVARCHAR'
  ])('a %s field keeps the empty-string test', async (type) => {
    const { db, sql } = fakeDb({ populated: false, type })
    await nextSequenceValue(db, 'widgets', 'code')
    expect(probeOf(sql)).toBe("SELECT TOP 1 1 AS hit FROM ?? WHERE ?? IS NOT NULL AND ?? <> ''")
  })

  it('a populated decimal field is refused as unseeded, not a 500', async () => {
    const { db } = fakeDb({ populated: true, type: 'decimal' })
    await expect(nextSequenceValue(db, 'widgets', 'code')).rejects.toMatchObject({
      code: 'SEQUENCE_UNSEEDED'
    })
  })

  it('a type that cannot be read falls back to IS NOT NULL', async () => {
    const { db, sql } = fakeDb({ populated: false, type: null })
    expect(await nextSequenceValue(db, 'widgets', 'code')).toBe(1)
    expect(probeOf(sql)).toBe('SELECT TOP 1 1 AS hit FROM ?? WHERE ?? IS NOT NULL')
  })
})

describe('the first-use insert race (REVIEW-R5 L1)', () => {
  it('a key violation by number (2627 / 2601) is the race', async () => {
    for (const number of [2627, 2601]) {
      const { db } = fakeDb({
        populated: false,
        insertFails: true,
        insertError: Object.assign(new Error('x'), { number }),
        onInsert: (s) => {
          s['widgets.code'] = 1
        }
      })
      expect(await nextSequenceValue(db, 'widgets', 'code')).toBe(2)
    }
  })

  it('a transient insert failure is rethrown as itself, not SEQUENCE_UNSEEDED', async () => {
    const boom = Object.assign(new Error('Connection lost - read ECONNRESET'), { code: 'ESOCKET' })
    const { db } = fakeDb({ populated: false, insertFails: true, insertError: boom })
    const err = await nextSequenceValue(db, 'widgets', 'code').catch((e) => e)
    expect(err).toBe(boom)
  })
})

describe('peekSequenceValue (dry-run creates)', () => {
  it('previews stored + 1', async () => {
    const { db } = fakeDb({ seq: { 'workflows.workflow_id': 10 } })
    expect(await peekSequenceValue(db, 'workflows', 'workflow_id')).toBe(11)
  })

  it('previews 1 for a brand-new field', async () => {
    const { db } = fakeDb({ populated: false })
    expect(await peekSequenceValue(db, 'widgets', 'code')).toBe(1)
  })

  it('refuses like the real create when unseeded', async () => {
    const { db } = fakeDb({ populated: true })
    await expect(peekSequenceValue(db, 'workflows', 'workflow_id')).rejects.toMatchObject({
      code: 'SEQUENCE_UNSEEDED'
    })
  })
})
