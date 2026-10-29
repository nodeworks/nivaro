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
  const db = Object.assign((table: string) => chain(table), {
    schema: { hasTable: async (t: string) => Object.hasOwn(tables, t) }
  })
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

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Row
) {
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
    const { logActivity } = await import('../../../services/activity.js')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        collection: 'nivaro_layout_templates',
        item: String(id),
        comment: 'name'
      })
    )
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

describe('linked sections (#3194)', () => {
  const ROOT = 'lib70_00aa11bb'
  /** Layout `id` with the Address section placed as linked (`fields` in it). */
  const linkedForm = (id: number, fields: string[], key = ROOT) => ({
    layout: { id, collection: 'orders', layout_type: 'grouped', name: `Form ${id}` },
    groups: [
      { ...newGroup(key, 'Address', 'section', null), sort: 0, icon: 'home' },
      ungroupedGroup(1)
    ],
    placements: fields.map((f, i) => ({ ...newPlacement(f, key), sort: i })),
    rev: `rev-${id}`
  })

  async function librarySection() {
    fake.tables.nivaro_layout_section_links = []
    const saved = await call('POST', '/templates', {
      kind: 'section',
      name: 'Address',
      layout_id: 22,
      group_key: 'address'
    })
    return saved.body.data.id as number
  }

  it('plans a linked drop with a root key of its own', async () => {
    const tid = await librarySection()
    const plan = await call('POST', '/blocks/plan', {
      source: { template_id: tid },
      target_collection: 'orders',
      target_bundle: sparing,
      linked: true
    })
    expect(plan.status).toBe(200)
    expect(plan.body.linked_key).toMatch(new RegExp(`^lib${tid}_[a-f0-9]{8}$`))
    expect(plan.body.ops[0]).toMatchObject({ op: 'group_create', key: plan.body.linked_key })
    // Only a library section can be linked.
    const bad = await call('POST', '/blocks/plan', {
      source: { layout_id: 22, group_key: 'address' },
      target_collection: 'orders',
      target_bundle: sparing,
      linked: true
    })
    expect(bad.status).toBe(400)
  })

  it('links a drop, confirms it once saved, and reads it as in sync', async () => {
    const tid = await librarySection()
    const key = `lib${tid}_00aa11bb`
    const made = await call('POST', '/24/section-links', { template_id: tid, group_key: key })
    expect(made.status).toBe(201)
    expect(
      (await call('POST', '/24/section-links', { template_id: tid, group_key: key })).status
    ).toBe(409)
    expect(
      (await call('POST', '/24/section-links', { template_id: tid, group_key: 'address' })).status
    ).toBe(400)

    // Still only in the editor's draft: pending.
    let list = await call('GET', '/24/section-links')
    expect(list.body.data).toEqual([
      expect.objectContaining({ group_key: key, confirmed: false, in_sync: null, linked_forms: 1 })
    ])

    // Saved: confirmed, and the copy matches the library.
    const saved = linkedForm(24, ['street', 'city'], key)
    ops.bundles.set(24, saved)
    list = await call('GET', '/24/section-links')
    expect(list.body.data[0]).toMatchObject({ confirmed: true, in_sync: true })

    // Edited on the form some other way: it differs.
    ops.bundles.set(24, { ...saved, placements: saved.placements.slice(0, 1) })
    list = await call('GET', '/24/section-links')
    expect(list.body.data[0].in_sync).toBe(false)

    // The plan puts the library version back.
    const plan = await call('POST', `/24/section-links/${key}/plan`, {})
    expect(plan.status).toBe(200)
    expect(plan.body.ops.map((o: Row) => o.op)).toEqual([
      'group_remove',
      'group_create',
      'place',
      'place'
    ])
  })

  it('a confirmed link whose section left the form is dropped', async () => {
    const tid = await librarySection()
    fake.tables.nivaro_layout_section_links.push({
      id: 900,
      template_id: tid,
      layout_id: 24,
      group_key: ROOT,
      field_map: null,
      created_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString()
    })
    const list = await call('GET', '/24/section-links')
    expect(list.body.data).toEqual([])
    expect(fake.tables.nivaro_layout_section_links).toEqual([])
  })

  it('publishes the saved copy to the library and every other linked form', async () => {
    const tid = await librarySection()
    const at = (id: number) => ({
      id: id * 10,
      template_id: tid,
      layout_id: id,
      group_key: ROOT,
      field_map: null,
      created_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString()
    })
    fake.tables.nivaro_fields.push({ collection: 'orders', field: 'zip' })
    ops.bundles.set(24, linkedForm(24, ['street', 'city', 'zip']))
    ops.bundles.set(25, linkedForm(25, ['street', 'city']))
    ops.bundles.set(26, linkedForm(26, ['street', 'city']))
    fake.tables.nivaro_layout_section_links.push(at(24), at(25), at(26))
    ops.run.mockImplementation(async (id: number) =>
      id === 26
        ? { status: 400, error: 'Frozen', freeze: { until: 'x', reason: 'y' } }
        : { status: 200, bundle: ops.bundles.get(id), changed: true }
    )

    const res = await call('PUT', `/templates/${tid}/content`, { layout_id: 24, group_key: ROOT })
    expect(res.status).toBe(200)
    expect(res.body.data.updated.map((o: Row) => o.layout_id)).toEqual([25])
    expect(res.body.data.skipped).toEqual([
      expect.objectContaining({ layout_id: 26, reason: 'the form is frozen' })
    ])
    // The library now holds the edited copy, under its own root key.
    const stored = JSON.parse(String(fake.tables.nivaro_layout_templates[0].payload))
    expect(stored.top).toEqual([{ group: 'address' }])
    expect(stored.placements.map((p: Row) => p.field)).toEqual(['street', 'city', 'zip'])
    // Form 25 got the change through the ops service, with a reason for its History.
    const call25 = ops.run.mock.calls.find(([id]) => id === 25)
    const input = call25?.[1] as { base_rev: string; reason: string; ops: Row[] }
    expect(input.base_rev).toBe('rev-25')
    expect(input.reason).toMatch(/Linked section "Address" updated in the library/)
    expect(input.ops.filter((o) => o.op === 'place').map((o) => o.field)).toEqual([
      'street',
      'city',
      'zip'
    ])
    // Publishing needs the section linked to that library section.
    expect(
      (await call('PUT', `/templates/${tid}/content`, { layout_id: 22, group_key: 'address' }))
        .status
    ).toBe(400)
  })

  it('unlinks, and deleting the library section unlinks every form', async () => {
    const tid = await librarySection()
    fake.tables.nivaro_layout_section_links.push(
      { id: 1, template_id: tid, layout_id: 24, group_key: ROOT },
      { id: 2, template_id: tid, layout_id: 25, group_key: ROOT }
    )
    expect((await call('DELETE', `/24/section-links/${ROOT}`)).status).toBe(204)
    expect(fake.tables.nivaro_layout_section_links.map((r) => r.id)).toEqual([2])
    expect((await call('DELETE', `/24/section-links/${ROOT}`)).status).toBe(404)
    const list = await call('GET', '/templates?kind=section')
    expect(list.body.data[0].linked_forms).toBe(1)
    expect((await call('DELETE', `/templates/${tid}`)).status).toBe(204)
    expect(fake.tables.nivaro_layout_section_links).toEqual([])
  })
})
