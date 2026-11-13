// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { CollectionBrowserView } from './CollectionBrowserView'
import type { QuickFilterDef } from './quick-filters/config'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false
})) as never
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

const FY: QuickFilterDef = {
  key: 'fy',
  label: 'Funding Year',
  path: ['workflow', 'funding_years'],
  collection: 'funding_years',
  label_field: 'year',
  sort: '-year'
}
const ZONE: QuickFilterDef = {
  key: 'zone',
  label: 'Zone',
  path: ['workflow', 'divisions'],
  collection: 'divisions',
  label_field: 'name'
}
const REGION: QuickFilterDef = {
  key: 'region',
  label: 'Region',
  path: ['workflow', 'regions'],
  collection: 'regions',
  label_field: 'name'
}

function rel(
  many_collection: string,
  many_field: string,
  one_collection: string | null,
  one_field: string | null = null,
  junction_field: string | null = null
) {
  return { many_collection, many_field, one_collection, one_field, junction_field }
}

function makeClient(
  opts: { failPatch?: boolean; stored?: Record<string, unknown>; scopes?: unknown } = {}
) {
  const calls: Cmd[] = []
  let stored: Record<string, unknown> = opts.stored ?? {
    page_size: 50,
    export_filename: '{{collection}}',
    quick_filters: [FY, ZONE, REGION]
  }
  const metas: Record<string, unknown> = {
    workflows: {
      collection: 'workflows',
      display_template: '{{name}}',
      fields: [
        { field: 'id', type: 'integer' },
        { field: 'name', type: 'string' }
      ],
      relations: [
        rel('forecasts', 'workflow', 'workflows'),
        rel(
          'workflows_funding_years',
          'workflows_id',
          'workflows',
          'funding_years',
          'funding_years_id'
        ),
        rel('workflows_funding_years', 'funding_years_id', 'funding_years', null, 'workflows_id')
      ]
    },
    funding_years: {
      collection: 'funding_years',
      display_template: null,
      fields: [
        { field: 'id', type: 'integer' },
        { field: 'year', type: 'integer' }
      ],
      relations: []
    }
  }
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/collections/forecasts' && (cmd._method ?? 'GET') === 'GET')
        return {
          data: {
            collection: 'forecasts',
            display_name: 'Forecasts',
            display_template: '{{id}}',
            fields: [
              { field: 'id', type: 'integer', hidden: false },
              { field: 'amount', type: 'decimal', hidden: false },
              { field: 'workflow', type: 'integer', hidden: false }
            ],
            relations: [rel('forecasts', 'workflow', 'workflows')],
            browser_config: stored
          }
        }
      if (p === '/collections/forecasts' && cmd._method === 'PATCH') {
        if (opts.failPatch)
          throw Object.assign(new Error('Request failed with status code 500'), {
            status: 500,
            response: { status: 500, data: { error: 'boom' } }
          })
        stored = (cmd._body as { browser_config: Record<string, unknown> }).browser_config
        return { data: { collection: 'forecasts' } }
      }
      if (p.startsWith('/collections/')) {
        const c = p.slice('/collections/'.length)
        return { data: metas[c] ?? { collection: c, fields: [], relations: [] } }
      }
      if (p === '/items/forecasts') return { data: [{ id: 1, amount: 10, workflow: 4 }], total: 1 }
      if (p.startsWith('/items/')) return { data: [] }
      if (p === '/saved-views') return { data: [] }
      if (p === '/users/me/scopes') return { data: opts.scopes ?? null }
      return { data: null }
    })
  }
  return { client, calls, stored: () => stored }
}

let root: Root | null = null
let qc: QueryClient
beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState({ usr: null, idx: 0 }, '', '/records/forecasts')
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } })
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function settle() {
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function mount(
  client: unknown,
  { isAdmin, quickFilters }: { isAdmin: boolean; quickFilters?: QuickFilterDef[] }
) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin, userId: 'u1' }}>
            <CollectionBrowserView collection='forecasts' quickFilters={quickFilters} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle()
}

const editBtn = () => document.querySelector<HTMLButtonElement>('[data-qf-edit]')
const tokens = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-qf-token]')).map(
    (t) => t.dataset.qfToken
  )
