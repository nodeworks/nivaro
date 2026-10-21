// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { applyLayoutOps, type LayoutBundle, type LayoutOp } from '../../../lib/layout-ops'
import { type ApplyOptions, LayoutDraftEngine } from '../useLayoutDraft'
import { FormSettings } from './FormSettings'
import type { LayoutKind } from './settings-registry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Pick lists are cmdk lists, which measure with ResizeObserver and scroll the
// active entry into view; jsdom has neither.
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView ??= () => {}

interface ParityRow {
  key: string
  home: string | null
  status: string
  layout_types: string[]
}
const PARITY_JSON = '../parity-keys.json'
const parity = (await import(/* @vite-ignore */ PARITY_JSON)).default as ParityRow[]
const formRows = parity.filter(
  (r) => r.home === 'form_settings' && ['keep', 'fix', 'add'].includes(r.status)
)
const RETIRED = parity.filter((r) => r.status === 'retired').map((r) => r.key)
const KINDS: LayoutKind[] = ['grouped', 'table', 'file', 'addendum', 'detail', 'summary']

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

const FIELDS = [
  {
    field: 'status',
    label: 'Status',
    type: 'string',
    interface: 'select-dropdown',
    options: {
      choices: [
        { text: 'Open', value: 'open' },
        { text: 'Closed', value: 'closed' }
      ]
    }
  },
  { field: 'line_no', label: 'Line number', type: 'integer' },
  { field: 'title', label: 'Title', type: 'string' },
  { field: 'is_rush', label: 'Rush order', type: 'boolean' }
]

function bundleOf(kind: LayoutKind, extra: Record<string, unknown> = {}): LayoutBundle {
  return {
    layout: {
      id: 5,
      collection: 'orders',
      name: 'Order form',
      layout_type: kind,
      slug: 'order_form',
      is_active: false,
      ...extra
    },
    groups: [],
    placements: [],
    rev: 'r1'
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

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const COLUMNS = [
  { name: 'id', data_type: 'int' },
  { name: 'status', data_type: 'nvarchar' },
  { name: 'line_no', data_type: 'int' },
  { name: 'title', data_type: 'nvarchar' },
  { name: 'is_rush', data_type: 'bit' }
]

interface Fixture {
  fields?: unknown[]
  /** null = the table route fails (a collection without a table). */
  columns?: unknown[] | null
  relations?: unknown[]
  layouts?: unknown[]
}

function makeClient(fx: Fixture = {}) {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/field-config/orders') return { data: fx.fields ?? FIELDS }
      if (p === '/data-model/relations/for/orders') return { data: fx.relations ?? [] }
      if (p === '/data-model/orders') {
        if (fx.columns === null) throw Object.assign(new Error('Not found'), { status: 404 })
        return { data: { name: 'orders', columns: fx.columns ?? COLUMNS } }
      }
      if (p === '/collection-layouts/preview-as-role')
        return {
          data: {
            role: { id: 'r-fin', name: 'Finance', admin_access: false },
            can_read: true,
            can_update: true,
            layout: { id: 5, name: 'Order form', is_active: true },
            hidden_fields: ['title'],
            readonly_fields: [],
            record_conditional_layouts: [],
            note: null
          }
        }
      if (p === '/roles')
        return {
          data: [
            { id: 'r-fin', name: 'Finance' },
            { id: 'r-eng', name: 'Engineering' }
          ]
        }
      if (p === '/collection-layouts')
        return { data: fx.layouts ?? [{ id: 5, name: 'Order form', layout_type: 'grouped' }] }
      if (p === '/pipelines') return { data: [{ id: 'wf1', name: 'Change orders' }] }
      if (p === '/pdf-templates') return { data: [{ id: 3, name: 'Invoice' }] }
      if (p === '/collection-layouts/5/versions')
        return {
          data: [
            {
              id: 1,
              version: 1,
              note: 'before save',
              created_at: '2026-10-19T14:00:00Z',
              created_by_name: 'Dana'
            }
          ]
        }
      if (p.endsWith('/diff'))
        return {
          data: {
            from: { version: 1, created_at: null, note: null },
            layout: [],
            groups: { added: [], removed: [], changed: [] },
            assignments: { added: [], removed: [], changed: [] },
            warnings: [],
            total: 0
          }
        }
      return { data: {} }
    })
  }
  return { client, calls }
}

