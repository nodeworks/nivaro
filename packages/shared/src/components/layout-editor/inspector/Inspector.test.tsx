// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import {
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'
import { LayoutEditorHostContext } from '../host'
import parityRows from '../parity-keys.json'
import { Inspector } from './Inspector'
import { CONDITION_OPS } from './kit'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no scrollIntoView; the choice lists call it on open.
Element.prototype.scrollIntoView ??= () => {}

// ── Fixture: an `orders` collection with every kind of field ────────────────

const FIELDS = [
  { field: 'id', type: 'integer', label: null, interface: null },
  {
    field: 'title',
    type: 'string',
    label: 'Title',
    interface: 'input',
    options: { input_mask: 'AAA' }
  },
  { field: 'status', type: 'string', label: 'Status', interface: 'input' },
  {
    field: 'amount',
    type: 'decimal',
    label: 'Amount',
    interface: 'input',
    options: { format: 'currency', currency: 'USD' }
  },
  { field: 'due', type: 'datetime', label: 'Due', interface: 'datetime' },
  {
    field: 'vendor',
    type: 'integer',
    label: 'Vendor',
    interface: 'relation-picker',
    dependency_config: {
      cascade_filters: [
        {
          parent_field: 'region',
          filter_column: 'region_id',
          clear_on_parent_change: true,
          show_all_if_no_parent: true,
          value_map: { north: 'N' }
        },
        {
          parent_field: 'region',
          filter_column: 'zone_id',
          clear_on_parent_change: true,
          show_all_if_no_parent: true
        }
      ]
    }
  },
  { field: 'region', type: 'integer', label: 'Region', interface: 'relation-picker' },
  { field: 'total', type: 'decimal', label: 'Total', interface: 'input', computed_type: 'rollup' },
  {
    field: 'lines',
    type: 'alias',
    label: 'Lines',
    interface: 'inline-table',
    options: {
      column_presets: [
        { name: 'Short', columns: ['qty'] },
        { name: 'Long', columns: ['qty', 'note'] }
      ]
    }
  },
  { field: 'grid_lines', type: 'alias', label: 'Grid lines', interface: 'inline-grid' }
]

const RELATIONS = [
  {
    many_collection: 'orders',
    many_field: 'vendor',
    one_collection: 'vendors',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'orders',
    many_field: 'region',
    one_collection: 'regions',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'order_lines',
    many_field: 'order',
    one_collection: 'orders',
    one_field: 'lines',
    junction_field: null
  },
  {
    many_collection: 'order_grid',
    many_field: 'order',
    one_collection: 'orders',
    one_field: 'grid_lines',
    junction_field: null
  },
  {
    many_collection: 'orders_tags',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'tags',
    junction_field: 'tags_id'
  },
  {
    many_collection: 'orders_tags',
    many_field: 'tags_id',
    one_collection: 'tags',
    one_field: null,
    junction_field: 'orders_id'
  },
  {
    many_collection: 'orders_files',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'attachments',
    junction_field: 'nivaro_files_id'
  },
  {
    many_collection: 'orders_files',
    many_field: 'nivaro_files_id',
    one_collection: 'nivaro_files',
    one_field: null,
    junction_field: 'orders_id'
  }
]

const CHILD_FIELDS = [
  { field: 'id', type: 'integer', label: null },
  { field: 'product', type: 'integer', label: 'Product', interface: 'relation-picker' },
  { field: 'qty', type: 'integer', label: 'Qty' },
  { field: 'note', type: 'string', label: 'Note' },
  { field: 'status', type: 'string', label: 'Status' },
  { field: 'amount', type: 'decimal', label: 'Amount' }
]

const CHILD_RELATIONS = [
  {
    many_collection: 'order_lines',
    many_field: 'product',
    one_collection: 'products',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'order_lines',
    many_field: 'order',
    one_collection: 'orders',
    one_field: 'lines',
    junction_field: null
  },
  {
    many_collection: 'allocations',
    many_field: 'line',
    one_collection: 'order_lines',
    one_field: 'allocations',
    junction_field: null
  }
]

const binding = (key: string, value: unknown) => ({
  key,
  binding_type: 'static',
  binding_value: typeof value === 'string' ? value : JSON.stringify(value)
})

const place = (field: string, group: string | null, extra: Partial<PlacementRow> = {}) => ({
  ...newPlacement(field, group),
  ...extra
})
const group = (
  key: string,
  type: string,
  parent: string | null,
  extra: Partial<GroupRow> = {}
) => ({
  ...newGroup(key, key.replace('_', ' '), type, parent),
  ...extra
})

const LINES_OPTIONS = {
  parent_cascades: [{ parent_field: 'vendor', child_field: 'product' }],
  unique_by: ['product'],
  drawer_relations: ['allocations'],
  row_rules: [
    {
      trigger_field: 'product',
      trigger_op: 'eq',
      trigger_value: '7',
      trigger_fields: ['qty'],
      target_field: 'note',
      target_type: 'set',
      target_value: 'a',
      sort: 0
    },
    {
      trigger_field: 'qty',
      target_field: 'note',
      target_type: 'precedence',
      sources: [
        { source_type: 'relation_field', source_field: 'product', source_related_field: 'name' }
      ],
      sort: 1
    },
    { trigger_field: 'status', target_field: 'qty', target_type: 'lock', sort: 2 }
  ]
}

