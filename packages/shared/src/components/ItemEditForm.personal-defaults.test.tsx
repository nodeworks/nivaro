// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { ActiveLayoutData, CMSField } from './item-edit/types'

// Personal field defaults on the real record form: a new record opens with the person's saved
// value in an allowed field, marked "Your default", without counting as unsaved work; a
// restored draft wins outright.
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
    group_key: 'main',
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    layout_assigned: true,
    ...over
  }
}

const LAYOUT: ActiveLayoutData = {
  layout: {
    id: 7,
    name: 'Order form',
    tab_mode: null,
    validate_before_next: false,
    summary_enabled: false,
    summary_show_all: false,
    ai_enabled: false
  },
  groups: [
    { id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0, is_collapsed: false }
  ],
  assignments: [
    { field: 'title', sort: 0, group_key: 'main', is_visible: true },
    { field: 'notes', sort: 1, group_key: 'main', is_visible: true }
  ],
  ungrouped_sort: 99
}

const FIELD_CONFIG: CMSField[] = [
  field('title', 'Title', { sort: 0, _overrides: { personal_default: true } }),
  field('notes', 'Notes', { sort: 1 })
]

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

let serverDraft: unknown = null
function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/collection-layouts/active') return { data: LAYOUT }
      if (p === '/field-config/orders') return { data: FIELD_CONFIG }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (p === '/field-defaults/mine')
        return {
          data: [
            {
              id: 1,
              collection: 'orders',
              field: 'title',
              value: 'Rush order',
              context: {},
              updated_at: '2026-10-28T10:00:00.000Z'
            }
          ]
        }
      if (p === '/drafts/orders/new' && serverDraft) return { data: serverDraft }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
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
  serverDraft = null
  window.localStorage.clear()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1000))
  })
}

async function mountNew(onDirtyChange = vi.fn()) {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'u1' }}>
            <ItemEditForm collection='orders' documentTitle={false} onDirtyChange={onDirtyChange} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls, onDirtyChange }
}

const titleInput = () => host.querySelector<HTMLInputElement>('[data-field="title"] input')

describe('ItemEditForm personal defaults', () => {
  it('a new record opens with the saved value, marked, and nothing unsaved', async () => {
    const { calls, onDirtyChange } = await mountNew()
    await settle(() => !!host.querySelector('[data-personal-default="title"]'))
    expect(titleInput()?.value).toBe('Rush order')
    const pill = host.querySelector('[data-personal-default="title"]')
    expect(pill?.textContent).toContain('Your default')
    expect(pill?.getAttribute('data-tip')).toBe('Prefilled from your saved default · Undo')
    expect(host.querySelector('[data-personal-default="notes"]')).toBeNull()
    // Prefill: never dirty, never a stored draft.
    expect(onDirtyChange.mock.calls.some(([dirty]) => dirty === true)).toBe(false)
    expect(calls.some((c) => c._method === 'PUT' && c._path.startsWith('/drafts/'))).toBe(false)
    expect(calls.filter((c) => c._path === '/field-defaults/mine')).toHaveLength(1)

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-personal-default-undo="title"]')?.click()
    )
    await settle(() => !host.querySelector('[data-personal-default="title"]'))
    expect(titleInput()?.value).toBe('')
    expect(host.querySelector('[data-personal-default="title"]')).toBeNull()
  })

  it('a restored draft wins outright: no default is applied after it', async () => {
    serverDraft = {
      saved_at: '2026-10-28T09:00:00.000Z',
      payload: {
        key: 'x',
        collection: 'orders',
        item_id: 'new',
        user_id: 'u1',
        saved_at: '2026-10-28T09:00:00.000Z',
        fields: { notes: 'from my draft' },
        base: {},
        base_updated_at: null,
        pending_rows: {},
        pending_edits: {},
        pending_deletes: {},
        m2m_links: {},
        m2m_unlinks: {}
      }
    }
    await mountNew()
    await settle(() =>
      [...host.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Restore')
    )
    // While the draft is offered, nothing is applied.
    expect(titleInput()?.value).toBe('')
    const restore = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore'
    )
    await act(async () => restore?.click())
    await settle(() => false)
    expect(
      host.querySelector<HTMLTextAreaElement>(
        '[data-field="notes"] input, [data-field="notes"] textarea'
      )?.value
    ).toBe('from my draft')
    expect(titleInput()?.value).toBe('')
    expect(host.querySelector('[data-personal-default="title"]')).toBeNull()
  })
})
