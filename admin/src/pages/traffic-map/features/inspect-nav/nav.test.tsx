import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventTicker } from '../../EventTicker'
import { getInspectSnapshot, resetInspectForTests } from '../../inspect/stack'
import type { TrafficModel } from '../../model'
import { RewindBar, requestMapRewind } from '../../RewindBar'
import type { TrafficEventWire } from '../../types'
import { AnchorAction } from './HeaderActions'
import { LoadPanel } from './LoadPanel'
import { RelatedRail } from './RelatedRail'
import { SearchBox } from './Search'

const RID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const get = vi.fn()
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) } }))

// jsdom has no ResizeObserver and no scrollIntoView; the search results list (cmdk) uses both
// once it renders.
if (typeof ResizeObserver === 'undefined') {
  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(() => {
  act(() => resetInspectForTests())
  get.mockReset()
})

const ev = (i: number, extra: Partial<TrafficEventWire> = {}): TrafficEventWire => ({
  t: 1_000_000 + i,
  lane: 'items',
  entity: 'workflows',
  kind: 'read',
  caller: 'anon',
  route: `GET /api/items/workflows/${i}`,
  ...extra
})

describe('ticker keys (#1209)', () => {
  it('j / k move a visible selection and Enter opens the selected event', () => {
    const events = [ev(3, { rid: RID }), ev(2), ev(1)]
    render(
      wrap(
        <div className='traffic-map'>
          <EventTicker
            events={events}
            newestT={1_000_003}
            win={300}
            catalog={null}
            total={3}
            loading={false}
          />
        </div>
      )
    )
    fireEvent.keyDown(window, { key: 'j' })
    let sel = document.querySelectorAll('[data-tm-event-selected]')
    expect(sel).toHaveLength(1)
    expect(document.activeElement).toBe(sel[0])
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'k' })
    sel = document.querySelectorAll('[data-tm-event-selected]')
    expect(sel[0].getAttribute('aria-label')).toContain('workflows')
    // first row (with a request id) is selected again → Enter opens it
    fireEvent.keyDown(sel[0], { key: 'Enter' })
    expect(getInspectSnapshot().levels[0]).toMatchObject({ kind: 'request', id: RID })
  })

  it('j does nothing while typing', () => {
    render(
      wrap(
        <div className='traffic-map'>
          <input aria-label='field' />
          <EventTicker
            events={[ev(1)]}
            newestT={1_000_001}
            win={300}
            catalog={null}
            total={1}
            loading={false}
          />
        </div>
      )
    )
    const input = screen.getByLabelText('field')
    input.focus()
    fireEvent.keyDown(input, { key: 'j' })
    expect(document.querySelectorAll('[data-tm-event-selected]')).toHaveLength(0)
  })
})

describe('search box (#1208)', () => {
  it('/ focuses it when the map page has focus and stops the admin-wide shortcut', () => {
    const globalSpy = vi.fn()
    window.addEventListener('keydown', globalSpy)
    render(
      wrap(
        <div className='traffic-map'>
          <button type='button'>in map</button>
          <SearchBox />
        </div>
      )
    )
    screen.getByText('in map').focus()
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement?.hasAttribute('data-tm-inspect-search')).toBe(true)
    expect(globalSpy).not.toHaveBeenCalled()
    window.removeEventListener('keydown', globalSpy)
  })

  it('leaves / alone outside the map page', () => {
    render(
      wrap(
        <>
          <button type='button'>outside</button>
          <div className='traffic-map'>
            <SearchBox />
          </div>
        </>
      )
    )
    screen.getByText('outside').focus()
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement?.textContent).toBe('outside')
  })

  it('never sends a credential-shaped entry', async () => {
    render(wrap(<SearchBox />))
    const input = document.querySelector('[data-tm-inspect-search]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'nvk_secretvalue123' } })
    await new Promise((r) => setTimeout(r, 300))
    expect(get).not.toHaveBeenCalled()
    expect(document.querySelector('[data-tm-inspect-search-refused]')).not.toBeNull()
  })

  it('Enter pressed before the results settle opens the first result once they land', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          q: RID,
          type: 'uuid',
          results: [{ ref: { kind: 'request', id: RID, at: 5 }, label: 'GET /x · 200', hint: '' }]
        }
      }
    })
    render(wrap(<SearchBox />))
    const input = document.querySelector('[data-tm-inspect-search]') as HTMLInputElement
    fireEvent.change(input, { target: { value: RID } })
    // paste, Enter — within the 250 ms debounce, nothing has been fetched yet
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(get).not.toHaveBeenCalled()
    expect(getInspectSnapshot().levels).toHaveLength(0)
    await waitFor(() =>
      expect(getInspectSnapshot().levels[0]).toMatchObject({ kind: 'request', id: RID })
    )
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('Enter on an entry that matches nothing opens the search level, which says so', async () => {
    get.mockResolvedValue({ data: { data: { q: 'CR26-1', type: 'friendly', results: [] } } })
    render(wrap(<SearchBox />))
    const input = document.querySelector('[data-tm-inspect-search]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'CR26-1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(getInspectSnapshot().levels[0]).toMatchObject({ kind: 'search', id: 'CR26-1' })
    )
  })
})

