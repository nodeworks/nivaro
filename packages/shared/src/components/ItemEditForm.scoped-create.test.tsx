// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm, UNAVAILABLE_OPTION_ERROR } from './ItemEditForm'
import type { CMSField, CMSRelation } from './item-edit/types'

// 2026-10-23, staging: a Zone-scoped user (Zones 1–3) created workflows from
// the new-record form. The form POSTed the record WITHOUT his Zone / Region /
// Sub-type picks (they waited for an "Update relationships" step after the
// create); a workflow with no Zone is outside his view, so the create's own
// read-back answered data null, `String(r.data.id)` threw "Cannot read
// properties of null (reading 'id')", the links step never ran — and his
// retry made a duplicate. Funding year alone landed: the server copied it
// from the project inside the create.
//
// Now every staged relation rides in the record's own write, a hidden
// read-back answers data {id} + meta {readable:false, reason}, and the form
// treats the create as done either way. The server here is a small stand-in
// for the items service: it stores what the body carried and judges the
// caller's Zone scope on the result.

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  message: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: Object.assign((..._a: unknown[]) => undefined, toasts),
  Toaster: () => null
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function field(name: string, label: string, over: Partial<CMSField> = {}): CMSField {
  return {
    field: name,
    type: 'string',
    interface: 'input',
    label,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: 'main',
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    layout_assigned: true,
    ...over
  }
}

let relId = 1
const r = (x: Partial<CMSRelation>): CMSRelation =>
  ({
    id: relId++,
    many_collection: null,
    many_field: null,
    one_collection: null,
    one_field: null,
    junction_field: null,
    ...x
  }) as CMSRelation

/** M2M alias `field` on `coll` through `<coll>_<field>` to `target`. */
function m2m(coll: string, fieldName: string, target: string, relatedFk: string): CMSRelation[] {
  const junction = `${coll}_${fieldName}`
  return [
    r({
      many_collection: junction,
      many_field: `${coll}_id`,
      one_collection: coll,
      one_field: fieldName,
      junction_field: relatedFk
    }),
    r({
      many_collection: junction,
      many_field: relatedFk,
      one_collection: target,
      junction_field: `${coll}_id`
    })
  ]
}

const m2mField = (name: string, label: string, over: Partial<CMSField> = {}) =>
  field(name, label, {
    type: 'alias',
    interface: 'select-multiple-m2m',
    options: JSON.stringify({ max_values: 1 }),
    ...over
  })

// ── Collection shapes ──────────────────────────────────────────────────────

interface Shape {
  name: string
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
  /** Junction / child collections a follow-up step would POST to. */
  followUps: string[]
  /** The scope rule: which created bodies a Zone 1–3 user can read back. */
  visibleToScoped: (body: Record<string, unknown>) => boolean
  /** Reason the stand-in server gives when hidden. */
  reason: string
}

const WORKFLOWS: Shape = {
  name: 'M2M-scoped (workflows: Zone = divisions)',
  collection: 'workflows',
  fields: [
    field('project', 'Project', {
      interface: 'relation-m2o',
      required: true,
      // As on EFP: picking a project fills its parents upstream (fill-only-empty).
      dependency_config: JSON.stringify({
        cascade_filters: [
          {
            parent_field: 'divisions',
            filter_column: 'divisions',
            filter_is_m2m: true,
            upstream: true
          },
          {
            parent_field: 'funding_years',
            filter_column: 'funding_years',
            filter_is_m2m: true,
            upstream: true
          }
        ]
      })
    }),
    m2mField('funding_years', 'Funding years', {
      required: true,
      options: JSON.stringify({ max_values: null })
    }),
    m2mField('divisions', 'Zone', { required: true }),
    m2mField('regions', 'Region', { required: true }),
    m2mField('project_sub_types', 'Sub-type', { required: true }),
    field('contacts', 'Contacts', { type: 'alias', interface: 'list-m2a' }),
    field('lines', 'Lines', { type: 'alias', interface: 'list-o2m' })
  ],
  relations: [
    r({ many_collection: 'workflows', many_field: 'project', one_collection: 'projects' }),
    ...m2m('workflows', 'funding_years', 'funding_years', 'funding_years_year'),
    ...m2m('workflows', 'divisions', 'divisions', 'divisions_id'),
    ...m2m('workflows', 'regions', 'regions', 'regions_id'),
    ...m2m('workflows', 'project_sub_types', 'project_sub_types', 'project_sub_types_id'),
    r({
      many_collection: 'workflows_contacts',
      many_field: 'workflows_id',
      one_collection: 'workflows',
      one_field: 'contacts',
      junction_field: 'item'
    }),
    {
      ...r({
        many_collection: 'workflows_contacts',
        many_field: 'item',
        junction_field: 'workflows_id'
      }),
      one_allowed_collections: 'nivaro_users',
      one_collection_field: 'collection'
    } as CMSRelation,
    r({
      many_collection: 'workflow_lines',
      many_field: 'workflow',
      one_collection: 'workflows',
      one_field: 'lines'
    })
  ],
  followUps: [
    'workflows_funding_years',
    'workflows_divisions',
    'workflows_regions',
    'workflows_project_sub_types',
    'workflows_contacts',
    'workflow_lines'
  ],
  visibleToScoped: (b) =>
    Array.isArray(b.divisions) && b.divisions.some((d) => ['1', '2', '3'].includes(String(d))),
  reason: 'no Zone set'
}