const byLabel = (label: string) =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`) as HTMLElement
const byText = (text: string, sel = 'button') =>
  Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
    (b) => b.textContent?.trim() === text
  ) as HTMLElement
async function click(el: HTMLElement | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    el?.click()
  })
  await settle()
}
async function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}
const patches = (calls: Cmd[]) =>
  calls
    .filter((c) => c._method === 'PATCH')
    .map((c) => (c._body as { browser_config: Record<string, unknown> }).browser_config)

describe('Quick filters edited from the list', () => {
  it('administrators get an Edit control on the bar; other people do not', async () => {
    const admin = makeClient()
    await mount(admin.client, { isAdmin: true })
    expect(editBtn()).toBeTruthy()
    act(() => root?.unmount())
    document.body.replaceChildren()

    const person = makeClient()
    await mount(person.client, { isAdmin: false })
    expect(document.body.textContent).toContain('Funding Year')
    expect(editBtn()).toBeNull()
    expect(document.querySelector('[data-qf-editor]')).toBeNull()
  })

  it('a host-supplied bar (quickFilters prop) is not editable — the config would never show', async () => {
    const { client } = makeClient()
    await mount(client, { isAdmin: true, quickFilters: [FY] })
    expect(editBtn()).toBeNull()
  })

  it('removing a filter saves the bar through PATCH /collections and keeps every other setting', async () => {
    const { client, calls } = makeClient()
    await mount(client, { isAdmin: true })
    await click(editBtn())
    expect(tokens()).toEqual(['fy', 'zone', 'region'])
    await click(byLabel('Remove Zone'))
    expect(tokens()).toEqual(['fy', 'region'])
    await click(document.querySelector<HTMLElement>('[data-qf-save]'))
    expect(patches(calls)).toEqual([
      { page_size: 50, export_filename: '{{collection}}', quick_filters: [FY, REGION] }
    ])
    expect(document.querySelector('[data-qf-editor]')).toBeNull()
    // The bar shows the saved filters, and says so.
    expect(document.body.textContent).not.toContain('Zone')
    expect(document.body.textContent).toContain('Saved')
  })

  it('renaming keeps the key (people’s picks and default filters follow it)', async () => {
    const { client, calls } = makeClient()
    await mount(client, { isAdmin: true })
    await click(editBtn())
    await click(byLabel('Zone: settings. Alt+Left or Alt+Right moves it.'))
    const name = document.querySelector<HTMLInputElement>('input[placeholder="Funding Year"]')
    await typeInto(name as HTMLInputElement, 'Zones')
    await click(document.querySelector<HTMLElement>('[data-qf-save]'))
    const saved = patches(calls)[0].quick_filters as QuickFilterDef[]
    expect(saved[1]).toEqual({ ...ZONE, label: 'Zones' })
  })

  it('Alt+Right moves a filter one place', async () => {
    const { client, calls } = makeClient()
    await mount(client, { isAdmin: true })
    await click(editBtn())
    const fy = byLabel('Funding Year: settings. Alt+Left or Alt+Right moves it.')
    await act(async () => {
      fy.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })
      )
    })
    await settle()
    expect(tokens()).toEqual(['zone', 'fy', 'region'])
    await click(document.querySelector<HTMLElement>('[data-qf-save]'))
    expect((patches(calls)[0].quick_filters as QuickFilterDef[]).map((f) => f.key)).toEqual([
      'zone',
      'fy',
      'region'
    ])
  })

  it('adds a filter through a relation (M2M lands on its target, label column guessed)', async () => {
    const { client, calls } = makeClient({ stored: { quick_filters: [ZONE] } })
    await mount(client, { isAdmin: true })
    await click(editBtn())
    await click(document.querySelector<HTMLElement>('[data-qf-add]'))
    await click(byLabel('Fields of Workflow'))
    await click(
      Array.from(document.querySelectorAll<HTMLElement>('li button')).find((b) =>
        b.textContent?.startsWith('Funding Years')
      )
    )
    expect(tokens()).toEqual(['zone', 'funding_years'])
    // Its settings open at once, so it can be renamed.
    expect(document.querySelector<HTMLInputElement>('[data-qf-name]')?.value).toBe('Funding Years')
    await click(document.querySelector<HTMLElement>('[data-qf-save]'))
    expect(patches(calls)[0].quick_filters).toEqual([
      ZONE,
      {
        key: 'funding_years',
        label: 'Funding Years',
        path: ['workflow', 'funding_years'],
        collection: 'funding_years',
        label_field: 'year',
        value_field: 'id'
      }
    ])
  })

  it('a refused save puts the old bar back and reopens the editor on the same draft', async () => {
    const { client } = makeClient({ failPatch: true })
    await mount(client, { isAdmin: true })
    await click(editBtn())
    await click(byLabel('Remove Region'))
    await click(document.querySelector<HTMLElement>('[data-qf-save]'))
    expect(document.querySelector('[data-qf-editor]')).toBeTruthy()
    expect(tokens()).toEqual(['fy', 'zone'])
    expect(document.querySelector('[data-qf-editor]')?.textContent).toMatch(/try again/i)
    // Cancel: the stored bar, untouched.
    await click(byText('Cancel'))
    expect(document.body.textContent).toContain('Region')
  })

  it('an empty bar can be started from the list', async () => {
    const { client } = makeClient({ stored: { page_size: 50 } })
    await mount(client, { isAdmin: true })
    const start = editBtn()
    expect(start?.textContent).toContain('Add quick filters')
    await click(start)
    expect(document.querySelector('[data-qf-editor]')).toBeTruthy()
    // The field list opens at once.
    expect(document.querySelector('input[aria-label="Find a field"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Workflow')
  })

  it('a person’s default pick survives a rename and goes with the filter when it is removed', async () => {
    const { client, calls } = makeClient({
      stored: { quick_filters: [FY, ZONE] },
      scopes: {
        dimensions: [{ name: 'zone', target_collection: 'divisions' }],
        defaults: { zone: [3] },
        restricted: {}
      }
    })
    const lastConditions = () =>
      String(
        [...calls]
          .reverse()
          .find(
            (c) => c._path === '/items/forecasts' && c._params?.limit !== 1 && !c._params?.aggregate
          )?._params?.conditions ?? ''
      )
    await mount(client, { isAdmin: true })
    expect(document.body.textContent?.toLowerCase()).toContain('your default')
    expect(lastConditions()).toContain('divisions')

    await click(editBtn())
    await click(byLabel('Zone: settings. Alt+Left or Alt+Right moves it.'))
    await typeInto(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="Funding Year"]'
      ) as HTMLInputElement,
      'Zones'
    )
    await click(document.querySelector<HTMLElement>('[data-qf-save]'))
    expect(document.body.textContent?.toLowerCase()).toContain('your default')
    expect(lastConditions()).toContain('divisions')

    await click(editBtn())
    await click(byLabel('Remove Zones'))
    await click(document.querySelector<HTMLElement>('[data-qf-save]'))
    expect(document.body.textContent?.toLowerCase()).not.toContain('your default')
    expect(lastConditions()).not.toContain('divisions')
  })
})
