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
import { LayoutEditor } from './LayoutEditor'
import { closeBarMenu, openBarMenu, pickBarRow } from './toolbar-kit.test-utils'

// Way-finding in the editor: Find (#2620), the outline (#2621), the
// inspector breadcrumb (#2622), the shortcut sheet (#2626), compact canvas and
// expand / collapse all (#2627).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function field(name: string, label: string): CMSField {
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
    dependency_config: null
  }
}

const FIELDS: Record<string, CMSField> = {
  title: field('title', 'Title'),
  amount: field('amount', 'Amount'),
  notes: field('notes', 'Notes'),
  vendor: field('vendor', 'Vendor name')
}

function sections(): LayoutBundle {
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
      { ...newPlacement('notes', 'extra'), id: 12, sort: 0, overrides: { hidden: true } }
    ],
    rev: 'r0'
  }
}

// A steps holder: Request (title) then Billing (notes, vendor).
function steps(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Order form', layout_type: 'grouped' },
    groups: [
      { ...newGroup('flow', 'Flow', 'container', null), id: 1, sort: 0, tab_mode: 'steps' },
      { ...newGroup('one', 'Request', 'tab', 'flow'), id: 2, sort: 0 },
      { ...newGroup('two', 'Billing', 'tab', 'flow'), id: 3, sort: 1 },
      ungroupedGroup(1)
    ],
    placements: [
      { ...newPlacement('title', 'one'), id: 10, sort: 0 },
      { ...newPlacement('notes', 'two'), id: 11, sort: 0 },
      { ...newPlacement('vendor', 'two'), id: 12, sort: 1 }
    ],
    rev: 'r0'
  }
}

let bundleOf: () => LayoutBundle = sections

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

function project(assignments: Array<Record<string, unknown>>): CMSField[] {
  const placed = assignments.filter((a) => !String(a.field).startsWith('__'))
  const rows = placed.map((a) => ({
    ...FIELDS[String(a.field)],
    group_key: (a.group_key as string | null) ?? null,
    sort: Number(a.sort),
    // The server's projection applies the placement's Hidden switch.
    hidden: (a.overrides as { hidden?: boolean } | null)?.hidden === true,
    layout_assigned: true
  }))
  const names = new Set(placed.map((a) => a.field))
  for (const f of Object.values(FIELDS))
    if (!names.has(f.field)) rows.push({ ...f, group_key: null, layout_assigned: false })
  return rows
}

function makeClient() {
  const calls: Cmd[] = []
  let stored = bundleOf()
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
      if (p === '/collection-layouts/overview') return { data: { rows: [], warning: null } }
      if (p === '/field-config/orders') return { data: project(stored.placements as never) }
      if (p === '/field-config/orders/project')
        return { data: project((cmd._body?.assignments ?? []) as never) }
      if (p === '/collections/orders')
        return { data: { display_name: 'Orders', fields: Object.values(FIELDS) } }
      if (method !== 'GET') return { data: null }
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
  try {
    localStorage.clear()
  } catch {
    /* none */
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  bundleOf = sections
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 150 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null
const canvasField = (f: string) => $(`[data-editor-canvas] [data-field="${f}"]`)
const title = () => $('[data-inspector] h2')?.textContent
const opsCalls = (calls: Cmd[]) =>
  calls
    .filter((c) => c._path === '/collection-layouts/7/ops')
    .map((c) => c._body?.ops as LayoutOp[])

function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    ;(el as HTMLElement).click()
  })
}
const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
function type(input: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function mount(firstField = 'title') {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditor collection='orders' layoutId={7} onBack={() => {}} mode='page' />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => !!canvasField(firstField))
  // Autosave on: each change reaches the server as it is made.
  await pickBarRow('Save options', '[data-autosave-switch]')
  await settle(() => !$('[data-editor-save]'))
  return { calls }
}

