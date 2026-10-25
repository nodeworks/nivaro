// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// A record the approval edit lock refuses this person: the host's "Save all"
// trigger (registerSaveHandler) used to send the PATCH the disabled header
// Save would not, and the step label on the lock named the state's key.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastInfo = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: toastInfo,
    error: vi.fn(),
    warning: vi.fn()
  })
}))

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
    group_key: 'main',
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

function makeClient(editAllowed: boolean) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 7, name: 'Order form', slug: 'order-form' },
            groups: [{ id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0 }],
            assignments: [{ field: 'title', sort: 0, group_key: 'main', is_visible: true }],
            ungrouped_sort: 99
          }
        }
      if (p === '/field-config/orders') return { data: [field('title', 'Title')] }
      if (p === '/collections/orders')
        return {
          data: {
            display_name: 'Orders',
            summary_mode_rules: {
              default: 'edit',
              rules: [],
              edit_lock: { states: ['l1'], children: [] }
            }
          }
        }
      if (p === '/items/orders/1') return { data: { id: 1, title: 'First' } }
      if (p === '/pipelines/instance/orders/1')
        return {
          data: {
            instance: { current_state: 's1' },
            states: [
              { id: 's1', key: 'waiting_on_manager_approval', label: 'Waiting on Level 1 Approval' }
            ],
            edit_lock: editAllowed
              ? { locked: true, allowed: true }
              : {
                  locked: true,
                  allowed: false,
                  message:
                    'This record is at Waiting on Level 1 Approval — only its owners can change it.'
                }
          }
        }
      if (p.startsWith('/record-views/')) return { data: null }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: { id: 1 } }
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
  toastInfo.mockClear()
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

async function mount(editAllowed: boolean) {
  const { client, calls } = makeClient(editAllowed)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let save: (() => void) | null = null
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'U1' }}>
            <ItemEditForm
              collection='orders'
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
  await settle(
    () =>
      !!host.querySelector('[data-field="title"] input') &&
      calls.some((c) => c._path === '/pipelines/instance/orders/1')
  )
  return { calls, save: () => save?.() }
}

const patches = (calls: Cmd[]) =>
  calls.filter((c) => (c._method ?? '').toUpperCase() === 'PATCH' && c._path === '/items/orders/1')

describe('ItemEditForm on a record the approval edit lock refuses', () => {
  it('a host Save all trigger sends nothing and says why', async () => {
    const { calls, save } = await mount(false)
    await act(async () => save())
    await settle(() => toastInfo.mock.calls.length > 0)
    expect(patches(calls)).toHaveLength(0)
    expect(String(toastInfo.mock.calls[0]?.[0])).toContain('Waiting on Level 1 Approval')
  })

  it('locks the field (keyboard too) with the server reason', async () => {
    await mount(false)
    await settle(() => !!host.querySelector('[data-field="title"] [inert]'))
    expect(host.querySelector('[data-field="title"] [inert] input')).toBeTruthy()
  })

  it('a person the lock allows still saves', async () => {
    const { calls, save } = await mount(true)
    const input = host.querySelector('[data-field="title"] input') as HTMLInputElement
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      set?.call(input, 'Second')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => save())
    await settle(() => patches(calls).length > 0)
    expect(patches(calls)[0]?._body?.title).toBe('Second')
  })
})
