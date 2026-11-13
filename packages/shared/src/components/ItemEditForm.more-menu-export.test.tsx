// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ITEM_EDIT_EXPORT_MENU_SLOT, ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// A host's own export ("Export lines (Excel)" on an EFP inventory request) sat near the
// bottom of the More menu, rows away from "Export PDF", the other export of the same record
// (design review round 2). moreMenuExportItems puts host rows right after the record's own
// exports; moreMenuItems keeps the rest above Delete.
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
      if (p === '/collection-layouts')
        return {
          data: [
            {
              id: 9,
              name: 'Order PDF',
              layout_type: 'file',
              is_active: true,
              pdf_button_label: null
            }
          ]
        }
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
  exportRows?: ReactNode
  hostRows?: ReactNode
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
              moreMenuExportItems={opts.exportRows}
              moreMenuItems={opts.hostRows}
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
  await settle(() => calls.some((c) => c._path === '/collection-layouts'))
  const btn = host.querySelector('[data-nvr-header-menu-btn]') as HTMLButtonElement
  await act(async () => btn.click())
  const panel = () => document.body.querySelector('[data-nvr-header-menu-panel]')
  await settle(() => !!panel())
  return { calls, panel: panel as () => Element | null }
}

const rowLabels = (panel: Element | null) =>
  [...(panel?.children ?? [])].map((el) =>
    el.hasAttribute('data-nvr-menu-divider') ? '—' : (el.textContent ?? '').trim()
  )

describe('the More menu’s export slot', () => {
  it('draws a host’s export right after Export PDF, before the record tools', async () => {
    const { panel } = await mountAndOpenMore({
      exportRows: (
        <button type='button' data-host-export>
          Export lines (Excel)
        </button>
      ),
      hostRows: (
        <button type='button' data-host-row>
          Edit layout
        </button>
      )
    })
    await settle(() => rowLabels(panel()).includes('Export PDF'))
    const rows = rowLabels(panel())
    const pdf = rows.indexOf('Export PDF')
    expect(pdf).toBeGreaterThanOrEqual(0)
    expect(rows[pdf + 1]).toBe('Export lines (Excel)')
    // The host's other rows keep their place, after it.
    expect(rows.indexOf('Edit layout')).toBeGreaterThan(pdf + 1)
  })

  it('says it is there, for hosts that must work with a package without it', () => {
    expect(ITEM_EDIT_EXPORT_MENU_SLOT).toBe(true)
  })
})
