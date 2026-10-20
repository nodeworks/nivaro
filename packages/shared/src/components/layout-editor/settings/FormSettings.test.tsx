// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import type { ApplyOptions } from '../useLayoutDraft'
import { FormSettings } from './FormSettings'
import type { LayoutKind } from './settings-registry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/field-config/orders') return { data: FIELDS }
      if (p === '/data-model/relations/for/orders') return { data: [] }
      if (p === '/roles')
        return {
          data: [
            { id: 'r-fin', name: 'Finance' },
            { id: 'r-eng', name: 'Engineering' }
          ]
        }
      if (p === '/collection-layouts')
        return { data: [{ id: 5, name: 'Order form', layout_type: 'grouped' }] }
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
  opts: { apply?: (ops: LayoutOp[], o?: ApplyOptions) => void; flush?: () => void } = {}
) {
  const { client, calls } = makeClient()
  const apply = vi.fn(opts.apply ?? (() => {}))
  const flush = vi.fn(opts.flush ?? (() => {}))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <FormSettings bundle={bundle} apply={apply} flush={flush} collection='orders' />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => !!document.querySelector('[data-setting="tool.version_restore"]'))
  return { apply, flush, calls, qc }
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
  it.each(
    KINDS
  )('renders a control for every form settings parity row on a %s layout', async (kind) => {
    await mount(bundleOf(kind))
    const missing = formRows
      .filter((r) => r.layout_types.includes(kind))
      .map((r) => r.key)
      .filter((key) => !setting(key))
    expect(missing).toEqual([])
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

  it('typing is coalesced and blur flushes it', async () => {
    const { apply, flush } = await mount(bundleOf('grouped'))
    const input = setting('layout.create_label')?.querySelector('input') ?? null
    await type(input, 'New order')
    expect(apply).toHaveBeenLastCalledWith(
      [{ op: 'layout_update', patch: { create_label: 'New order' } }],
      { label: 'Change New-menu label', text: true }
    )
    await blur(input)
    expect(flush).toHaveBeenCalled()
  })

  it('link names keep only what the server stores', async () => {
    const { apply } = await mount(bundleOf('grouped'))
    await type(setting('layout.slug')?.querySelector('input') ?? null, 'Unit Order!')
    expect(apply.mock.calls.at(-1)?.[0]).toEqual([
      { op: 'layout_update', patch: { slug: 'unit_order_' } }
    ])
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

  it('Make default calls the type-scoped activate route', async () => {
    const { calls, apply } = await mount(bundleOf('detail'))
    await click(q('[data-action="make-default"]'))
    await settle(() => calls.some((c) => c._path === '/collection-layouts/5/activate'))
    const call = calls.find((c) => c._path === '/collection-layouts/5/activate')
    expect(call?._method).toBe('POST')
    expect(apply).not.toHaveBeenCalled()
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
