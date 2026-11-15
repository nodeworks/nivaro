// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GridPresenceLine } from '../components/GridPresenceLine'
import { NivaroProvider } from '../context'
import { gridPresenceCell, useGridPresence } from './grid-presence'
import { __resetLivePreferenceForTests, setLiveMode } from './live-preference'
import { RealtimeContext } from './realtime'

// Realtime round 8, item 22: page presence on a budget grid — watch the rows on screen,
// announce the cell the person stops on, show others with their row and cell outlined.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  __resetLivePreferenceForTests()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function fakeRealtime() {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const sent: Array<[string, unknown]> = []
  return {
    sent,
    fire: (event: string, p: unknown) => {
      for (const h of handlers.get(event) ?? []) h(p)
    },
    adapter: {
      subscribeCollections: () => () => {},
      on: (event: string, cb: (p: unknown) => void) => {
        const set = handlers.get(event) ?? new Set()
        set.add(cb)
        handlers.set(event, set)
        return () => set.delete(cb)
      },
      emit: (event: string, payload?: unknown) => sent.push([event, payload])
    }
  }
}

function Grid() {
  const ref = useRef<HTMLDivElement>(null)
  const { editors } = useGridPresence({
    page: 'forecast-worksheet:2026',
    collection: 'workflows',
    items: [4471, 4472],
    containerRef: ref
  })
  return (
    <div ref={ref}>
      <GridPresenceLine
        editors={editors}
        noun='forecasts'
        rowLabel={(i) => (i === '4471' ? 'CM26-4471' : null)}
        cellLabel={(f) => (f === '.2' ? 'Mar' : null)}
      />
      <input data-grid-cell={gridPresenceCell(4471, '.2')} />
      <input data-grid-cell={gridPresenceCell(4472, '.2')} />
    </div>
  )
}

const client = {
  request: vi.fn(async () => ({ data: { id: 'me' } }))
}
function render(rt: ReturnType<typeof fakeRealtime>) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client as never}>
          <RealtimeContext.Provider value={rt.adapter}>
            <Grid />
          </RealtimeContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
}

const beth = (over: Record<string, unknown> = {}) => ({
  collection: 'workflows',
  item: '4471',
  field: '.2',
  page: 'forecast-worksheet:2026',
  state: 'start',
  user: { id: 'beth', name: 'Beth Ray' },
  ...over
})

describe('useGridPresence', () => {
  it('watches the rows on screen', () => {
    const rt = fakeRealtime()
    render(rt)
    expect(rt.sent).toContainEqual([
      'grid:watch',
      { collection: 'workflows', items: ['4471', '4472'] }
    ])
  })

  it('asks for its rows again when access changes (a regained row shows again)', () => {
    const rt = fakeRealtime()
    render(rt)
    const before = rt.sent.filter(([e]) => e === 'grid:watch').length
    act(() => rt.fire('access:changed', { perms: true }))
    act(() => vi.advanceTimersByTime(900))
    const watches = rt.sent.filter(([e]) => e === 'grid:watch')
    expect(watches.length).toBe(before + 1)
    expect(watches.at(-1)?.[1]).toEqual({ collection: 'workflows', items: ['4471', '4472'] })
  })

  it('shows who is editing where and outlines their cell', () => {
    const rt = fakeRealtime()
    render(rt)
    act(() => rt.fire('grid:editing', beth()))
    expect(host.textContent).toContain('Beth Ray is editing forecasts for CM26-4471 · Mar')
    const cell = host.querySelector(`[data-grid-cell="${gridPresenceCell(4471, '.2')}"]`)
    expect(cell?.classList.contains('nvr-remote-editing')).toBe(true)
    expect(cell?.getAttribute('data-tip')).toBe('Beth Ray is here')
    act(() => rt.fire('grid:editing', beth({ state: 'end' })))
    expect(host.textContent).not.toContain('Beth Ray')
    expect(cell?.classList.contains('nvr-remote-editing')).toBe(false)
  })

  it('ignores another page', () => {
    const rt = fakeRealtime()
    render(rt)
    act(() => rt.fire('grid:editing', beth({ page: 'forecast-worksheet:2025' })))
    expect(host.textContent).not.toContain('Beth Ray')
  })

  it('Calm shows nobody', () => {
    setLiveMode('calm')
    const rt = fakeRealtime()
    render(rt)
    act(() => rt.fire('grid:editing', beth()))
    expect(host.textContent).not.toContain('Beth Ray')
  })

  it('announces the cell the person stops on, then the end when they leave', () => {
    const rt = fakeRealtime()
    render(rt)
    const cell = host.querySelector(
      `[data-grid-cell="${gridPresenceCell(4472, '.2')}"]`
    ) as HTMLInputElement
    act(() => cell.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    act(() => vi.advanceTimersByTime(200))
    expect(rt.sent).toContainEqual([
      'grid:here',
      {
        collection: 'workflows',
        page: 'forecast-worksheet:2026',
        item: '4472',
        field: '.2',
        state: 'start'
      }
    ])
    act(() =>
      cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    )
    act(() => vi.advanceTimersByTime(300))
    expect(rt.sent.at(-1)?.[1]).toMatchObject({ item: '4472', state: 'end' })
  })
})
