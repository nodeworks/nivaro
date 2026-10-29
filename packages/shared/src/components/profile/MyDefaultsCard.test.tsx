// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import { MyDefaultsCard } from './MyDefaultsCard'

// Profile → My defaults (spec 2026-10-28-personal-field-defaults): every saved
// default, grouped by collection, the value and its context as labels read as
// the viewer (never a raw id), Change through the field's own control, Clear,
// and rows whose field no form allows any more listed for clearing.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The add form's pick lists are cmdk lists (ResizeObserver + scrollIntoView).
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView ??= () => {}

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

const ROWS = [
  {
    id: 1,
    collection: 'orders',
    field: 'ship_to',
    value: 31,
    context: { region: 5, zone: 2 },
    updated_at: '2026-10-20T15:00:00.000Z',
    updated_by: null,
    on_layout: true
  },
  {
    id: 4,
    collection: 'orders',
    field: 'ship_to',
    value: 99,
    context: { zone: 5 },
    updated_at: '2026-10-21T15:00:00.000Z',
    updated_by: null,
    on_layout: true
  },
  {
    id: 2,
    collection: 'orders',
    field: 'notes',
    value: 'Rush order',
    context: {},
    updated_at: '2026-10-22T15:00:00.000Z',
    updated_by: 'admin-1',
    on_layout: true
  },
  {
    id: 3,
    collection: 'invoices',
    field: 'terms',
    value: 'net30',
    context: {},
    updated_at: '2026-10-23T15:00:00.000Z',
    updated_by: null,
    on_layout: false
  }
]

const f = (field: string, extra: Record<string, unknown> = {}) => ({
  field,
  type: 'string',
  interface: null,
  label: null,
  required: false,
  hidden: false,
  readonly: false,
  sort: 1,
  group_key: null,
  options: null,
  computed_formula: null,
  computed_type: null,
  note: null,
  placeholder: null,
  repeater_schema: null,
  dependency_config: null,
  ...extra
})

const FIELDS: Record<string, unknown[]> = {
  orders: [
    f('zone', { type: 'integer', label: 'Zone' }),
    f('region', {
      type: 'integer',
      label: 'Region',
      dependency_config: { cascade_filters: [{ parent_field: 'zone', filter_column: 'zone' }] }
    }),
    f('ship_to', {
      type: 'integer',
      label: 'Ship-to',
      dependency_config: { cascade_filters: [{ parent_field: 'region', filter_column: 'region' }] }
    }),
    f('notes', { label: 'Notes' })
  ],
  invoices: [
    f('terms', {
      label: 'Payment terms',
      interface: 'select-dropdown',
      options: { choices: [{ value: 'net30', text: 'Net 30' }] }
    })
  ]
}

const rel = (id: number, field: string, one: string) => ({
  id,
  many_collection: 'orders',
  many_field: field,
  one_collection: one,
  one_field: null,
  junction_field: null
})
const RELATIONS: Record<string, unknown[]> = {
  orders: [rel(1, 'zone', 'zones'), rel(2, 'region', 'regions'), rel(3, 'ship_to', 'addresses')],
  invoices: []
}
const RECORDS: Record<string, Array<Record<string, unknown>>> = {
  zones: [
    { id: 2, name: 'Zone 2' },
    { id: 5, name: 'Zone 5' }
  ],
  regions: [{ id: 5, name: 'Boston' }],
  addresses: [{ id: 31, name: 'Cambridge' }]
}

let root: Root
let host: HTMLDivElement
let calls: Cmd[] = []
let rows: Array<Omit<(typeof ROWS)[number], 'context'> & { context: Record<string, unknown> }> =
  ROWS
let anyAllowed = true
let allowedNone = false
let holdPut: Promise<void> | null = null
let listFailures = 0

