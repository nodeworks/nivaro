// query_items, as the model calls it and as an answer's download re-runs it:
// "today" is the asker's local day on a timestamp column, and a download reads
// every matching row instead of the page the model was shown.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/items.js', () => ({
  ForbiddenError: class extends Error {},
  applyConditions: vi.fn(),
  createOne: vi.fn(),
  planConditionPath: vi.fn(),
  readItems: vi.fn(),
  updateOne: vi.fn()
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(),
  getRowFilter: vi.fn(),
  isAdminRole: vi.fn()
}))
vi.mock('../../../services/embeddings.js', () => ({
  embedText: vi.fn(),
  searchEmbeddings: vi.fn()
}))
vi.mock('../../../services/access-narrowing.js', () => ({
  withAccessNote: async (_u: unknown, _t: unknown, _i: unknown, out: unknown) => out
}))

const { db } = await import('../../../db/index.js')
const { planConditionPath, readItems } = await import('../../../services/items.js')
const { can } = await import('../../../services/permissions.js')
const { buildAction } = await import('../../../services/ai-actions.js')
const { executeChatTool, EXPORT_MAX_ROWS } = await import('../../../services/ai-chat.js')

const TABLES: Record<string, Array<Record<string, unknown>>> = {
  nivaro_fields: [
    { field: 'id', label: null, special: null },
    { field: 'name', label: null, special: null },
    { field: 'created', label: 'Created', special: 'date-created' },
    { field: 'date_required', label: null, special: null }
  ],
  'information_schema.columns': [
    { column_name: 'id', data_type: 'int' },
    { column_name: 'name', data_type: 'nvarchar' },
    // A timestamp (an instant) and a calendar date kept as written.
    { column_name: 'created', data_type: 'datetimeoffset' },
    { column_name: 'date_required', data_type: 'datetime2' }
  ],
  nivaro_relations: [],
  nivaro_settings: [{ sla_timezone: 'America/New_York' }]
}

function query(rows: Array<Record<string, unknown>>) {
  const q: Record<string, unknown> = {}
  for (const m of ['where', 'whereNot', 'whereNotNull', 'whereIn', 'select', 'orderBy', 'limit'])
    q[m] = () => q
  q.first = async () => rows[0]
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited like this
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(ok, bad)
  q.catch = (bad: (e: unknown) => unknown) => Promise.resolve(rows).catch(bad)
  return q
}

const user = { id: 'user-1', role: 'role-1' } as never
const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i + 1 }))

/** The `conditions` a read was given, and its paging. */
function reads() {
  return vi.mocked(readItems).mock.calls.map((c) => {
    const q = c[2] as { limit?: number; offset?: number; fields?: string[] }
    const raw = (c[3] as { query?: { conditions?: string } } | undefined)?.query?.conditions
    return {
      limit: q.limit,
      offset: q.offset ?? 0,
      fields: q.fields,
      sort: (q as { sort?: string[] }).sort,
      conditions: raw ? JSON.parse(raw) : []
    }
  })
}

beforeEach(() => {
  vi.mocked(readItems).mockReset()
  vi.mocked(db).mockImplementation(((name: string) => query(TABLES[name] ?? [])) as never)
  vi.mocked(planConditionPath).mockImplementation((async (collection: string, path: string[]) => ({
    hops: [],
    leafTable: collection,
    leafCol: path[path.length - 1]
  })) as never)
})

describe('query_items — "created today" is the asker’s day', () => {
  it('reads the filter the model wrote for today as the Eastern day', async () => {
    vi.mocked(readItems).mockResolvedValue({ data: page(1), total: 1 } as never)
    await executeChatTool(user, 'query_items', {
      collection: 'workflows',
      filter: { created: { _gte: '2026-11-09T00:00:00', _lte: '2026-11-09T23:59:59' } }
    })
    expect(reads()[0].conditions).toEqual([
      { path: ['created'], op: '_gte', value: '2026-11-09T05:00:00.000' },
      { path: ['created'], op: '_lt', value: '2026-11-10T05:00:00.000' }
    ])
  })

  it('never shifts a calendar date', async () => {
    vi.mocked(readItems).mockResolvedValue({ data: [], total: 0 } as never)
    await executeChatTool(user, 'query_items', {
      collection: 'workflows',
      filter: { date_required: { _gte: '2026-11-09' } }
    })
    expect(reads()[0].conditions).toEqual([
      { path: ['date_required'], op: '_gte', value: '2026-11-09' }
    ])
  })
})

