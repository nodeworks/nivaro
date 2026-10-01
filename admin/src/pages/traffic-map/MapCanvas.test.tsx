import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapCanvas } from './MapCanvas'
import { defaultFilters, TrafficModel } from './model'
import type { TrafficSnapshot } from './types'

const T0 = 1_800_000_000
const snapshot: TrafficSnapshot = {
  instance: 'test-node',
  node_scope: 'this API process only',
  at: new Date(T0 * 1000).toISOString(),
  window_s: 60,
  uptime_s: 10,
  frame: 5,
  lanes: [{ id: 'items', label: 'Items', route_hint: '/api/items/:collection' }],
  entities: [
    {
      key: 'items/workflows',
      lane: 'items',
      entity: 'workflows',
      label: 'workflows',
      system: false,
      req: 120,
      read: 100,
      create: 2,
      update: 10,
      delete: 0,
      error: 8,
      p50: 100,
      p95: 500,
      series: Array.from({ length: 60 }, () => 2),
      routes: [],
      callers: [{ key: 'uA', n: 120 }],
      down: { db: 120 },
      recent_errors: [],
      recent_writes: []
    }
  ],
  callers: [{ key: 'uA', req: 120, error: 8 }],
  down: [{ id: 'db', label: 'SQL Server', kind: 'db', req: 120, error: 0, p95: 240 }],
  totals: {
    req: 120,
    read: 100,
    create: 2,
    update: 10,
    delete: 0,
    error: 8,
    p50: 100,
    p95: 500,
    outbound_req: 0,
    outbound_error: 0
  },
  sockets: { count: 1, users: 1 },
  journal_seq: null
}

/** A 2D context whose every method is a no-op spy (jsdom has no canvas). */
function fakeContext() {
  const calls: Record<string, unknown[][]> = {}
  const target: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 6 })
  }
  return {
    calls,
    ctx: new Proxy(target, {
      get(obj, key: string) {
        if (key in obj) return obj[key]
        return (...args: unknown[]) => {
          if (!calls[key]) calls[key] = []
          calls[key].push(args)
        }
      },
      set(obj, key: string, v) {
        obj[key] = v
        return true
      }
    })
  }
}

describe('MapCanvas', () => {
  let fake: ReturnType<typeof fakeContext>
  const realMatchMedia = window.matchMedia
  beforeEach(() => {
    fake = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D
    )
    // reduced motion: the canvas paints synchronously, no rAF loop
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduced-motion'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
  })
  afterEach(() => {
    vi.restoreAllMocks()
    window.matchMedia = realMatchMedia
  })
  const texts = () => (fake.calls.fillText ?? []).map((a) => String(a[0]))

  it('paints with fallback tokens (empty computed styles) without throwing', () => {
    const m = new TrafficModel()
    m.applySnapshot(snapshot)
    const onSelect = vi.fn()
    render(
      <MapCanvas
        model={m}
        filters={defaultFilters()}
        selection={{ kind: 'entity', id: 'items/workflows' }}
        onSelect={onSelect}
        catalog={null}
        tick={1}
        paused={false}
      />
    )
    const canvas = screen.getByRole('img')
    expect(canvas.getAttribute('aria-label')).toContain('Items')
    expect(document.querySelector('[data-tm-motion]')?.getAttribute('data-tm-motion')).toBe('off')
    const texts = (fake.calls.fillText ?? []).map((a) => String(a[0]))
    expect(texts).toContain('Items')
    expect(texts).toContain('workflows')
    expect(texts.some((t) => t.startsWith('SQL Server'))).toBe(true)
  })

  it('shows a quiet loading state (no empty-state copy) before the first snapshot', () => {
    render(
      <MapCanvas
        model={new TrafficModel()}
        filters={defaultFilters()}
        selection={null}
        onSelect={() => {}}
        catalog={null}
        tick={0}
        paused={false}
      />
    )
    expect(texts().some((t) => t.startsWith('No traffic'))).toBe(false)
    expect((fake.calls.roundRect ?? []).length).toBeGreaterThan(5)
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('loading')
  })

  it('draws the empty state after a snapshot with no traffic, in window words', () => {
    const m = new TrafficModel()
    m.applySnapshot({ ...snapshot, window_s: 300, entities: [], callers: [], down: [] })
    render(
      <MapCanvas
        model={m}
        filters={{ ...defaultFilters(), win: 300 }}
        selection={null}
        onSelect={() => {}}
        catalog={null}
        tick={1}
        paused={false}
      />
    )
    expect(texts()).toContain('No traffic in the last 5 min. Requests appear here as they happen.')
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Flow of API traffic: no requests in the last 5 min.'
    )
  })

  it('omits callers with no traffic into a drawn lane (no orphan nodes)', () => {
    const m = new TrafficModel()
    // `anon` has requests (all in lane other) but no edge into a drawn lane
    m.applySnapshot({
      ...snapshot,
      callers: [...snapshot.callers, { key: 'anon', req: 40, error: 40 }]
    })
    render(
      <MapCanvas
        model={m}
        filters={defaultFilters()}
        selection={null}
        onSelect={() => {}}
        catalog={null}
        tick={1}
        paused={false}
      />
    )
    expect(texts().some((t) => t.startsWith('Unauthenticated'))).toBe(false)
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('last 1 min')
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('1 caller,')
  })

  it('selects an entity row on click', () => {
    const m = new TrafficModel()
    m.applySnapshot(snapshot)
    const onSelect = vi.fn()
    render(
      <MapCanvas
        model={m}
        filters={defaultFilters()}
        selection={null}
        onSelect={onSelect}
        catalog={null}
        tick={1}
        paused={false}
      />
    )
    const canvas = screen.getByRole('img')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 860,
      bottom: 400,
      width: 860,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    // width 860 → lane w 292 at x 284, entity rows at x 290; the first row starts at y 52
    fireEvent.click(canvas, { clientX: 300, clientY: 57 })
    expect(onSelect).toHaveBeenCalledWith({ kind: 'entity', id: 'items/workflows' })
  })
})