function respond(cmd: Cmd): unknown {
  const p = cmd._path
  if (cmd._method === 'DELETE') return { data: { id: Number(p.split('/').pop()) } }
  if (cmd._method === 'PUT') return { data: { id: 9, ...(cmd._body as object) } }
  if (p === '/field-defaults/mine' || /^\/field-defaults\/users\/[^/]+$/.test(p)) {
    if (listFailures > 0) {
      listFailures--
      throw Object.assign(new Error('boom'), { status: 500 })
    }
    return { data: rows }
  }
  if (p.endsWith('/allowed') && cmd._params?.any) return { data: { any: anyAllowed } }
  if (p.endsWith('/allowed') && allowedNone) return { data: [] }
  if (p.endsWith('/allowed'))
    return {
      data: [
        { collection: 'orders', label: 'Purchase orders', fields: ['notes', 'ship_to'] },
        { collection: 'invoices', label: null, fields: ['terms'] }
      ]
    }
  const fc = p.match(/^\/field-config\/(\w+)$/)
  if (fc) return { data: FIELDS[fc[1]] ?? [] }
  const rl = p.match(/^\/data-model\/relations\/for\/(\w+)$/)
  if (rl) return { data: RELATIONS[rl[1]] ?? [] }
  const col = p.match(/^\/collections\/(\w+)$/)
  if (col) {
    const names: Record<string, string> = { orders: 'Purchase orders', invoices: 'Invoices' }
    return {
      data: { collection: col[1], display_name: names[col[1]] ?? null, display_template: null }
    }
  }
  const items = p.match(/^\/items\/(\w+)$/)
  if (items) {
    const filter = JSON.parse(String(cmd._params?.filter ?? '{}')) as {
      id?: { _in?: unknown[] }
    }
    const want = (filter.id?._in ?? []).map(String)
    return { data: (RECORDS[items[1]] ?? []).filter((r) => want.includes(String(r.id))) }
  }
  return { data: null }
}

async function settle(until?: () => boolean) {
  for (let i = 0; i < 60; i++) {
    await act(async () => await new Promise((r) => setTimeout(r, 5)))
    if (until?.()) return
  }
}

async function mount(opts: { userId?: string; isAdmin?: boolean } = {}) {
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'PUT' && holdPut) await holdPut
      return respond(cmd)
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: opts.isAdmin ?? false, userId: 'me-1' }}>
            <MyDefaultsCard userId={opts.userId} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(
    () =>
      !!host
        .querySelector('[data-default-row="1"] [data-default-value]')
        ?.textContent?.match(/Cambridge/)
  )
  return client
}