describe('a proposed bulk change reads dates the way the answer did', () => {
  it('finds the records of the asker’s day, not the UTC day', async () => {
    vi.mocked(can).mockResolvedValue(true as never)
    vi.mocked(readItems).mockResolvedValue({ data: [{ id: 7, name: 'A' }] } as never)
    await buildAction(user, {
      action_type: 'bulk_update',
      collection: 'workflows',
      filter: { created: { _gte: '2026-11-09' }, name: { _contains: 'fuse' } },
      changes: { name: 'B' }
    })
    expect((vi.mocked(readItems).mock.calls[0][2] as { filter: unknown }).filter).toEqual({
      created: { _gte: '2026-11-09T05:00:00.000' },
      name: { _contains: 'fuse' }
    })
  })
})

describe('query_items — the page the model reads, the rows a download holds', () => {
  it('gives the model one page of at most 50 rows and 15 columns', async () => {
    vi.mocked(readItems).mockResolvedValue({ data: page(50), total: 64 } as never)
    const out = await executeChatTool(user, 'query_items', {
      collection: 'workflows',
      limit: 500,
      fields: Array.from({ length: 20 }, () => 'name')
    })
    expect(reads()).toHaveLength(1)
    expect(reads()[0]).toMatchObject({ limit: 50, offset: 0 })
    expect(reads()[0].fields).toHaveLength(15)
    expect(out.summary).toBe('50 of 64 row(s) from workflows')
  })

  it('pages through every match for a download (the production file stopped at 50 of 64)', async () => {
    vi.mocked(readItems)
      .mockResolvedValueOnce({ data: page(1000), total: 2300 } as never)
      .mockResolvedValueOnce({ data: page(1000, 1000), total: 2300 } as never)
      .mockResolvedValueOnce({ data: page(300, 2000), total: 2300 } as never)
    const out = await executeChatTool(
      user,
      'query_items',
      { collection: 'workflows', limit: 50, fields: Array.from({ length: 20 }, () => 'name') },
      { exportRows: EXPORT_MAX_ROWS }
    )
    expect(reads().map((r) => [r.limit, r.offset])).toEqual([
      [1000, 0],
      [1000, 1000],
      [1000, 2000]
    ])
    // Every column the query named, not the model's 15.
    expect(reads()[0].fields).toHaveLength(20)
    const result = out.result as { total: number; rows: unknown[] }
    expect(result.rows).toHaveLength(2300)
    expect(result.total).toBe(2300)
  })

  it('breaks ties by id while paging, so no row is read twice or skipped', async () => {
    vi.mocked(readItems).mockResolvedValue({ data: page(3), total: 3 } as never)
    const input = { collection: 'workflows', sort: ['-created'] }
    await executeChatTool(user, 'query_items', input, { exportRows: EXPORT_MAX_ROWS })
    await executeChatTool(user, 'query_items', input)
    expect(reads().map((r) => r.sort)).toEqual([['-created', 'id'], ['-created']])
  })

  it('stops at the cap', async () => {
    vi.mocked(readItems).mockImplementation((async (
      _u: unknown,
      _c: unknown,
      q: { limit: number }
    ) => ({
      data: page(q.limit),
      total: 99_999
    })) as never)
    const out = await executeChatTool(
      user,
      'query_items',
      { collection: 'workflows' },
      { exportRows: 2500 }
    )
    expect(reads().map((r) => [r.limit, r.offset])).toEqual([
      [1000, 0],
      [1000, 1000],
      [500, 2000]
    ])
    expect((out.result as { rows: unknown[] }).rows).toHaveLength(2500)
  })

  it('keeps a short list short: "the 10 newest" downloads 10', async () => {
    vi.mocked(readItems).mockResolvedValue({ data: page(10), total: 812 } as never)
    const out = await executeChatTool(
      user,
      'query_items',
      { collection: 'workflows', limit: 10 },
      { exportRows: EXPORT_MAX_ROWS }
    )
    expect(reads()).toHaveLength(1)
    expect(reads()[0]).toMatchObject({ limit: 10, offset: 0 })
    expect((out.result as { rows: unknown[] }).rows).toHaveLength(10)
  })
})
