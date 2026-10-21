import { beforeEach, describe, expect, it, vi } from 'vitest'

// Named tools, the query they point at and the flow — a tiny in-memory db.
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    let rows = [...(state.tables[table] ?? [])]
    const q = {
      where(obj: Record<string, unknown>) {
        rows = rows.filter((r) => Object.entries(obj).every(([k, v]) => r[k] === v))
        return q
      },
      whereIn(col: string, vals: unknown[]) {
        rows = rows.filter((r) => vals.includes(r[col]))
        return q
      },
      select: async () => rows,
      first: async () => rows[0]
    }
    return q
  }
  return { db: chain }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
const executeFlow = vi.fn(async () => ({ done: true }))
vi.mock('../../../services/flow-executor.js', () => ({ executeFlow }))
vi.mock('../../../services/activity.js', () => ({ logActivity: async () => null }))

const { callInstanceTool, instanceToolCatalog, mcpCallerAccess } = await import(
  '../../../services/mcp-tools.js'
)

const NAMED = [
  {
    name: 'admin_spend',
    description: 'Spend (admins).',
    kind: 'custom_query',
    ref: 'spend',
    access: 'admin',
    read_only: true,
    enabled: true
  },
  {
    name: 'raise_po',
    description: 'Raise a PO.',
    kind: 'flow',
    ref: 'F-1',
    access: 'authenticated',
    read_only: false,
    enabled: true,
    params: [{ name: 'amount', type: 'number' }]
  }
]

beforeEach(() => {
  executeFlow.mockClear()
  state.tables = {
    nivaro_settings: [{ id: 1, mcp_tools: JSON.stringify(NAMED) }],
    nivaro_custom_queries: [
      {
        slug: 'spend',
        name: 'Spend',
        description: null,
        params: '[]',
        access: 'authenticated',
        enabled: true
      }
    ],
    nivaro_flows: [{ id: 'F-1', name: 'Raise PO', status: 'active' }]
  }
})

const inject = vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ data: [{ n: 1 }] }) }))
const app = { inject, log: { info() {}, warn() {}, error() {} } } as never
const reqFor = (o: { isAdmin: boolean; scopes?: unknown }) =>
  ({
    isAdmin: o.isAdmin,
    user: { id: 'U1', ...(o.scopes ? { api_key_scopes: o.scopes } : {}) },
    headers: { authorization: 'Bearer k' },
    ip: '127.0.0.1'
  }) as never
const SCOPES = [{ collection: 'articles', actions: ['read'] }]

describe('mcpCallerAccess — one rule for the catalog and the call', () => {
  it('an administrator on a collection-scoped key is not an administrator', () => {
    expect(mcpCallerAccess(reqFor({ isAdmin: true }))).toEqual({ isAdmin: true, scoped: false })
    expect(mcpCallerAccess(reqFor({ isAdmin: true, scopes: SCOPES }))).toEqual({
      isAdmin: false,
      scoped: true
    })
    expect(mcpCallerAccess(reqFor({ isAdmin: false }))).toEqual({ isAdmin: false, scoped: false })
  })
})

describe('admin-only named tools on a scoped key (HIGH)', () => {
  it('is neither listed nor callable for an admin on a scoped key', async () => {
    const scopedAdmin = reqFor({ isAdmin: true, scopes: SCOPES })
    const listed = await instanceToolCatalog(mcpCallerAccess(scopedAdmin))
    expect(listed.map((t) => t.name)).not.toContain('admin_spend')
    await expect(callInstanceTool(app, scopedAdmin, 'admin_spend', {})).rejects.toMatchObject({
      statusCode: 404
    })
    expect(inject).not.toHaveBeenCalled()
  })

  it('an unscoped admin lists and runs it through the query route', async () => {
    const admin = reqFor({ isAdmin: true })
    expect((await instanceToolCatalog(mcpCallerAccess(admin))).map((t) => t.name)).toContain(
      'admin_spend'
    )
    const out = await callInstanceTool(app, admin, 'admin_spend', {})
    expect(out).toMatchObject({ rows: [{ n: 1 }], row_count: 1 })
    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/api/custom-queries/spend/execute' })
    )
  })
})

describe('flow tools on a scoped key (MEDIUM)', () => {
  it('are left out of the catalog and refused on call with 403', async () => {
    const scoped = reqFor({ isAdmin: false, scopes: SCOPES })
    const listed = await instanceToolCatalog(mcpCallerAccess(scoped))
    expect(listed.map((t) => t.name)).not.toContain('raise_po')
    await expect(callInstanceTool(app, scoped, 'raise_po', { amount: 5 })).rejects.toMatchObject({
      statusCode: 403
    })
    expect(executeFlow).not.toHaveBeenCalled()
  })

  it('run as the caller for an unscoped key, with only the declared inputs', async () => {
    const person = reqFor({ isAdmin: false })
    await callInstanceTool(app, person, 'raise_po', { amount: 5, sneaky: 1 })
    expect(executeFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'F-1',
        trigger: 'mcp',
        userId: 'U1',
        payload: { amount: 5, $tool: 'raise_po' }
      })
    )
  })
})
