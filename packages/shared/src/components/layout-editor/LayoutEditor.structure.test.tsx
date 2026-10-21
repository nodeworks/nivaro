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
import { pickBarRow } from './toolbar-kit.test-utils'

// The canvas menu, ⌘D, pin and find & replace in the real editor
// (#2623 #2624 #2625 #2628 #2630): what the person sees after each gesture.
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
  title: field('title', 'Oracle title'),
  amount: field('amount', 'Amount'),
  notes: field('notes', 'Notes')
}

function makeBundle(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Order form', layout_type: 'grouped' },
    groups: [
      { ...newGroup('main', 'Main Oracle', 'section', null), id: 1, sort: 0 },
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

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

function project(assignments: Array<Record<string, unknown>>): CMSField[] {
  return assignments
    .filter((a) => !String(a.field).startsWith('__'))
    .map((a) => ({
      ...FIELDS[String(a.field)],
      group_key: (a.group_key as string | null) ?? null,
      sort: Number(a.sort),
      layout_assigned: true
    }))
}

function makeClient() {
  let stored = makeBundle()
  let rev = 0
  return {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      const p = cmd._path
      if (p === '/collection-layouts/7/bundle') return stored
      if (p === '/collection-layouts/7/ops') {
        stored = { ...applyLayoutOps(stored, cmd._body?.ops as LayoutOp[]), rev: `r${++rev}` }
        return stored
      }
      if (p === '/field-config/orders') return { data: project(stored.placements as never) }
      if (p === '/field-config/orders/project')
        return { data: project((cmd._body?.assignments ?? []) as never) }
      if (p === '/collections/orders')
        return { data: { display_name: 'Orders', fields: Object.values(FIELDS) } }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
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
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

const canvasFields = () =>
  [...document.querySelectorAll('[data-editor-canvas] [data-field]')].map((el) =>
    el.getAttribute('data-field')
  )
const node = (key: string) =>
  document.querySelector(`[data-design-target="${key}"]`) as HTMLElement | null

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={makeClient() as never}>
          <LayoutEditor collection='orders' layoutId={7} onBack={() => {}} mode='page' />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => canvasFields().length >= 3)
}

const menu = () => document.querySelector('[data-structure-menu]') as HTMLElement | null
const action = (a: string) =>
  document.querySelector(`[data-structure-action="${a}"]`) as HTMLElement | null

function rightClick(key: string) {
  act(() => {
    node(key)?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40
      })
    )
  })
}

const groups = () =>
  [...document.querySelectorAll('[data-editor-canvas] [data-design-target^="group:"]')].map((el) =>
    el.getAttribute('data-design-target')
  )

function setInput(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('LayoutEditor structure actions', () => {
  it('right-click a section: Duplicate copies it with its fields, one undo step', async () => {
    await mount()
    rightClick('group:main')
    await settle(() => !!menu())
    expect(node('group:main')?.getAttribute('data-selected')).toBe('true')
    act(() => action('duplicate')?.click())
    await settle(() => !!node('field:title:main_copy'))
    expect(node('group:main_copy')).not.toBeNull()
    expect(node('group:main_copy')?.getAttribute('data-selected')).toBe('true')
    expect(menu()).toBeNull()
    // One undo takes the whole copy away.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))
    })
    await settle(() => !node('group:main_copy'))
    expect(node('field:title:main_copy')).toBeNull()
  })

  it('⌘D duplicates the selected section; on a field it says why not', async () => {
    await mount()
    act(() => node('group:extra')?.click())
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true }))
    })
    await settle(() => !!node('field:notes:extra_copy'))
    expect(node('group:extra_copy')).not.toBeNull()
    act(() => node('field:title:main')?.click())
    rightClick('field:title:main')
    await settle(() => !!menu())
    expect(action('duplicate')?.getAttribute('aria-disabled')).toBe('true')
    expect(action('duplicate')?.getAttribute('data-tip')).toMatch(/once per section/)
  })

  it('Wrap puts a field in a new section; Unwrap dissolves it again', async () => {
    await mount()
    rightClick('field:notes:extra')
    await settle(() => !!action('wrap'))
    act(() => action('wrap')?.click())
    await settle(() => !!node('field:notes:section'))
    expect(groups()).toContain('group:section')
    rightClick('group:section')
    await settle(() => !!action('unwrap'))
    act(() => action('unwrap')?.click())
    await settle(() => !!node('field:notes:'))
    expect(node('group:section')).toBeNull()
  })

  it('Convert previews what changes, then makes the section a tab', async () => {
    await mount()
    rightClick('group:extra')
    await settle(() => !!action('convert'))
    act(() => action('convert')?.click())
    await settle(() => !!document.querySelector('[data-structure-convert]'))
    const tab = document.querySelector('[data-convert-choice="tab"]') as HTMLElement
    expect(tab.textContent).toMatch(/new tabs holder takes its place/)
    act(() => (tab.querySelector('button') as HTMLElement).click())
    await settle(() => !!node('group:tabs'))
    expect(node('field:notes:extra')).not.toBeNull()
  })

  it('Pin shows a Pinned tag and the section no longer drags', async () => {
    await mount()
    expect(node('group:main')?.hasAttribute('aria-roledescription')).toBe(true)
    rightClick('group:main')
    await settle(() => !!action('pin'))
    act(() => action('pin')?.click())
    await settle(() => !!node('group:main')?.querySelector('[data-design-mark]'))
    expect(node('group:main')?.textContent).toMatch(/Pinned/)
    expect(node('group:main')?.hasAttribute('aria-roledescription')).toBe(false)
    expect(node('field:title:main')?.hasAttribute('aria-roledescription')).toBe(false)
    expect(node('field:notes:extra')?.hasAttribute('aria-roledescription')).toBe(true)
  })

  it('Find and replace lists every hit and applies the ticked ones as one step', async () => {
    await mount()
    await pickBarRow('Tools', '[data-find-replace-open]')
    await settle(() => !!document.querySelector('[data-find-replace]'))
    const [find, repl] = [
      ...document.querySelectorAll('[data-find-replace] input')
    ] as HTMLInputElement[]
    setInput(find, 'Oracle')
    setInput(repl, 'Fusion')
    await settle(() => document.querySelectorAll('[data-find-hit]').length === 2)
    expect(
      [...document.querySelectorAll('[data-find-hit]')].map((h) => h.getAttribute('data-find-hit'))
    ).toEqual(['group_label', 'field_label'])
    act(() => (document.querySelector('[data-find-replace-apply]') as HTMLElement).click())
    await settle(() => /Main Fusion/.test(node('group:main')?.textContent ?? ''))
    expect(document.querySelector('[data-tip^="Undo Replace 2 matches"]')).not.toBeNull()
  })
})
