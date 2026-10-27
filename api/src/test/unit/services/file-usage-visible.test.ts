import { beforeEach, describe, expect, it, vi } from 'vitest'

// Low (security audit 2026-10-27): a file's usage list never names hidden
// collections, hidden fields or rows the caller cannot see.

const st = vi.hoisted(() => ({
  readable: new Set<string>(),
  fields: {} as Record<string, string[] | null>,
  rows: {} as Record<string, string[]>,
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
    b.where = () => b
    b.limit = () => b
    b.pluck = async () => st.rows[table] ?? []
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

  it('tolerates a malformed scan', async () => {
    expect(await fileUsageForReader(req(false), 'F', [] as never)).toEqual({
      usages: [],
      total: 0
    })
  })
})
