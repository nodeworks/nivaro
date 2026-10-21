// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type LayoutBundle, type LayoutOp, newGroup, newPlacement } from '../../../lib/layout-ops'
import { otherFormSuggestions } from '../AddPanel'
import { LayoutEditorHostContext } from '../host'
import { Inspector } from '../inspector/Inspector'
import { FindingsStrip } from '../overview/FindingsStrip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => {}

const FIELDS = [
  { field: 'id', type: 'integer', label: null, interface: null },
  { field: 'code', type: 'string', label: 'Code', interface: 'input', note: 'Short code' },
  { field: 'vendor', type: 'integer', label: 'Vendor', interface: 'relation-picker' },
  { field: 'zone', type: 'integer', label: 'Zone', interface: 'relation-picker' }
]
const RELATIONS = [
  { many_collection: 'orders', many_field: 'vendor', one_collection: 'vendors', one_field: null },
  { many_collection: 'orders', many_field: 'zone', one_collection: 'zones', one_field: null }
]
const VENDOR_DEP = { cascade_filters: [{ parent_field: 'zone', filter_column: 'zone' }] }

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

function makeClient(over: Record<string, unknown> = {}) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p in over) {
        const v = over[p]
        return typeof v === 'function' ? (v as (c: Cmd) => unknown)(cmd) : v
      }
      if (p === '/collections/orders')
        return {
          data: {
            fields: FIELDS.map((f) =>
              f.field === 'vendor' ? { ...f, dependency_config: VENDOR_DEP } : f
            ),
            relations: RELATIONS,
            display_template: '{{code}}'
          }
        }
      if (p === '/collections/vendors')
        return { data: { fields: [], relations: [], display_template: '{{name}}' } }
      if (p.startsWith('/collections/')) return { data: { fields: [], relations: [] } }
      if (p === '/layout-inspect/orders/columns')
        return {
          data: {
            id: { type: 'int', max_length: null, precision: null, scale: null, nullable: false },
            code: { type: 'nvarchar', max_length: 6, precision: null, scale: null, nullable: true }
          }
        }
      if (p === '/layout-inspect/orders/value-lengths')
        return {
          data: {
            field: 'code',
            sampled: 300,
            filled: 280,
            p50: 20,
            p95: 45,
            max: 60,
            capped: false
          }
        }
      if (p === '/layout-inspect/orders/translations')
        return {
          data: {
            base: 'en',
            locales: ['es'],
            groups_supported: true,
            layouts: [
              { layout_id: 7, name: 'Order form', layout_type: 'grouped', missing: 3, total: 4 }
            ]
          }
        }
      if (p === '/items/orders/5') return { data: { id: 5, zone: 2, vendor: 9 } }
      if (p === '/items/orders') return { data: [{ id: 5, code: 'ORD-5' }] }
      if (p === '/layout-inspect/picker-preview')
        return {
          data: {
            total: 40,
            steps: [{ key: 'cascade', label: 'Cascade filters (Zone)', count: 6, applies: true }],
            excluded: 1,
            offered: 5,
            picker_filter: null,
            with_picker_filter: null,
            rows: [
              { id: 1, name: 'Acme' },
              { id: 2, name: 'Bolt' }
            ]
          }
        }
      return { data: [] }
    })
  }
  return { client, calls }
}

function bundle(): LayoutBundle {
  return {
    layout: {
      id: 7,
      collection: 'orders',
      name: 'Order form',
      layout_type: 'grouped',
      default_values: { code: 'TOO-LONG-CODE' }
    },
    rev: 'r1',
    groups: [newGroup('main', 'Main', 'section', null)],
    placements: [
      { ...newPlacement('code', 'main'), col_span: 3 },
      { ...newPlacement('vendor', 'main') }
    ]
  }
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
  document.body.innerHTML = ''
})

async function settle(ms = 150) {
  for (let i = 0; i < ms / 10; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

async function render(node: (client: unknown) => ReactNode, over?: Record<string, unknown>) {
  const { client, calls } = makeClient(over)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditorHostContext.Provider
            value={{ isAdmin: true, navigate: () => {}, warning: null, recordLink: () => '' }}
          >
            {node(client)}
          </LayoutEditorHostContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle()
  return { calls }
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle(80)
}

describe('column type and width (#2636, #2634)', () => {
  it('shows the column, warns what cannot fit, and applies the suggested width', async () => {
    const apply = vi.fn()
    await render(() => (
      <Inspector
        bundle={bundle()}
        target={{ kind: 'field', field: 'code', group_key: 'main' }}
        apply={apply}
        collection='orders'
      />
    ))
    const fit = host.querySelector('[data-setting="field.column_fit"]')
    expect(fit?.textContent).toContain('nvarchar(6)')
    expect(host.querySelector('[data-fit-warning="default"]')?.textContent).toContain(
      'column holds 6'
    )
    await click(host.querySelector('[data-width-check]'))
    const result = host.querySelector('[data-width-result]')
    expect(result?.textContent).toContain('95% of 280 values are 45 characters')
    expect(result?.textContent).toContain('cuts them off')
    await click(host.querySelector('[data-width-apply]'))
    const ops = apply.mock.calls.at(-1)?.[0] as LayoutOp[]
    expect(ops[0]).toMatchObject({ op: 'update_placement', patch: { col_span: 6 } })
  })
})

describe('translations (#2665)', () => {
  it('writes a label translation into the placement overrides', async () => {
    const apply = vi.fn()
    await render(() => (
      <Inspector
        bundle={bundle()}
        target={{ kind: 'field', field: 'code', group_key: 'main' }}
        apply={apply}
        collection='orders'
      />
    ))
    const toggle = [...host.querySelectorAll('[data-section-toggle]')].find((b) =>
      b.textContent?.includes('Translations')
    )
    expect(toggle?.textContent).toContain('2 missing')
    await click(toggle)
    const input = host.querySelector('input[aria-label="Label in ES"]') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'Código')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const ops = apply.mock.calls.at(-1)?.[0] as LayoutOp[]
    expect(ops[0]).toMatchObject({
      op: 'update_placement',
      patch: { overrides: { i18n: { es: { label: 'Código' } } } }
    })
  })

  it('translates a section name through a group update', async () => {
    const apply = vi.fn()
    await render(() => (
      <Inspector
        bundle={bundle()}
        target={{ kind: 'group', key: 'main' }}
        apply={apply}
        collection='orders'
      />
    ))
    const toggle = [...host.querySelectorAll('[data-section-toggle]')].find(
      (b) => b.textContent === 'Translations'
    )
    await click(toggle)
    const input = host.querySelector('input[aria-label="Name in ES"]') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'Principal')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const ops = apply.mock.calls.at(-1)?.[0] as LayoutOp[]
    expect(ops[0]).toEqual({
      op: 'group_update',
      key: 'main',
      patch: { i18n: JSON.stringify({ es: { label: 'Principal' } }) }
    })
  })
})

