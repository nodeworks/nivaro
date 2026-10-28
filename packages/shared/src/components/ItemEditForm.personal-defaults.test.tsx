// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import { type M2MStagingCtx, useM2MStaging } from './item-edit/M2MStagingContext'
import type { ActiveLayoutData, CMSField, CMSRelation } from './item-edit/types'

// Personal field defaults on the real record form: a new record opens with the person's saved
// value in an allowed field, marked "Your default", without counting as unsaved work; a
// restored draft wins outright.
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

const LAYOUT: ActiveLayoutData = {
  layout: {
    id: 7,
    name: 'Order form',
    tab_mode: null,
    validate_before_next: false,
    summary_enabled: false,
    summary_show_all: false,
    ai_enabled: false
  },
  groups: [
    { id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0, is_collapsed: false }
  ],
  assignments: [
    { field: 'title', sort: 0, group_key: 'main', is_visible: true },
    { field: 'notes', sort: 1, group_key: 'main', is_visible: true }
  ],
  ungrouped_sort: 99
}

const FIELD_CONFIG: CMSField[] = [
  field('title', 'Title', { sort: 0, _overrides: { personal_default: true } }),
  field('notes', 'Notes', { sort: 1 })
]

type Cmd = {
  _method?: string
  _path: string
  _params?: Record<string, unknown>
  _body?: unknown
}

const TITLE_DEFAULT = {
  id: 1,
  collection: 'orders',
  field: 'title',
  value: 'Rush order',
  context: {},
  updated_at: '2026-10-28T10:00:00.000Z'
}
// Per-test fixture: what the form is configured with and extra server answers.
let fx: {
  fieldConfig: CMSField[]
  relations: CMSRelation[]
  defaults: unknown[]
  fieldRules: unknown[]
  answer?: (cmd: Cmd) => unknown
} = { fieldConfig: FIELD_CONFIG, relations: [], defaults: [TITLE_DEFAULT], fieldRules: [] }
let serverDraft: unknown = null
function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const extra = fx.answer?.(cmd)
      if (extra !== undefined) return extra
      if (p === '/collection-layouts/active') return { data: LAYOUT }
      if (p === '/field-config/orders') return { data: fx.fieldConfig }
      if (p === '/data-model/relations/for/orders') return { data: fx.relations }
      if (p === '/field-rules') return { data: fx.fieldRules }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (p === '/field-defaults/mine') return { data: fx.defaults }
      if (p === '/drafts/orders/new' && serverDraft) return { data: serverDraft }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
}

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
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  serverDraft = null
  fx = { fieldConfig: FIELD_CONFIG, relations: [], defaults: [TITLE_DEFAULT], fieldRules: [] }
  staging = null
  window.localStorage.clear()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1000))
  })
}

// The form's M2M staging, as a picker would use it.
let staging: M2MStagingCtx | null = null
function GrabStaging() {
  staging = useM2MStaging()
  return null
}

type MountOpts = { userId?: string; itemId?: string; grabStaging?: boolean }
async function mountNew(onDirtyChange = vi.fn(), opts: MountOpts = {}) {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const render = (o: MountOpts) =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: o.userId ?? 'u1' }}>
            <ItemEditForm
              collection='orders'
              itemId={o.itemId}
              documentTitle={false}
              onDirtyChange={onDirtyChange}
              renderField={o.grabStaging ? () => <GrabStaging /> : undefined}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  await act(async () => render(opts))
  return {
    calls,
    onDirtyChange,
    rerender: async (o: MountOpts) => {
      await act(async () => render({ ...opts, ...o }))
    }
  }
}

const titleInput = () => host.querySelector<HTMLInputElement>('[data-field="title"] input')

