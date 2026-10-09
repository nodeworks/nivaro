import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1: the generic items reader never returns a help-video recording, render,
// caption or poster as a file row — neither a direct read of the files table
// nor a record's file field expanded to its row.

// Any query-builder call chains; awaiting answers rows for the table.
const rowsFor = vi.hoisted(() => ({ map: {} as Record<string, unknown[]> }))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rowsFor.map[table] ?? []).then(res, rej)
        if (prop === 'columnInfo') return async () => ({})
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain('raw')
    }
  })
  return { db, dbRead: db }
})
const hv = vi.hoisted(() => ({ calls: [] as Array<{ q: unknown; col: string }> }))
vi.mock('../../../services/help-video-files.js', () => ({
  isFilesCollection: (c: string) => /^(nivaro|directus)_files$/i.test(c),
  whereNotHelpVideoFile: (q: unknown, col: string) => {
    hv.calls.push({ q, col })
    return q
  }
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async () => [
    { many_collection: 'orders', many_field: 'invoice_file', one_collection: 'nivaro_files' }
  ])
}))

import { readItems } from '../../../services/items.js'

const admin = { id: 'ADMIN-1', role: 'R1' } as never

beforeEach(() => {
  hv.calls = []
})

describe('items reader and help-video files', () => {
  it('a read of the files table excludes help-video files from the page and the count', async () => {
    await readItems(admin, 'nivaro_files', { fields: ['id'], limit: 10 }).catch(() => undefined)
    expect(hv.calls.map((c) => c.col)).toEqual(['nivaro_files.id', 'nivaro_files.id'])
    expect(hv.calls[0].q).not.toBe(hv.calls[1].q)
  })

  it('a business collection read adds nothing', async () => {
    await readItems(admin, 'orders', { fields: ['id'], limit: 10 }).catch(() => undefined)
    expect(hv.calls).toEqual([])
  })

  it("expanding a record's file field excludes help-video files", async () => {
    rowsFor.map.orders = [{ id: 1, invoice_file: '11111111-1111-4111-8111-111111111111' }]
    try {
      await readItems(admin, 'orders', { fields: ['id', 'invoice_file.*'], limit: 10 }).catch(
        () => undefined
      )
    } finally {
      rowsFor.map = {}
    }
    expect(hv.calls.map((c) => c.col)).toContain('nivaro_files.id')
  })
})