describe('load panel (#1205)', () => {
  it('draws the waterfall and opens a bar as its request', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          load: 'load-abc123',
          screen: 'admin /collections/:collection',
          app: 'admin',
          page: '/collections/:collection',
          caller: 'uABC',
          caller_label: 'Rob',
          user: 'abc',
          user_name: 'Rob',
          started_at: 1000,
          ended_at: 1500,
          calls: 2,
          dropped: 0,
          waterfall: {
            rows: [
              {
                rid: RID,
                route: 'GET /api/auth/me',
                start: 1000,
                ms: 100,
                status: 200,
                offset_ms: 0
              },
              { rid: null, route: 'GET /api/x', start: 1100, ms: 400, status: 500, offset_ms: 100 }
            ],
            total_ms: 500,
            slowest: {
              rid: null,
              route: 'GET /api/x',
              start: 1100,
              ms: 400,
              status: 500,
              offset_ms: 100
            },
            duplicates: [],
            errors: 1
          },
          rum: null,
          node: 'abcd1234',
          instance: 'development'
        }
      }
    })
    render(
      wrap(
        <LoadPanel
          inspectRef={{ kind: 'load', id: 'load-abc123' }}
          open={() => {}}
          anchor={null}
          windowSec={300}
        />
      )
    )
    await waitFor(() =>
      expect(document.querySelector('[data-tm-inspect-waterfall]')).not.toBeNull()
    )
    expect(document.querySelectorAll('[data-tm-inspect-waterfall-row]')).toHaveLength(2)
    expect(document.querySelector('[data-tm-inspect-waterfall-bar="error"]')).not.toBeNull()
    expect(document.querySelector('[data-tm-inspect-load-rum="none"]')).not.toBeNull()
    fireEvent.click(document.querySelector(`[data-tm-inspect-link="request:${RID}"]`) as Element)
    expect(getInspectSnapshot().levels.at(-1)).toMatchObject({ kind: 'request', id: RID })
  })

  it('an unauthenticated load names no caller level', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          load: 'load-anon01',
          screen: '/login',
          app: null,
          page: '/login',
          caller: 'anon',
          caller_label: 'Unauthenticated',
          user: null,
          user_name: null,
          started_at: 1000,
          ended_at: 1000,
          calls: 0,
          dropped: 0,
          waterfall: { rows: [], total_ms: 0, slowest: null, duplicates: [], errors: 0 },
          rum: null,
          node: 'abcd1234',
          instance: 'development'
        }
      }
    })
    render(
      wrap(
        <LoadPanel
          inspectRef={{ kind: 'load', id: 'load-anon01' }}
          open={() => {}}
          anchor={null}
          windowSec={300}
        />
      )
    )
    await waitFor(() =>
      expect(document.querySelector('[data-tm-inspect-load-caller="anon"]')).not.toBeNull()
    )
    expect(screen.getByText('Unauthenticated')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="caller:anon"]')).toBeNull()
  })

  it('says why a load is gone', async () => {
    get.mockRejectedValue({ response: { status: 404, data: { code: 'INSPECT_NOT_FOUND' } } })
    render(
      wrap(
        <LoadPanel
          inspectRef={{ kind: 'load', id: 'load-gone1' }}
          open={() => {}}
          anchor={null}
          windowSec={300}
        />
      )
    )
    await waitFor(() =>
      expect(document.querySelector('[data-tm-inspect-load-missing]')).not.toBeNull()
    )
    expect(screen.getByText(/no longer kept/)).toBeTruthy()
  })
})

