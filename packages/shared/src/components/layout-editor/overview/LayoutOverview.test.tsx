// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { LayoutOverview } from './LayoutOverview'
import type { OverviewRow } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// inventory_request on EFP_Development, as GET /collection-layouts/overview returns it.
const shape = (steps: number, fields: number) => ({ groups: steps, steps_or_tabs: steps, fields })
const IR_ROWS: OverviewRow[] = [
  {
    layout_id: 22,
    name: 'Sparing Order',
    layout_type: 'grouped',
    slug: 'sparing_order',
    section: 'forms',
    reason: {
      kind: 'record_rule',
      rules: [
        { field: 'is_unit_specific_order', op: 'eq', value: 'false' },
        { field: 'is_sparing', op: 'eq', value: 'true' }
      ]
    },
    is_default: false,
    new_menu: { label: 'Sparing', hidden: false },
    shape: shape(4, 31),
    references: [],
    warnings: []
  },
  {
    layout_id: 23,
    name: 'Non-Unit Order',
    layout_type: 'grouped',
    slug: 'non_unit_order',
    section: 'forms',
    reason: {
      kind: 'record_rule',
      rules: [
        { field: 'is_unit_specific_order', op: 'eq', value: 'false' },
        { field: 'is_sparing', op: 'eq', value: 'false' }
      ]
    },
    is_default: false,
    new_menu: { label: 'Non-Unit', hidden: false },
    shape: shape(4, 29),
    references: [],
    warnings: []
  },
  {
    layout_id: 24,
    name: 'Unit Order',
    layout_type: 'grouped',
    slug: 'unit_order',
    section: 'forms',
    reason: { kind: 'default' },
    is_default: true,
    new_menu: { label: 'Unit (Node Splits / Genesis)', hidden: false },
    shape: shape(4, 34),
    references: [],
    warnings: []
  },
  {
    layout_id: 58,
    name: 'Warehouse Submission',
    layout_type: 'grouped',
    slug: 'warehouse_submission',
    section: 'link_only',
    reason: { kind: 'slug' },
    is_default: false,
    new_menu: { label: 'Warehouse Submission', hidden: true },
    shape: shape(1, 6),
    references: [{ kind: 'transition', id: 7, label: 'Submit to Warehouse dialog' }],
    warnings: []
  },
  {
    layout_id: 87,
    name: 'Summary',
    layout_type: 'summary',
    slug: null,
    section: 'other_views',
    reason: { kind: 'type_use', type_use: 'Read mode (Summary button)' },
    is_default: true,
    new_menu: null,
    shape: shape(0, 22),
    references: [],
    warnings: []
  },
  {
    layout_id: 59,
    name: 'IR Export',
    layout_type: 'file',
    slug: null,
    section: 'other_views',
    reason: { kind: 'type_use', type_use: 'Generate PDF' },
    is_default: true,
    new_menu: null,
    shape: shape(0, 18),
    references: [],
    warnings: []
  },
  {
    layout_id: 46,
    name: 'Drill Columns',
    layout_type: 'table',
    slug: null,
    section: 'other_views',
    reason: { kind: 'type_use', type_use: 'List drill-down columns' },
    is_default: false,
    new_menu: null,
    shape: shape(0, 9),
    references: [{ kind: 'grid', id: 'materials', label: 'Materials grid on Unit Order' }],
    warnings: []
  },
  {
    layout_id: 20,
    name: 'Default',
    layout_type: 'grouped',
    slug: null,
    section: 'unused',
    reason: { kind: 'fallback' },
    is_default: false,
    new_menu: null,
    shape: shape(0, 0),
    references: [],
    warnings: []
  }
]

const FIELDS = [
  { field: 'is_unit_specific_order', label: null, type: 'boolean', options: null },
  { field: 'is_sparing', label: null, type: 'boolean', options: null }
]

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

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
  document.body.innerHTML = ''
})

