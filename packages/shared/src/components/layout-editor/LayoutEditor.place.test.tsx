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
import { CLIP_STORAGE_KEY } from './place-clip'

// The placing tools in the real editor (#3179 #3181 #3191 #3197 #3201): copy and
// paste, pasted field lists, slash-insert, put back as saved, recently removed.
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
const zoneOrder = (key: string) =>
  [...(node(`group:${key}`)?.querySelectorAll('[data-design-target^="field:"]') ?? [])].map((el) =>
    el.getAttribute('data-design-target')
  )

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

function clipboardEvent(type: 'copy' | 'paste', text = '') {
  const data: Record<string, string> = { 'text/plain': text }
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      getData: (k: string) => data[k] ?? '',
      setData: (k: string, v: string) => {
        data[k] = v
      }
    }
  })
  act(() => {
    document.body.dispatchEvent(ev)
  })
  return { ev, text: () => data['text/plain'] }
}

const placeAction = (a: string) =>
  document.querySelector(`[data-place-action="${a}"]`) as HTMLElement | null

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

describe('LayoutEditor placing tools', () => {
  beforeEach(() => localStorage.clear())

  it('⌘C a section and ⌘V it after the selection: a copy with its fields, one undo step', async () => {
    await mount()
    act(() => node('group:extra')?.click())
    const copied = clipboardEvent('copy')
    expect(copied.ev.defaultPrevented).toBe(true)
    expect(copied.text()).toContain('nivaro-layout-clip')
    expect(localStorage.getItem(CLIP_STORAGE_KEY)).toContain('"kind":"group"')
    clipboardEvent('paste', copied.text())
    await settle(() => !!node('field:notes:extra_2'))
    expect(node('group:extra_2')?.textContent).toMatch(/Extra \(copy\)/)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))
    })
    await settle(() => !node('group:extra_2'))
  })

  it('⌘V of plain field names places them in order after the selected field', async () => {
    await mount()
    act(() => node('field:title:main')?.click())
    const pasted = clipboardEvent('paste', 'Notes\nnope')
    expect(pasted.ev.defaultPrevented).toBe(true)
    await settle(() => !!node('field:notes:main'))
    expect(zoneOrder('main')).toEqual(['field:title:main', 'field:notes:main', 'field:amount:main'])
  })

  it('text typed in an input keeps its own paste', async () => {
    await mount()
    const input = document.createElement('input')
    document.querySelector('[data-editor-inspector]')?.appendChild(input)
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => 'notes' } })
    act(() => {
      input.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(false)
    input.remove()
  })

  it('/ on a focused field opens the search; a pick lands in that gap', async () => {
    await mount()
    act(() => node('field:title:main')?.focus())
    act(() => {
      node('field:title:main')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
      )
    })
    await settle(() => !!document.querySelector('[data-slash-insert]'))
    expect(document.querySelector('[data-slash-gap]')).not.toBeNull()
    const pick = document.querySelector('[data-slash-choice="notes"]') as HTMLElement
    expect(pick).not.toBeNull()
    act(() => pick.click())
    await settle(() => !!node('field:notes:main'))
    expect(zoneOrder('main')).toEqual(['field:title:main', 'field:notes:main', 'field:amount:main'])
    expect(document.querySelector('[data-slash-insert]')).toBeNull()
  })

  it('put back as saved takes a new section off; Recently removed brings it back', async () => {
    await mount()
    act(() => node('group:extra')?.click())
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true }))
    })
    await settle(() => !!node('group:extra_copy'))
    rightClick('group:extra_copy')
    await settle(() => !!placeAction('revert'))
    expect(placeAction('revert')?.textContent).toMatch(/Take Extra \(copy\) off/)
    act(() => placeAction('revert')?.click())
    await settle(() => !node('group:extra_copy'))
    act(() => (document.querySelector('[data-editor-tab="add"]') as HTMLElement).click())
    await settle(() => !!document.querySelector('[data-removed-entry]'))
    const row = document.querySelector('[data-removed-entry]') as HTMLElement
    expect(row.textContent).toMatch(/Extra \(copy\)/)
    act(() => row.click())
    await settle(() => !!node('field:notes:extra_copy'))
    expect(document.querySelector('[data-removed-entry]')).toBeNull()
  })

  it('a field changed since the save offers put back in the canvas menu', async () => {
    await mount()
    rightClick('field:title:main')
    await settle(() => !!placeAction('revert'))
    expect(placeAction('revert')?.getAttribute('aria-disabled')).toBe('true')
    expect(placeAction('copy')).not.toBeNull()
    expect(placeAction('copy-look')).not.toBeNull()
  })
})