async function mount(
  bundle: LayoutBundle,
  opts: {
    apply?: (ops: LayoutOp[], o?: ApplyOptions) => void
    flush?: () => void
    onPreviewRole?: (p: unknown) => void
    fixture?: Fixture
  } = {}
) {
  const { client, calls } = makeClient(opts.fixture)
  const apply = vi.fn(opts.apply ?? (() => {}))
  const flush = vi.fn(opts.flush ?? (() => {}))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const render = async (b: LayoutBundle) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <FormSettings
              bundle={b}
              apply={apply}
              flush={flush}
              collection='orders'
              onPreviewRole={opts.onPreviewRole}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
  }
  await render(bundle)
  await settle(() => !!document.querySelector('[data-setting="tool.version_restore"]'))
  return { apply, flush, calls, qc, rerender: render }
}

const q = (sel: string) => document.querySelector(sel)
const setting = (key: string) => q(`[data-setting="${key}"]`)

async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

async function type(el: Element | null, value: string) {
  if (!el) throw new Error('no input')
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function blur(el: Element | null) {
  await act(async () => {
    ;(el as HTMLElement).dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

const findOption = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => (o.querySelector('span')?.textContent ?? o.textContent)?.trim() === label
  )

/** A pick-list entry by its label (popovers mount on the next tick). */
async function option(label: string): Promise<HTMLElement> {
  await settle(() => !!findOption(label))
  const hit = findOption(label)
  if (!hit) throw new Error(`no option ${label}`)
  return hit
}

describe('FormSettings', () => {
  // Rows whose control comes from the host app; with no host slot they say so.
  const HOST_SLOT_ROWS = ['tool.describe', 'tool.ai_review', 'tool.ai_text']
  const CONTROL = 'input, button, textarea, a, [role="switch"]'

  it.each(
    KINDS
  )('renders a control for every form settings parity row on a %s layout', async (kind) => {
    await mount(bundleOf(kind))
    const keys = formRows.filter((r) => r.layout_types.includes(kind)).map((r) => r.key)
    expect(keys.filter((key) => !setting(key))).toEqual([])
    const withoutControl = keys.filter((key) => {
      const el = setting(key) as HTMLElement
      return !el.matches(CONTROL) && !el.querySelector(CONTROL)
    })
    expect(withoutControl.filter((k) => !HOST_SLOT_ROWS.includes(k))).toEqual([])
    for (const k of withoutControl) expect(setting(k)?.textContent).toContain('Not offered')
  })

  it('offers no retired setting', async () => {
    for (const kind of ['grouped', 'summary'] as const) {
      await mount(bundleOf(kind, { summary_enabled: true }))
      for (const key of RETIRED) expect(setting(key), key).toBeNull()
      expect(document.body.textContent).not.toMatch(/show all fields in summary|clone button for/i)
      act(() => root.unmount())
      root = createRoot(host)
    }
  })

  it('gives addendum layouts every section that applies to them', async () => {
    await mount(bundleOf('addendum'))
    const sections = Array.from(document.querySelectorAll('[data-section]')).map((s) =>
      s.getAttribute('data-section')
    )
    expect(sections).toEqual(['who', 'layout', 'addendum', 'defaults', 'inheritance', 'tools'])
    for (const key of [
      'layout.conditions.role_ids',
      'layout.validate_before_next',
      'layout.workflow_template_id',
      'layout.default_values',
      'layout.parent_layout_id',
      'tool.version_history'
    ])
      expect(setting(key), key).not.toBeNull()
  })

  it('a switch emits one layout_update op with a plain label', async () => {
    const { apply } = await mount(bundleOf('grouped'))
    await click(setting('layout.disable_comments')?.querySelector('[role="switch"]') ?? null)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'layout_update', patch: { disable_comments: true } }],
      {
        label: 'Turn on Hide comments'
      }
    )
  })

  it('a text setting goes out as typed text (sent after a pause) and blur flushes it', async () => {
    const { apply, flush } = await mount(bundleOf('grouped'))
    const input = setting('layout.create_label')?.querySelector('input') ?? null
    await type(input, 'New order')
    // The draft coalesces typed text and sends it after a 600 ms pause.
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'layout_update', patch: { create_label: 'New order' } }],
      { label: 'Change New-menu label', text: true }
    )
    expect(flush).not.toHaveBeenCalled()
    await blur(input)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalled()
  })

  it('a save the server trims never rewrites what is being typed', async () => {
    const { apply, rerender } = await mount(bundleOf('file'))
    const input = setting('layout.pdf_button_label')?.querySelector('input') as HTMLInputElement
    await type(input, 'a ')
    // Someone's save comes back trimmed while the admin is still typing.
    await rerender(bundleOf('file', { pdf_button_label: 'a' }))
    expect(input.value).toBe('a ')
    await type(input, 'a b')
    expect(input.value).toBe('a b')
    await blur(input)
    expect(apply).toHaveBeenLastCalledWith(
      [{ op: 'layout_update', patch: { pdf_button_label: 'a b' } }],
      { label: 'Change Button label', text: true }
    )
  })

  it('Escape puts the value from before the edit back', async () => {
    const { apply, rerender } = await mount(bundleOf('grouped', { create_label: 'New order' }))
    const input = setting('layout.create_label')?.querySelector('input') as HTMLInputElement
    await type(input, 'Something else')
    // The draft follows the typing.
    await rerender(bundleOf('grouped', { create_label: 'Something else' }))
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(apply).toHaveBeenLastCalledWith(
      [{ op: 'layout_update', patch: { create_label: 'New order' } }],
      { label: 'Change New-menu label', text: true }
    )
    await rerender(bundleOf('grouped', { create_label: 'New order' }))
    await blur(input)
    expect(input.value).toBe('New order')
  })

  it('link names are sanitised as typed and only sent on blur', async () => {
    const { apply } = await mount(bundleOf('grouped'))
    const input = setting('layout.slug')?.querySelector('input') ?? null
    await type(input, 'Unit Order!')
    expect((input as HTMLInputElement).value).toBe('unit_order_')
    expect(apply).not.toHaveBeenCalled()
    await blur(input)
    expect(apply.mock.calls.at(-1)?.[0]).toEqual([
      { op: 'layout_update', patch: { slug: 'unit_order_' } }
    ])
  })

  it('a link name typed and not yet sent is sent when the panel goes away', async () => {
    const { apply } = await mount(bundleOf('grouped'))
    const input = setting('layout.slug')?.querySelector('input') ?? null
    await type(input, 'warehouse')
    expect(apply).not.toHaveBeenCalled()
    // Closing Form settings removes the focused input: no blur fires.
    await act(async () => root.render(null))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0]).toEqual([{ op: 'layout_update', patch: { slug: 'warehouse' } }])
  })

  it('a PDF layout shows only what a PDF uses', async () => {
    await mount(bundleOf('file'))
    const sections = Array.from(document.querySelectorAll('[data-section]')).map((s) =>
      s.getAttribute('data-section')
    )
    expect(sections).toContain('pdf')
    expect(sections).not.toContain('layout')
    expect(sections).not.toContain('buttons')
    expect(sections).not.toContain('defaults')
    // No read view or summary panel, and no New-menu rows: a PDF is never opened or created.
    expect(sections).not.toContain('read')
    for (const key of [
      'layout.summary_enabled',
      'layout.summary_hide_empty',
      'layout.create_label',
      'layout.create_hidden'
    ])
      expect(setting(key), key).toBeNull()
  })

  it('only grouped forms offer the New-menu rows (only they join the New menu)', async () => {
    await mount(bundleOf('grouped'))
    expect(setting('layout.create_label')).not.toBeNull()
    expect(setting('layout.create_hidden')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await mount(bundleOf('table'))
    expect(setting('layout.create_label')).toBeNull()
  })

  it('search narrows to matching settings across sections', async () => {
    await mount(bundleOf('file'))
    await type(q('[data-settings-search]'), 'logo')
    const keys = Array.from(document.querySelectorAll('[data-setting]')).map((e) =>
      e.getAttribute('data-setting')
    )
    expect(keys).toEqual(['layout.pdf_show_logo'])
    expect(Array.from(document.querySelectorAll('[data-section]')).length).toBe(1)
    await type(q('[data-settings-search]'), 'restore')
    expect(setting('tool.version_history')).not.toBeNull()
  })

  it('record conditions: field and choice labels, only is / is not / has a value', async () => {
    const { apply } = await mount(bundleOf('grouped'))
    const box = setting('layout.record_conditions')
    const addRule = Array.from(box?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Add rule'
    )
    await click(addRule ?? null)
    const ops = Array.from(box?.querySelectorAll('[aria-label="Rule test"] button') ?? [])
    expect(ops.map((o) => o.textContent)).toEqual(['is', 'is not', 'has a value'])
    expect(apply).not.toHaveBeenCalled()

    await click(box?.querySelector('[aria-label="Rule field"]') ?? null)
    await click(await option('Status'))
    // The field list closes and hands focus back to its button (a deferred focus)
    // before the next list opens, as it does between two real clicks.
    await settle(() => !findOption('Status'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(apply).not.toHaveBeenCalled()
    await click(box?.querySelector('[aria-label="Rule value"]') ?? null)
    await click(await option('Open'))
    expect(apply).toHaveBeenLastCalledWith(
      [
        {
          op: 'layout_update',
          patch: { record_conditions: [{ field: 'status', op: 'eq', value: 'open' }] }
        }
      ],
      { label: 'Change Show for matching records' }
    )
  })

  it('shows stored rules as a sentence with labels', async () => {
    await mount(
      bundleOf('grouped', {
        record_conditions: [
          { field: 'status', op: 'neq', value: 'closed' },
          { field: 'title', op: 'nnull' }
        ]
      })
    )
    const sentence = q('[data-rule-sentence]')?.textContent ?? ''
    expect(sentence).toContain('Status')
    expect(sentence).toContain('Closed')
    expect(sentence).toContain('Title')
    expect(sentence).not.toContain('status')
  })

  it('roles are picked and shown by name', async () => {
    const { apply } = await mount(bundleOf('table', { conditions: { role_ids: ['r-fin'] } }))
    const box = setting('layout.conditions.role_ids')
    expect(box?.textContent).toContain('Finance')
    expect(box?.textContent).not.toContain('r-fin')
    const add = Array.from(box?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Add role'
    )
    await click(add ?? null)
    await click(await option('Engineering'))
    expect(apply).toHaveBeenLastCalledWith(
      [{ op: 'layout_update', patch: { conditions: { role_ids: ['r-fin', 'r-eng'] } } }],
      { label: 'Add a role' }
    )
  })

  it('Make default asks first, naming the current default, then sends one non-undoable op', async () => {
    const { calls, apply } = await mount(bundleOf('detail'), {
      fixture: {
        layouts: [
          { id: 5, name: 'Order form', layout_type: 'detail', is_active: false },
          { id: 8, name: 'Order drill-down', layout_type: 'detail', is_active: true },
          { id: 9, name: 'Main form', layout_type: 'grouped', is_active: true }
        ]
      }
    })
    await click(q('[data-action="make-default"]'))
    expect(apply).not.toHaveBeenCalled()
    await settle(
      () => !!q('[data-make-default-confirm]')?.textContent?.includes('Order drill-down')
    )
    const confirm = q('[data-make-default-confirm]')?.textContent ?? ''
    expect(confirm).toContain('Order drill-down stops being the default detail layout')
    expect(confirm).not.toContain('Main form')
    await click(q('[data-action="make-default-confirm"]'))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith([{ op: 'layout_update', patch: { is_active: true } }], {
      label: 'Make default',
      undoable: false
    })
    expect(calls.some((c) => c._path.endsWith('/activate'))).toBe(false)
    expect(q('[data-make-default-confirm]')).toBeNull()
  })

  it('search finds Make default by "default"', async () => {
    await mount(bundleOf('grouped'))
    await type(q('[data-settings-search]'), 'default')
    expect(q('[data-action="make-default"]')).not.toBeNull()
  })

  it('Make default leaves undo as it was', async () => {
    const start = bundleOf('grouped')
    let rev = 1
    const engine = new LayoutDraftEngine(
      {
        send: async (ops, _base) => ({ ...applyLayoutOps(start, ops), rev: `r${++rev}` }),
        saved: () => {},
        reload: () => {},
        notify: () => {}
      },
      { autosave: true }
    )
    engine.receive(start)
    await mount(start, { apply: (ops, o) => engine.apply(ops, o) })
    await click(setting('layout.disable_tasks')?.querySelector('[role="switch"]') ?? null)
    await settle(() => engine.getView().status === 'saved')
    expect(engine.getView().undoLabel).toBe('Turn on Hide tasks')

    await click(q('[data-action="make-default"]'))
    await click(q('[data-action="make-default-confirm"]'))
    await settle(
      () =>
        engine.getView().status === 'saved' && engine.getView().bundle?.layout.is_active === true
    )
    const saved = engine.getView().bundle as LayoutBundle
    engine.receive(saved)
    expect(engine.getView().canUndo).toBe(true)
    expect(engine.getView().undoLabel).toBe('Turn on Hide tasks')
  })

  it('says the Dossier switch does nothing off the default form', async () => {
    await mount(bundleOf('detail'))
    const row = setting('layout.dossier_enabled')
    expect(row?.textContent).toMatch(/No effect on this kind of layout/)
    expect(row?.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(true)
    act(() => root.unmount())
    root = createRoot(host)
    await mount(bundleOf('grouped', { is_active: false }))
    expect(setting('layout.dossier_enabled')?.textContent).toMatch(/while this form is the default/)
    act(() => root.unmount())
    root = createRoot(host)
    await mount(bundleOf('grouped', { is_active: true }))
    expect(setting('layout.dossier_enabled')?.textContent).not.toMatch(/No effect|while this form/)
  })

  it('preview as role reports to the canvas and clears on unmount', async () => {
    const onPreviewRole = vi.fn()
    await mount(bundleOf('grouped'), { onPreviewRole })
    await click(
      setting('tool.preview_as_role')?.querySelector('[aria-label="Preview as role"]') ?? null
    )
    await click(await option('Finance'))
    await settle(() => onPreviewRole.mock.calls.some((c) => c[0] != null))
    expect(setting('tool.preview_as_role')?.textContent).toContain('1 field hidden')
    act(() => root.unmount())
    root = createRoot(host)
    expect(onPreviewRole).toHaveBeenLastCalledWith(null)
  })

  it('rule and starting-value fields: real columns without a field row, no aliases or virtual fields', async () => {
    await mount(bundleOf('grouped'), {
      fixture: {
        fields: [
          ...FIELDS,
          { field: 'lines', label: 'Lines', type: 'string' },
          { field: 'virtual_total', label: 'Virtual total', type: 'decimal' }
        ],
        columns: [...COLUMNS, { name: 'legacy_code', data_type: 'nvarchar' }],
        relations: [
          {
            many_collection: 'order_lines',
            many_field: 'order_id',
            one_collection: 'orders',
            one_field: 'lines',
            junction_field: null
          }
        ]
      }
    })
    const box = setting('layout.record_conditions')
    await click(
      Array.from(box?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Add rule'
      ) ?? null
    )
    await click(box?.querySelector('[aria-label="Rule field"]') ?? null)
    await settle(() => !!findOption('Status'))
    const labels = Array.from(document.querySelectorAll('[role="option"] span:first-of-type')).map(
      (o) => o.textContent
    )
    expect(labels).toContain('Legacy Code')
    expect(labels).toContain('Status')
    expect(labels).not.toContain('Lines')
    expect(labels).not.toContain('Virtual total')
  })

  it('without the table route, a string-typed alias is still left out (judged by relation)', async () => {
    await mount(bundleOf('grouped'), {
      fixture: {
        fields: [...FIELDS, { field: 'lines', label: 'Lines', type: 'string' }],
        columns: null,
        relations: [
          {
            many_collection: 'order_lines',
            many_field: 'order_id',
            one_collection: 'orders',
            one_field: 'lines',
            junction_field: null
          }
        ]
      }
    })
    const box = setting('layout.default_values')
    await click(
      Array.from(box?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Add a starting value'
      ) ?? null
    )
    await click(box?.querySelector('[aria-label="Starting value field"]') ?? null)
    await settle(() => !!findOption('Status'))
    const labels = Array.from(document.querySelectorAll('[role="option"] span:first-of-type')).map(
      (o) => o.textContent
    )
    expect(labels).toContain('Title')
    expect(labels).not.toContain('Lines')
  })

  it('PDF layouts have no Make default; the PDF switch saves is_active', async () => {
    const { apply } = await mount(bundleOf('file'))
    expect(q('[data-action="make-default"]')).toBeNull()
    await click(setting('layout.pdf_export_active')?.querySelector('[role="switch"]') ?? null)
    expect(apply).toHaveBeenLastCalledWith([{ op: 'layout_update', patch: { is_active: true } }], {
      label: 'Turn on PDF button on records'
    })
  })

  it('picking a custom PDF template also switches the theme to custom', async () => {
    const { apply } = await mount(bundleOf('file'))
    await click(
      setting('layout.pdf_template_id')?.querySelector('[aria-label="Custom template"]') ?? null
    )
    await click(await option('Invoice'))
    expect(apply).toHaveBeenLastCalledWith(
      [{ op: 'layout_update', patch: { pdf_theme: 'custom', pdf_template_id: 3 } }],
      { label: 'Use a custom PDF template' }
    )
  })

  it('an out-of-range read view width says so and saves nothing', async () => {
    const { apply } = await mount(bundleOf('summary'))
    const input = setting('layout.sheet_width')?.querySelector('input') ?? null
    await type(input, '120')
    await blur(input)
    expect(apply).not.toHaveBeenCalled()
    expect(setting('layout.sheet_width')?.textContent).toMatch(/320 to 2000/)
    await type(input, '900')
    await blur(input)
    expect(apply).toHaveBeenLastCalledWith([{ op: 'layout_update', patch: { sheet_width: 900 } }], {
      label: 'Change Read view width'
    })
  })

  it('switching kind with placements asks first', async () => {
    const b = bundleOf('grouped')
    b.placements = [
      {
        field: 'title',
        group_key: null,
        sort: 0,
        label_override: null,
        is_visible: true,
        default_expanded: false,
        col_span: null,
        overrides: null,
        show_row_revisions: false,
        allow_revision_restore: null,
        lock_conditions: null,
        input_bindings: null,
        widget_id: null,
        show_approval_chain: false
      }
    ]
    const { apply } = await mount(b)
    const pdf = Array.from(
      setting('layout.layout_type')?.querySelectorAll('[aria-pressed]') ?? []
    ).find((r) => r.textContent === 'PDF')
    await click(pdf ?? null)
    expect(apply).not.toHaveBeenCalled()
    expect(q('[data-kind-confirm="file"]')).not.toBeNull()
    const yes = Array.from(document.querySelectorAll('button')).find(
      (x) => x.textContent === 'Yes, change it'
    )
    await click(yes ?? null)
    expect(apply).toHaveBeenLastCalledWith(
      [{ op: 'layout_update', patch: { layout_type: 'file' } }],
      { label: 'Change kind to PDF' }
    )
  })
})