function makeClient(
  rows: OverviewRow[],
  opts: { warning?: string | null; onDelete?: (cmd: Cmd) => unknown } = {}
) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collection-layouts/overview') {
        return { data: { rows, warning: opts.warning ?? null } }
      }
      if (cmd._path.startsWith('/field-config/')) return { data: FIELDS }
      if (cmd._path.startsWith('/collections/')) return { data: { display_template: null } }
      if (cmd._path === '/roles') return { data: [] }
      if (cmd._path === '/items/inventory_request') {
        return { data: [{ id: 32833, name: 'IR 32833' }] }
      }
      if (cmd._path === '/collection-layouts/explain') {
        return {
          data: {
            layout_id: 24,
            reason: { kind: 'default' },
            checked: [
              { layout_id: 22, matched: false, why: 'is sparing does not hold' },
              { layout_id: 23, matched: false, why: 'is unit-specific' },
              { layout_id: 24, matched: true, why: 'the default' }
            ]
          }
        }
      }
      if (cmd._method === 'DELETE') return opts.onDelete ? opts.onDelete(cmd) : { data: null }
      if (cmd._method === 'POST' && cmd._path === '/collection-layouts') {
        return { data: { id: 101 } }
      }
      return { data: null }
    })
  }
  return { client, calls }
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mount(
  client: { request: unknown },
  props: Partial<Parameters<typeof LayoutOverview>[0]> = {}
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutOverview
            collection='inventory_request'
            onOpen={props.onOpen ?? (() => {})}
            onCreate={props.onCreate}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
}

const text = () => document.body.textContent ?? ''

function button(label: string | RegExp, scope: ParentNode = document.body): HTMLButtonElement {
  const all = Array.from(scope.querySelectorAll('button'))
  const hit = all.find((b) =>
    typeof label === 'string'
      ? b.textContent?.trim() === label || b.getAttribute('aria-label') === label
      : label.test(b.textContent ?? '') || label.test(b.getAttribute('aria-label') ?? '')
  )
  if (!hit) throw new Error(`no button ${label}`)
  return hit
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}

