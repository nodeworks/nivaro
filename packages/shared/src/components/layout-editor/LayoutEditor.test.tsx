// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../lib/layout-ops'
import type { CMSField } from '../item-edit/types'
import { isTyping, LayoutEditor } from './LayoutEditor'

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

const FIELDS: Record<string, CMSField> = {
  title: field('title', 'Title'),
  amount: field('amount', 'Amount', { type: 'decimal' }),
  notes: field('notes', 'Notes', { type: 'text' }),
  vendor: field('vendor', 'Vendor name')
}

function makeBundle(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Order form', layout_type: 'grouped' },
    groups: [
      { ...newGroup('main', 'Main', 'section', null), id: 1, sort: 0 },
      { ...newGroup('extra', 'Extra', 'section', null), id: 2, sort: 1 },
      ungroupedGroup(2)
    ],
    placements: [
      { ...newPlacement('title', 'main'), id: 10, sort: 0 },
      { ...newPlacement('amount', 'main'), id: 11, sort: 1 },
      { ...newPlacement('notes', 'extra'), id: 12, sort: 0 }
    ],
    rev: 'r0'
  }
}

const OVERVIEW = {
  rows: [
    {
      layout_id: 7,
      name: 'Order form',
      layout_type: 'grouped',
      slug: null,
      section: 'forms',
      reason: { kind: 'default' },
      is_default: true,
      new_menu: null,
      shape: { groups: 2, steps_or_tabs: 0, fields: 3 },
      references: [],
      warnings: []
    },
    {
      layout_id: 8,
      name: 'Order summary',
      layout_type: 'summary',
      slug: null,
      section: 'other_views',
      reason: { kind: 'type_use', type_use: 'Read mode' },
      is_default: false,
      new_menu: null,
      shape: { groups: 1, steps_or_tabs: 0, fields: 2 },
      references: [],
      warnings: []
    }
  ],
  warning: null
}

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

// The server's POST /field-config/:col/project, reduced to these fixtures.
function project(assignments: Array<Record<string, unknown>>): CMSField[] {
  const placed = assignments.filter((a) => !String(a.field).startsWith('__'))
  const rows = placed.map((a) => ({
    ...FIELDS[String(a.field)],
    group_key: (a.group_key as string | null) ?? null,
    sort: Number(a.sort),
    layout_assigned: true
  }))
  const names = new Set(placed.map((a) => a.field))
  for (const f of Object.values(FIELDS))
    if (!names.has(f.field)) rows.push({ ...f, group_key: null, layout_assigned: false })
  return rows
}

let widgetsFail = false
// Per-test layout and its parent (layout 9), when not makeBundle().
let bundleOverride: LayoutBundle | null = null
let parentBundle: LayoutBundle | null = null
// Per-test answer of GET /collection-layouts/preview-as-role, when not ROLE_PREVIEW.
let rolePreviewOverride: Record<string, unknown> | null = null

const ROLE_PREVIEW: Record<string, unknown> = {
  role: { id: 'r-fin', name: 'Finance', admin_access: false },
  can_read: true,
  can_update: true,
  layout: { id: 7, name: 'Order form', is_active: true },
  hidden_fields: ['notes'],
  readonly_fields: [],
  record_conditional_layouts: [],
  note: null
}