const UNITS: Shape = {
  name: 'M2O-scoped (units: Zone = zone)',
  collection: 'units',
  fields: [field('zone', 'Zone', { interface: 'relation-m2o', required: true })],
  relations: [r({ many_collection: 'units', many_field: 'zone', one_collection: 'divisions' })],
  followUps: [],
  visibleToScoped: (b) => ['1', '2', '3'].includes(String(b.zone)),
  reason: 'its Zone (Zone 4) is not one of yours'
}

const NOTES: Shape = {
  name: 'no scopes (notes)',
  collection: 'notes',
  fields: [field('title', 'Title', { required: true })],
  relations: [],
  followUps: [],
  visibleToScoped: () => true,
  reason: ''
}

// ── Stand-in server ────────────────────────────────────────────────────────

type Cmd = {
  _method?: string
  _path: string
  _body?: Record<string, unknown>
  _params?: Record<string, unknown>
}

interface ServerOpts {
  shape: Shape
  scoped: boolean
  /** An API from before the fix: a hidden create answers data null, no meta. */
  oldServer?: boolean
  existing?: Record<string, unknown>
  /** Collections whose availability probes say the picked value is no longer
   *  an option (a location outside the Region picked after it). */
  unavailable?: string[]
}

function makeServer(o: ServerOpts) {
  const calls: Cmd[] = []
  const created: Array<Record<string, unknown>> = []
  let nextId = 372777
  const layoutFields = o.shape.fields.map((f) => f.field)
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: {
              id: 2,
              name: 'Default',
              slug: 'default',
              quick_picker: layoutFields.filter((f) => f !== 'contacts' && f !== 'lines')
            },
            groups: [{ id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0 }],
            assignments: layoutFields.map((f, i) => ({
              field: f,
              sort: i + 1,
              group_key: 'main',
              is_visible: true
            })),
            ungrouped_sort: 99
          }
        }
      if (p === `/field-config/${o.shape.collection}`) return { data: o.shape.fields }
      if (p === `/collections/${o.shape.collection}`)
        return { data: { display_name: o.shape.collection, singular: 'Workflow' } }
      if (p === `/data-model/relations/for/${o.shape.collection}`)
        return { data: o.shape.relations }
      if (p === '/data-model/relations/for/projects')
        return {
          data: [
            r({
              many_collection: 'project_divisions_junction',
              many_field: 'project',
              one_collection: 'projects',
              one_field: 'divisions',
              junction_field: 'division'
            }),
            r({
              many_collection: 'project_funding_years_junction',
              many_field: 'project',
              one_collection: 'projects',
              one_field: 'funding_years',
              junction_field: 'funding_year'
            })
          ]
        }
      // Project 8170's shape on staging: 3 Zones, 1 funding year.
      if (p === '/items/project_divisions_junction')
        return { data: [1, 2, 3].map((d) => ({ id: d, division: d })) }
      if (p === '/items/project_funding_years_junction')
        return { data: [{ id: 1, funding_year: 2027 }] }
      if (p === '/items/batch-read') return { data: [] }
      if (method === 'POST' && p === `/items/${o.shape.collection}`) {
        const body = cmd._body ?? {}
        const id = nextId++
        created.push({ id, ...body })
        const visible = !o.scoped || o.shape.visibleToScoped(body)
        if (visible) return { data: { id, ...body } }
        if (o.oldServer) return { data: null }
        return { data: { id }, meta: { id, readable: false, reason: o.shape.reason } }
      }
      if (method === 'PATCH' && p.startsWith(`/items/${o.shape.collection}/`)) {
        const body = cmd._body ?? {}
        const merged = { ...(o.existing ?? {}), ...body }
        const visible = !o.scoped || o.shape.visibleToScoped(merged)
        const id = o.existing?.id
        if (visible) return { data: merged }
        return { data: { id }, meta: { id, readable: false, reason: o.shape.reason } }
      }
      if (p === `/items/${o.shape.collection}/${String(o.existing?.id)}`)
        return { data: o.existing ?? null }
      if (method !== 'GET') return { data: null }
      // A picker's availability probe (its value AND its filter, limit 1): the
      // picked value is still an option. Answering [] here would flag every
      // pick "not an available option", which now blocks the save.
      const params = cmd._params
      if (
        params?.picker === '1' &&
        params.limit === 1 &&
        typeof params.filter === 'string' &&
        !o.unavailable?.some((x) => p === `/items/${x}`)
      ) {
        const hit = /"id":\{"_eq":"?([^"}]+)"?\}/.exec(params.filter)
        if (hit) return { data: [{ id: hit[1] }] }
      }
      return { data: [] }
    })
  }
  return { client, calls, created }
}

