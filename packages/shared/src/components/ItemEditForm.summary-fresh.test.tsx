// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// The Summary rail must follow the record after a save (own, or another
// tab's arriving live): the army saw it keep the old Description for
// minutes while the field showed the saved one.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  })
}))

function field(name: string, label: string, group: string): CMSField {
  return {
    field: name,
    type: 'text',
    interface: 'input',
    label,
    required: true,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: group,
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
  const row: Record<string, unknown> = { id: 1, description: 'A', zone: 'Zone 1' }
  // A GET the test holds open: its answer is the row as it was when it was
  // ASKED (a read that started before a save landed).
  let holdNext = false
  let held: (() => void) | null = null
  const client = {
    url: 'http://test',
    getToken: () => null,
    holdNextRead() {
      holdNext = true
    },
    releaseHeld() {
      held?.()
      held = null
    },
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 7, name: 'Workflow', slug: 'workflow', summary_enabled: true },
            groups: [
              { id: 1, key: 'basic', label: 'Basic Info', type: 'tab', icon: null, sort: 0 },
              { id: 2, key: 'details', label: 'Details', type: 'tab', icon: null, sort: 1 }
            ],
            assignments: [
              { field: 'description', sort: 0, group_key: 'basic', is_visible: true },
              { field: 'zone', sort: 0, group_key: 'details', is_visible: true }
            ],
            ungrouped_sort: 99
          }
        }
      if (p === '/field-config/workflows')
        return {
          data: [field('description', 'Description', 'basic'), field('zone', 'Zone', 'details')]
        }
      if (p === '/collections/workflows') return { data: { display_name: 'Workflows' } }
      if (p === '/items/workflows/1' && method === 'GET') {
        const snapshot = { ...row }
        if (holdNext) {
          holdNext = false
          return new Promise((resolve) => {
            held = () => resolve({ data: snapshot })
          })
        }
        return { data: snapshot }
      }
      if (p === '/items/workflows/1' && method === 'PATCH') {
        Object.assign(row, cmd._body ?? {})
        return { data: { ...row } }
      }
      if (p.startsWith('/record-views/')) return { data: null }
      if (method !== 'GET') return { data: { id: 1 } }
      return { data: [] }
    })
  }
  return { client, calls, row }
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
  for (let i = 0; i < 100 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

/** The Summary rail's text for a field (label button outside the form body). */
function summaryText(label: string): string | null {
  const btn = [...host.querySelectorAll('button')].find(
    (b) => !b.closest('[data-field]') && b.querySelector('span')?.textContent?.trim() === label
  )
  if (!btn) return null
  const spans = btn.querySelectorAll(':scope > span')
  return spans[spans.length - 1]?.textContent?.trim() ?? null
}

const fieldInput = () =>
  host.querySelector('[data-field="description"] input') as HTMLInputElement | null

async function type(value: string) {
  const input = fieldInput() as HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function mount() {
  const server = makeServer()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let save: (() => void) | null = null
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={server.client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
            <ItemEditForm
              collection='workflows'
              itemId='1'
              documentTitle={false}
              registerSaveHandler={(fn) => {
                save = fn
              }}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => !!fieldInput() && summaryText('Description') === 'A')
  return { ...server, qc, save: () => save?.() }
}

const patches = (calls: Cmd[]) => calls.filter((c) => (c._method ?? '').toUpperCase() === 'PATCH')

describe('ItemEditForm Summary rail after a save', () => {
  it('follows the field while typing and after the own save + refetch', async () => {
    const { calls, save } = await mount()
    expect(summaryText('Description')).toBe('A')
    await type('A b3')
    expect(fieldInput()?.value).toBe('A b3')
    expect(summaryText('Description')).toBe('A b3')
    await act(async () => save())
    await settle(() => patches(calls).length > 0)
    await settle(() => calls.filter((c) => c._path === '/items/workflows/1').length > 2)
    expect(fieldInput()?.value).toBe('A b3')
    expect(summaryText('Description')).toBe('A b3')
  })

  it('follows a save from another tab arriving as a live refetch', async () => {
    const { row, qc } = await mount()
    row.description = 'A b3 (other tab)'
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['item', 'workflows', '1'] })
    })
    await settle(() => fieldInput()?.value === 'A b3 (other tab)')
    expect(summaryText('Description')).toBe('A b3 (other tab)')
  })

  it('a read that started before the own save cannot put the old value back', async () => {
    const { client, calls, qc, save, row } = await mount()
    await type('A b3')
    // A live refetch (someone else's write elsewhere on the record) is in
    // flight when the save lands, and answers with the pre-save row.
    row.date_updated = '2026-10-25T20:18:00Z' // someone else's write elsewhere on the record
    client.holdNextRead()
    const late = qc.refetchQueries({ queryKey: ['item', 'workflows', '1'] })
    await act(async () => save())
    await settle(() => patches(calls).length > 0)
    await act(async () => {
      client.releaseHeld()
      await late
    })
    await settle(() => false)
    expect(fieldInput()?.value).toBe(summaryText('Description'))
    expect(summaryText('Description')).toBe('A b3')
  })

  it("another tab's save reaches the rail even with an older read still in flight", async () => {
    const { client, row, qc } = await mount()
    // A read is in flight (sent before the other tab saved) …
    client.holdNextRead()
    const early = qc.refetchQueries({ queryKey: ['item', 'workflows', '1'] })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })
    // … the other tab saves, and its live event refetches the record.
    row.description = 'A b3 (other tab)'
    row.date_updated = '2026-10-25T20:19:00Z'
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['item', 'workflows', '1'] })
    })
    await act(async () => {
      client.releaseHeld()
      await early
    })
    await settle(() => summaryText('Description') === 'A b3 (other tab)')
    expect(summaryText('Description')).toBe('A b3 (other tab)')
    expect(fieldInput()?.value).toBe('A b3 (other tab)')
  })
})
