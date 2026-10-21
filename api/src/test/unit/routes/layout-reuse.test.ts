import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Route harness for templates / section library / copy a section (#2584/#2594/
// #2606): a loose knex stand-in (object .where() filters only), and the ops
// service's bundle read + ops run mocked — the pure planning is real.

type Row = Record<string, unknown>

const fake = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {}
  let nextId = 70
  const chain = (table: string) => {
    const filters: Row[] = []
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every((f) => Object.entries(f).every(([k, v]) => String(r[k]) === String(v)))
      )
    const q: Record<string, unknown> = {}
    for (const m of ['orderBy', 'select']) q[m] = () => q
    q.where = (f: unknown) => {
      if (f && typeof f === 'object') filters.push(f as Row)
      return q
    }
    q.first = async () => rows().at(-1)
    q.insert = async (data: Row) => {
      const row = { id: nextId++, ...data }
      tables[table] = [...(tables[table] ?? []), row]
      return [row.id]
    }
    q.update = async (patch: Row) => {
      for (const r of rows()) Object.assign(r, patch)
      return 1
    }
    q.delete = async () => {
      const gone = new Set(rows())
      tables[table] = (tables[table] ?? []).filter((r) => !gone.has(r))
      return gone.size
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    q.then = (ok: (r: Row[]) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, fail)
    return q
  }
  const db = (table: string) => chain(table)
  const reset = (seed: Record<string, Row[]>) => {
    for (const k of Object.keys(tables)) delete tables[k]
    Object.assign(tables, JSON.parse(JSON.stringify(seed)))
    nextId = 70
  }
  return { db, tables, reset }
})