// ── Harness ────────────────────────────────────────────────────────────────

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false
})) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => {}
g.CSS ??= { escape: (v: string) => v }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  for (const f of Object.values(toasts)) f.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean, rounds = 120) {
  for (let i = 0; i < rounds && !until(); i++) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 10))
    })
  }
}

async function mount(
  o: ServerOpts & {
    itemId?: string
    initialValues?: Record<string, unknown>
    initialLinks?: Record<string, unknown[]>
    initialRows?: Record<string, Array<Record<string, unknown>>>
  }
) {
  const srv = makeServer(o)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSaved = vi.fn()
  let save: (() => void) | null = null
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={srv.client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'BERNARD' }}>
            <ItemEditForm
              collection={o.shape.collection}
              itemId={o.itemId}
              documentTitle={false}
              initialValues={o.initialValues}
              initialLinks={o.initialLinks}
              initialRows={o.initialRows}
              onSaved={onSaved}
              registerSaveHandler={(fn) => {
                save = fn
              }}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => host.querySelectorAll('[data-field]').length >= o.shape.fields.length - 2)
  await settle(() => save != null)
  return { ...srv, onSaved, save: () => act(async () => save?.()) }
}

const writesTo = (calls: Cmd[], collections: string[]) =>
  calls.filter(
    (c) =>
      (c._method ?? 'GET').toUpperCase() === 'POST' &&
      collections.some((x) => c._path === `/items/${x}`)
  )

// ── Tests ──────────────────────────────────────────────────────────────────

describe('new workflow — the 8170 case (3 Zones on the project, one picked)', () => {
  for (const scoped of [true, false]) {
    it(`${scoped ? 'Zone-scoped' : 'unscoped'} user: every pick lands in the create itself`, async () => {
      const m = await mount({
        shape: WORKFLOWS,
        scoped,
        // The project pick runs the upstream cascade: the project's one funding
        // year fills in; its three Zones are ambiguous for a one-Zone field, so
        // the person picks Zone / Region / Sub-type themselves.
        initialValues: { project: 8170 },
        initialLinks: { divisions: ['2'], regions: ['14'], project_sub_types: ['S1'] },
        initialRows: { 'workflow_lines.workflow': [{ qty: 3, description: 'Fiber' }] }
      })
      // Wait for the cascade's funding-year fill.
      await settle(() => m.calls.some((c) => c._path === '/items/project_funding_years_junction'))
      await settle(() => false, 10)
      await m.save()
      await settle(() => m.onSaved.mock.calls.length > 0, 250)

      expect(m.created).toHaveLength(1)
      const body = m.created[0]
      expect(body.project).toBe(8170)
      expect(body.divisions).toEqual(['2'])
      expect(body.regions).toEqual(['14'])
      expect(body.project_sub_types).toEqual(['S1'])
      expect(body.funding_years).toEqual(['2027'])
      expect(body.lines).toEqual([{ qty: 3, description: 'Fiber' }])
      // Nothing waits for a step after the create.
      expect(writesTo(m.calls, WORKFLOWS.followUps)).toHaveLength(0)
      expect(m.onSaved).toHaveBeenCalledWith('372777')
      expect(toasts.success).toHaveBeenCalledWith('Record created')
      expect(toasts.error).not.toHaveBeenCalled()
    })
  }

  it('a required Zone left empty blocks the save — nothing is created', async () => {
    const m = await mount({
      shape: WORKFLOWS,
      scoped: true,
      initialValues: { project: 8170 },
      initialLinks: { regions: ['14'], project_sub_types: ['S1'], funding_years: ['2027'] }
    })
    await settle(() => false, 15)
    await m.save()
    await settle(() => false, 15)
    expect(m.created).toHaveLength(0)
    expect(toasts.error).toHaveBeenCalledWith('Zone is required')
  })

  it('a pick its own picker flags "not an available option" blocks the save', async () => {
    const m = await mount({
      shape: WORKFLOWS,
      scoped: false,
      unavailable: ['projects'],
      initialValues: { project: 8170 },
      initialLinks: { divisions: ['2'], regions: ['14'], project_sub_types: ['S1'] },
      initialRows: { 'workflow_lines.workflow': [{ qty: 3, description: 'Fiber' }] }
    })
    await settle(() => m.calls.some((c) => c._path === '/items/project_funding_years_junction'))
    await settle(() => false, 10)
    await m.save()
    await settle(() => false, 15)
    expect(m.created).toHaveLength(0)
    expect(toasts.error).toHaveBeenCalledWith(UNAVAILABLE_OPTION_ERROR)
  })
})