describe('Find on canvas (#2620)', () => {
  it('⌘F opens Find; a hidden field is found too, and Enter selects it with Show hidden on', async () => {
    await mount()
    expect(canvasField('notes')).toBeNull()
    press('f', { metaKey: true })
    await settle(() => !!$('[data-editor-find] input'))
    type($('[data-editor-find] input') as HTMLInputElement, 'not')
    await settle(() => !!$('[data-find-hit]'))
    expect($('[data-find-count]')?.textContent).toBe('1 match · 1 hidden')
    press('Enter', {}, $('[data-editor-find] input') as HTMLElement)
    await settle(() => title() === 'Notes')
    expect(title()).toBe('Notes')
    expect($('[data-editor-find]')).toBeNull()
    await settle(() => !!canvasField('notes'))
    // Show hidden lives in the Preview popover; the Preview button marks it on.
    expect($('[data-preview-hidden-on]')).not.toBeNull()
    click($('[data-preview-as]'))
    await settle(() => !!$('[data-show-hidden-switch]'))
    expect($('[data-show-hidden-switch]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('opens the step a field sits on', async () => {
    bundleOf = steps
    await mount()
    expect(canvasField('vendor')).toBeNull()
    press('f', { ctrlKey: true })
    await settle(() => !!$('[data-editor-find] input'))
    type($('[data-editor-find] input') as HTMLInputElement, 'vendor')
    await settle(() => !!$('[data-find-hit]'))
    click($('[data-find-hit]'))
    await settle(() => !!canvasField('vendor'))
    expect(canvasField('vendor')).not.toBeNull()
    expect(title()).toBe('Vendor name')
    // The breadcrumb names the holder and the step (#2622).
    expect($('[data-panel-eyebrow]')?.textContent).toBe('Field · Flow › Billing')
  })

  it('leaves ⌘F alone when focus is outside the editor', async () => {
    await mount()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    press('f', { metaKey: true }, outside)
    await settle(() => false)
    expect($('[data-editor-find]')).toBeNull()
    outside.remove()
  })
})

describe('Inspector breadcrumb (#2622)', () => {
  it('a part of the breadcrumb selects that step', async () => {
    bundleOf = steps
    await mount()
    click($('[data-editor-canvas] [data-design-target="field:title:one"]'))
    await settle(() => title() === 'Title')
    expect($('[data-panel-eyebrow]')?.textContent).toBe('Field · Flow › Request')
    click($('[data-crumb="one"]'))
    await settle(() => title() === 'Request')
    expect($('[data-panel-eyebrow]')?.textContent).toBe('Step · Flow')
    click($('[data-crumb="flow"]'))
    await settle(() => title() === 'Flow')
    expect($('[data-panel-eyebrow]')?.textContent).toBe('Steps holder')
  })
})

describe('Outline (#2621)', () => {
  it('a row selects on the canvas; the canvas selection marks its row', async () => {
    await mount()
    await pickBarRow('Tools', '[data-editor-outline-toggle]')
    await settle(() => !!$('[data-editor-outline]'))
    const rows = [...document.querySelectorAll('[data-outline-row]')].map((r) =>
      r.getAttribute('data-outline-row')
    )
    expect(rows).toEqual([
      'group:main',
      'field:title:main',
      'field:amount:main',
      'group:extra',
      'field:notes:extra'
    ])
    click($('[data-outline-row="field:amount:main"]'))
    await settle(() => title() === 'Amount')
    expect($('[data-outline-row="field:amount:main"]')?.getAttribute('aria-selected')).toBe('true')
    click($('[data-editor-canvas] [data-design-target="field:title:main"]'))
    await settle(() => title() === 'Title')
    expect($('[data-outline-row="field:title:main"]')?.getAttribute('aria-selected')).toBe('true')
    expect($('[data-outline-row="field:amount:main"]')?.getAttribute('aria-selected')).toBe('false')
    // Open stays open for this viewer.
    expect(localStorage.getItem('nvr_layout_editor_outline')).toBe('1')
  })

  it('a row dropped on another emits the canvas’s own move op', async () => {
    const { calls } = await mount()
    await pickBarRow('Tools', '[data-editor-outline-toggle]')
    await settle(() => !!$('[data-editor-outline]'))
    const drag = (type: string, el: HTMLElement, y: number) =>
      act(() => {
        const e = new Event(type, { bubbles: true, cancelable: true })
        Object.assign(e, {
          clientY: y,
          dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' }
        })
        el.dispatchEvent(e)
      })
    const from = $('[data-outline-row="field:amount:main"]') as HTMLElement
    const to = $('[data-outline-row="field:notes:extra"]') as HTMLElement
    drag('dragstart', from, 0)
    drag('dragover', to, -1)
    expect(to.querySelector('[data-outline-drop="before"]')).not.toBeNull()
    drag('drop', to, -1)
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)[0]).toEqual([
      { op: 'move', from: { field: 'amount', group_key: 'main' }, to_group_key: 'extra', index: 0 }
    ])
    await settle(() => title() === 'Amount')
    expect($('[data-outline-row="field:amount:extra"]')?.getAttribute('aria-selected')).toBe('true')
  })
})

describe('Shortcut sheet (#2626)', () => {
  it('? opens the sheet; not while typing', async () => {
    await mount()
    const input = document.createElement('input')
    $('[data-layout-editor]')?.appendChild(input)
    press('?', { shiftKey: true }, input)
    await settle(() => false)
    expect($('[data-editor-shortcuts]')).toBeNull()
    input.remove()
    press('?', { shiftKey: true })
    await settle(() => !!$('[data-editor-shortcuts]'))
    for (const id of ['undo', 'redo', 'save', 'find', 'duplicate', 'alt-move', 'keyboard-drag'])
      expect($(`[data-shortcut="${id}"]`)).not.toBeNull()
  })
})

