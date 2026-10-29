// The MCP form tools' routes (#3216–#3218): reads (markConfigRead), a role
// preview only for administrators (a non-admin never learns role names), the
// render's refusal passed through with its code, and the stored-layout lint.
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ isAdmin: false }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: any) => {
    req.user = { id: 'U1', role: 'R-CLERK' }
    req.isAdmin = state.isAdmin
  }),
  requireAdmin: vi.fn(async (req: any, reply: any) => {
    req.user = { id: 'U1', role: 'R-ADMIN' }
    req.isAdmin = state.isAdmin
    if (!state.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
  })
}))
const markConfigRead = vi.hoisted(() => vi.fn())
vi.mock('../../../services/config-live.js', () => ({ markConfigRead }))
const findRole = vi.hoisted(() =>
  vi.fn(async (r: string) => ({ id: 'R-FIN', name: r, admin: false }))
)
vi.mock('../../../services/ai-design/layout-explain-field.js', () => ({
  findRole,
  LayoutAssistError: class extends Error {
    statusCode = 404
  }
}))
const computeFormState = vi.hoisted(() =>
  vi.fn(async (_u: unknown, _a: boolean, opts: Record<string, unknown>) => ({
    collection: opts.collection,
    record: opts.item,
    as: { role: 'Clerk', admin: false, preview: false },
    layout: { id: 5, name: 'Default', why: null },
    can_update: true,
    derived: {},
    groups: [],
    fields: [],
    summary: { visible: 0, hidden: 0, required: [], locked: [], missing: [] },
    _facts: { secret: true },
    _values: { secret: 'x' },
    _principal: {},
    _rows: [],
    _groups: []
  }))
)
vi.mock('../../../services/form-state.js', async () => {
  const real = await vi.importActual<typeof import('../../../services/form-state.js')>(
    '../../../services/form-state.js'
  )
  return { ...real, computeFormState }
})
const renderFormImage = vi.hoisted(() =>
  vi.fn(async () => ({
    png: Buffer.from('PNGDATA'),
    width: 1100,
    state: {
      collection: 'orders',
      record: '7',
      as: { role: null, admin: false, preview: false },
      layout: null,
      can_update: true,
      summary: { visible: 1, hidden: 0, required: [], locked: [], missing: [] }
    }
  }))
)
vi.mock('../../../services/form-image.js', () => ({ renderFormImage }))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: vi.fn(async (_who: string, fn: () => Promise<unknown>) => fn())
}))
const facts = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../../../services/ai-design/layout-facts.js', () => ({
  loadLayoutFacts: vi.fn(async () => facts.value),
  fieldLabel: (_f: unknown, field: string) => field.toUpperCase(),
  groupName: (_b: unknown, key: string | null) => `[${key}]`
}))

import { formToolsRoutes } from '../../../routes/form-tools.js'

let app: FastifyInstance
beforeEach(async () => {
  state.isAdmin = false
  facts.value = null
  vi.clearAllMocks()
  app = Fastify()
  await app.register(formToolsRoutes, { prefix: '/api/collection-layouts' })
  await app.ready()
})

describe('POST /collection-layouts/form-state', () => {
  it('answers the public state as a read, private loader fields stripped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/collection-layouts/form-state',
      payload: { collection: 'orders', item: 7, values: { a: 1 }, viewport: 'phone' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.collection).toBe('orders')
    expect(body._facts).toBeUndefined()
    expect(body._values).toBeUndefined()
    expect(markConfigRead).toHaveBeenCalled()
    expect(computeFormState.mock.calls[0]?.[2]).toMatchObject({
      collection: 'orders',
      item: '7',
      values: { a: 1 },
      viewport: 'phone',
      role: null
    })
  })

  it('refuses a role preview to a non-admin without looking the role up', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/collection-layouts/form-state',
      payload: { collection: 'orders', role: 'Fin' }
    })
    expect(res.statusCode).toBe(403)
    expect(findRole).not.toHaveBeenCalled()
    expect(computeFormState).not.toHaveBeenCalled()
  })

  it('an administrator may preview as a role', async () => {
    state.isAdmin = true
    const res = await app.inject({
      method: 'POST',
      url: '/api/collection-layouts/form-state',
      payload: { collection: 'orders', role: 'Finance' }
    })
    expect(res.statusCode).toBe(200)
    expect(findRole).toHaveBeenCalledWith('Finance')
    expect(computeFormState.mock.calls[0]?.[2]).toMatchObject({ role: { id: 'R-FIN' } })
  })
})

describe('POST /collection-layouts/render-form', () => {
  it('answers the PNG as base64 with the summary', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/collection-layouts/render-form',
      payload: { collection: 'orders', item: '7', theme: 'dark', show_hidden: true }
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(Buffer.from(d.base64, 'base64').toString()).toBe('PNGDATA')
    expect(d).toMatchObject({ mime: 'image/png', width: 1100, bytes: 7, collection: 'orders' })
    expect((renderFormImage.mock.calls[0] as unknown[] | undefined)?.[2]).toMatchObject({
      theme: 'dark',
      showHidden: true
    })
    expect(markConfigRead).toHaveBeenCalled()
  })

  it('passes a render refusal through with its code', async () => {
    renderFormImage.mockRejectedValueOnce(
      Object.assign(new Error('This server cannot make PDFs'), {
        statusCode: 503,
        code: 'RENDER_UNAVAILABLE'
      })
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/collection-layouts/render-form',
      payload: { collection: 'orders' }
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'RENDER_UNAVAILABLE' })
  })
})

describe('GET /collection-layouts/:id/lint', () => {
  it('is for administrators', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/collection-layouts/5/lint' })
    expect(res.statusCode).toBe(403)
  })

  it('404s an unknown layout', async () => {
    state.isAdmin = true
    const res = await app.inject({ method: 'GET', url: '/api/collection-layouts/5/lint' })
    expect(res.statusCode).toBe(404)
  })

  it('lints the saved layout with the editor rules', async () => {
    state.isAdmin = true
    facts.value = {
      bundle: {
        layout: { id: 5, name: 'Default', collection: 'orders', layout_type: 'grouped' },
        groups: [{ key: 'empty', parent_key: null, sort: 1, label: 'Empty', type: 'section' }],
        placements: [],
        rev: 'r'
      },
      parent: null,
      ctx: { fields: [], roles: [], requirements: [] }
    }
    const res = await app.inject({ method: 'GET', url: '/api/collection-layouts/5/lint' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.layout).toEqual({ id: 5, name: 'Default', collection: 'orders' })
    expect(typeof d.score).toBe('number')
    expect(d.findings.some((f: { rule: string }) => f.rule === 'empty-section')).toBe(true)
    expect(d.findings[0].where).toBe('[empty]')
  })
})
