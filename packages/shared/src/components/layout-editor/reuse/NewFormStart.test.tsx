// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { LayoutOverview } from '../overview/LayoutOverview'
import type { OverviewRow } from '../overview/types'
import { FormFromRecordButton } from './FormFromRecordButton'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// New form → Start with (#2594 template, #2616 field list) and Test a record →
// New form from this record (#2585): what each sends to POST /collection-layouts.

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

type Cmd = { _method?: string; _path: string; _body?: any; _params?: any }

const ROWS: OverviewRow[] = [
  {
    layout_id: 22,
    name: 'Main form',
    layout_type: 'grouped',
    slug: 'main',
    section: 'forms',
    reason: { kind: 'default' },
    is_default: true,
    new_menu: null,
    shape: { groups: 1, steps_or_tabs: 0, fields: 3 },
    references: [],
    warnings: []
  } as unknown as OverviewRow
]
const FIELDS = [
  { field: 'id', label: 'ID' },
  { field: 'title', label: 'Title' },
  { field: 'unit_price', label: 'Unit price' },
  { field: 'vendor_id', label: 'Vendor' }
]

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collection-layouts/overview') return { data: { rows: ROWS } }
      if (cmd._path.startsWith('/field-config/')) return { data: FIELDS }
      if (cmd._path === '/collections/orders')
        return { data: { fields: FIELDS.map((f) => ({ ...f })), relations: [] } }
      if (cmd._path === '/collection-layouts/templates')
        return {
          data: [
            {
              id: 5,
              kind: 'form',
              name: 'Starter',
              description: null,
              source_collection: 'sites',
              layout_type: 'grouped',
              fields: ['title', 'price'],
              sections: 2
            }
          ]
        }
      if (cmd._path === '/collection-layouts/explain')
        return { data: { layout_id: 22, reason: { kind: 'default' }, checked: [] } }
      if (cmd._path === '/items/orders/9')
        return { data: { id: 9, title: 'A', unit_price: null, vendor_id: 3 } }
      if (cmd._method === 'POST' && cmd._path === '/collection-layouts') return { data: { id: 77 } }
      return { data: [] }
    })
  }
  return { client, calls }
}

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
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}
const buttons = () => Array.from(document.querySelectorAll('button'))
const byText = (t: string) => buttons().find((b) => b.textContent?.trim() === t) as HTMLElement
const click = (el: Element) =>
  act(async () => {
    ;(el as HTMLElement).click()
  })
async function mount(client: unknown, onOpen = vi.fn(), onCreate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutOverview collection='orders' onOpen={onOpen} onCreate={onCreate} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => !!byText('New form'))
  return { onOpen, onCreate }
}
const posts = (calls: Cmd[]) =>
  calls.filter((c) => c._method === 'POST' && c._path === '/collection-layouts')

describe('New form → Start with', () => {
  it('a pasted field list creates a form with the matched fields in that order', async () => {
    const { client, calls } = makeClient()
    const { onCreate } = await mount(client)
    await click(byText('New form'))
    await settle(() => !!byText('Field list'))
    await click(byText('Field list'))
    const area = document.querySelector('textarea[aria-label="Field names"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(area, 'Vendor\nunit price\nnope')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(() => !!document.querySelector('[data-start-list-count]'))
    expect(document.querySelector('[data-start-list-count]')?.textContent).toContain('2 of 3')
    await click(byText('Create'))
    await settle(() => posts(calls).length > 0)
    expect(posts(calls)[0]._body).toMatchObject({
      collection: 'orders',
      layout_type: 'grouped',
      seed_fields: ['vendor_id', 'unit_price']
    })
    await settle(() => onCreate.mock.calls.length > 0)
    expect(onCreate).toHaveBeenCalledWith('grouped', 77)
  })

  it('a template from another collection sends its id and the suggested field map', async () => {
    const { client, calls } = makeClient()
    await mount(client)
    await click(byText('New form'))
    await settle(() => !!byText('Template'))
    await click(byText('Template'))
    await settle(() => !!document.querySelector('[data-start-template="5"]'))
    await click(document.querySelector('[data-start-template="5"]') as Element)
    await settle(() => !!document.querySelector('[data-reuse-map-row="price"]'))
    await settle(() => !(byText('Create') as HTMLButtonElement).disabled)
    await click(byText('Create'))
    await settle(() => posts(calls).length > 0)
    expect(posts(calls)[0]._body).toMatchObject({
      template_id: 5,
      field_map: { price: 'unit_price' }
    })
  })
})

describe('New form from this record', () => {
  it('makes a form from the fields the record has filled in, in field order', async () => {
    const { client, calls } = makeClient()
    const onMade = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <FormFromRecordButton
              collection='orders'
              recordId={9}
              recordLabel='PO 9'
              onMade={onMade}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    const btn = () => document.querySelector('[data-form-from-record]') as HTMLButtonElement
    await settle(() => !!btn() && !btn().disabled)
    await click(btn())
    await settle(() => onMade.mock.calls.length > 0)
    expect(posts(calls)[0]._body).toMatchObject({
      name: 'Form from PO 9',
      seed_fields: ['title', 'vendor_id']
    })
    expect(onMade).toHaveBeenCalledWith(77)
  })
})