describe('ItemEditForm personal defaults', () => {
  it('a new record opens with the saved value, marked, and nothing unsaved', async () => {
    const { calls, onDirtyChange } = await mountNew()
    await settle(() => !!host.querySelector('[data-personal-default="title"]'))
    expect(titleInput()?.value).toBe('Rush order')
    const pill = host.querySelector('[data-personal-default="title"]')
    expect(pill?.textContent).toContain('Your default')
    expect(pill?.getAttribute('data-tip')).toBe('Prefilled from your saved default · Undo')
    expect(host.querySelector('[data-personal-default="notes"]')).toBeNull()
    // Prefill: never dirty, never a stored draft.
    expect(onDirtyChange.mock.calls.some(([dirty]) => dirty === true)).toBe(false)
    expect(calls.some((c) => c._method === 'PUT' && c._path.startsWith('/drafts/'))).toBe(false)
    expect(calls.filter((c) => c._path === '/field-defaults/mine')).toHaveLength(1)

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-personal-default-undo="title"]')?.click()
    )
    await settle(() => !host.querySelector('[data-personal-default="title"]'))
    expect(titleInput()?.value).toBe('')
    expect(host.querySelector('[data-personal-default="title"]')).toBeNull()
  })

  it('a restored draft wins outright: no default is applied after it', async () => {
    serverDraft = {
      saved_at: '2026-10-28T09:00:00.000Z',
      payload: {
        key: 'x',
        collection: 'orders',
        item_id: 'new',
        user_id: 'u1',
        saved_at: '2026-10-28T09:00:00.000Z',
        fields: { notes: 'from my draft' },
        base: {},
        base_updated_at: null,
        pending_rows: {},
        pending_edits: {},
        pending_deletes: {},
        m2m_links: {},
        m2m_unlinks: {}
      }
    }
    await mountNew()
    await settle(() =>
      [...host.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Restore')
    )
    // While the draft is offered, nothing is applied.
    expect(titleInput()?.value).toBe('')
    const restore = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore'
    )
    await act(async () => restore?.click())
    await settle(() => false)
    expect(
      host.querySelector<HTMLTextAreaElement>(
        '[data-field="notes"] input, [data-field="notes"] textarea'
      )?.value
    ).toBe('from my draft')
    expect(titleInput()?.value).toBe('')
    expect(host.querySelector('[data-personal-default="title"]')).toBeNull()
  })
})

// Tags (M2M) whose pick fills Zone from the picked tag (an upstream cascade): a tag with a zone
// fills it, the way a person's pick would.
function tagsFixture(tagsAllowed: boolean) {
  fx.fieldConfig = [
    field('title', 'Title', { sort: 0, _overrides: { personal_default: true } }),
    field('zone', 'Zone', { sort: 1, interface: 'select-dropdown-m2o' }),
    field('tags', 'Tags', {
      sort: 2,
      type: 'alias',
      interface: 'list-m2m',
      dependency_config: {
        cascade_filters: [{ parent_field: 'zone', filter_column: 'zone', upstream: true }]
      },
      ...(tagsAllowed ? { _overrides: { personal_default: true } } : {})
    })
  ]
  fx.relations = [
    {
      id: 1,
      many_collection: 'orders',
      many_field: 'zone',
      one_collection: 'zones',
      one_field: null,
      junction_field: null
    },
    {
      id: 2,
      many_collection: 'orders_tags',
      many_field: 'orders_id',
      one_collection: 'orders',
      one_field: 'tags',
      junction_field: 'tags_id'
    },
    {
      id: 3,
      many_collection: 'orders_tags',
      many_field: 'tags_id',
      one_collection: 'tags',
      one_field: null,
      junction_field: 'orders_id'
    }
  ]
  fx.answer = (cmd) => {
    if (cmd._path === '/items/tags' && cmd._params?.filter) {
      const f = JSON.parse(String(cmd._params.filter)) as {
        _and?: Array<{ id?: { _in?: string[] } }>
      }
      return { data: (f._and?.[0]?.id?._in ?? []).map((id) => ({ id })) }
    }
    if (cmd._path === '/items/tags/7') return { data: { id: '7', zone: null } }
    if (cmd._path === '/items/tags/8') return { data: { id: '8', zone: 'Z' } }
    return undefined
  }
}

