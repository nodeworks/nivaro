import { beforeEach, describe, expect, it, vi } from 'vitest'

// Low (security audit 2026-10-27): a file's usage list never names hidden
// collections, hidden fields or rows the caller cannot see.

const st = vi.hoisted(() => ({
  readable: new Set<string>(),
  fields: {} as Record<string, string[] | null>,
  rows: {} as Record<string, string[]>,
  plucked: [] as string[],
  relations: [] as Array<Record<string, unknown>>,
  visible: new Set<string>()
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async (_u: unknown, _a: string, c: string) => st.readable.has(c)),
  getAllowedFields: vi.fn(async (_u: unknown, _a: string, c: string) => st.fields[c] ?? null)
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => st.visible.has(i)))
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const b: Record<string, unknown> = {}
    let many: unknown
    b.where = (w: unknown) => {
      if (w && typeof w === 'object') many = (w as { many_collection?: unknown }).many_collection
      return b
    }
    b.limit = () => b
    b.select = async () =>
      table === 'nivaro_relations' ? st.relations.filter((r) => r.many_collection === many) : []
    b.pluck = async (col: string) => {
      st.plucked.push(`${table}.${col}`)
      return st.rows[table] ?? []
    }
    return b
  }
}))

import { fileUsageForReader } from '../../../services/file-usage-visible.js'

const usage = {
  usages: [
    { table: 'orders', column: 'invoice_pdf', count: 3 },
    { table: 'salaries', column: 'contract', count: 1 },
    { table: 'nivaro_help_videos', column: 'source', count: 1 },
    { table: 'vendors', column: 'secret_doc', count: 2 }
  ],
  total: 7
}
const req = (isAdmin: boolean) => ({ user: { id: 'U1', role: 'R1' }, isAdmin }) as never

beforeEach(() => {
  st.readable = new Set(['orders', 'vendors'])
  st.fields = { vendors: ['name'] }
  st.rows = { orders: ['1', '2', '3'], vendors: ['8', '9'] }
  st.visible = new Set(['1', '3'])
  st.relations = []
  st.plucked = []
})

describe('fileUsageForReader', () => {
  it('gives an unrestricted administrator the whole scan', async () => {
    expect(await fileUsageForReader(req(true), 'F', usage)).toBe(usage)
  })

  it('keeps readable collections + fields and counts only visible rows', async () => {
    const out = await fileUsageForReader(req(false), 'F', usage)
    expect(out).toEqual({
      usages: [{ table: 'orders', column: 'invoice_pdf', count: 2 }],
      total: 2
    })
  })

  it('judges an M2M junction row through the record that owns it (review A10)', async () => {
    st.relations = [
      // file leg: orders_files.directus_files_id → files, paired with orders_id
      {
        many_collection: 'orders_files',
        many_field: 'directus_files_id',
        one_collection: 'directus_files',
        one_field: null,
        junction_field: 'orders_id'
      },
      // parent leg: orders_files.orders_id → orders.attachments (the M2M alias)
      {
        many_collection: 'orders_files',
        many_field: 'orders_id',
        one_collection: 'orders',
        one_field: 'attachments',
        junction_field: 'directus_files_id'
      }
    ]
    st.rows.orders_files = ['1', '2', '3', '3']
    const out = await fileUsageForReader(req(false), 'F', {
      usages: [{ table: 'orders_files', column: 'directus_files_id', count: 4 }],
      total: 4
    })
    expect(st.plucked).toEqual(['orders_files.orders_id'])
    expect(out).toEqual({
      usages: [{ table: 'orders', column: 'attachments', count: 2 }],
      total: 2
    })

    // the alias field hidden from the reader → the site stays hidden
    st.fields = { orders: ['name'] }
    const hidden = await fileUsageForReader(req(false), 'F', {
      usages: [{ table: 'orders_files', column: 'directus_files_id', count: 4 }],
      total: 4
    })
    expect(hidden).toEqual({ usages: [], total: 0 })
  })

  it('tolerates a malformed scan', async () => {
    expect(await fileUsageForReader(req(false), 'F', [] as never)).toEqual({
      usages: [],
      total: 0
    })
  })
})