function makeClient() {
  const calls: Cmd[] = []
  let stored = bundleOverride ?? makeBundle()
  let rev = 0
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/7/bundle') return stored
      if (p === '/collection-layouts/9/bundle' && parentBundle) return parentBundle
      if (p === '/collection-layouts/preview-as-role')
        return { data: rolePreviewOverride ?? ROLE_PREVIEW }
      if (p === '/roles')
        return {
          data: [
            { id: 'r-fin', name: 'Finance' },
            { id: 'r-eng', name: 'Engineering' }
          ]
        }
      if (p === '/collection-layouts/7/ops') {
        stored = { ...applyLayoutOps(stored, cmd._body?.ops as LayoutOp[]), rev: `r${++rev}` }
        return stored
      }
      if (p === '/collection-layouts/overview') return { data: OVERVIEW }
      if (p === '/field-config/orders') return { data: project(stored.placements as never) }
      if (p === '/field-config/orders/project')
        return { data: project((cmd._body?.assignments ?? []) as never) }
      if (p === '/collections/orders')
        return { data: { display_name: 'Orders', fields: Object.values(FIELDS) } }
      if (p === '/widgets-internal' && widgetsFail) throw new Error('Server unavailable')
      if (method !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
}

// jsdom lacks the layout observers the record form measures with.
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
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

// Overlay mode portals out of `host`, so look in the whole document.
const canvasFields = () => document.querySelectorAll('[data-editor-canvas] [data-field]')
const opsCalls = (calls: Cmd[]) =>
  calls
    .filter((c) => c._path === '/collection-layouts/7/ops')
    .map((c) => c._body?.ops as LayoutOp[])

async function mount(
  opts: { mode?: 'page' | 'overlay'; inDialog?: boolean; onBack?: () => void } = {}
) {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const editor = (
    <LayoutEditor
      collection='orders'
      layoutId={7}
      onBack={opts.onBack ?? (() => {})}
      mode={opts.mode ?? 'page'}
    />
  )
  const render = (open: boolean) =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          {/* A host's modal sheet, with the button that opened the editor. */}
          <div role={opts.inDialog ? 'dialog' : undefined} data-host-sheet=''>
            <button type='button' data-opener=''>
              Edit layout
            </button>
            {open && editor}
          </div>
        </NivaroProvider>
      </QueryClientProvider>
    )
  await act(async () => render(false))
  ;(document.querySelector('[data-opener]') as HTMLElement).focus()
  await act(async () => render(true))
  await settle(() => canvasFields().length >= 3)
  return { calls, close: () => act(() => render(false)) }
}

// Live layout for drag tests: Main 0-200 (Title, Amount stacked), Extra
// 220-420 (Notes), the Add panel's rows off to the left of the canvas.
const RECTS: Record<string, [number, number, number, number]> = {
  'group:main': [0, 0, 600, 200],
  'field:title:main': [20, 50, 560, 40],
  'field:amount:main': [20, 100, 560, 40],
  'group:extra': [0, 220, 600, 200],
  'field:notes:extra': [20, 270, 560, 40],
  'add:vendor': [-300, 0, 240, 30]
}
const originalRect = Element.prototype.getBoundingClientRect
function mockRects() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const add = this.getAttribute('data-add-field')
    const k = this.getAttribute('data-design-target') ?? (add ? `add:${add}` : '')
    const [x, y, w, h] = RECTS[k] ?? [0, 0, 0, 0]
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h } as DOMRect
  }
}
afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect
  bundleOverride = null
  parentBundle = null
  rolePreviewOverride = null
})

function pointer(type: string, target: EventTarget, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(e, 'isPrimary', { value: true })
  act(() => {
    target.dispatchEvent(e)
  })
}
const key = (code: string, target: EventTarget = document) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }))
  })
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))
const node = (k: string) => document.querySelector(`[data-design-target="${k}"]`) as HTMLElement

function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