function makeBundle(layout: Record<string, unknown> = {}): LayoutBundle {
  return {
    layout: {
      id: 7,
      collection: 'orders',
      name: 'Order form',
      is_active: false,
      layout_type: 'grouped',
      ...layout
    },
    rev: 'r1',
    groups: [
      group('main', 'section', null, {
        summary_fields: JSON.stringify([{ field: 'lines', agg: 'sum', agg_field: 'amount' }]),
        swap_config: JSON.stringify({
          enabled: true,
          primary_field: 'vendor',
          alternate_fields: []
        })
      }),
      group('steps', 'container', null, { tab_mode: 'steps' }),
      group('step_one', 'tab', 'steps'),
      group('note_block', 'content', null, { content: 'Read this', content_tone: 'info' })
    ],
    placements: [
      place('title', 'main'),
      place('amount', 'main'),
      place('due', 'main'),
      place('vendor', 'main', {
        overrides: { interface: 'relation-grouped' },
        input_bindings: [
          binding('__inline_display__', {
            fields: [
              { field: 'name', label: null, format: null },
              { field: 'code', label: 'Code', format: 'date' }
            ],
            separator: ', '
          })
        ],
        lock_conditions: JSON.stringify([
          { type: 'pipeline_state', state_keys: [] },
          { type: 'pipeline_state', pipeline_id: 'p1', state_keys: ['open'] },
          { type: 'role', role_ids: [] }
        ])
      }),
      place('total', 'main'),
      place('tags', 'main', { overrides: { options: { max_values: 2 } } }),
      place('attachments', 'main', { overrides: { interface: 'files-m2m' } }),
      place('lines', 'main', { overrides: { options: LINES_OPTIONS }, show_row_revisions: true }),
      place('grid_lines', 'main'),
      place('status', 'step_one'),
      place('__pipeline__', null),
      place('__pdf__', 'main'),
      place('__widget_5__', 'main', { widget_id: 5 }),
      place('title', '__header__'),
      place('__subtitle__', null, {
        input_bindings: [
          binding('__subtitle_config__', {
            fields: [{ field: 'status', label: 'Status' }],
            separator: ' | '
          })
        ]
      })
    ]
  }
}

const PARENT: LayoutBundle = {
  layout: { id: 3, collection: 'orders', name: 'Base order', is_active: true },
  rev: 'p1',
  groups: [group('shipping', 'section', null)],
  placements: [place('region', 'shipping', { col_span: 6 })]
}

// ── Harness ─────────────────────────────────────────────────────────────────

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

const failPatch: { next: string | null } = { next: null }

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (cmd._method === 'PATCH') {
        if (failPatch.next) throw Object.assign(new Error(failPatch.next), { status: 400 })
        return { data: { ok: true } }
      }
      if (p === '/widgets-internal/5/placements')
        return {
          data: [
            { layout_id: 7, name: 'Order form', collection: 'orders' },
            { layout_id: 8, name: 'Order summary', collection: 'orders' }
          ]
        }
      if (p === '/report-studio') return { data: [{ id: 'r1', name: 'Spend report' }] }
      if (p === '/report-studio/r1')
        return { data: { widgets: [{ id: 'w1', type: 'kpi', title: 'Total' }] } }
      if (p === '/collections/orders') return { data: { fields: FIELDS, relations: RELATIONS } }
      if (p === '/collections/order_lines')
        return { data: { fields: CHILD_FIELDS, relations: CHILD_RELATIONS } }
      if (p.startsWith('/collections/')) return { data: { fields: [], relations: [] } }
      if (p === '/field-config/order_lines') return { data: CHILD_FIELDS }
      if (p === '/field-config/orders') return { data: FIELDS }
      if (p.startsWith('/field-config/')) return { data: [] }
      if (p === '/data-model/relations/for/order_lines') return { data: CHILD_RELATIONS }
      if (p === '/data-model/relations/for/orders') return { data: RELATIONS }
      if (p.startsWith('/data-model/relations/for/')) return { data: [] }
      if (p.endsWith('/impact'))
        return {
          data: [
            { source: 'layout', label: "Layout 'Other form'", detail: 'field assignment' },
            { source: 'queue-source', label: "Queue 'Open orders'", detail: 'extra field' }
          ],
          total: 2
        }
      if (p === '/roles') return { data: [{ id: 'r-1', name: 'Buyer' }] }
      if (p === '/pipelines')
        return { data: [{ id: 'p1', name: 'Order flow', collections: ['orders'] }] }
      if (p === '/pipelines/p1')
        return { data: { states: [{ id: 's1', key: 'open', label: 'Open' }] } }
      if (p === '/widgets-internal')
        return {
          data: [
            {
              id: 5,
              name: 'Spend',
              widget_type: 'report_widget',
              config: { report_id: 'r1', widget_id: 'w1' }
            }
          ]
        }
      if (p === '/collection-layouts/3/bundle') return PARENT
      if (p === '/collection-layouts') return { data: [] }
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
  document.body.innerHTML = ''
})