describe('LayoutOverview', () => {
  it('lists the four sections in the order records are matched', async () => {
    const { client } = makeClient(IR_ROWS)
    await mount(client)
    await settle(() => text().includes('Unit Order'))

    const headings = Array.from(document.querySelectorAll('[data-overview-section]')).map((el) =>
      el.getAttribute('data-overview-section')
    )
    expect(headings).toEqual(['forms', 'link_only', 'other_views', 'unused'])
    const t = text()
    expect(t).toContain('Forms people fill in — checked in this order')
    expect(t).toContain('Opened by a link or button only')
    expect(t).toContain('Other views of the same record')
    expect(t).toContain('Unused')

    const names = Array.from(document.querySelectorAll('[data-layout-row]')).map((el) =>
      el.getAttribute('data-layout-row')
    )
    expect(names).toEqual(['22', '23', '24', '58', '87', '59', '46', '20'])

    const sparing = document.querySelector('[data-layout-row="22"]')?.textContent ?? ''
    expect(sparing).toContain('is not unit specific order and is sparing')
    expect(sparing).toContain('rule')
    expect(sparing).toContain('4 steps · 31 fields')
    expect(sparing).toContain('“Sparing” on New menu')

    const unit = document.querySelector('[data-layout-row="24"]')?.textContent ?? ''
    expect(unit).toContain('anything else')
    expect(unit).toContain('default')
    expect(unit).toContain('“Unit (Node Splits / Genesis)” on New menu')

    const warehouse = document.querySelector('[data-layout-row="58"]')?.textContent ?? ''
    expect(warehouse).toContain('Submit to Warehouse dialog')
    expect(warehouse).toContain('hidden from New menu')

    expect(document.querySelector('[data-layout-row="87"]')?.textContent).toContain(
      'Read mode (Summary button)'
    )
    // Forms rows are not draggable; their order is computed.
    expect(document.querySelector('[data-layout-row="22"] [data-drag-handle]')).toBeNull()
    // No staging banner on development.
    expect(t).not.toContain('replaced every night')
  })

  it('shows the staging warning when the instance is overwritten nightly', async () => {
    const warning =
      'Layouts here are replaced every night from development. Make lasting changes on development.'
    const { client } = makeClient(IR_ROWS, { warning })
    await mount(client)
    await settle(() => text().includes('Unit Order'))
    expect(text()).toContain(warning)
  })

  it('lists references before deleting, and the ones the server finds', async () => {
    const { client, calls } = makeClient(IR_ROWS, {
      onDelete: () => {
        throw {
          status: 409,
          response: {
            error: 'This layout is still used',
            references: [{ kind: 'queue', id: 3, label: 'Queue “Open IRs”' }]
          }
        }
      }
    })
    await mount(client)
    await settle(() => text().includes('Drill Columns'))

    // Row menu → Delete on a referenced layout lists what uses it, inline.
    const drill = document.querySelector('[data-layout-row="46"]') as HTMLElement
    await click(button('Layout actions', drill))
    await settle(() => text().includes('Duplicate as summary') || text().includes('Rename'))
    await click(button('Delete…'))
    await settle(() => !!document.querySelector('[data-delete-confirm="46"]'))
    const confirm = document.querySelector('[data-delete-confirm="46"]') as HTMLElement
    expect(confirm.textContent).toContain('Materials grid on Unit Order')

    // The server can still find a reference; it is listed and nothing is deleted.
    await click(button('Delete layout', confirm))
    await settle(() => text().includes('Queue “Open IRs”'))
    expect(text()).toContain('Queue “Open IRs”')
    expect(calls.some((c) => c._method === 'DELETE' && c._path === '/collection-layouts/46')).toBe(
      true
    )
  })

  it('offers an inline delete on unused layouts', async () => {
    const { client, calls } = makeClient(IR_ROWS)
    await mount(client)
    await settle(() => text().includes('Default'))
    const unused = document.querySelector('[data-layout-row="20"]') as HTMLElement
    await click(button('Delete', unused))
    const confirm = document.querySelector('[data-delete-confirm="20"]') as HTMLElement
    expect(confirm.textContent).toContain('Nothing uses this layout')
    await click(button('Delete layout', confirm))
    await settle(() => calls.some((c) => c._method === 'DELETE'))
    expect(calls.some((c) => c._method === 'DELETE' && c._path === '/collection-layouts/20')).toBe(
      true
    )
  })

  it('explains layouts and creates the first form when there are none', async () => {
    const onCreate = vi.fn()
    const { client, calls } = makeClient([])
    await mount(client, { onCreate })
    await settle(() => text().includes('Create first form'))
    expect(text()).toContain('No forms yet')
    expect(document.querySelector('[data-overview-section]')).toBeNull()

    await click(button('Create first form'))
    await settle(() => onCreate.mock.calls.length > 0)
    const post = calls.find((c) => c._method === 'POST' && c._path === '/collection-layouts')
    expect(post?._body).toMatchObject({
      collection: 'inventory_request',
      layout_type: 'grouped',
      seed_fields: true
    })
    expect(onCreate).toHaveBeenCalledWith('grouped', 101)
  })

  it('opens a layout from its name', async () => {
    const onOpen = vi.fn()
    const { client } = makeClient(IR_ROWS)
    await mount(client, { onOpen })
    await settle(() => text().includes('Sparing Order'))
    await click(button('Sparing Order'))
    expect(onOpen).toHaveBeenCalledWith(22)
  })

  it('lights up the form a tested record gets, with the reason', async () => {
    const { client, calls } = makeClient(IR_ROWS)
    await mount(client)
    await settle(() => text().includes('Unit Order'))
    await click(button('Test a record…'))
    await settle(() => text().includes('IR 32833'))
    await click(button('IR 32833'))
    await click(button('Show its form'))
    await settle(() => !!document.querySelector('[data-layout-row="24"][data-tested]'))

    expect(document.querySelector('[data-layout-row="24"]')?.getAttribute('data-tested')).toBe(
      'true'
    )
    expect(document.querySelector('[data-layout-row="22"]')?.hasAttribute('data-tested')).toBe(
      false
    )
    expect(text()).toContain(
      'IR 32833 opens Unit Order — no rule caught it, so it gets the default'
    )
    expect(text()).toContain('is sparing does not hold')
    const explain = calls.find((c) => c._path === '/collection-layouts/explain')
    expect(explain?._params).toMatchObject({ collection: 'inventory_request', item: 32833 })
    expect(explain?._params).not.toHaveProperty('role_id')
  })

  it('drags other views only among layouts of the same kind', async () => {
    const extraTable: OverviewRow = {
      ...IR_ROWS[6],
      layout_id: 47,
      name: 'Materials Columns',
      references: []
    }
    const rows = [...IR_ROWS.slice(0, 7), extraTable, IR_ROWS[7]]
    const { client } = makeClient(rows)
    await mount(client)
    await settle(() => text().includes('Materials Columns'))
    const handles = Array.from(document.querySelectorAll('[data-drag-handle]')).map((h) =>
      h.closest('[data-layout-row]')?.getAttribute('data-layout-row')
    )
    expect(handles).toEqual(['46', '47'])
    expect(text()).toContain('Drag to change which one is used first')
  })

  it('says tabs when the form uses tabs', async () => {
    const tabbed: OverviewRow = {
      ...IR_ROWS[2],
      shape: { groups: 3, steps_or_tabs: 3, fields: 12, container_mode: 'tabs' }
    }
    const { client } = makeClient([IR_ROWS[0], tabbed])
    await mount(client)
    await settle(() => text().includes('Unit Order'))
    expect(document.querySelector('[data-layout-row="24"]')?.textContent).toContain(
      '3 tabs · 12 fields'
    )
    expect(document.querySelector('[data-layout-row="22"]')?.textContent).toContain(
      '4 steps · 31 fields'
    )
  })

  describe('inline rename', () => {
    // The input goes away on Enter / Escape and the browser blurs it on the way
    // out; that blur can reach the last render's onBlur, with the typed text still
    // in its closure, before the re-render lands. Same act = same window here.
    async function startRename(typed: string) {
      const { client, calls } = makeClient(IR_ROWS)
      await mount(client)
      await settle(() => text().includes('Sparing Order'))
      const row = document.querySelector('[data-layout-row="22"]') as HTMLElement
      await click(button('Layout actions', row))
      await settle(() => text().includes('Rename'))
      await click(button('Rename'))
      await settle(() => !!document.querySelector('input[aria-label="Layout name"]'))
      const input = document.querySelector('input[aria-label="Layout name"]') as HTMLInputElement
      expect(document.activeElement).toBe(input)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(input, typed)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      return { input, calls }
    }

    const keyThenBlur = (el: HTMLElement, k: string) =>
      act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      })
    const patches = (calls: Cmd[]) =>
      calls.filter((c) => c._method === 'PATCH' && c._path === '/collection-layouts/22')

    it('Escape drops the typed name, even when the input blurs on the way out', async () => {
      const { input, calls } = await startRename('Spare Parts Order')
      await keyThenBlur(input, 'Escape')
      await settle(() => !document.querySelector('input[aria-label="Layout name"]'))
      expect(document.querySelector('input[aria-label="Layout name"]')).toBeNull()
      expect(patches(calls)).toHaveLength(0)
    })

    it('Enter saves the name once', async () => {
      const { input, calls } = await startRename('Spare Parts Order')
      await keyThenBlur(input, 'Enter')
      await settle(() => patches(calls).length > 0)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30))
      })
      expect(patches(calls)).toHaveLength(1)
      expect(patches(calls)[0]._body).toEqual({ name: 'Spare Parts Order' })
    })
  })
})