describe('LayoutEditor', () => {
  it('opens a grouped layout on the ItemEditForm canvas', async () => {
    await mount()
    const canvas = document.querySelector('[data-editor-canvas]')
    expect(canvas?.getAttribute('data-renderer')).toBe('item-edit-form')
    expect(canvas?.querySelector('[data-design-canvas]')).not.toBeNull()
    expect([...canvasFields()].map((el) => el.getAttribute('data-field'))).toEqual([
      'title',
      'amount',
      'notes'
    ])
    const bar = document.querySelector('[data-editor-topbar]')
    expect(bar?.textContent).toContain('Order form')
    expect(bar?.textContent).toContain('default')
    expect(bar?.textContent).toContain('anything else')
    // The rail lists the collection's layouts with their purposes.
    const rail = document.querySelector('[data-editor-rail]')
    expect(rail?.textContent).toContain('Order summary')
    expect(rail?.textContent).toContain('Read mode')
  })

  it('selecting a field opens its inspector', async () => {
    await mount()
    click(document.querySelector('[data-design-target="field:title:main"]'))
    await settle(() => !!document.querySelector('[data-editor-inspector] [data-setting]'))
    const insp = document.querySelector('[data-editor-inspector]')
    expect(insp?.querySelector('h2')?.textContent).toBe('Title')
    expect(insp?.querySelector('[data-inspector]')).not.toBeNull()
    expect(
      document
        .querySelector('[data-design-target="field:title:main"]')
        ?.getAttribute('data-selected')
    ).toBe('true')
  })

  it('a field selected on the canvas opens the real inspector; a new label saves one op', async () => {
    const { calls } = await mount()
    click(document.querySelector('[data-design-target="field:title:main"]'))
    await settle(
      () => !!document.querySelector('[data-editor-inspector] [data-setting="field.label"]')
    )
    const insp = document.querySelector('[data-editor-inspector]') as HTMLElement
    expect(insp.querySelector('[data-inspector-tab="look"]')?.getAttribute('aria-selected')).toBe(
      'true'
    )
    const input = insp.querySelector('[data-setting="field.label"] input') as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Subject'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [
        {
          op: 'update_placement',
          at: { field: 'title', group_key: 'main' },
          patch: { overrides: { label: 'Subject' } }
        }
      ]
    ])
  })

  it('a typed label saves after a pause, with focus kept in the box', async () => {
    const { calls } = await mount()
    click(document.querySelector('[data-design-target="field:title:main"]'))
    await settle(
      () => !!document.querySelector('[data-editor-inspector] [data-setting="field.label"]')
    )
    const input = document.querySelector(
      '[data-editor-inspector] [data-setting="field.label"] input'
    ) as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Subject'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // No blur: the pause alone sends it.
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [
        {
          op: 'update_placement',
          at: { field: 'title', group_key: 'main' },
          patch: { overrides: { label: 'Subject' } }
        }
      ]
    ])
    expect(input.value).toBe('Subject')
  })

  it('add panel marks placed fields and adds after selection (emits one place op)', async () => {
    const { calls } = await mount()
    click(document.querySelector('[data-design-target="field:title:main"]'))
    click(document.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!document.querySelector('[data-add-field="vendor"]'))
    const row = (f: string) => document.querySelector(`[data-add-field="${f}"]`)
    expect(row('title')?.getAttribute('data-on-form')).toBe('true')
    expect(row('vendor')?.getAttribute('data-on-form')).toBeNull()
    expect(row('vendor')?.textContent).toContain('Vendor name')
    click(row('vendor'))
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [{ op: 'place', field: 'vendor', group_key: 'main', index: 1 }]
    ])
    await settle(() => row('vendor')?.getAttribute('data-on-form') === 'true')
    expect(row('vendor')?.getAttribute('data-on-form')).toBe('true')
  })

  it('undo button reverses the last batch', async () => {
    const { calls } = await mount()
    click(document.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!document.querySelector('[data-add-field="vendor"]'))
    click(document.querySelector('[data-add-field="vendor"]'))
    await settle(() => opsCalls(calls).length === 1)
    const undo = document.querySelector('[aria-label="Undo"]') as HTMLButtonElement
    await settle(() => !undo.disabled)
    click(undo)
    await settle(() => opsCalls(calls).length === 2)
    expect(opsCalls(calls)[1]).toEqual([
      { op: 'remove', at: { field: 'vendor', group_key: 'main' } }
    ])
    await settle(
      () =>
        document.querySelector('[data-add-field="vendor"]')?.getAttribute('data-on-form') == null
    )
    expect(
      document.querySelector('[data-add-field="vendor"]')?.getAttribute('data-on-form')
    ).toBeNull()
  })

  it('add panel adds another copy into the selected section, never twice in one', async () => {
    const { calls } = await mount()
    click(document.querySelector('[data-design-target="field:title:main"]'))
    click(document.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!document.querySelector('[data-add-copy="title"]'))
    // Title is already in Main, where the selection is: refused in words.
    click(document.querySelector('[data-add-copy="title"]'))
    expect(document.querySelector('[data-add-notice]')?.textContent).toBe(
      'Title is already in Main. Select another section first.'
    )
    expect(opsCalls(calls)).toEqual([])
    // Select the Extra section: the copy lands there.
    click(document.querySelector('[data-design-target="group:extra"]'))
    click(document.querySelector('[data-add-copy="title"]'))
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [{ op: 'place', field: 'title', group_key: 'extra', index: 1 }]
    ])
    expect(document.querySelector('[data-add-notice]')).toBeNull()
  })

  it('add panel offers every slot card the classic editor could add', async () => {
    await mount()
    click(document.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!document.querySelector('[data-add-slot]'))
    const slots = [...document.querySelectorAll('[data-add-slot]')].map((el) =>
      el.getAttribute('data-add-slot')
    )
    expect(slots).toEqual([
      '__pipeline__',
      '__comments__',
      '__tasks__',
      '__addendums__',
      '__referenced_by__',
      '__related_records__',
      '__owners__',
      '__pdf__',
      '__subtitle__'
    ])
  })

  it('a widget list that fails to load says so', async () => {
    widgetsFail = true
    try {
      await mount()
      click(document.querySelector('[data-editor-tab="add"]'))
      await settle(() => !!document.querySelector('[data-editor-add] [role="alert"]'))
      expect(document.querySelector('[data-editor-add] [role="alert"]')?.textContent).toContain(
        'Server unavailable'
      )
    } finally {
      widgetsFail = false
    }
  })

  it('undo that removes the selected placement clears the selection; Ctrl+Y redoes', async () => {
    const { calls } = await mount()
    click(document.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!document.querySelector('[data-add-field="vendor"]'))
    click(document.querySelector('[data-add-field="vendor"]'))
    await settle(() => opsCalls(calls).length === 1)
    await settle(
      () => document.querySelector('[data-editor-inspector] h2')?.textContent === 'Vendor name'
    )
    expect(document.querySelector('[data-editor-inspector] h2')?.textContent).toBe('Vendor name')
    const undo = document.querySelector('[aria-label="Undo"]') as HTMLButtonElement
    await settle(() => !undo.disabled)
    click(undo)
    await settle(() => !document.querySelector('[data-editor-inspector] h2'))
    expect(document.querySelector('[data-editor-inspector] h2')).toBeNull()
    await settle(() => opsCalls(calls).length === 2)
    const redo = document.querySelector('[aria-label="Redo"]') as HTMLButtonElement
    await settle(
      () => !redo.disabled && document.querySelector('[data-save-status="saved"]') != null
    )
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })
      )
    })
    await settle(() => opsCalls(calls).length === 3)
    // Nothing was selected, so the add (and its redo) went to the end of Main.
    expect(opsCalls(calls)[2]).toEqual([
      { op: 'place', field: 'vendor', group_key: 'main', index: 2 }
    ])
  })

  it('overlay inside a modal sheet mounts in that sheet as a dialog; Escape leaves; focus returns', async () => {
    const onBack = vi.fn()
    const { close } = await mount({ mode: 'overlay', inDialog: true, onBack })
    const editor = document.querySelector('[data-layout-editor]') as HTMLElement
    expect(editor.closest('[data-host-sheet]')).not.toBeNull()
    expect(editor.getAttribute('role')).toBe('dialog')
    expect(editor.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(editor)
    // Escape typed into a field is the field's.
    const search = document.createElement('input')
    editor.appendChild(search)
    act(() => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onBack).not.toHaveBeenCalled()
    act(() => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onBack).toHaveBeenCalledTimes(1)
    search.remove()
    close()
    expect(document.activeElement?.getAttribute('data-opener')).toBe('')
  })

  it('overlay outside any dialog mounts on body', async () => {
    await mount({ mode: 'overlay' })
    const editor = document.querySelector('[data-layout-editor]') as HTMLElement
    expect(editor.parentElement).toBe(document.body)
  })

  it('overlay says which layout it edits and who gets it; Done leaves', async () => {
    const onBack = vi.fn()
    await mount({ mode: 'overlay', onBack })
    await settle(() => !!document.querySelector('[data-editing-banner]'))
    const banner = document.querySelector('[data-editing-banner]') as HTMLElement
    expect(banner.textContent).toContain('Editing Order form')
    expect(banner.textContent).toContain('used by every record no rule catches')
    click(banner.querySelector('button'))
    expect(onBack).toHaveBeenCalledTimes(1)
    // Hosts get a promise that settles once the last save has landed.
    expect(onBack.mock.calls[0][0]).toBeInstanceOf(Promise)
    expect(document.querySelector('[data-editor-topbar]')?.textContent).toContain('Back to record')
  })

  it('an Add panel row dragged onto a section emits one place op and selects it', async () => {
    mockRects()
    const { calls } = await mount()
    click(document.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!document.querySelector('[data-add-field="vendor"]'))
    const row = document.querySelector('[data-add-field="vendor"]') as HTMLElement
    // Already on the form: click only.
    expect(
      document.querySelector('[data-add-field="title"]')?.hasAttribute('aria-roledescription')
    ).toBe(false)
    pointer('pointerdown', row, -200, 15)
    pointer('pointermove', document, -190, 20)
    await tick()
    // Lower half of Title: after it.
    pointer('pointermove', document, 100, 80)
    await tick()
    expect(node('field:title:main').getAttribute('data-drop-slot')).toBe('after')
    pointer('pointerup', document, 100, 80)
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [{ op: 'place', field: 'vendor', group_key: 'main', index: 1 }]
    ])
    await settle(
      () => document.querySelector('[data-editor-inspector] h2')?.textContent === 'Vendor name'
    )
    expect(document.querySelector('[data-editor-inspector] h2')?.textContent).toBe('Vendor name')
    expect(document.querySelector('[aria-label="Undo"]')?.getAttribute('data-tip')).toContain(
      'Add Vendor name'
    )
  })

  it('a keyboard drag on the canvas emits one move op', async () => {
    mockRects()
    const { calls } = await mount()
    const title = node('field:title:main')
    expect(title.getAttribute('aria-roledescription')).toBe('draggable')
    title.focus()
    key('Space', title)
    await tick()
    key('ArrowDown')
    await tick()
    expect(node('field:amount:main').getAttribute('data-drop-slot')).toBe('after')
    key('Space')
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [{ op: 'move', from: { field: 'title', group_key: 'main' }, to_group_key: 'main', index: 1 }]
    ])
  })

  it('Escape during a drag in overlay mode cancels the drag, not the editor', async () => {
    mockRects()
    const onBack = vi.fn()
    const { calls } = await mount({ mode: 'overlay', onBack })
    const title = node('field:title:main')
    title.focus()
    key('Space', title)
    await tick()
    key('ArrowDown')
    await tick()
    expect(node('field:amount:main').getAttribute('data-drop-slot')).toBe('after')
    key('Escape', title)
    await tick()
    expect(onBack).not.toHaveBeenCalled()
    expect(node('field:amount:main').hasAttribute('data-drop-slot')).toBe(false)
    // No drag now: Escape leaves.
    key('Escape', title)
    expect(onBack).toHaveBeenCalledTimes(1)
    await tick()
    expect(opsCalls(calls)).toEqual([])
  })

  it('a pointer drag on the canvas emits one move op', async () => {
    mockRects()
    const { calls } = await mount()
    pointer('pointerdown', node('field:title:main'), 100, 70)
    pointer('pointermove', document, 106, 72)
    await tick()
    // Lower half of Amount: after it.
    pointer('pointermove', document, 100, 130)
    await tick()
    expect(node('field:amount:main').getAttribute('data-drop-slot')).toBe('after')
    pointer('pointerup', document, 100, 130)
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [{ op: 'move', from: { field: 'title', group_key: 'main' }, to_group_key: 'main', index: 1 }]
    ])
    // dnd-kit swallows document clicks for 50 ms after a pointer drag: let it go.
    await act(() => new Promise((r) => setTimeout(r, 60)))
  })

  it('Form settings is the real panel; a toggle saves one layout_update', async () => {
    const { calls } = await mount()
    click(document.querySelector('[data-rail-settings]'))
    await settle(() => !!document.querySelector('[data-editor-inspector] [data-form-settings]'))
    const toggle = document.querySelector(
      '[data-setting="layout.accordion_mode"] [role="switch"]'
    ) as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    click(toggle)
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([[{ op: 'layout_update', patch: { accordion_mode: true } }]])
  })

  it('a save that leaves the overview as it was never refetches it; a New-menu change does', async () => {
    const { calls } = await mount()
    const overviewReads = () =>
      calls.filter((c) => c._path === '/collection-layouts/overview').length
    await settle(() => overviewReads() > 0)
    const before = overviewReads()
    click(document.querySelector('[data-rail-settings]'))
    await settle(() => !!document.querySelector('[data-editor-inspector] [data-form-settings]'))
    const toggle = (key: string) =>
      click(document.querySelector(`[data-setting="${key}"] [role="switch"]`))
    toggle('layout.accordion_mode')
    await settle(() => opsCalls(calls).length === 1)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(overviewReads()).toBe(before)

    toggle('layout.create_hidden')
    await settle(() => opsCalls(calls).length === 2)
    await settle(() => overviewReads() > before)
    expect(overviewReads()).toBe(before + 1)
  })

  it('Preview as role in Form settings is the top bar role; the canvas follows', async () => {
    const b = makeBundle()
    bundleOverride = {
      ...b,
      groups: b.groups.map((g) => (g.key === 'extra' ? { ...g, hidden_for_roles: '["r-fin"]' } : g))
    }
    await mount()
    const previewBtn = () => document.querySelector('[aria-label="Preview as"]')
    click(document.querySelector('[data-rail-settings]'))
    await settle(() => !!document.querySelector('[data-setting="tool.preview_as_role"]'))
    const roleSetting = () => document.querySelector('[data-setting="tool.preview_as_role"]')
    click(roleSetting()?.querySelector('[aria-label="Preview as role"]') ?? null)
    const option = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (o) => (o.querySelector('span')?.textContent ?? o.textContent)?.trim() === label
      )
    await settle(() => !!option('Finance'))
    click(option('Finance') ?? null)
    // Extra is hidden for Finance: gone from the canvas; the top bar says Finance.
    await settle(() => !node('field:notes:extra'))
    expect(node('field:notes:extra')).toBeNull()
    await settle(() => !!previewBtn()?.textContent?.includes('Finance'))
    expect(previewBtn()?.textContent).toContain('Finance')
    await settle(() => !!roleSetting()?.textContent?.includes('1 field hidden'))
    expect(roleSetting()?.textContent).toContain('1 field hidden')
    // Back to the inspector and again: the role stays, the setting still shows it.
    click(document.querySelector('[data-design-target="field:title:main"]'))
    expect(previewBtn()?.textContent).toContain('Finance')
    click(document.querySelector('[data-rail-settings]'))
    await settle(() => !!roleSetting())
    expect(roleSetting()?.querySelector('[aria-label="Preview as role"]')?.textContent).toContain(
      'Finance'
    )
    // Off in Form settings: off on the canvas.
    click(roleSetting()?.querySelector('[aria-label="Preview as role"]') ?? null)
    await settle(() => !!option('Nobody (off)'))
    click(option('Nobody (off)') ?? null)
    await settle(() => !!node('field:notes:extra'))
    expect(node('field:notes:extra')).not.toBeNull()
    expect(previewBtn()?.textContent).not.toContain('Finance')
  })

  it('Preview as role marks the fields the role cannot see or change, not only its groups', async () => {
    const b = makeBundle()
    bundleOverride = {
      ...b,
      groups: b.groups.map((g) => (g.key === 'extra' ? { ...g, hidden_for_roles: '["r-fin"]' } : g))
    }
    // Field permissions hide Amount and lock Title; the layout hides the Extra section.
    rolePreviewOverride = { ...ROLE_PREVIEW, hidden_fields: ['amount'], readonly_fields: ['title'] }
    await mount()
    const mark = (k: string) => node(k)?.querySelector('[data-design-role-tag]')
    expect(mark('field:amount:main')).toBeNull()
    click(document.querySelector('[data-rail-settings]'))
    await settle(() => !!document.querySelector('[data-setting="tool.preview_as_role"]'))
    const roleSetting = () => document.querySelector('[data-setting="tool.preview_as_role"]')
    const option = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (o) => (o.querySelector('span')?.textContent ?? o.textContent)?.trim() === label
      )
    click(roleSetting()?.querySelector('[aria-label="Preview as role"]') ?? null)
    await settle(() => !!option('Finance'))
    click(option('Finance') ?? null)
    await settle(() => !!mark('field:amount:main'))
    // Hidden by permissions: still on the canvas, faint, tagged, selectable.
    expect(node('field:amount:main').getAttribute('data-role-mark')).toBe('hidden')
    expect(mark('field:amount:main')?.textContent).toBe('Hidden for Finance')
    // Read-only by permissions: a lock tag, not faint.
    expect(node('field:title:main').getAttribute('data-role-mark')).toBe('readonly')
    expect(mark('field:title:main')?.textContent).toBe('Read-only for Finance')
    // The section the layout hides for the role is gone.
    expect(node('field:notes:extra')).toBeNull()
    click(node('field:amount:main'))
    await settle(
      () => document.querySelector('[data-editor-inspector] h2')?.textContent === 'Amount'
    )
    expect(document.querySelector('[data-editor-inspector] h2')?.textContent).toBe('Amount')
    // Preview off: no marks.
    click(document.querySelector('[data-rail-settings]'))
    await settle(() => !!roleSetting())
    click(roleSetting()?.querySelector('[aria-label="Preview as role"]') ?? null)
    await settle(() => !!option('Nobody (off)'))
    click(option('Nobody (off)') ?? null)
    await settle(() => !mark('field:amount:main'))
    expect(mark('field:amount:main')).toBeNull()
    expect(node('field:amount:main').hasAttribute('data-role-mark')).toBe(false)
  })

  it('what a parent layout supplies never drags; the layout’s own fields do', async () => {
    const b = makeBundle()
    bundleOverride = { ...b, layout: { ...b.layout, parent_layout_id: 9 } }
    parentBundle = {
      layout: { id: 9, collection: 'orders', name: 'Base form', layout_type: 'grouped' },
      groups: [{ ...newGroup('base', 'Base', 'section', null), id: 5, sort: 2 }],
      placements: [{ ...newPlacement('vendor', 'base'), id: 50, sort: 0 }],
      rev: 'p0'
    }
    await mount()
    await settle(() => !!node('field:vendor:base'))
    expect(node('field:vendor:base').hasAttribute('aria-roledescription')).toBe(false)
    expect(node('group:base').hasAttribute('aria-roledescription')).toBe(false)
    expect(node('field:title:main').getAttribute('aria-roledescription')).toBe('draggable')
  })

  it('page mode shows no editing banner', async () => {
    await mount()
    expect(document.querySelector('[data-editing-banner]')).toBeNull()
  })

  it('⌘K opens the command palette; a command previews in words and applies as one batch', async () => {
    const { calls } = await mount()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    })
    await settle(() => !!document.querySelector('[data-command-input]'))
    const input = document.querySelector('[data-command-input]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'move Notes to Main; make Title required'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.form?.requestSubmit()
    })
    await settle(() => !!document.querySelector('[data-command-preview]'))
    const preview = document.querySelector('[data-command-preview]')?.textContent ?? ''
    expect(preview).toContain('Move Notes to Main')
    expect(preview).toContain('Make Title required')
    expect(opsCalls(calls)).toEqual([])
    click(document.querySelector('[data-command-apply]'))
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [
        {
          op: 'move',
          from: { field: 'notes', group_key: 'extra' },
          to_group_key: 'main',
          index: 2
        },
        {
          op: 'update_placement',
          at: { field: 'title', group_key: 'main' },
          patch: { overrides: { required: true } }
        }
      ]
    ])
    expect(document.querySelector('[data-command-input]')).toBeNull()
  })
})

describe('isTyping', () => {
  it('covers inputs, textboxes and every editable element', () => {
    const make = (html: string) => {
      const d = document.createElement('div')
      d.innerHTML = html
      document.body.appendChild(d)
      return d.firstElementChild as HTMLElement
    }
    expect(isTyping(make('<input />'))).toBe(true)
    expect(isTyping(make('<div role="textbox"><span>x</span></div>').firstElementChild)).toBe(true)
    expect(isTyping(make('<div contenteditable="plaintext-only">x</div>'))).toBe(true)
    expect(isTyping(make('<div contenteditable="false">x</div>'))).toBe(false)
    expect(isTyping(make('<button>x</button>'))).toBe(false)
  })
})