const rowEl = (id: number) => host.querySelector<HTMLElement>(`[data-default-row="${id}"]`)
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  calls = []
  rows = ROWS
  anyAllowed = true
  allowedNone = false
  holdPut = null
  listFailures = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('MyDefaultsCard', () => {
  it('reads the viewer own defaults with the form state, grouped by collection', async () => {
    await mount()
    const list = calls.find((c) => c._path === '/field-defaults/mine')
    expect(list?._params).toMatchObject({ on_layout: 1 })
    const groups = [...host.querySelectorAll('[data-default-group]')].map((g) =>
      g.getAttribute('data-default-group')
    )
    // Sorted by the collection's name as people see it.
    expect(groups).toEqual(['invoices', 'orders'])
    const heading = host.querySelector('[data-default-group="orders"] [data-default-group-label]')
    expect(heading?.textContent).toBe('Purchase orders')
    expect(rowEl(1)?.querySelector('[data-default-field]')?.textContent).toBe('Ship-to')
  })

  it('shows the value and its context as labels, parents farthest first', async () => {
    await mount()
    expect(rowEl(1)?.querySelector('[data-default-value]')?.textContent).toBe('Cambridge')
    expect(rowEl(1)?.querySelector('[data-default-context]')?.textContent).toBe(
      'For Zone 2 · Boston'
    )
    expect(rowEl(2)?.querySelector('[data-default-context]')).toBeNull()
    expect(rowEl(2)?.querySelector('[data-default-value]')?.textContent).toBe('Rush order')
  })

  it('reads labels in one request per related collection and never shows a raw id', async () => {
    await mount()
    const addressReads = calls.filter((c) => c._path === '/items/addresses')
    expect(addressReads).toHaveLength(1)
    expect(JSON.parse(String(addressReads[0]._params?.filter))).toEqual({
      id: { _in: ['31', '99'] }
    })
    expect(calls.filter((c) => c._path === '/items/zones')).toHaveLength(1)
    // 99 no longer reads for the viewer: a plain statement, not the key.
    const missing = rowEl(4)?.querySelector('[data-default-value]')?.textContent ?? ''
    expect(missing).toBe('No longer available')
    expect(host.textContent).not.toMatch(/\b99\b/)
  })

  it('clears a default with DELETE /mine/:id after a second click', async () => {
    await mount()
    const clear = rowEl(2)?.querySelector('[data-default-clear]')
    await click(clear)
    expect(calls.some((c) => c._method === 'DELETE')).toBe(false)
    await click(rowEl(2)?.querySelector('[data-default-clear]'))
    await settle()
    expect(calls.filter((c) => c._method === 'DELETE').map((c) => c._path)).toEqual([
      '/field-defaults/mine/2'
    ])
  })

  it('lists a field no form allows any more as such, with Clear and no Change', async () => {
    await mount()
    const stale = rowEl(3)
    expect(stale?.querySelector('[data-default-stale]')?.textContent).toBe('No longer on any form')
    expect(stale?.querySelector('[data-default-value]')?.textContent).toBe('Net 30')
    expect(stale?.querySelector('[data-default-change]')).toBeNull()
    expect(stale?.querySelector('[data-default-clear]')).toBeTruthy()
  })

  it('changes a value through the field own control, keeping its context', async () => {
    await mount()
    await click(rowEl(2)?.querySelector('[data-default-change]'))
    await settle(() => !!rowEl(2)?.querySelector('input'))
    const input = rowEl(2)?.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('Rush order')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'Standard')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(rowEl(2)?.querySelector('[data-default-save]'))
    await settle()
    const put = calls.find((c) => c._method === 'PUT')
    expect(put?._path).toBe('/field-defaults/mine')
    expect(put?._body).toEqual({
      collection: 'orders',
      field: 'notes',
      value: 'Standard',
      context: {}
    })
  })

  it('own page: draws nothing until known, and nothing at all with none saved or offered', async () => {
    rows = []
    anyAllowed = false
    const seen: string[] = []
    const obs = new MutationObserver(() => seen.push(host.innerHTML))
    obs.observe(host, { childList: true, subtree: true, characterData: true })
    await mount()
    await settle()
    obs.disconnect()
    expect(seen.filter(Boolean)).toEqual([])
    expect(host.innerHTML).toBe('')
    // The own page asks only "is there anything" — never the full list.
    const allowedCalls = calls.filter((c) => c._path === '/field-defaults/mine/allowed')
    expect(allowedCalls.map((c) => c._params)).toEqual([{ any: 1 }])
  })

  it('own page: no skeleton while the reads are in flight', async () => {
    const client = { request: vi.fn(() => new Promise(() => {})) }
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'me-1' }}>
              <MyDefaultsCard />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    expect(host.innerHTML).toBe('')
  })

  it('offers Retry when the list fails, and reads again', async () => {
    listFailures = 1
    await mount()
    await settle(() => !!host.querySelector('[data-default-retry]'))
    await click(host.querySelector('[data-default-retry]'))
    await settle(() => !!rowEl(1))
    expect(calls.filter((c) => c._path === '/field-defaults/mine')).toHaveLength(2)
    expect(rowEl(1)).toBeTruthy()
  })

  it('Clear tells its state through data-tip and aria-label, never a native title', async () => {
    await mount()
    const btn = rowEl(2)?.querySelector('[data-default-clear]')?.closest('button')
    expect(btn?.hasAttribute('title')).toBe(false)
    expect(btn?.getAttribute('data-tip')).toBe('Clear the default for Notes')
    expect(btn?.getAttribute('aria-label')).toBe('Clear the default for Notes')
    await click(btn)
    expect(btn?.getAttribute('aria-label')).toBe('Clear the default for Notes?')
    // Armed: no tip over "Clear?", the cluster stays shown, and screen readers hear the step.
    expect(btn?.hasAttribute('data-tip')).toBe(false)
    expect(btn?.hasAttribute('data-armed')).toBe(true)
    expect(btn?.parentElement?.className).not.toContain('opacity-0')
    expect(btn?.querySelector('[aria-live=polite]')?.textContent).toBe('Press again to confirm')
  })

  it('explains a stale row to screen readers, not only in a tooltip', async () => {
    await mount()
    expect(rowEl(3)?.querySelector('.sr-only')?.textContent).toMatch(/not used/)
  })

  it('names a context parent that is no longer a field instead of "Saved value"', async () => {
    rows = [
      {
        ...ROWS[0],
        id: 7,
        field: 'notes',
        value: 'Rush order',
        context: { legacy_area: 3 }
      }
    ]
    await mount()
    await settle(() => !!rowEl(7)?.querySelector('[data-default-context]'))
    expect(rowEl(7)?.querySelector('[data-default-context]')?.textContent).toBe('For Legacy Area')
  })

  it('Change focuses the control, Escape cancels, and focus returns to Change', async () => {
    await mount()
    const change = rowEl(2)?.querySelector<HTMLElement>('[data-default-change]')
    await click(change)
    await settle(() => document.activeElement?.tagName === 'INPUT')
    const input = rowEl(2)?.querySelector('input')
    expect(document.activeElement).toBe(input)
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle(() => !rowEl(2)?.querySelector('input'))
    expect(rowEl(2)?.querySelector('input')).toBeNull()
    expect(document.activeElement).toBe(rowEl(2)?.querySelector('[data-default-change]'))
  })

  it('teaches how to save one when there are none', async () => {
    rows = []
    await mount()
    await settle(() => !!host.querySelector('[data-default-empty]'))
    expect(host.querySelector('[data-default-empty]')?.textContent).toMatch(
      /Make default.*beside its label/
    )
  })

  it('an admin with nothing to add is told about the person, never "add one here"', async () => {
    rows = []
    allowedNone = true
    await mount({ userId: 'bob-1', isAdmin: true })
    await settle(() => !!host.querySelector('[data-default-empty]'))
    const text = host.querySelector('[data-default-empty]')?.textContent ?? ''
    expect(text).toMatch(/^This person hasn’t saved any defaults yet\./)
    expect(text).not.toMatch(/add one here/)
    expect(host.querySelector('[data-default-add]')).toBeNull()
  })

  it('an admin with forms to add from is offered "add one here"', async () => {
    rows = []
    await mount({ userId: 'bob-1', isAdmin: true })
    await settle(() => !!host.querySelector('[data-default-add]'))
    expect(host.querySelector('[data-default-empty]')?.textContent).toMatch(/or add one here\./)
  })

  it('the Add form: Field waits for a collection', async () => {
    await mount({ userId: 'bob-1', isAdmin: true })
    await click(host.querySelector('[data-default-add]'))
    const fieldPick = host.querySelector<HTMLButtonElement>('[data-default-pick="field"]')
    expect(fieldPick?.disabled).toBe(true)
  })

  it('an admin reads and clears through /users/:id and can add a default', async () => {
    await mount({ userId: 'bob-1', isAdmin: true })
    expect(calls.some((c) => c._path === '/field-defaults/users/bob-1')).toBe(true)
    expect(calls.some((c) => c._path === '/field-defaults/mine')).toBe(false)
    await click(rowEl(2)?.querySelector('[data-default-clear]'))
    await click(rowEl(2)?.querySelector('[data-default-clear]'))
    await settle()
    expect(calls.find((c) => c._method === 'DELETE')?._path).toBe('/field-defaults/users/bob-1/2')
    expect(calls.some((c) => c._path === '/field-defaults/users/bob-1/allowed')).toBe(true)
    expect(host.querySelector('[data-default-add]')).toBeTruthy()
  })

  it('an admin adds a default: collection, then an allowed field, then its value', async () => {
    await mount({ userId: 'bob-1', isAdmin: true })
    await click(host.querySelector('[data-default-add]'))
    const option = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (o) => o.textContent === text
      )
    await click(host.querySelector('[data-default-pick="collection"]'))
    await click(option('Purchase orders'))
    await settle(() => !document.querySelector('[role="option"]'))
    expect(host.querySelector('[data-default-pick="collection"]')?.textContent).toBe(
      'Purchase orders'
    )
    await click(host.querySelector('[data-default-pick="field"]'))
    await settle(() => document.querySelectorAll('[role="option"]').length > 0)
    // Only the fields some form allows: Notes and Ship-to, never Zone.
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'Notes',
      'Ship-to'
    ])
    await click(option('Notes'))
    await settle(() => !!host.querySelector('[data-default-add-form] input'))
    const input = host.querySelector('[data-default-add-form] input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Hold')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    let release = () => {}
    holdPut = new Promise<void>((r) => {
      release = r
    })
    await click(host.querySelector('[data-default-add-form] [data-default-save]'))
    await settle(() => !!host.querySelector('[data-default-add-form] [data-default-save]:disabled'))
    expect(host.querySelector('[data-default-add-form] [data-default-save]')?.textContent).toBe(
      'Saving…'
    )
    release()
    await settle()
    const putCall = calls.find((c) => c._method === 'PUT')
    expect(putCall?._path).toBe('/field-defaults/users/bob-1')
    expect(putCall?._body).toEqual({
      collection: 'orders',
      field: 'notes',
      value: 'Hold',
      context: {}
    })
  })

  it('shows a non-admin nothing of another person', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={{ request: vi.fn() } as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'me-1' }}>
              <MyDefaultsCard userId='bob-1' />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    expect(host.innerHTML).toBe('')
  })

  it('never offers Add default on the person own page', async () => {
    await mount()
    expect(host.querySelector('[data-default-add]')).toBeNull()
  })
})
