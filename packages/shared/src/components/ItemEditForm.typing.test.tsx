// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// army6 M1: the New PO form's Description box dropped typed characters
// (~1 in 100). Cause: after every keystroke passive effects queued no-op state
// updates (validation clean-ups, personal-default publish). Keys arriving
// while React's scheduler had no turn (only microtasks between keys, as when
// fast input starves it) made React count each keystroke's commit as a nested
// update; past 50 the next setDraft threw "Maximum update depth exceeded" and
// that key was lost (200 keys kept 197 before the fix). The keys below get
// only microtasks between them.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
}))

function field(name: string, label: string, iface = 'input'): CMSField {
  return {
    field: name,
    type: 'text',
    interface: iface,
    label,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: 'basic',
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    layout_assigned: true
  }
}

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

function makeServer() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 7, name: 'Workflow', slug: 'workflow' },
            groups: [
              { id: 1, key: 'basic', label: 'Basic Info', type: 'tab', icon: null, sort: 0 }
            ],
            assignments: [
              { field: 'description', sort: 0, group_key: 'basic', is_visible: true },
              { field: 'notes', sort: 1, group_key: 'basic', is_visible: true }
            ],
            ungrouped_sort: 99
          }
        }
      if (p === '/field-config/workflows')
        return {
          data: [field('description', 'Description'), field('notes', 'Notes', 'textarea')]
        }
      if (p === '/collections/workflows') return { data: { display_name: 'Workflows' } }
      if (p.startsWith('/drafts/') && method === 'GET')
        throw Object.assign(new Error('404'), { status: 404 })
      if (p.startsWith('/record-views/')) return { data: null }
      if (method !== 'GET') return { data: { id: 1 } }
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
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean, rounds = 100) {
  for (let i = 0; i < rounds && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const box = (f: string) =>
  host.querySelector(`[data-field="${f}"] input, [data-field="${f}"] textarea`) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null

/** One key the way the browser applies it: the DOM value grows by one
 *  character, then `input` fires. No act / await between keys. */
function key(el: HTMLInputElement | HTMLTextAreaElement, ch: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  set?.call(el, el.value + ch)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** What a browser runs between two key events (separate tasks): the
 *  microtask queue, where React flushes the sync work a commit scheduled. */
async function microtasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function mountNew() {
  const server = makeServer()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={server.client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
            <ItemEditForm collection='workflows' itemId='new' documentTitle={false} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => !!box('description') && !!box('notes'))
  return server
}

const TEXT = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(5).slice(0, 150)

describe('ItemEditForm fast typing (army6 M1)', () => {
  it('keeps every character typed into a text input', async () => {
    await mountNew()
    const el = box('description') as HTMLInputElement
    el.focus()
    for (const ch of TEXT) {
      key(el, ch)
      await microtasks()
    }
    await settle(() => false, 5)
    expect(el.value).toBe(TEXT)
  }, 120_000)

  it('keeps every character while timers and requests land between keys', async () => {
    await mountNew()
    const el = box('description') as HTMLInputElement
    el.focus()
    let i = 0
    for (const ch of TEXT) {
      key(el, ch)
      await microtasks()
      // Every few keys the draft persist debounce, rule calls and the like run.
      if (++i % 7 === 0)
        await act(async () => {
          await new Promise((r) => setTimeout(r, 15))
        })
    }
    await settle(() => false, 100)
    expect(el.value).toBe(TEXT)
  }, 120_000)

  it('keeps every character typed into a textarea', async () => {
    await mountNew()
    const el = box('notes') as HTMLTextAreaElement
    el.focus()
    for (const ch of TEXT) {
      key(el, ch)
      await microtasks()
    }
    await settle(() => false, 5)
    expect(el.value).toBe(TEXT)
  }, 120_000)
})
