// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { type RealtimeAdapter, RealtimeContext } from '../../lib/realtime'
import { RecordActivityStream } from './RecordActivityStream'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

const row = (id: number, collection: string, item: string, over: Record<string, unknown> = {}) => ({
  id,
  action: 'update',
  user: 'u1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  collection,
  item,
  comment: null,
  timestamp: new Date(Date.UTC(2026, 10, 14, 15, 0, 0) - id * 60_000).toISOString(),
  ...over
})

function mount(
  ui: ReactNode,
  respond: (cmd: Cmd) => unknown,
  navigate = vi.fn(),
  rt?: RealtimeAdapter
) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://localhost',
    getToken: () => null,
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
          <RealtimeContext.Provider value={rt ?? null}>
            <NavigationContext.Provider value={{ navigate }}>{ui}</NavigationContext.Provider>
          </RealtimeContext.Provider>
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
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

// A different person, so a minute-apart pair is two lines and not one folded burst.
const B = { user: 'u2', first_name: 'Grace', last_name: 'Hopper' }
const SOURCES = [{ collection: 'workflows', filter: { project: { _eq: 12 } } }]
const TYPES = [
  { collection: 'workflows', records: 4, truncated: false },
  { collection: 'invoices', records: 2, truncated: false }
]

describe('RecordActivityStream', () => {
  it('asks the feed route for the sources and shows the rows with type chips', async () => {
    const { host, calls, cleanup } = mount(
      <RecordActivityStream sources={SOURCES} records={[{ collection: 'projects', id: 12 }]} />,
      (cmd) =>
        cmd._path === '/activity/feed'
          ? { data: [row(9, 'workflows', '5'), row(8, 'invoices', '3')], next: null, types: TYPES }
          : { data: {} }
    )
    await flush()
    const feed = calls.find((c) => c._path === '/activity/feed')
    expect(feed?._method).toBe('POST')
    expect(feed?._body).toMatchObject({
      sources: SOURCES,
      records: [{ collection: 'projects', id: '12' }],
      collections: []
    })
    expect(host.querySelectorAll('[data-activity-entry]').length).toBe(2)
    const chips = [...host.querySelectorAll('[aria-pressed]')].map((b) => b.textContent)
    expect(chips).toEqual(['All', 'Workflows', 'Invoices'])
    cleanup()
  })

  it('a type chip narrows the read and the other chips stay', async () => {
    const { host, calls, cleanup } = mount(<RecordActivityStream sources={SOURCES} />, (cmd) =>
      cmd._path === '/activity/feed'
        ? {
            data: (cmd._body?.collections as string[])?.length
              ? [row(9, 'invoices', '3')]
              : [row(9, 'workflows', '5'), row(8, 'invoices', '3')],
            next: null,
            types: TYPES
          }
        : { data: {} }
    )
    await flush()
    const invoices = [...host.querySelectorAll('button[aria-pressed]')].find(
      (b) => b.textContent === 'Invoices'
    ) as HTMLButtonElement
    await act(async () => invoices.click())
    await flush()
    const last = [...calls].reverse().find((c) => c._path === '/activity/feed')
    expect(last?._body?.collections).toEqual(['invoices'])
    expect(host.querySelectorAll('[data-activity-entry]').length).toBe(1)
    expect(host.querySelectorAll('button[aria-pressed]').length).toBe(3)
    cleanup()
  })

  it('shows earlier rows on request with the id cursor and keeps what was read', async () => {
    const { host, calls, cleanup } = mount(<RecordActivityStream sources={SOURCES} />, (cmd) => {
      if (cmd._path !== '/activity/feed') return { data: {} }
      return cmd._body?.before
        ? { data: [row(3, 'workflows', '5', B)], next: null, types: TYPES }
        : { data: [row(9, 'workflows', '5'), row(8, 'workflows', '6', B)], next: 8, types: TYPES }
    })
    await flush()
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show earlier')
    expect(more).toBeTruthy()
    await act(async () => (more as HTMLButtonElement).click())
    await flush()
    const older = calls.filter((c) => c._path === '/activity/feed').find((c) => c._body?.before)
    expect(older?._body?.before).toBe(8)
    expect(host.querySelectorAll('[data-activity-entry]').length).toBe(3)
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Show earlier')).toBe(
      false
    )
    cleanup()
  })

  it('says so when nothing has changed', async () => {
    const { host, cleanup } = mount(
      <RecordActivityStream sources={SOURCES} empty='Nothing has changed on this project yet.' />,
      () => ({ data: [], next: null, types: [] })
    )
    await flush()
    expect(host.textContent).toContain('Nothing has changed on this project yet.')
    cleanup()
  })

  it('opens the record a row is about', async () => {
    const navigate = vi.fn()
    const { host, cleanup } = mount(
      <RecordActivityStream sources={SOURCES} />,
      (cmd) =>
        cmd._path === '/activity/feed'
          ? { data: [row(9, 'workflows', '5')], next: null, types: TYPES }
          : { data: {} },
      navigate
    )
    await flush()
    const btn = host.querySelector('[data-activity-entry] button') as HTMLButtonElement
    await act(async () => btn.click())
    expect(navigate).toHaveBeenCalledWith('/collections/workflows/5')
    cleanup()
  })
})