describe('picker option preview (#2637)', () => {
  it('compiles the cascade off the sample record and shows the count and options', async () => {
    const { calls } = await render(() => (
      <Inspector
        bundle={bundle()}
        target={{ kind: 'field', field: 'vendor', group_key: 'main' }}
        apply={vi.fn()}
        collection='orders'
      />
    ))
    const tab = [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Picker')
    await click(tab)
    expect(host.querySelector('[data-setting="field.picker_preview"]')).not.toBeNull()
    await click(host.querySelector('[data-setting="field.picker_preview"] button'))
    await settle()
    const option = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'ORD-5'
    )
    await click(option)
    await settle(300)
    const sent = calls.find((c) => c._path === '/layout-inspect/picker-preview')
    expect(sent?._body).toEqual({
      collection: 'vendors',
      steps: [{ key: 'cascade', label: 'Cascade filters (Zone)', filter: { zone: { _eq: 2 } } }],
      fields: ['name']
    })
    const box = host.querySelector('[data-picker-preview]')
    expect(box?.querySelector('[data-picker-offered]')?.textContent).toBe('5 options')
    expect(box?.textContent).toContain('Picker exclusions')
    expect(box?.querySelector('[data-picker-options]')?.textContent).toContain('Acme')
  })
})

describe('add panel suggestions (#2638)', () => {
  it('ranks fields other forms of the same kind carry and this one does not', () => {
    const b = bundle()
    const out = otherFormSuggestions(
      b,
      [
        { layout_id: 7, name: 'Order form', layout_type: 'grouped', fields: ['code'] },
        { layout_id: 8, name: 'Quick', layout_type: 'grouped', fields: ['zone', 'code'] },
        { layout_id: 9, name: 'Full', layout_type: 'grouped', fields: ['zone', 'id'] },
        { layout_id: 10, name: 'Read', layout_type: 'detail', fields: ['id'] }
      ],
      FIELDS
    )
    expect(out.map((o) => [o.field, o.count, o.of])).toEqual([
      ['zone', 2, 2],
      ['id', 1, 2]
    ])
    expect(out[0].names).toEqual(['Quick', 'Full'])
  })
})

describe('orphaned placements (#2650)', () => {
  it('removes a layout’s orphans in one ops batch on its current rev', async () => {
    const onChanged = vi.fn()
    const { calls } = await render(
      () => (
        <FindingsStrip
          collection='orders'
          rows={[]}
          loops={{ byLayout: new Map(), collection: [] }}
          checking={false}
          onRecheck={() => {}}
          onOpen={() => {}}
          onCompare={() => {}}
          onChanged={onChanged}
        />
      ),
      {
        '/layout-inspect/orders/orphans': {
          data: [
            {
              layout_id: 7,
              name: 'Order form',
              layout_type: 'grouped',
              placements: [
                { field: 'old_code', group_key: 'main', reason: 'column_dropped' },
                { field: '__widget_4__', group_key: 'main', reason: 'widget_deleted' }
              ]
            }
          ]
        },
        '/collection-layouts/7/bundle': {
          ...bundle(),
          rev: 'r9',
          placements: [
            newPlacement('old_code', 'main'),
            newPlacement('__widget_4__', 'main'),
            newPlacement('code', 'main')
          ]
        },
        '/collection-layouts/7/ops': { ok: true }
      }
    )
    // One strip: "2 things need a look", each kind a chip; the heading opens them all.
    expect(host.querySelector('[data-overview-findings]')?.textContent).toContain(
      '2 things need a look'
    )
    expect(host.querySelector('[data-findings-chip="orphans"]')?.textContent).toBe(
      '2 placements point at nothing'
    )
    await click(host.querySelector('[data-findings-toggle]'))
    expect(host.querySelector('[data-orphans]')?.textContent).toContain('column no longer exists')
    expect(host.querySelector('[data-missing-layout="7"]')?.textContent).toContain('3 of 4')
    await click(host.querySelector('[data-remove-orphans="7"]'))
    const op = calls.find((c) => c._path === '/collection-layouts/7/ops')
    expect(op?._body).toEqual({
      ops: [
        { op: 'remove', at: { field: 'old_code', group_key: 'main' } },
        { op: 'remove', at: { field: '__widget_4__', group_key: 'main' } }
      ],
      base_rev: 'r9',
      note: 'Remove placements that point at nothing'
    })
    expect(onChanged).toHaveBeenCalled()
  })
})
