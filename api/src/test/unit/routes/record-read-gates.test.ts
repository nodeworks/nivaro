import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 2026-10-25: per-record side routes (last touch, provenance, field history,
// timeline, lineage, attributes, translations, legal-hold check, field watches) answered
// for any record id with a collection-level gate only. Each now reads the record as the
// caller first: a record they cannot open answers 404, one they can open answers as before.

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  visible: true,
  updatable: true,
  allowed: null as string[] | null,
  tables: {} as Record<string, Row[]>
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'PAUL', role: 'APPROVER' }
    req.isAdmin = false
  }
  return { authenticate: sign, requireAuth: sign, requireAdmin: async () => {} }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => state.allowed),
  isAdminRole: vi.fn(async () => false)
}))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    state.visible ? { id, objective: 'x' } : null
  ),
  readItems: vi.fn(async () => ({ data: [] })),
  canUpdateItem: vi.fn(async () => state.updatable)
}))
vi.mock('../../../services/edit-lock.js', () => ({
  EDIT_LOCKED: 'EDIT_LOCKED',
  EditLockedError: class extends Error {},
  assertNotEditLocked: vi.fn(async () => undefined)
}))
vi.mock('../../../services/chain-columns.js', () => ({
  hasChainColumns: vi.fn(async () => false),
  chainFields: vi.fn(async () => ({}))
}))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn(async () => ({})) }))
vi.mock('../../../db/index.js', () => {
  const builder = (raw: string) => {
    const table = raw.split(' as ')[0]
    const rows = () => state.tables[table] ?? []
    const b: any = {}
    for (const m of [
      'where',
      'whereIn',
      'whereNull',
      'whereNotNull',
      'whereNotIn',
      'join',
      'leftJoin',
      'orderBy',
      'limit',
      'select',
      'update',
      'delete',
      'insert'
    ])
      b[m] = () => b
    b.first = async () => rows()[0]
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
    b.catch = () => Promise.resolve(rows())
    return b
  }
  return { db: Object.assign(builder, { raw: async () => [] }) }
})

import { attributesRoutes } from '../../../routes/attributes.js'
import { fieldHistoryRoutes } from '../../../routes/field-history.js'
import { fieldTranslationsRoutes } from '../../../routes/field-translations.js'
import { fieldWatchesRoutes } from '../../../routes/field-watches.js'
import { lastTouchRoutes } from '../../../routes/last-touch.js'
import { legalHoldRoutes } from '../../../routes/legal-holds.js'
import { lineageRoutes } from '../../../routes/lineage.js'
import { timelineRoutes } from '../../../routes/timeline.js'

let app: FastifyInstance
async function build() {
  const a = Fastify()
  await a.register(lastTouchRoutes)
  await a.register(fieldHistoryRoutes)
  await a.register(attributesRoutes)
  await a.register(timelineRoutes, { prefix: '/timeline' })
  await a.register(lineageRoutes, { prefix: '/lineage' })
  await a.register(legalHoldRoutes, { prefix: '/legal-holds' })
  await a.register(fieldTranslationsRoutes, { prefix: '/field-translations' })
  await a.register(fieldWatchesRoutes, { prefix: '/field-watches' })
  return a
}

beforeEach(async () => {
  state.visible = true
  state.updatable = true
  state.allowed = null
  state.tables = {
    nivaro_fields: [{ collection: 'workflows', field: 'objective' }],
    nivaro_settings: [{ id: 1, field_watch_enabled: true }]
  }
  app = await build()
})

const READS = [
  '/last-touch/workflows/372786',
  '/provenance/workflows/372786',
  '/field-history/workflows/372786/objective',
  '/attributes/workflows/372786',
  '/timeline/workflows/372786',
  '/legal-holds/check/workflows/372786',
  '/field-translations/workflows/372786',
  '/field-translations/workflows/372786/objective'
]

describe('per-record side routes', () => {
  it.each(READS)('GET %s answers 404 for a record the caller cannot open', async (url) => {
    state.visible = false
    expect((await app.inject({ url })).statusCode).toBe(404)
  })

  it.each(READS)('GET %s answers for a record the caller can open', async (url) => {
    expect((await app.inject({ url })).statusCode).toBe(200)
  })

  it('lineage reads the record as the caller', async () => {
    state.visible = false
    const hidden = await app.inject({ url: '/lineage/workflows/372786/forecast_left' })
    expect(hidden.json().error).toBe('Record not found')
    state.visible = true
    const open = await app.inject({ url: '/lineage/workflows/372786/forecast_left' })
    expect(open.json().error).toBe('Field is not computed')
  })

  it('field history refuses a field outside the read allow-list', async () => {
    state.allowed = ['id', 'name']
    const res = await app.inject({ url: '/field-history/workflows/372786/objective' })
    expect(res.statusCode).toBe(403)
  })

  it('translation delete and attribute PATCH need the record visible and updatable', async () => {
    state.visible = false
    const del = '/field-translations/workflows/372786/objective'
    expect((await app.inject({ method: 'DELETE', url: del })).statusCode).toBe(404)
    expect(
      (await app.inject({ method: 'PATCH', url: '/attributes/workflows/372786', payload: {} }))
        .statusCode
    ).toBe(404)
    state.visible = true
    state.updatable = false
    expect((await app.inject({ method: 'DELETE', url: del })).statusCode).toBe(403)
    expect(
      (await app.inject({ method: 'PATCH', url: '/attributes/workflows/372786', payload: {} }))
        .statusCode
    ).toBe(403)
    state.updatable = true
    expect((await app.inject({ method: 'DELETE', url: del })).statusCode).toBe(204)
  })

  it('a self field watch needs the record visible', async () => {
    state.visible = false
    const res = await app.inject({
      method: 'POST',
      url: '/field-watches/self',
      payload: { collection: 'workflows', field: 'objective', item_id: '372786' }
    })
    expect(res.statusCode).toBe(404)
  })
})
