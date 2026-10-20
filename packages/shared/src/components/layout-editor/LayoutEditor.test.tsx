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

function makeClient() {
  const calls: Cmd[] = []
  let stored = makeBundle()
  let rev = 0
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/7/bundle') return stored
      if (p === '/collection-layouts/7/ops') {
        stored = { ...applyLayoutOps(stored, cmd._body?.ops as LayoutOp[]), rev: `r${++rev}` }
        return stored
      }
      if (p === '/collection-layouts/overview') return { data: OVERVIEW }
      if (p === '/field-config/orders') return { data: project(stored.placements as never) }
      if (p === '/field-config/orders/project')
        return { data: project((cmd._body?.assignments ?? []) as never) }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
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
    await settle(() => !!document.querySelector('[data-editor-inspector] h3'))
    const insp = document.querySelector('[data-editor-inspector]')
    expect(insp?.textContent).toContain('Title')
    expect(insp?.textContent).toContain('Main')
    expect(
      document
        .querySelector('[data-design-target="field:title:main"]')
        ?.getAttribute('data-selected')
    ).toBe('true')
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
    await settle(() => !!document.querySelector('[data-editor-inspector] h3'))
    expect(document.querySelector('[data-editor-inspector] h3')?.textContent).toBe('Vendor name')
    const undo = document.querySelector('[aria-label="Undo"]') as HTMLButtonElement
    await settle(() => !undo.disabled)
    click(undo)
    await settle(() => !document.querySelector('[data-editor-inspector] h3'))
    expect(document.querySelector('[data-editor-inspector] h3')).toBeNull()
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
    expect(document.querySelector('[data-editor-topbar]')?.textContent).toContain('Back to record')
  })

  it('page mode shows no editing banner', async () => {
    await mount()
    expect(document.querySelector('[data-editing-banner]')).toBeNull()
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