const ops = vi.hoisted(() => ({
  bundles: new Map<number, unknown>(),
  run: vi.fn()
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-admin' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: fake.db }))
vi.mock('../../../services/layout-ops.js', async () => {
  const pure = await import('../../../services/layout-ops-apply.js')
  return {
    ...pure,
    loadLayoutBundle: vi.fn(async (_q: unknown, id: number) => {
      const b = ops.bundles.get(id)
      return b ? JSON.parse(JSON.stringify(b)) : null
    }),
    runLayoutOps: ops.run
  }
})

import {
  applyTemplateToNewLayout,
  layoutReuseRoutes,
  loadFormTemplate
} from '../../../routes/layout-reuse.js'
import { newGroup, newPlacement, ungroupedGroup } from '../../../services/layout-ops-apply.js'

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Row) {
  const app = Fastify({ logger: false })
  app.register(layoutReuseRoutes, { prefix: '/collection-layouts' })
  await app.ready()
  const res = await app.inject({ method, url: `/collection-layouts${url}`, payload })
  await app.close()
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

const sparing = {
  layout: { id: 24, collection: 'orders', layout_type: 'grouped', name: 'Sparing' },
  groups: [ungroupedGroup(1)],
  placements: [],
  rev: 'rev-24'
}
const unit = {
  layout: { id: 22, collection: 'orders', layout_type: 'grouped', name: 'Unit' },
  groups: [
    { ...newGroup('address', 'Address', 'section', null), sort: 0, icon: 'home' },
    ungroupedGroup(1)
  ],
  placements: [
    { ...newPlacement('street', 'address'), sort: 0 },
    { ...newPlacement('city', 'address'), sort: 1 }
  ],
  rev: 'rev-22'
}

beforeEach(() => {
  fake.reset({
    nivaro_layout_templates: [],
    nivaro_fields: [
      { collection: 'orders', field: 'street' },
      { collection: 'orders', field: 'city' },
      { collection: 'sites', field: 'line1' },
      { collection: 'sites', field: 'city' }
    ]
  })
  ops.bundles.clear()
  ops.bundles.set(22, unit)
  ops.bundles.set(24, sparing)
  ops.run.mockReset()
  ops.run.mockImplementation(async () => ({ status: 200, bundle: sparing, changed: true }))
})

describe('section library + templates', () => {
  it('saves a section by field name and lists it with its fields', async () => {
    const saved = await call('POST', '/templates', {
      kind: 'section',
      name: 'Address block',
      layout_id: 22,
      group_key: 'address'
    })
    expect(saved.status).toBe(201)
    expect(saved.body.data).toMatchObject({
      kind: 'section',
      name: 'Address block',
      source_collection: 'orders',
      fields: ['street', 'city']
    })
    const stored = JSON.parse(String(fake.tables.nivaro_layout_templates[0].payload))
    expect(stored.groups[0]).toMatchObject({ key: 'address', label: 'Address' })
    expect(JSON.stringify(stored)).not.toContain('"id"')

    const list = await call('GET', '/templates?kind=section')
    expect(list.body.data.map((t: Row) => t.name)).toEqual(['Address block'])
  })

  it('saves what the editor shows when it posts its bundle', async () => {
    const shown = {
      ...unit,
      placements: [...unit.placements, { ...newPlacement('zip', 'address'), sort: 2 }]
    }
    const saved = await call('POST', '/templates', {
      kind: 'section',
      name: 'With zip',
      layout_id: 22,
      group_key: 'address',
      bundle: shown
    })
    expect(saved.body.data.fields).toEqual(['street', 'city', 'zip'])
  })

  it('refuses a bad kind, a missing name and an unknown section', async () => {
    expect((await call('POST', '/templates', { kind: 'x', name: 'a' })).status).toBe(400)
    expect(
      (await call('POST', '/templates', { kind: 'form', name: ' ', layout_id: 22 })).status
    ).toBe(400)
    expect(
      (
        await call('POST', '/templates', {
          kind: 'section',
          name: 'a',
          layout_id: 22,
          group_key: 'nope'
        })
      ).status
    ).toBe(400)
  })

  it('renames and deletes a template', async () => {
    const saved = await call('POST', '/templates', { kind: 'form', name: 'Starter', layout_id: 22 })
    const id = saved.body.data.id
    const renamed = await call('PATCH', `/templates/${id}`, { name: 'Starter form' })
    expect(renamed.body.data.name).toBe('Starter form')
    expect((await call('DELETE', `/templates/${id}`)).status).toBe(204)
    expect(fake.tables.nivaro_layout_templates).toEqual([])
  })

  it('plans a library drop on another collection, mapping fields', async () => {
    const saved = await call('POST', '/templates', {
      kind: 'section',
      name: 'Address block',
      layout_id: 22,
      group_key: 'address'
    })
    const plan = await call('POST', '/blocks/plan', {
      source: { template_id: saved.body.data.id },
      target_collection: 'sites',
      target_bundle: { layout: { layout_type: 'grouped' }, groups: [], placements: [] },
      field_map: { street: 'line1' }
    })
    expect(plan.status).toBe(200)
    expect(plan.body.unmapped).toEqual([])
    expect(plan.body.ops.filter((o: Row) => o.op === 'place').map((o: Row) => o.field)).toEqual([
      'line1',
      'city'
    ])

    const skip = await call('POST', '/blocks/plan', {
      source: { template_id: saved.body.data.id },
      target_collection: 'sites',
      target_bundle: { layout: {}, groups: [], placements: [] }
    })
    expect(skip.body.unmapped).toEqual(['street'])
  })
})

describe('POST /:id/copy-section', () => {
  it('copies a section onto another layout through its ops, at its current rev', async () => {
    const res = await call('POST', '/24/copy-section', {
      source_layout_id: 22,
      group_key: 'address'
    })
    expect(res.status).toBe(200)
    expect(res.body.group_key).toBe('address')
    const [layoutId, input] = ops.run.mock.calls[0]
    expect(layoutId).toBe(24)
    expect(input.base_rev).toBe('rev-24')
    expect(input.ops.map((o: Row) => o.op)).toEqual(['group_create', 'place', 'place'])
  })

  it('retries once when another save lands in between', async () => {
    ops.run
      .mockImplementationOnce(async () => ({ status: 409, bundle: sparing }))
      .mockImplementationOnce(async () => ({ status: 200, bundle: sparing, changed: true }))
    const res = await call('POST', '/24/copy-section', {
      source_layout_id: 22,
      group_key: 'address'
    })
    expect(res.status).toBe(200)
    expect(ops.run).toHaveBeenCalledTimes(2)
  })

  it('needs a section and a real target', async () => {
    expect((await call('POST', '/24/copy-section', { source_layout_id: 22 })).status).toBe(400)
    expect(
      (await call('POST', '/99/copy-section', { source_layout_id: 22, group_key: 'address' }))
        .status
    ).toBe(404)
  })
})

describe('a new layout from a form template', () => {
  it('lands the whole form through the ops service, with its behaviour settings', async () => {
    ops.bundles.set(22, { ...unit, layout: { ...unit.layout, tab_mode: 'steps' } })
    const saved = await call('POST', '/templates', { kind: 'form', name: 'Starter', layout_id: 22 })
    const tpl = await loadFormTemplate(saved.body.data.id)
    expect(tpl?.layout_type).toBe('grouped')
    ops.bundles.set(40, { ...sparing, layout: { id: 40, collection: 'sites' }, rev: 'rev-40' })
    const res = await applyTemplateToNewLayout(
      { id: 40, collection: 'sites' },
      tpl!,
      { street: 'line1' },
      'test-admin'
    )
    expect(res).toEqual({ unmapped: [], dropped: [], already: [] })
    const [, input] = ops.run.mock.calls[0]
    expect(input.base_rev).toBe('rev-40')
    expect(input.ops.at(-1)).toEqual({ op: 'layout_update', patch: { tab_mode: 'steps' } })
    expect(input.ops.filter((o: Row) => o.op === 'place').map((o: Row) => o.field)).toEqual([
      'line1',
      'city'
    ])
  })

  it('a section is not a form template', async () => {
    const saved = await call('POST', '/templates', {
      kind: 'section',
      name: 'Address',
      layout_id: 22,
      group_key: 'address'
    })
    expect(await loadFormTemplate(saved.body.data.id)).toBeNull()
  })
})
