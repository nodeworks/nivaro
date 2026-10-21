import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /ai/field-fill (#2692) gates: `*` field policies, record rules on new records and the
// cluster-wide rate limit. Services are mocked; the DB is a stub.

const m = vi.hoisted(() => ({
  layout: {} as Record<string, unknown>,
  writable: ['*'] as string[] | null,
  readable: ['*'] as string[] | null,
  prompts: [] as string[],
  hits: 0
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u1', role: 'r1' }
    req.isAdmin = false
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/system-collections.js', () => ({ isSystemCollection: () => false }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async () => ({ id: 1, title: 'Pump', kind: 'a' })),
  canUpdateItem: vi.fn(async () => true)
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async (_u: unknown, action: string) =>
    action === 'read' ? m.readable : m.writable
  )
}))
vi.mock('../../../routes/collection-layouts.js', () => ({
  matchesRecordConditions: (rules: Array<{ field: string; value: unknown }>, r: never) =>
    rules.every((x) => String(r[x.field] ?? '') === String(x.value))
}))
vi.mock('../../../services/ai-design/model.js', () => ({
  AiUnavailableError: class extends Error {},
  cleanText: (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null,
  titleCase: (s: string) => s,
  defaultComplete: vi.fn(async () => async (input: { user: string }) => {
    m.prompts.push(input.user)
    return 'Written'
  })
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const api: Record<string, unknown> = {
      where: () => api,
      whereIn: () => api,
      first: async () => {
        if (table === 'nivaro_collection_layouts') return m.layout
        if (table === 'orders') return { kind: 'a' }
        return undefined
      },
      select: async () => {
        if (table === 'nivaro_layout_field_assignments')
          return [{ overrides: { ai_generate: { enabled: true, prompt: 'About {{title}}' } } }]
        if (table === 'nivaro_fields')
          return [
            { field: 'summary', type: 'text', label: 'Summary' },
            { field: 'title', type: 'string', label: 'Title' }
          ]
        return []
      }
    }
    return api
  }
  return { db: Object.assign((t: string) => chain(t), { raw: vi.fn() }) }
})

const { aiFieldFillRoutes } = await import('../../../routes/ai-field-fill.js')
const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')

async function build() {
  const app = Fastify()
  app.decorate('redis', {
    incrby: async (_k: string, n: number) => {
      m.hits += n
      return m.hits
    },
    expire: async () => 1
  } as never)
  await app.register(aiFieldFillRoutes, { prefix: '/ai' })
  await app.ready()
  return app
}

const fill = (app: Awaited<ReturnType<typeof build>>, item_id: number | null = 1) =>
  app.inject({
    method: 'POST',
    url: '/ai/field-fill',
    payload: { collection: 'orders', layout_id: 7, field: 'summary', item_id }
  })

beforeEach(() => {
  m.layout = { id: 7, collection: 'orders', layout_type: 'grouped', conditions: null }
  m.writable = ['*']
  m.readable = ['*']
  m.prompts = []
  m.hits = 0
  resetWindowedMemory()
})

describe('ai field fill gates', () => {
  it('treats a `*` field policy as every field, for writing and for prompt tokens', async () => {
    const app = await build()
    const r = await fill(app)
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ value: 'Written', missing: [] })
    expect(m.prompts[0]).toContain('About Pump')
  })
  it('still refuses a field outside an explicit list', async () => {
    m.writable = ['title']
    const app = await build()
    expect((await fill(app)).statusCode).toBe(403)
  })
  it('refuses a new record on a form with record rules', async () => {
    m.layout = {
      ...m.layout,
      record_conditions: JSON.stringify([{ field: 'kind', op: 'eq', value: 'a' }])
    }
    const app = await build()
    expect((await fill(app, null)).statusCode).toBe(403)
    expect((await fill(app, 1)).statusCode).toBe(200)
  })
  it('allows a new record on a form without record rules', async () => {
    const app = await build()
    expect((await fill(app, null)).statusCode).toBe(200)
  })
  it('rate-limits through Redis', async () => {
    m.hits = 30
    const app = await build()
    expect((await fill(app)).statusCode).toBe(429)
  })
})