async function settle(ms = 120) {
  for (let i = 0; i < ms / 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mount(
  target: DesignTarget | null,
  opts: {
    bundle?: LayoutBundle
    inheritedFrom?: string | null
    navigate?: (to: string) => void
    openLayout?: (id: number) => void
    /** Fill the query cache first (another screen's reads). */
    seed?: (qc: QueryClient) => void
  } = {}
) {
  const { client, calls } = makeClient()
  const apply = vi.fn()
  const flush = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  opts.seed?.(qc)
  const draw = (bundle: LayoutBundle) =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditorHostContext.Provider
            value={{
              isAdmin: true,
              navigate: opts.navigate ?? (() => {}),
              warning: null,
              recordLink: () => ''
            }}
          >
            <Inspector
              bundle={bundle}
              target={target}
              apply={apply}
              flush={flush}
              collection='orders'
              inheritedFrom={opts.inheritedFrom}
              openLayout={opts.openLayout}
            />
          </LayoutEditorHostContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  await act(async () => {
    draw(opts.bundle ?? makeBundle())
  })
  await settle()
  /** The draft changed under the inspector (an autosave answer, undo…). */
  const redraw = async (bundle: LayoutBundle) => {
    await act(async () => {
      draw(bundle)
    })
  }
  return { apply, flush, calls, qc, redraw }
}

const CONTROL =
  'input, textarea, button, select, [role="switch"], [role="combobox"], [role="button"]'
const hasControl = (el: Element) => el.matches(CONTROL) || !!el.querySelector(CONTROL)
/** Parity rows that show something rather than change it. */
const READOUTS = new Set([
  'group.key',
  'field.impact',
  'field.row_rules_lint',
  'field.drawer_relations.hint',
  'inspector.enforcement_note'
])

/** Keys whose marker holds a real control (or is a read-out row). */
const settingsIn = () =>
  [...host.querySelectorAll('[data-setting]')]
    .filter((e) => hasControl(e) || READOUTS.has(e.getAttribute('data-setting') as string))
    .map((e) => e.getAttribute('data-setting') as string)

/** Setting rows missing their one-line effect or their scope tag. */
const rowProblems = new Set<string>()
const scopesSeen = new Set<string>()
function checkRows() {
  for (const row of host.querySelectorAll('[data-setting-row]')) {
    const k = row.getAttribute('data-setting') as string
    const effect = row.querySelector(':scope > [data-effect]')
    if (!effect?.textContent?.trim()) rowProblems.add(`${k}: no effect sentence`)
    const scope = row.querySelector(':scope > div [data-scope]')
    if (!scope) rowProblems.add(`${k}: no scope tag`)
    else if (hasControl(row)) scopesSeen.add(scope.getAttribute('data-scope') as string)
  }
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle(60)
}

/** Every control on every tab (row rules expanded). */
async function collectAll(): Promise<string[]> {
  checkRows()
  const out = new Set(settingsIn())
  const tabs = [...host.querySelectorAll('[data-inspector-tab]')].map((t) =>
    t.getAttribute('data-inspector-tab')
  )
  for (const t of tabs) {
    await click(host.querySelector(`[data-inspector-tab="${t}"]`))
    for (const h of [...host.querySelectorAll('[role="button"][aria-expanded="false"]')])
      await click(h)
    checkRows()
    for (const k of settingsIn()) out.add(k)
  }
  return [...out]
}

const field = (f: string, g: string | null = 'main'): DesignTarget => ({
  kind: 'field',
  field: f,
  group_key: g
})

/** Types into a focused input / textarea the way React sees it. */
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function leave(el: Element) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await settle(20)
}

const withPlacement = (b: LayoutBundle, field: string, patch: Partial<PlacementRow>) => ({
  ...b,
  placements: b.placements.map((p) =>
    p.field === field && p.group_key === 'main' ? { ...p, ...patch } : p
  )
})

interface ParityRow {
  key: string
  home: string | null
  status: string
  layout_types: string[]
}

describe('Inspector', () => {
  it('every parity-map row with home Inspector renders a control', async () => {
    const seen = new Set<string>()
    const grouped: DesignTarget[] = [
      ...[
        'title',
        'amount',
        'due',
        'vendor',
        'total',
        'tags',
        'attachments',
        'lines',
        'grid_lines'
      ].map((f) => field(f)),
      { kind: 'group', key: 'main' },
      { kind: 'group', key: 'steps' },
      { kind: 'group', key: 'step_one' },
      { kind: 'group', key: 'note_block' },
      { kind: 'slot', field: '__pipeline__', group_key: null },
      { kind: 'slot', field: '__pdf__', group_key: 'main' },
      { kind: 'slot', field: '__widget_5__', group_key: 'main' },
      { kind: 'header', field: 'title' },
      { kind: 'header', field: '__subtitle__' }
    ]
    for (const t of grouped) {
      await mount(t)
      for (const k of await collectAll()) seen.add(k)
    }
    // Addendum-only settings
    await mount(field('title'), { bundle: makeBundle({ layout_type: 'addendum' }) })
    for (const k of await collectAll()) seen.add(k)
    // An inherited placement
    await mount(field('region', 'shipping'), {
      bundle: { ...makeBundle({ parent_layout_id: 3 }) },
      inheritedFrom: 'Base order'
    })
    for (const k of settingsIn()) seen.add(k)
    // The every-form confirm opens on a global change
    await mount(field('amount'))
    await click(
      [...host.querySelectorAll('[data-setting="field.format"] button')].find(
        (b) => b.textContent === 'Decimal'
      )
    )
    for (const k of settingsIn()) seen.add(k)

    // A cascade filter's column is picked in its add / edit form
    await mount(field('vendor'))
    await click(host.querySelector('[data-inspector-tab="picker"]'))
    await click(
      [...host.querySelectorAll('button')].find((x) =>
        /Add (another|cascade) filter/.test(x.textContent ?? '')
      )
    )
    for (const k of settingsIn()) seen.add(k)

    // "This form only" / "Every form" sits on the rows of real controls.
    if (scopesSeen.has('form') && scopesSeen.has('field')) seen.add('inspector.scope_marker')

    const required = (parityRows as ParityRow[]).filter(
      (r) => r.home === 'inspector' && r.status !== 'retired'
    )
    expect(required.length).toBeGreaterThan(170)
    const missing = required.map((r) => r.key).filter((k) => !seen.has(k))
    expect(missing).toEqual([])
    // Every setting says what it does and where it applies.
    expect([...rowProblems]).toEqual([])
  }, 60_000)

  it('global key asks before saving and lists affected layouts', async () => {
    const { apply, calls } = await mount(field('amount'))
    await click(
      [...host.querySelectorAll('[data-setting="field.format"] button')].find(
        (b) => b.textContent === 'Decimal'
      )
    )
    expect(calls.some((c) => c._method === 'PATCH')).toBe(false)
    const confirm = host.querySelector('[data-global-confirm]')
    expect(confirm?.textContent).toContain("Layout 'Other form'")
    expect(confirm?.textContent).toContain('every form')

    await click(host.querySelector('[data-global-save]'))
    const patch = calls.find((c) => c._method === 'PATCH')
    expect(patch?._path).toBe('/field-config/orders/amount')
    expect(patch?._body).toEqual({ options: { format: 'decimal', currency: 'USD' } })
    expect(apply).not.toHaveBeenCalled()
    expect(host.querySelector('[data-global-confirm]')).toBeNull()
  })

  it('cancelling a global change writes nothing', async () => {
    const { calls } = await mount(field('amount'))
    await click(
      [...host.querySelectorAll('[data-setting="field.format"] button')].find(
        (b) => b.textContent === 'Integer'
      )
    )
    await click(host.querySelector('[data-global-cancel]'))
    expect(calls.some((c) => c._method === 'PATCH')).toBe(false)
    expect(host.querySelector('[data-global-confirm]')).toBeNull()
  })

  it('layout-local key emits one op', async () => {
    const { apply } = await mount(field('title'))
    await click(host.querySelector('[data-inspector-tab="rules"]'))
    await click(host.querySelector('[data-setting="field.required"] [role="switch"]'))
    expect(apply).toHaveBeenCalledTimes(1)
    const [ops, opts] = apply.mock.calls[0]
    expect(ops).toEqual([
      {
        op: 'update_placement',
        at: { field: 'title', group_key: 'main' },
        patch: { overrides: { required: true } }
      }
    ])
    expect(opts.label).toBe('Make Title required')
  })

  it('types text as one coalesced setting and sends it on blur', async () => {
    const { apply, flush } = await mount(field('title'))
    const input = host.querySelector('[data-setting="field.label"] input') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'Subject')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const [ops, opts] = apply.mock.calls.at(-1) ?? []
    expect(ops[0].patch).toEqual({ overrides: { label: 'Subject' } })
    expect(opts).toEqual({ label: 'Rename Title', text: true })
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(flush).toHaveBeenCalled()
  })

  it('default-form-only label shows on a non-default layout', async () => {
    await mount(field('lines'))
    await click(host.querySelector('[data-inspector-tab="grid"]'))
    const rules = host.querySelector('[data-setting="field.row_rules"]')
    expect(rules?.textContent).toContain('Enforced on the default form only')

    await mount(field('lines'), { bundle: makeBundle({ is_active: true }) })
    await click(host.querySelector('[data-inspector-tab="grid"]'))
    expect(host.textContent).not.toContain('Enforced on the default form only')
  })

  it('offers prefill from the record on addendum layouts only', async () => {
    await mount(field('title'), { bundle: makeBundle({ layout_type: 'addendum' }) })
    await click(host.querySelector('[data-inspector-tab="rules"]'))
    expect(host.querySelector('[data-setting="field.prefill_from_parent"]')).not.toBeNull()

    await mount(field('title'))
    await click(host.querySelector('[data-inspector-tab="rules"]'))
    expect(host.querySelector('[data-setting="field.prefill_from_parent"]')).toBeNull()
  })

  it('inherited placements are read-only with Override here and Edit in parent', async () => {
    const openLayout = vi.fn()
    const { apply } = await mount(field('region', 'shipping'), {
      bundle: makeBundle({ parent_layout_id: 3 }),
      inheritedFrom: 'Base order',
      openLayout
    })
    expect(host.textContent).toContain('Base order')
    expect(host.querySelector('[data-inherited-view] fieldset[disabled]')).not.toBeNull()

    // Tabs still switch so the parent's settings can be read.
    await click(host.querySelector('[data-inspector-tab="rules"]'))
    expect(host.querySelector('[data-inspector-tab="rules"]')?.getAttribute('aria-selected')).toBe(
      'true'
    )
    // …but nothing inside can be changed (the fieldset disables it).
    expect(
      host.querySelector('[data-setting="field.required"] [role="switch"]')?.matches(':disabled')
    ).toBe(true)
    await click(host.querySelector('[data-setting="field.required"] [role="switch"]'))
    expect(apply).not.toHaveBeenCalled()

    await click(host.querySelector('[data-override-here]'))
    const [ops] = apply.mock.calls[0]
    expect(ops.map((o: { op: string }) => o.op)).toEqual(['group_create', 'place'])
    expect(ops[1]).toMatchObject({ field: 'region', group_key: 'shipping', patch: { col_span: 6 } })

    await click(host.querySelector('[data-edit-in-parent]'))
    expect(openLayout).toHaveBeenCalledWith(3)
  })

  it('hides Edit in parent when the host cannot open layouts', async () => {
    await mount(field('region', 'shipping'), {
      bundle: makeBundle({ parent_layout_id: 3 }),
      inheritedFrom: 'Base order'
    })
    expect(host.querySelector('[data-override-here]')).not.toBeNull()
    expect(host.querySelector('[data-edit-in-parent]')).toBeNull()
  })

  it('a slot without a row gets its first row where it is drawn now', async () => {
    const { apply } = await mount({ kind: 'slot', field: '__comments__', group_key: null })
    const input = host.querySelector(
      '[data-setting="slot.label_override"] input'
    ) as HTMLInputElement
    await typeInto(input, 'Notes')
    const [ops] = apply.mock.calls.at(-1) ?? []
    // The fixture has a pipeline row; tasks, related and referenced-by draw before Comments.
    expect(ops.map((o: { field: string }) => o.field)).toEqual([
      '__tasks__',
      '__related_records__',
      '__referenced_by__',
      '__comments__'
    ])
    expect(ops.at(-1)).toMatchObject({ op: 'place', patch: { label_override: 'Notes' } })
    expect(ops.every((o: { index: number }) => o.index < 100)).toBe(true)
  })

  it('condition builders offer only the ops the server evaluates', async () => {
    expect(CONDITION_OPS.map((o) => o.value)).toEqual(['eq', 'neq', 'nnull'])
    const b = makeBundle()
    b.groups = b.groups.map((g) =>
      g.key === 'step_one'
        ? { ...g, visible_when: JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }]) }
        : g
    )
    const { apply } = await mount({ kind: 'group', key: 'step_one' }, { bundle: b })
    const rows = host.querySelectorAll('[data-setting="group.visible_when"] [data-condition-row]')
    expect(rows).toHaveLength(1)
    // A new row waits until it names a field: nothing is saved yet.
    await click(
      [...host.querySelectorAll('button')].find((x) => x.textContent === '+ Add condition')
    )
    expect(
      host.querySelectorAll('[data-setting="group.visible_when"] [data-condition-row]')
    ).toHaveLength(2)
    expect(apply).not.toHaveBeenCalled()
  })

  it('says what to do when nothing is selected', async () => {
    await mount(null)
    expect(host.textContent).toContain('Select a field, section or panel')
  })

  describe('typing is never overwritten from the draft while focused', () => {
    it('a text setting keeps what was typed when the draft changes under it', async () => {
      const { redraw, flush } = await mount(field('title'))
      const input = host.querySelector('[data-setting="field.label"] input') as HTMLInputElement
      await typeInto(input, 'Subject ')
      // The autosave answer comes back trimmed.
      await redraw(withPlacement(makeBundle(), 'title', { overrides: { label: 'Subject' } }))
      expect(input.value).toBe('Subject ')
      await leave(input)
      expect(flush).toHaveBeenCalled()
      expect(input.value).toBe('Subject')
    })

    it('a decimal default can be typed', async () => {
      const { apply, redraw } = await mount(field('amount'))
      await click(host.querySelector('[data-inspector-tab="rules"]'))
      const input = host.querySelector(
        '[data-setting="field.default_value"] input'
      ) as HTMLInputElement
      await typeInto(input, '1.')
      const [ops, opts] = apply.mock.calls.at(-1) ?? []
      expect(ops[0]).toEqual({ op: 'layout_update', patch: { default_values: { amount: 1 } } })
      expect(opts.text).toBe(true)
      await redraw(makeBundle({ default_values: { amount: 1 } }))
      expect(input.value).toBe('1.')
      await typeInto(input, '1.5')
      expect(apply.mock.calls.at(-1)?.[0][0].patch).toEqual({ default_values: { amount: 1.5 } })
      await redraw(makeBundle({ default_values: { amount: 1.5 } }))
      expect(input.value).toBe('1.5')
    })

    it('editors wrapped in Buffered keep typed text (inline display separator)', async () => {
      const { redraw, flush } = await mount(field('vendor'))
      const sep = host.querySelector(
        '[data-setting="field.inline_display.separator"] input'
      ) as HTMLInputElement
      expect(sep.value).toBe(', ')
      await typeInto(sep, ' / ')
      await redraw(makeBundle())
      expect(sep.value).toBe(' / ')
      await leave(sep)
      expect(flush).toHaveBeenCalled()
      expect(sep.value).toBe(', ')
    })

    it('a section text keeps typed text', async () => {
      const { redraw } = await mount({ kind: 'group', key: 'note_block' })
      const area = host.querySelector(
        '[data-setting="group.content"] textarea'
      ) as HTMLTextAreaElement
      await typeInto(area, 'Read this first')
      const b = makeBundle()
      await redraw({
        ...b,
        groups: b.groups.map((g) => (g.key === 'note_block' ? { ...g, content: 'Other' } : g))
      })
      expect(area.value).toBe('Read this first')
    })

    it('the JSON box is not reset by a draft change while focused', async () => {
      const { redraw, apply } = await mount(field('title'))
      await click(host.querySelector('[data-inspector-tab="advanced"]'))
      const json = host.querySelector(
        '[data-setting="field.overrides_raw"] textarea'
      ) as HTMLTextAreaElement
      await typeInto(json, '{"label": "Sub')
      await redraw(withPlacement(makeBundle(), 'title', { overrides: { note: 'x' } }))
      expect(json.value).toBe('{"label": "Sub')
      await leave(json)
      expect(apply).not.toHaveBeenCalled()
      expect(host.textContent).toContain('Not valid JSON')
    })
  })

  describe('every-form changes wait together', () => {
    const fmtButton = (label: string) =>
      [...host.querySelectorAll('[data-setting="field.format"] button')].find(
        (b) => b.textContent === label
      )

    it('format away and back, then currency: only what differs is confirmed', async () => {
      const b = makeBundle()
      const { calls } = await mount(field('amount'), {
        bundle: b
      })
      // Stored: currency USD. Switch to Integer, then back to Currency and type EUR.
      await click(fmtButton('Integer'))
      expect(host.querySelectorAll('[data-global-confirm]')).toHaveLength(1)
      await click(fmtButton('Currency'))
      // Back to what is stored: nothing to confirm.
      expect(host.querySelector('[data-global-confirm]')).toBeNull()
      const cur = host.querySelector('[data-setting="field.currency"] input') as HTMLInputElement
      expect(cur).not.toBeNull()
      await typeInto(cur, 'EUR')
      // The currency box stayed mounted while typing and shows what was typed.
      expect(host.querySelector('[data-setting="field.currency"] input')).toBe(cur)
      expect(cur.value).toBe('EUR')
      // One confirm, under the setting changed last, listing every change.
      const confirms = host.querySelectorAll('[data-global-confirm]')
      expect(confirms).toHaveLength(1)
      expect(
        confirms[0].parentElement?.closest('[data-setting]')?.getAttribute('data-setting')
      ).toBe('field.currency')
      // The format change was undone, so only the currency is listed.
      expect(confirms[0].querySelector('[data-global-changes]')).toBeNull()
      await click(host.querySelector('[data-global-save]'))
      const patches = calls.filter((c) => c._method === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(patches[0]._body).toEqual({ options: { format: 'currency', currency: 'EUR' } })
    })

    it('a format change survives a later grid-footer change', async () => {
      const { calls } = await mount(field('amount'))
      await click(fmtButton('Decimal'))
      // The format control keeps showing the pending value.
      expect(fmtButton('Decimal')?.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelector('[data-setting="field.currency"]')).toBeNull()
      await click(host.querySelector('[data-setting="field.aggregate"] button'))
      await click(
        [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Sum')
      )
      expect(fmtButton('Decimal')?.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelectorAll('[data-global-changes] li')).toHaveLength(2)
      await click(host.querySelector('[data-global-save]'))
      const patch = calls.find((c) => c._method === 'PATCH')
      expect(patch?._body).toEqual({
        options: { format: 'decimal', currency: 'USD', aggregate: 'SUM' }
      })
    })

    it('deprecated then a note: both columns save', async () => {
      const { calls } = await mount(field('title'))
      await click(host.querySelector('[data-inspector-tab="advanced"]'))
      await click(host.querySelector('[data-setting="field.deprecated"] [role="switch"]'))
      const note = host.querySelector(
        '[data-setting="field.deprecation_note"] input'
      ) as HTMLInputElement
      await typeInto(note, 'use subject')
      expect(
        host
          .querySelector('[data-setting="field.deprecated"] [role="switch"]')
          ?.getAttribute('aria-checked')
      ).toBe('true')
      expect(host.querySelectorAll('[data-global-confirm]')).toHaveLength(1)
      await click(host.querySelector('[data-global-save]'))
      const patches = calls.filter((c) => c._method === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(patches[0]._body).toEqual({ deprecated: true, deprecation_note: 'use subject' })
    })

    it('cancel drops every pending change', async () => {
      await mount(field('amount'))
      await click(fmtButton('Integer'))
      await click(fmtButton('Decimal'))
      await click(host.querySelector('[data-global-cancel]'))
      expect(fmtButton('Currency')?.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelector('[data-global-confirm]')).toBeNull()
    })
  })

  it('reads collection meta under its own key and leaves other shapes alone', async () => {
    const { qc } = await mount(field('title'))
    expect(qc.getQueryData(['layout-editor', 'collection-meta', 'orders'])).toMatchObject({
      fields: expect.any(Array)
    })
    expect(qc.getQueryData(['collection-meta', 'orders'])).toBeUndefined()
  })

  it('moved editors ignore the relations array other screens keep under collection-meta', async () => {
    // RelationCombobox stores an ARRAY of relations under ['collection-meta', c].
    const seed = (qc: QueryClient) => {
      for (const c of ['orders', 'vendors', 'regions', 'order_lines', 'products'])
        qc.setQueryData(['collection-meta', c], [{ many_collection: c, many_field: 'x' }])
    }
    await mount(field('vendor'), { seed })
    await click(host.querySelector('[data-inspector-tab="picker"]'))
    // The cascade editor reads the related collection's fields: add a filter.
    const add = [...host.querySelectorAll('[data-setting="field.cascade_filters"] button')].find(
      (b) => /add/i.test(b.textContent ?? '')
    )
    await click(add)
    expect(host.querySelector('[data-setting="field.cascade_filters"]')).not.toBeNull()
    // Lines: the grid tab's field pickers read the child collection.
    await mount(field('lines'), { seed })
    for (const t of [...host.querySelectorAll('[data-inspector-tab]')])
      await click(
        host.querySelector(`[data-inspector-tab="${t.getAttribute('data-inspector-tab')}"]`)
      )
    expect(host.querySelector('[data-inspector-tab]')).not.toBeNull()
  })

  describe('cascade filters edited on the Picker and Advanced tabs', () => {
    const pickerClear = () =>
      host.querySelector(
        '[data-setting="field.cascade_filters.clear_on_parent_change"] [role="switch"]'
      )
    const valueMap = () =>
      host.querySelector(
        '[data-setting="field.cascade_filters.value_map"] textarea'
      ) as HTMLTextAreaElement | null

    it('a value map cleared in Advanced stays cleared after a Picker change', async () => {
      const { calls } = await mount(field('vendor'))
      await click(host.querySelector('[data-inspector-tab="advanced"]'))
      const box = valueMap() as HTMLTextAreaElement
      await typeInto(box, '')
      await leave(box)
      await click(host.querySelector('[data-inspector-tab="picker"]'))
      await click(pickerClear())
      await click(host.querySelector('[data-global-save]'))
      const patches = calls.filter((c) => c._method === 'PATCH')
      expect(patches).toHaveLength(1)
      const rules = (patches[0]._body as { dependency_config: { cascade_filters: unknown[] } })
        .dependency_config.cascade_filters as Array<Record<string, unknown>>
      expect(rules[0].value_map).toBeUndefined()
      expect(rules[0].clear_on_parent_change).toBe(false)
      expect(rules).toHaveLength(2)
    })

    it('the Picker shows and keeps a value map changed in Advanced after its own change', async () => {
      const { calls } = await mount(field('vendor'))
      await click(host.querySelector('[data-inspector-tab="picker"]'))
      await click(pickerClear())
      expect(pickerClear()?.getAttribute('aria-checked')).toBe('false')
      await click(host.querySelector('[data-inspector-tab="advanced"]'))
      const box = valueMap() as HTMLTextAreaElement
      await typeInto(box, '{"south": "S"}')
      await leave(box)
      await click(host.querySelector('[data-inspector-tab="picker"]'))
      // Still the Picker change, now beside the Advanced one.
      expect(pickerClear()?.getAttribute('aria-checked')).toBe('false')
      const show = host.querySelector(
        '[data-setting="field.cascade_filters.show_all_if_no_parent"] [role="switch"]'
      )
      await click(show)
      await click(host.querySelector('[data-global-save]'))
      const patches = calls.filter((c) => c._method === 'PATCH')
      expect(patches).toHaveLength(1)
      const rules = (patches[0]._body as { dependency_config: { cascade_filters: unknown[] } })
        .dependency_config.cascade_filters as Array<Record<string, unknown>>
      expect(rules[0]).toMatchObject({
        value_map: { south: 'S' },
        clear_on_parent_change: false,
        show_all_if_no_parent: false
      })
    })

    it('lists a change for each filter row, not one per setting', async () => {
      await mount(field('vendor'))
      await click(host.querySelector('[data-inspector-tab="advanced"]'))
      const boxes = [
        ...host.querySelectorAll('[data-setting="field.cascade_filters.value_map"] textarea')
      ] as HTMLTextAreaElement[]
      expect(boxes).toHaveLength(2)
      await typeInto(boxes[0], '{"a": 1}')
      await leave(boxes[0])
      const second = [
        ...host.querySelectorAll('[data-setting="field.cascade_filters.value_map"] textarea')
      ][1] as HTMLTextAreaElement
      await typeInto(second, '{"b": 2}')
      await leave(second)
      // One confirm, under the row changed last.
      const confirms = host.querySelectorAll('[data-global-confirm]')
      expect(confirms).toHaveLength(1)
      expect(confirms[0].parentElement?.closest('[data-setting]')?.querySelector('textarea')).toBe(
        second
      )
      const items = [...host.querySelectorAll('[data-global-changes] li')].map((l) => l.textContent)
      expect(items).toEqual([
        'Change the value map of filter 1 of Vendor',
        'Change the value map of filter 2 of Vendor'
      ])
    })
  })

  it('a change back to what is stored hides the confirm and sends nothing', async () => {
    const { calls } = await mount(field('title'))
    await click(host.querySelector('[data-inspector-tab="advanced"]'))
    const sw = () => host.querySelector('[data-setting="field.deprecated"] [role="switch"]')
    await click(sw())
    expect(host.querySelectorAll('[data-global-confirm]')).toHaveLength(1)
    await click(sw())
    expect(host.querySelector('[data-global-confirm]')).toBeNull()
    expect(calls.some((c) => c._method === 'PATCH')).toBe(false)
  })

  describe('slots without a row keep how they open', () => {
    const startsOpen = () =>
      host
        .querySelector('[data-setting="slot.default_expanded"] [role="switch"]')
        ?.getAttribute('aria-checked')

    it.each([
      ['__comments__', 'false'],
      ['__tasks__', 'false'],
      ['__related_records__', 'false'],
      ['__referenced_by__', 'true'],
      ['__addendums__', 'true']
    ])('%s shows Starts open as the record page draws it', async (f, open) => {
      await mount({ kind: 'slot', field: f, group_key: null })
      expect(startsOpen()).toBe(open)
    })

    it('a first row writes each panel’s rowless fold', async () => {
      const b = makeBundle()
      const bundle = { ...b, placements: b.placements.filter((p) => p.field !== '__pipeline__') }
      const { apply } = await mount(
        { kind: 'slot', field: '__comments__', group_key: null },
        { bundle }
      )
      const input = host.querySelector(
        '[data-setting="slot.label_override"] input'
      ) as HTMLInputElement
      await typeInto(input, 'Notes')
      const [ops] = apply.mock.calls.at(-1) ?? []
      expect(
        ops.map((o: { field: string; patch: { default_expanded?: boolean } }) => [
          o.field,
          o.patch.default_expanded
        ])
      ).toEqual([
        ['__pipeline__', false],
        ['__tasks__', false],
        ['__related_records__', false],
        ['__referenced_by__', true],
        ['__comments__', false]
      ])
    })
  })

  it('names the collection by its label in the every-form confirm', async () => {
    await mount(field('amount'))
    await click(
      [...host.querySelectorAll('[data-setting="field.format"] button')].find(
        (b) => b.textContent === 'Decimal'
      )
    )
    const confirm = host.querySelector('[data-global-confirm]')
    expect(confirm?.textContent).toContain('Forms of Orders')
    expect(confirm?.textContent).toContain('the Orders list')
  })

  describe("a report widget's own config", () => {
    const slot: DesignTarget = { kind: 'slot', field: '__widget_5__', group_key: 'main' }
    const applyBtn = () =>
      [...host.querySelectorAll('[data-setting="widget.report_config"] button')].find(
        (b) => b.textContent === 'Apply'
      )

    it('asks first, names the forms placing it, then saves and refreshes the catalog', async () => {
      failPatch.next = null
      const { calls, apply, qc } = await mount(slot)
      await click(applyBtn())
      expect(calls.some((c) => c._method === 'PATCH')).toBe(false)
      const confirm = host.querySelector('[data-widget-confirm]')
      expect(confirm?.textContent).toContain('Order form, Order summary')
      const before = calls.filter((c) => c._path === '/widgets-internal').length
      expect(qc.getQueryState(['layout-editor', 'widgets'])).toBeTruthy()
      await click(host.querySelector('[data-widget-save]'))
      const p = calls.find((c) => c._method === 'PATCH')
      expect(p?._path).toBe('/widgets-internal/5')
      expect(p?._body).toEqual({
        config: { report_id: 'r1', widget_id: 'w1', entity_filter_field: null }
      })
      expect(apply).not.toHaveBeenCalled()
      expect(host.querySelector('[data-widget-confirm]')).toBeNull()
      // The inspector's own catalog read is refetched (not just ['widgets-internal']).
      expect(calls.filter((c) => c._path === '/widgets-internal').length).toBeGreaterThan(before)
    })

    it('shows a failed save and keeps the confirm open', async () => {
      failPatch.next = 'Report not found'
      await mount(slot)
      await click(applyBtn())
      await click(host.querySelector('[data-widget-save]'))
      expect(host.querySelector('[data-widget-confirm]')?.textContent).toContain('Report not found')
      failPatch.next = null
    })
  })
})
