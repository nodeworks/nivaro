// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { layoutGrantedTools } from '../lib/layout-grants'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// "Schedule a change" and "Disable in pickers" (Form settings → Buttons &
// panels → allow_schedule / allow_disable_pickers) used to work in the admin
// ItemEdit page only. The shared record form offers them in its More menu
// when a host opts in (efp-new), with the same grant rule.
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
    group_key: null,
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    ...over
  }
}

const FIELD_CONFIG: CMSField[] = [
  field('title', 'Title', { group_key: 'main', sort: 0, layout_assigned: true }),
  field('amount', 'Amount', { group_key: 'main', sort: 1, layout_assigned: true })
]

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

function makeClient(flags: Record<string, boolean>) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 7, name: 'Order form', slug: 'order-form', ...flags },
            groups: [{ id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0 }],
            assignments: [
              { field: 'title', sort: 0, group_key: 'main', is_visible: true },
              { field: 'amount', sort: 1, group_key: 'main', is_visible: true }
            ],
            ungrouped_sort: 99
          }
        }
      if (p === '/field-config/orders') return { data: FIELD_CONFIG }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (p === '/items/orders/1') return { data: { id: 1, title: 'First', amount: '2' } }
      if (p.startsWith('/picker-exclusions/status/')) return { data: { excluded: false } }
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
  for (const el of document.body.querySelectorAll('[data-nvr-header-menu-panel]')) el.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mountAndOpenMore(opts: {
  flags?: Record<string, boolean>
  isAdmin?: boolean
  showGrantedTools?: boolean
  layoutSlug?: string
}) {
  const { client, calls } = makeClient(opts.flags ?? {})
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: !!opts.isAdmin, userId: 'U1' }}>
            <ItemEditForm
              collection='orders'
              itemId='1'
              documentTitle={false}
              layoutSlug={opts.layoutSlug}
              showGrantedTools={opts.showGrantedTools}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(
    () =>
      host.querySelectorAll('[data-field]').length >= 2 &&
      !!host.querySelector('[data-nvr-header-menu-btn]')
  )
  // Let the layout read land before the menu opens.
  await settle(() => calls.some((c) => c._path === '/collection-layouts/active'))
  const btn = host.querySelector('[data-nvr-header-menu-btn]') as HTMLButtonElement
  await act(async () => btn.click())
  const panel = () => document.body.querySelector('[data-nvr-header-menu-panel]')
  await settle(() => !!panel())
  return { calls, panel: panel as () => Element | null }
}

describe('layoutGrantedTools', () => {
  it('gives administrators both tools and everyone else what the form grants', () => {
    expect(layoutGrantedTools(null, true)).toEqual({ schedule: true, disablePickers: true })
    expect(layoutGrantedTools(null, false)).toEqual({ schedule: false, disablePickers: false })
    expect(layoutGrantedTools({ allow_schedule: 1, allow_disable_pickers: 0 }, false)).toEqual({
      schedule: true,
      disablePickers: false
    })
  })
})

describe('ItemEditForm granted record tools (showGrantedTools)', () => {
  it('offers both rows to a member when the form grants them', async () => {
    const { panel } = await mountAndOpenMore({
      flags: { allow_schedule: true, allow_disable_pickers: true },
      showGrantedTools: true
    })
    expect(panel()?.querySelector('[data-record-schedule-change]')).not.toBeNull()
    expect(panel()?.querySelector('[data-record-picker-exclusion]')).not.toBeNull()
  })

  it('hides them from a member when the form does not grant them, but not from an admin', async () => {
    const member = await mountAndOpenMore({ flags: {}, showGrantedTools: true })
    expect(member.panel()).not.toBeNull()
    expect(member.panel()?.querySelector('[data-record-schedule-change]')).toBeNull()
    expect(member.panel()?.querySelector('[data-record-picker-exclusion]')).toBeNull()
    act(() => root.unmount())
    for (const el of document.body.querySelectorAll('[data-nvr-header-menu-panel]')) el.remove()
    root = createRoot(host)
    const admin = await mountAndOpenMore({ flags: {}, isAdmin: true, showGrantedTools: true })
    expect(admin.panel()?.querySelector('[data-record-schedule-change]')).not.toBeNull()
    expect(admin.panel()?.querySelector('[data-record-picker-exclusion]')).not.toBeNull()
  })

  it('renders nothing extra when the host leaves it off (admin ItemEdit has its own)', async () => {
    const { panel } = await mountAndOpenMore({
      flags: { allow_schedule: true, allow_disable_pickers: true },
      isAdmin: true
    })
    expect(panel()).not.toBeNull()
    expect(panel()?.querySelector('[data-record-schedule-change]')).toBeNull()
    expect(panel()?.querySelector('[data-record-picker-exclusion]')).toBeNull()
  })

  it('sends the link name the page opened with, so the server checks the same form', async () => {
    const { calls, panel } = await mountAndOpenMore({
      flags: { allow_disable_pickers: true },
      showGrantedTools: true,
      layoutSlug: 'order-form'
    })
    const row = panel()?.querySelector('[data-record-picker-exclusion]') as HTMLButtonElement
    await act(async () => row.click())
    await settle(() => calls.some((c) => c._path === '/picker-exclusions'))
    const sent = calls.find((c) => c._path === '/picker-exclusions')
    expect(sent?._method).toBe('POST')
    expect(sent?._body).toEqual({ collection: 'orders', item_id: '1', layout: 'order-form' })
  })
})
