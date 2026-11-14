// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { registerViewAsOpener, viewAsPath } from '../lib/view-as'
import { PipelinePanel, PipelineTransitionButtons } from './panels/PipelinePanel'
import { ViewAsPersonButton } from './ViewAsPersonButton'

// Rob 2026-11-13: an admin sees EXACTLY what a person sees on a record.
// "See this record as <person>" opens the real View-as on this page; it says
// plainly that what is done there is done as them, and only admins get it.
// A person preview (?as_user=) shows that person's moves and presses nothing.

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

let host: HTMLDivElement
let root: Root
let unregister: (() => void) | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.history.replaceState(null, '', '/collections/inventory_request/37713?tab=lines')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  unregister?.()
  unregister = null
  vi.restoreAllMocks()
})

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined

const client = (calls: Cmd[], data: unknown = null) =>
  ({
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.endsWith('/owners')) return { data: [] }
      if (cmd._path.endsWith('/owners/all') || cmd._path.endsWith('/creator')) return { data: null }
      if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET') return { data }
      return { data: null }
    })
  }) as unknown as NivaroClient

function mount(ui: React.ReactNode, opts: { admin: boolean; calls?: Cmd[]; data?: unknown }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client(opts.calls ?? [], opts.data)}>
          <ItemEditAuthContext.Provider value={{ isAdmin: opts.admin, userId: 'u-admin' }}>
            {ui}
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
}

const DAVID = { id: 'u-david', name: 'David Pry', firstName: 'David' }

describe('ViewAsPersonButton', () => {
  it('is shown to administrators only', () => {
    unregister = registerViewAsOpener(vi.fn())
    mount(<ViewAsPersonButton person={DAVID} />, { admin: false })
    expect(document.querySelector('[data-view-as-person]')).toBeNull()
    mount(<ViewAsPersonButton person={DAVID} />, { admin: true })
    expect(document.querySelector('[data-view-as-person="u-david"]')).not.toBeNull()
  })

  it('is not shown where the app cannot open itself as someone else', () => {
    mount(<ViewAsPersonButton person={DAVID} />, { admin: true })
    expect(document.querySelector('[data-view-as-person]')).toBeNull()
  })

  it('says what is done there is done as them, then opens THIS record as them', async () => {
    const opener = vi.fn()
    unregister = registerViewAsOpener(opener)
    mount(<ViewAsPersonButton person={DAVID} />, { admin: true })
    const trigger = document.querySelector('[data-view-as-person="u-david"]') as HTMLButtonElement
    expect(trigger.getAttribute('aria-label')).toBe('See this record as David Pry')
    await act(async () => trigger.click())
    await until(() => !!document.querySelector('[data-view-as-person-confirm]'))
    const confirm = document.querySelector('[data-view-as-person-confirm]')
    expect(confirm?.textContent).toContain('View as David Pry')
    expect(confirm?.textContent).toContain('Anything you do there is done as David')
    // Nothing opens until the admin says so.
    expect(opener).not.toHaveBeenCalled()
    await act(async () => button('Open as David')?.click())
    expect(opener).toHaveBeenCalledWith({
      id: 'u-david',
      name: 'David Pry',
      path: '/collections/inventory_request/37713?tab=lines'
    })
  })
})

describe('viewAsPath', () => {
  it('keeps same-origin paths only', () => {
    expect(viewAsPath('/collections/a/1')).toBe('/collections/a/1')
    expect(viewAsPath('/x#masq=nvm_old')).toBe('/x')
    expect(viewAsPath('//evil.example/x')).toBeNull()
    expect(viewAsPath('https://evil.example/x')).toBeNull()
    expect(viewAsPath('/\\evil.example')).toBeNull()
  })
})

describe('a person preview of the pipeline', () => {
  const STATES = [
    { id: 'S-WH', key: 'warehouse', label: 'Warehouse Submission', color: null, sort: 3 },
    { id: 'S-DONE', key: 'done', label: 'Submitted', color: null, sort: 4 }
  ]
  const WHY =
    'Only the owner of Warehouse Submission can make this move. No one owns Warehouse Submission on this record yet — an administrator can make it, or ask to be made the owner.'
  const DATA = {
    instance: {
      id: 'i-1',
      current_state: 'S-WH',
      current_state_obj: STATES[0],
      completed_at: null
    },
    states: STATES,
    available_transitions: [
      {
        id: 't-cancel',
        label: 'Cancel Workflow',
        from_state: 'S-WH',
        to_state: 'S-DONE',
        sort: 5,
        comment_mode: 'none',
        color: null,
        group_label: null
      }
    ],
    blocked_transitions: [
      {
        id: 't-submit',
        label: 'Submit to Warehouse',
        from_state: 'S-WH',
        to_state: 'S-DONE',
        sort: 2,
        comment_mode: 'none',
        color: null,
        group_label: null,
        blocked: { code: 'OWNER', reason: WHY }
      }
    ],
    all_transitions: [],
    history: [],
    binding: { id: 1, template: 'tpl', collection: 'inventory_request', state_field: null },
    as_user: { id: 'u-david', name: 'David Pry', role: 'R-CREATOR', is_admin: false }
  }

  it.each([
    'header',
    'panel'
  ] as const)('the %s asks as_user, shows their blocked move, and a press sends nothing', async (ui) => {
    const calls: Cmd[] = []
    mount(
      ui === 'header' ? (
        <PipelineTransitionButtons collection='inventory_request' item='37713' asUser='u-david' />
      ) : (
        <PipelinePanel
          collection='inventory_request'
          item='37713'
          defaultExpanded
          asUser='u-david'
        />
      ),
      { admin: true, calls, data: DATA }
    )
    await until(() => !!button('Cancel Workflow'))
    const read = calls.find((c) => c._path.startsWith('/pipelines/instance/inventory_request'))
    expect(read?._path).toBe('/pipelines/instance/inventory_request/37713?as_user=u-david')
    expect(button('Submit to Warehouse')?.getAttribute('data-tip')).toBe(WHY)
    await act(async () => button('Cancel Workflow')?.click())
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(calls.filter((c) => c._method !== 'GET')).toEqual([])
  })
})