describe('RecordActivityStream — live without a timer', () => {
  function adapter() {
    let handler: ((ev: unknown) => void) | null = null
    const rt = {
      subscribeCollections: (_c: string[], cb: (ev: unknown) => void) => {
        handler = cb
        return () => {}
      },
      on: () => () => {},
      emit: () => {},
      joinWatch: () => () => {}
    } as unknown as RealtimeAdapter
    return { rt, fire: (ev: unknown) => handler?.(ev) }
  }
  const answer = (cmd: Cmd) =>
    cmd._path === '/activity/feed'
      ? {
          data: [row(9, 'workflows', '5')],
          next: null,
          types: [{ collection: 'workflows', records: 1, truncated: false, ids: ['5'] }]
        }
      : { data: {} }
  const reads = (calls: Cmd[]) => calls.filter((c) => c._path === '/activity/feed').length

  it('reads once, then only when a followed record is written (after a quiet window)', async () => {
    const { rt, fire } = adapter()
    const { calls, cleanup } = mount(
      <RecordActivityStream sources={SOURCES} />,
      answer,
      vi.fn(),
      rt
    )
    await flush()
    expect(reads(calls)).toBe(1)
    // another record of the same collection: not this stream's business
    fire({ collection: 'workflows', item: '99', action: 'update', changed_fields: ['name'] })
    await act(async () => await new Promise((r) => setTimeout(r, 2400)))
    expect(reads(calls)).toBe(1)
    // a followed record, written twice in a burst: one read
    fire({ collection: 'workflows', item: '5', action: 'update', changed_fields: ['name'] })
    fire({ collection: 'workflows', item: '5', action: 'update', changed_fields: ['note'] })
    await act(async () => await new Promise((r) => setTimeout(r, 300)))
    expect(reads(calls)).toBe(1)
    await act(async () => await new Promise((r) => setTimeout(r, 2400)))
    await flush()
    expect(reads(calls)).toBe(2)
    cleanup()
  }, 20_000)

  it('a new record of a followed type is read too', async () => {
    const { rt, fire } = adapter()
    const { calls, cleanup } = mount(
      <RecordActivityStream sources={SOURCES} />,
      answer,
      vi.fn(),
      rt
    )
    await flush()
    fire({ collection: 'workflows', item: '100', action: 'create' })
    await act(async () => await new Promise((r) => setTimeout(r, 2400)))
    await flush()
    expect(reads(calls)).toBe(2)
    cleanup()
  }, 20_000)
})