describe('a create the creator cannot read back', () => {
  it('Zone outside the scope: told plainly, the create is done, no crash, no second POST', async () => {
    const m = await mount({
      shape: WORKFLOWS,
      scoped: true,
      initialValues: { project: 8170 },
      initialLinks: {
        divisions: ['4'],
        regions: ['14'],
        project_sub_types: ['S1'],
        funding_years: ['2027']
      }
    })
    await settle(() => false, 15)
    await m.save()
    await settle(() => m.onSaved.mock.calls.length > 0, 250)
    expect(m.created).toHaveLength(1)
    expect(m.onSaved).toHaveBeenCalledWith('372777')
    expect(toasts.warning).toHaveBeenCalledWith(
      'Workflow 372777 was created, but it’s outside what you can see (no Zone set).',
      expect.anything()
    )
    expect(host.textContent ?? '').not.toMatch(/Cannot read properties/)
  })

  it('an older server answering data null: a plain note replaces the form — no Save to press twice', async () => {
    const m = await mount({
      shape: WORKFLOWS,
      scoped: true,
      oldServer: true,
      initialValues: { project: 8170 },
      initialLinks: {
        divisions: ['4'],
        regions: ['14'],
        project_sub_types: ['S1'],
        funding_years: ['2027']
      }
    })
    await settle(() => false, 15)
    await m.save()
    await settle(() => !!host.querySelector('[data-created-out-of-view]'), 250)
    expect(host.querySelector('[data-created-out-of-view]')).not.toBeNull()
    expect(m.created).toHaveLength(1)
    expect(m.onSaved).not.toHaveBeenCalled()
    expect(host.textContent ?? '').not.toMatch(/Cannot read properties/)
  })

  for (const shape of [UNITS, NOTES]) {
    for (const scoped of [true, false]) {
      it(`${shape.name}, ${scoped ? 'scoped' : 'unscoped'}: created once, answered without a crash`, async () => {
        const value = shape === UNITS ? { zone: scoped ? 4 : 2 } : { title: 'Hello' }
        const m = await mount({ shape, scoped, initialValues: value })
        await settle(() => false, 10)
        await m.save()
        await settle(() => m.onSaved.mock.calls.length > 0, 250)
        expect(m.created).toHaveLength(1)
        expect(m.created[0]).toMatchObject(value)
        expect(m.onSaved).toHaveBeenCalledWith('372777')
        const hidden = scoped && !shape.visibleToScoped(value)
        if (hidden)
          expect(toasts.warning).toHaveBeenCalledWith(
            expect.stringContaining('was created, but it’s outside what you can see'),
            expect.anything()
          )
        else expect(toasts.success).toHaveBeenCalledWith('Record created')
      })
    }
  }
})

describe('an edit that moves the record out of the editor’s scope', () => {
  // Stand-in rule: a ticket titled "moved" now belongs to another Zone.
  const TICKETS: Shape = {
    name: 'tickets',
    collection: 'tickets',
    fields: [field('title', 'Title')],
    relations: [],
    followUps: [],
    visibleToScoped: (b) => b.title !== 'moved',
    reason: 'its Zone (Zone 4) is not one of yours'
  }
  for (const scoped of [true, false]) {
    it(`${scoped ? 'scoped' : 'unscoped'}: saved, told plainly, no crash`, async () => {
      const m = await mount({
        shape: TICKETS,
        scoped,
        itemId: '55',
        existing: { id: 55, title: 'before' }
      })
      await settle(() => !!host.querySelector('[data-field="title"] input'))
      const input = host.querySelector('[data-field="title"] input') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(input, 'moved')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await settle(() => false, 5)
      await m.save()
      await settle(() => m.onSaved.mock.calls.length > 0, 250)
      const patches = m.calls.filter((c) => (c._method ?? '').toUpperCase() === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(patches[0]._body).toMatchObject({ title: 'moved' })
      expect(m.onSaved).toHaveBeenCalledWith('55')
      if (scoped)
        expect(toasts.warning).toHaveBeenCalledWith(
          'Saved, but this workflow is now outside what you can see (its Zone (Zone 4) is not one of yours).',
          expect.anything()
        )
      else expect(toasts.success).toHaveBeenCalledWith('Changes saved')
      expect(host.textContent ?? '').not.toMatch(/Cannot read properties/)
    })
  }
})