describe('related rail (#1204)', () => {
  it('renders groups of links, more counts and notes', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          groups: [
            {
              key: 'chain',
              label: 'Same chain',
              refs: [
                { kind: 'chain', id: 'c1', label: 'Event path' },
                { kind: 'write', id: '7', label: 'update x 1' }
              ],
              more: 4
            },
            {
              key: 'caller',
              label: 'Same caller',
              refs: [{ kind: 'caller', id: 'k12', label: 'Partner' }]
            },
            { key: 'error', label: 'Same error', refs: [{ kind: 'issue', id: '3', label: 'boom' }] }
          ],
          notes: ['Page load: not known'],
          load: null,
          at: 1,
          window: 300
        }
      }
    })
    render(
      wrap(
        <RelatedRail
          inspectRef={{ kind: 'request', id: RID }}
          open={() => {}}
          anchor={null}
          windowSec={300}
        />
      )
    )
    await waitFor(() =>
      expect(document.querySelector('[data-tm-inspect-related-group="chain"]')).not.toBeNull()
    )
    expect(document.querySelector('[data-tm-inspect-related-more="4"]')).not.toBeNull()
    expect(document.querySelector('[data-tm-inspect-related-note]')?.textContent).toContain(
      'Page load'
    )
    // the third group starts folded
    expect(document.querySelector('[data-tm-inspect-related-item="issue:3"]')).toBeNull()
    fireEvent.click(document.querySelector('[data-tm-inspect-related-toggle="error"]') as Element)
    expect(document.querySelector('[data-tm-inspect-related-item="issue:3"]')).not.toBeNull()
    expect(String(get.mock.calls[0][0])).toContain(`/traffic-map/inspect/related/request/${RID}`)
  })
})

describe('time anchor (#1206)', () => {
  it('anchors at the level, and Rewind pauses the map through its own Pause control', () => {
    const at = Date.now() - 60_000
    const pause = document.createElement('button')
    pause.id = 'tm-pause'
    const clicked = vi.fn()
    pause.addEventListener('click', clicked)
    document.body.appendChild(pause)
    render(
      wrap(
        <AnchorAction
          inspectRef={{ kind: 'request', id: RID, at }}
          open={() => {}}
          anchor={null}
          windowSec={300}
        />
      )
    )
    fireEvent.click(document.querySelector('[data-tm-inspect-anchor]') as Element)
    expect(document.querySelector('[data-tm-inspect-anchor-text]')?.textContent).toContain('now')
    fireEvent.click(document.querySelector('[data-tm-inspect-anchor-here]') as Element)
    expect(getInspectSnapshot().anchor).toBe(at)
    fireEvent.click(document.querySelector('[data-tm-inspect-rewind]') as Element)
    expect(clicked).toHaveBeenCalledTimes(1)
    pause.remove()
  })

  it('says when the map cannot pause', () => {
    expect(requestMapRewind(Date.now())).toBe('unavailable')
  })

  it('goes through the rewind bar’s own rule while it is up: clamped, and never a rewind to Live', () => {
    const onRewind = vi.fn()
    const model = {
      rewindRange: () => ({ min: 100, max: 200 }),
      fineFrom: null
    } as unknown as TrafficModel
    const { unmount } = render(
      <RewindBar
        model={model}
        win={300}
        viewSec={null}
        frozen={false}
        onRewind={onRewind}
        onLive={() => {}}
      />
    )
    expect(requestMapRewind(150_000)).toBe('rewound')
    expect(onRewind).toHaveBeenLastCalledWith(150)
    // older than the rings hold → the oldest second
    expect(requestMapRewind(50_000)).toBe('rewound')
    expect(onRewind).toHaveBeenLastCalledWith(100)
    // newer than the bar's newest second → that would be Live, not a rewind
    expect(requestMapRewind(250_000)).toBe('unavailable')
    expect(onRewind).toHaveBeenCalledTimes(2)
    unmount()
    expect(requestMapRewind(150_000)).toBe('unavailable')
  })
})
