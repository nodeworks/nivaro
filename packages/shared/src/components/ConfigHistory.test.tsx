// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../context'
import { ConfigHistory, type ConfigHistoryEntry, configHistoryLine } from './ConfigHistory'
import { PersonDidPanel } from './profile/PersonDidPanel'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** #12 ConfigHistory + #13 "What they did" (shared). */

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

const entry = (over: Partial<ConfigHistoryEntry> = {}): ConfigHistoryEntry => ({
  id: 1,
  action: 'update',
  timestamp: new Date(Date.now() - 60_000).toISOString(),
  user: 'u1',
  collection: 'nivaro_roles',
  item: 'r1',
  comment: 'name, admin_access',
  first_name: 'Ada',
  last_name: 'Lovelace',
  ...over
})

function mount(ui: ReactNode, respond: (cmd: Cmd) => unknown, navigate = vi.fn()) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      return respond(cmd)
    })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <NavigationContext.Provider value={{ navigate }}>{ui}</NavigationContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return {
    host,
    calls,
    cleanup: () => {
      act(() => root.unmount())
      host.remove()
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

describe('configHistoryLine (adapter)', () => {
  it('names the person and the change', () => {
    expect(configHistoryLine(entry())).toEqual({
      who: 'Ada Lovelace',
      what: 'changed this',
      detail: 'name, admin_access'
    })
    expect(configHistoryLine(entry({ first_name: null, last_name: null, user: null })).who).toBe(
      'The system'
    )
    expect(configHistoryLine(entry({ action: 'api_key_revoked' })).what).toBe('api key revoked')
  })
})

describe('ConfigHistory', () => {
  it('reads GET /activity for the row and lists the entries, newest first', async () => {
    const navigate = vi.fn()
    const { host, calls, cleanup } = mount(
      <ConfigHistory collection='nivaro_roles' item='r1' />,
      () => ({
        data: [entry({ id: 2 }), entry({ id: 1, action: 'create', comment: null })],
        total: 2
      }),
      navigate
    )
    await flush()
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/activity',
      _params: { collection: 'nivaro_roles', item: 'r1', limit: 20, offset: 0 }
    })
    const rows = host.querySelectorAll('[data-config-history-entry]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Ada Lovelace changed this')
    expect(rows[1].textContent).toContain('created this')
    const details = [...rows[0].querySelectorAll('button')].find((b) => b.textContent === 'Details')
    act(() => details?.click())
    expect(navigate).toHaveBeenCalledWith('/activity/2')
    cleanup()
  })

  it('says so when nothing is recorded, and waits for a saved row', async () => {
    const empty = mount(<ConfigHistory collection='nivaro_flows' item='f1' />, () => ({
      data: [],
      total: 0
    }))
    await flush()
    expect(empty.host.textContent).toContain('No changes recorded yet.')
    empty.cleanup()

    const unsaved = mount(<ConfigHistory collection='nivaro_flows' item={null} />, () => {
      throw new Error('must not fetch')
    })
    await flush()
    expect(unsaved.calls).toHaveLength(0)
    expect(unsaved.host.textContent).toContain('History starts once this is saved.')
    unsaved.cleanup()
  })
})

describe('PersonDidPanel', () => {
  const summary = {
    days: [
      {
        day: '2026-10-29',
        total: 3,
        collections: [
          { collection: 'invoices', count: 2, actions: { update: 1, delete: 1 } },
          { collection: null, count: 1, actions: { login: 1 } }
        ]
      }
    ],
    total: 3,
    truncated: false,
    window_days: 30,
    tz: 'UTC'
  }

  it('shows days → collections with counts and expands a group to its entries', async () => {
    const { host, calls, cleanup } = mount(<PersonDidPanel userId='u1' name='Sam' />, (cmd) => {
      if (cmd._path.endsWith('/summary')) return { data: summary }
      if (cmd._path.endsWith('/entries'))
        return {
          data: [
            {
              id: 9,
              action: 'delete',
              timestamp: '2026-10-29T10:00:00.000Z',
              collection: 'invoices',
              item: '42',
              comment: null
            }
          ]
        }
      return { data: null }
    })
    await flush()
    expect(host.textContent).toContain('What Sam did')
    const groups = host.querySelectorAll('[data-person-did-day] li > button')
    expect(groups).toHaveLength(2)
    expect(groups[0].textContent).toContain('Invoices')
    expect(groups[0].textContent).toContain('2')
    expect(groups[1].textContent).toContain('Sign-ins and other')
    act(() => (groups[0] as HTMLButtonElement).click())
    await flush()
    const entriesCall = calls.find((c) => c._path === '/activity/people/u1/entries')
    expect(entriesCall?._params).toMatchObject({ day: '2026-10-29', collection: 'invoices' })
    expect(host.textContent).toContain('#42')
    cleanup()
  })

  it('exports through POST …/export (the server logs it)', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { host, calls, cleanup } = mount(<PersonDidPanel userId='u1' />, (cmd) => {
      if (cmd._path.endsWith('/summary')) return { data: summary }
      if (cmd._path.endsWith('/export'))
        return { data: { csv: 'a,b\r\n', filename: 'activity-u1.csv', rows: 3 } }
      return { data: null }
    })
    await flush()
    const btn = host.querySelector('[data-person-did-export]') as HTMLButtonElement
    act(() => btn.click())
    await flush()
    expect(calls.find((c) => c._path === '/activity/people/u1/export')).toMatchObject({
      _method: 'POST',
      _body: { days: 30 }
    })
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    click.mockRestore()
    cleanup()
    vi.unstubAllGlobals()
  })
})
