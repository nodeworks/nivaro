import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Collection Designer's procedure import pipeline never writes over a procedure app config
// owns (an app-managed one, or one an import definition owns): it skips the pipeline and says so.

const m = vi.hoisted(() => ({
  owner: vi.fn(async (_n: string): Promise<Record<string, unknown> | null> => null),
  raw: [] as string[],
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: 'admin', email: 'a@x' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn()
}))
vi.mock('../../../services/managed-procedures/owners.js', () => ({ procedureOwner: m.owner }))
vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const k of ['where', 'whereIn', 'select', 'limit', 'orderBy']) q[k] = () => q
    q.pluck = async () => []
    q.first = async () => undefined
    q.update = async () => 1
    q.insert = async (row: Record<string, unknown>) => {
      m.inserts.push({ table, row })
      return [1]
    }
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited as a thenable
    q.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return q
  }
  const db = Object.assign(builder, {
    raw: async (sql: string) => {
      m.raw.push(sql)
      return []
    },
    fn: { now: () => 'now' },
    schema: {
      createTable: async () => {},
      table: async () => {},
      hasTable: async () => false
    }
  })
  return { db }
})

import { collectionDesignerRoutes } from '../../../routes/collection-designer.js'

const plan = {
  collections: [
    {
      collection: 'spend',
      display_name: 'Spend',
      fields: [{ field: 'amount', type: 'decimal', source_column: 'Amount' }]
    }
  ]
}

async function apply() {
  const app = Fastify()
  await app.register(collectionDesignerRoutes, { prefix: '/designer' })
  return app.inject({
    method: 'POST',
    url: '/designer/apply',
    payload: { plan, create_import: true, import_processor: 'procedure' }
  })
}

beforeEach(() => {
  m.owner.mockReset()
  m.owner.mockImplementation(async () => null)
  m.raw.length = 0
  m.inserts.length = 0
})

describe('Collection Designer import pipeline and app-managed procedures', () => {
  it('skips the pipeline with that error text when the procedure is app-managed', async () => {
    m.owner.mockImplementation(async () => ({
      kind: 'managed',
      id: 3,
      name: 'import_spend',
      dropped: false
    }))
    const res = await apply()
    const body = JSON.stringify(res.json())
    expect(body).toContain('Procedure import_spend is app-managed — import pipeline skipped')
    expect(m.owner).toHaveBeenCalledWith('import_spend')
    expect(m.raw.some((s) => /CREATE\s+(OR\s+ALTER\s+)?PROC/i.test(s))).toBe(false)
    expect(m.inserts.some((i) => i.table === 'nivaro_import_definitions')).toBe(false)
  })

  it('skips it too when an import definition owns the procedure', async () => {
    m.owner.mockImplementation(async () => ({ kind: 'import', key: 'old', name: 'import_spend' }))
    const res = await apply()
    expect(JSON.stringify(res.json())).toContain(
      'Procedure import_spend is app-managed — import pipeline skipped'
    )
    expect(m.raw.some((s) => /CREATE\s+(OR\s+ALTER\s+)?PROC/i.test(s))).toBe(false)
  })

  it('an unowned, absent procedure is generated as before', async () => {
    const res = await apply()
    expect(JSON.stringify(res.json())).not.toContain('app-managed')
    expect(m.raw.some((s) => /CREATE\s+(OR\s+ALTER\s+)?PROC/i.test(s))).toBe(true)
    expect(m.inserts.some((i) => i.table === 'nivaro_import_definitions')).toBe(true)
  })
})