describe('Compact canvas and collapse all (#2627)', () => {
  it('compact is an editor-only zoom kept for this viewer', async () => {
    await mount()
    expect($('[data-canvas-density]')?.getAttribute('data-canvas-density')).toBe('normal')
    await pickBarRow('Tools', '[data-editor-compact]')
    await settle(
      () => $('[data-canvas-density]')?.getAttribute('data-canvas-density') === 'compact'
    )
    expect(($('[data-canvas-density]') as HTMLElement).style.zoom).toBe('0.8')
    expect(localStorage.getItem('nvr_layout_editor_compact')).toBe('1')
  })

  it('the zoom slider zooms the canvas, keeps it for this viewer, and stacks with compact (#3188)', async () => {
    await mount()
    await openBarMenu('Tools')
    const slider = $('[data-bar-menu-list="Tools"] [data-zoom-slider]') as HTMLInputElement
    expect(slider).not.toBeNull()
    type(slider, '0.6')
    await settle(() => $('[data-canvas-density]')?.style.zoom === '0.6')
    expect(localStorage.getItem('nvr_layout_editor_zoom')).toBe('0.6')
    expect($('[data-bar-menu-list="Tools"] [data-zoom-value]')?.textContent).toBe('60%')
    await closeBarMenu('Tools')
    // A chip on the canvas while zoomed; its 100% goes back.
    expect($('[data-zoom-chip]')).not.toBeNull()
    await pickBarRow('Tools', '[data-editor-compact]')
    await settle(() => $('[data-canvas-density]')?.style.zoom === '0.48')
    click($('[data-zoom-chip-reset]'))
    await settle(() => $('[data-canvas-density]')?.style.zoom === '0.8')
    expect($('[data-zoom-chip]')).toBeNull()
    expect(localStorage.getItem('nvr_layout_editor_zoom')).toBeNull()
  })

  it('Fit to screen fits every device side by side into the pane (#3187 #3188)', async () => {
    await mount()
    // Preview → Device → All: three panes, only the desktop one drags.
    click($('[data-preview-as]'))
    await settle(() => !!$('[data-preview-modes]'))
    const all = [...document.querySelectorAll('[data-preview-modes] button')].find(
      (b) => b.textContent === 'All'
    )
    click(all ?? null)
    await settle(() => !!$('[data-preview-devices]'))
    expect(
      [...document.querySelectorAll('[data-preview-devices] > [data-preview-pane]')].map((s) =>
        s.getAttribute('data-preview-pane')
      )
    ).toEqual(['desktop', 'tablet', 'phone'])
    expect($('[data-preview-summary]')?.textContent).toContain('All devices')
    expect(document.querySelectorAll('[data-editor-canvas] [data-field="title"]').length).toBe(3)
    click($('[data-preview-as]'))
    await settle(() => !$('[data-preview-modes]'))
    // jsdom lays nothing out: give the pane a width.
    const pane = $('main') as HTMLElement
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1126 })
    // Radix hands focus back to the Preview button a tick after it closes.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    await openBarMenu('Tools')
    await settle(() => !!$('[data-bar-menu-list="Tools"] [data-zoom-fit]'))
    click($('[data-bar-menu-list="Tools"] [data-zoom-fit]'))
    await settle(() => $('[data-canvas-density]')?.style.zoom === '0.5')
    await closeBarMenu('Tools')
  })

  it('a sample record fills the preview when the collection has no records (#3196)', async () => {
    const { calls } = await mount()
    click($('[data-preview-as]'))
    await settle(() => !!$('[data-sample-offer="empty"] [data-sample-record]:not([disabled])'))
    expect($('[data-sample-offer="empty"]')?.textContent).toContain('No records yet')
    click($('[data-sample-record]'))
    await settle(() => !!$('[data-sample-chip]'))
    expect($('[data-preview-summary]')?.textContent).toContain('Sample record')
    const input = $('[data-editor-canvas] [data-field="title"] input') as HTMLInputElement | null
    await settle(() => !!input?.value)
    expect(input?.value).toBeTruthy()
    // Nothing is written anywhere.
    expect(
      calls.some((c) => c._path.startsWith('/items') && c._method && c._method !== 'GET')
    ).toBe(false)
    // × goes back to no record.
    click($('[data-sample-chip] button'))
    await settle(() => !$('[data-sample-chip]'))
    expect($('[data-preview-summary]')?.textContent).toBe('No record')
  })

  it('collapse all folds every section; expand all opens them and lays out every step', async () => {
    await mount()
    await pickBarRow('Tools', '[data-editor-collapse-all]')
    await settle(() => !canvasField('title'))
    expect(canvasField('amount')).toBeNull()
    await pickBarRow('Tools', '[data-editor-expand-all]')
    await settle(() => !!canvasField('title'))
    expect(canvasField('amount')).not.toBeNull()
  })

  it('expand all shows every step of a steps holder at once', async () => {
    bundleOf = steps
    await mount()
    expect(canvasField('notes')).toBeNull()
    await pickBarRow('Tools', '[data-editor-expand-all]')
    await settle(() => !!canvasField('notes'))
    expect(canvasField('title')).not.toBeNull()
    expect(canvasField('vendor')).not.toBeNull()
    expect($('[data-design-stacked="two"]')?.textContent).toBe('Billing')
    await pickBarRow('Tools', '[data-editor-collapse-all]')
    await settle(() => !canvasField('notes'))
    expect(canvasField('title')).not.toBeNull()
  })
})
