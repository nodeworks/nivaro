import { beforeEach, describe, expect, it } from 'vitest'
import { hasColumn, resetColumnProbes } from './column-probe.js'
import { requesterInsertFields, requesterSelectColumns } from './requester-columns.js'

function fakeDb(answer: () => Promise<boolean>, database = 'one') {
  let calls = 0
  const db = {
    client: { config: { connection: { server: 'sql', database } } },
    schema: {
      hasColumn: async () => {
        calls++
        return answer()
      }
    }
  } as never
  return { db, calls: () => calls }
}

describe('column probe', () => {
  beforeEach(() => resetColumnProbes())

  it('remembers a hit for the life of the process', async () => {
    const { db, calls } = fakeDb(async () => true)
    expect(await hasColumn(db, 't', 'c')).toBe(true)
    expect(await hasColumn(db, 't', 'c')).toBe(true)
    expect(calls()).toBe(1)
  })

  it('remembers a miss for a minute only, and never throws', async () => {
    const { db, calls } = fakeDb(async () => {
      throw new Error('no such table')
    })
    expect(await hasColumn(db, 't', 'c')).toBe(false)
    expect(await hasColumn(db, 't', 'c')).toBe(false)
    expect(calls()).toBe(1)
  })

  it('keeps one answer per database', async () => {
    const a = fakeDb(async () => true, 'a')
    const b = fakeDb(async () => false, 'b')
    expect(await hasColumn(a.db, 't', 'c')).toBe(true)
    expect(await hasColumn(b.db, 't', 'c')).toBe(false)
  })

  it('shares one in-flight probe', async () => {
    let resolve!: (v: boolean) => void
    const { db, calls } = fakeDb(() => new Promise<boolean>((r) => (resolve = r)))
    const p = Promise.all([hasColumn(db, 't', 'c'), hasColumn(db, 't', 'c')])
    resolve(true)
    expect(await p).toEqual([true, true])
    expect(calls()).toBe(1)
  })
})

describe('requester columns', () => {
  beforeEach(() => resetColumnProbes())

  it('names the columns only once the migration has landed', async () => {
    const before = fakeDb(async () => false, 'old')
    expect(await requesterInsertFields(before.db, 'nivaro_erp_submissions', 'u', 'api')).toEqual({})
    expect(await requesterSelectColumns(before.db, 'nivaro_erp_submissions')).toEqual([])
    const after = fakeDb(async () => true, 'new')
    expect(await requesterInsertFields(after.db, 'nivaro_erp_submissions', 'u', 'api')).toEqual({
      requested_by: 'u',
      requested_via: 'api'
    })
    expect(
      await requesterInsertFields(after.db, 'nivaro_erp_submissions', undefined, null)
    ).toEqual({ requested_by: null, requested_via: null })
    expect(await requesterSelectColumns(after.db, 'nivaro_erp_submissions')).toEqual([
      'requested_by',
      'requested_via'
    ])
  })
})