describe('ItemEditForm personal defaults: fix round 1', () => {
  it('a person adding a link to a defaulted M2M field: what it derives is their work', async () => {
    tagsFixture(true)
    fx.defaults = [{ ...TITLE_DEFAULT, id: 2, field: 'tags', value: ['7'] }]
    const { calls, onDirtyChange } = await mountNew(vi.fn(), { grabStaging: true })
    await settle(() => (staging?.getStagedLinks('tags') ?? []).length > 0)
    expect(staging?.getStagedLinks('tags')).toEqual(['7'])
    expect(onDirtyChange.mock.calls.some(([dirty]) => dirty === true)).toBe(false)
    await act(async () => staging?.stageLink('tags', '8'))
    await settle(() => calls.some((c) => c._path === '/items/tags/8'))
    expect(onDirtyChange.mock.calls.some(([dirty]) => dirty === true)).toBe(true)
    // The recovery draft is kept (mirrored to the server).
    expect(calls.some((c) => c._method === 'PUT' && c._path === '/drafts/orders/new')).toBe(true)
  })

  it('default → field rule → cascade: everything derived stays prefill', async () => {
    tagsFixture(false)
    fx.fieldRules = [
      { id: 1, collection: 'orders', trigger_field: 'title', target_field: 'tags', is_active: true }
    ]
    const base = fx.answer
    fx.answer = (cmd) =>
      cmd._path === '/field-rules/evaluate' ? { data: { tags: ['8'] } } : base?.(cmd)
    const { calls, onDirtyChange } = await mountNew(vi.fn(), { grabStaging: true })
    await settle(() => calls.some((c) => c._path === '/items/tags/8'))
    expect(staging?.getStagedLinks('tags')).toEqual(['8'])
    expect(onDirtyChange.mock.calls.some(([dirty]) => dirty === true)).toBe(false)
    expect(calls.some((c) => c._method === 'PUT' && c._path.startsWith('/drafts/'))).toBe(false)
  })

  it('no applying before the signed-in person is known', async () => {
    await mountNew(vi.fn(), { userId: '' })
    await settle(() => false)
    expect(titleInput()?.value).toBe('')
  })

  it('the created record keeps no pill when the form stays mounted', async () => {
    const answer = (cmd: Cmd) =>
      cmd._path === '/items/orders/41' ? { data: { id: 41, title: 'Rush order' } } : undefined
    fx.answer = answer
    const { rerender } = await mountNew()
    await settle(() => !!host.querySelector('[data-personal-default="title"]'))
    await rerender({ itemId: '41' })
    await settle(() => !host.querySelector('[data-personal-default="title"]'))
    expect(titleInput()?.value).toBe('Rush order')
    expect(host.querySelector('[data-personal-default="title"]')).toBeNull()
  })
})

describe('ItemEditForm personal defaults: fix round 2', () => {
  it("a default's rule staging onto a field the person already picked keeps their cascade dirty", async () => {
    tagsFixture(false)
    fx.fieldRules = [
      { id: 1, collection: 'orders', trigger_field: 'title', target_field: 'tags', is_active: true }
    ]
    const gate = () => {
      let open: () => void = () => {}
      const p = new Promise<void>((r) => {
        open = r
      })
      return { p, open: () => open() }
    }
    const defaultsGate = gate()
    const zoneGate = gate()
    const base = fx.answer
    fx.answer = (cmd) => {
      if (cmd._path === '/field-rules/evaluate') return { data: { tags: ['5'] } }
      // The defaults arrive after the person's pick; that pick resolves its Zone slowly.
      if (cmd._path === '/field-defaults/mine')
        return defaultsGate.p.then(() => ({ data: fx.defaults }))
      if (cmd._path === '/items/tags/8') return zoneGate.p.then(() => base?.(cmd))
      return base?.(cmd)
    }
    const { calls } = await mountNew(vi.fn(), { grabStaging: true })
    for (let i = 0; i < 80 && !staging; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })
    await act(async () => staging?.stageLink('tags', '8'))
    await act(async () => defaultsGate.open())
    await settle(() => (staging?.getStagedLinks('tags') ?? []).map(String).includes('5'))
    const draftPut = () =>
      calls.some((c) => c._method === 'PUT' && c._path === '/drafts/orders/new')
    // Nothing set isDirty yet (a staged link alone does not): no recovery draft.
    expect(draftPut()).toBe(false)
    await act(async () => zoneGate.open())
    await settle(draftPut)
    // The person's pick filled Zone: their work, so the recovery draft is written.
    expect(draftPut()).toBe(true)
  })
})
