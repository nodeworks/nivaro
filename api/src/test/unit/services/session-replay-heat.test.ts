import { describe, expect, it } from 'vitest'
import {
  bucketOf,
  depthBucket,
  FrameCollector,
  foldEvents,
  type HeatCell,
  mergeCells,
  routeOf,
  shapeHeat,
  viewportClass
} from '../../../services/session-replay-heat.js'
import { ReplayNodeMap } from '../../../services/session-replay-heat-nodes.js'

// Hand-built rrweb fixtures: type 4 Meta, 2 FullSnapshot, 3 Incremental
// (source 0 mutation, 2 mouse interaction, 3 scroll, 4 viewport resize),
// 5 Custom (the recorder's 'route' events).

const T0 = Date.parse('2026-10-01T12:00:00.000Z')

const el = (
  id: number,
  tagName: string,
  attributes: Record<string, string> = {},
  childNodes: unknown[] = []
) => ({ type: 2, id, tagName, attributes, childNodes })
const text = (id: number, textContent: string) => ({ type: 3, id, textContent })

const snapshotTree = {
  type: 0,
  id: 1,
  childNodes: [
    el(2, 'html', {}, [
      el(3, 'body', {}, [
        el(4, 'div', { 'data-testid': 'toolbar' }, [
          el(5, 'button', { class: 'btn' }, [el(6, 'svg'), text(7, ' Save ')]),
          el(8, 'span', {}, [text(9, 'Order 1234')]),
          el(10, 'button', { id: ':r1:' }, [text(11, 'Item 42')])
        ]),
        el(12, 'main', {}, [el(13, 'p', {}, [text(14, 'Hello')])])
      ])
    ])
  ]
}

const meta = (ts: number, href: string, width = 1000, height = 800) => ({
  type: 4,
  timestamp: ts,
  data: { href, width, height }
})
const full = (ts: number) => ({ type: 2, timestamp: ts, data: { node: snapshotTree } })
const click = (ts: number, id: number, x: number, y: number) => ({
  type: 3,
  timestamp: ts,
  data: { source: 2, type: 2, id, x, y }
})
const scroll = (ts: number, id: number, y: number) => ({
  type: 3,
  timestamp: ts,
  data: { source: 3, id, x: 0, y }
})
const route = (ts: number, path: string) => ({
  type: 5,
  timestamp: ts,
  data: { tag: 'route', payload: { path } }
})
const mutation = (ts: number, data: Record<string, unknown>) => ({
  type: 3,
  timestamp: ts,
  data: { source: 0, adds: [], removes: [], attributes: [], texts: [], ...data }
})

describe('ReplayNodeMap → selector', () => {
  const map = () => {
    const m = new ReplayNodeMap()
    m.ingest(full(T0))
    return m
  }

  it('a click inside a button counts for the button, named by its text', () => {
    expect(map().selectorFor(6)).toBe('button:has-text("Save")')
    expect(map().selectorFor(7)).toBe('button:has-text("Save")')
  })

  it('anchors an element without identity under the nearest ancestor that has one', () => {
    expect(map().selectorFor(8)).toBe('[data-testid="toolbar"] span')
  })

  it('never keeps generated ids or record-looking text', () => {
    // id ':r1:' is React-generated; 'Item 42' names a record, not a control.
    expect(map().selectorFor(10)).toBe('[data-testid="toolbar"] button')
  })

  it('falls back to the bare tag with no identity anywhere up the tree', () => {
    expect(map().selectorFor(13)).toBe('p')
  })

  it('follows mutations: added nodes resolve, removed ones do not, attributes update', () => {
    const m = map()
    m.ingest(
      mutation(T0 + 1, {
        adds: [
          { parentId: 12, nextId: null, node: el(20, 'button', { 'aria-label': 'Close panel' }) }
        ]
      })
    )
    expect(m.selectorFor(20)).toBe('button[aria-label="Close panel"]')
    m.ingest(mutation(T0 + 2, { attributes: [{ id: 20, attributes: { 'data-testid': 'close' } }] }))
    expect(m.selectorFor(20)).toBe('[data-testid="close"]')
    m.ingest(mutation(T0 + 3, { removes: [{ parentId: 3, id: 4 }] }))
    expect(m.selectorFor(6)).toBeNull()
    expect(m.nodes.has(5)).toBe(false)
  })

  it('a text mutation renames a button', () => {
    const m = map()
    m.ingest(mutation(T0 + 1, { texts: [{ id: 7, value: 'Saving' }] }))
    expect(m.selectorFor(5)).toBe('button:has-text("Saving")')
  })

  it('a new full snapshot replaces the map', () => {
    const m = map()
    m.ingest(mutation(T0 + 1, { adds: [{ parentId: 12, node: el(99, 'a', { name: 'x' }) }] }))
    m.ingest(full(T0 + 2))
    expect(m.nodes.has(99)).toBe(false)
    expect(m.documentId()).toBe(1)
  })
})

describe('bucketing', () => {
  it('positions fall in 2% buckets, clamped to the viewport', () => {
    expect(bucketOf(0, 1000)).toBe(0)
    expect(bucketOf(250, 1000)).toBe(12)
    expect(bucketOf(999, 1000)).toBe(49)
    expect(bucketOf(1500, 1000)).toBe(49)
    expect(bucketOf(-5, 1000)).toBe(0)
  })
  it('viewport classes', () => {
    expect(viewportClass(390)).toBe('xs')
    expect(viewportClass(800)).toBe('sm')
    expect(viewportClass(1280)).toBe('md')
    expect(viewportClass(1600)).toBe('lg')
    expect(viewportClass(2560)).toBe('xl')
  })
  it('scroll depth in quarter screens; 4 = never scrolled; capped', () => {
    expect(depthBucket(0, 800)).toBe(4)
    expect(depthBucket(1200, 800)).toBe(10)
    expect(depthBucket(10_000_000, 800)).toBe(80)
  })
  it('routes are patterns, never concrete paths', () => {
    expect(routeOf('https://app.example/collections/workflows/371367?tab=2')).toBe(
      '/collections/workflows/:id'
    )
    expect(routeOf('/people/7a0411f3-c687-40e5-adf5-614157cf88ec/day')).toBe('/people/:id/day')
    expect(routeOf('not a url')).toBeNull()
  })
})

describe('foldEvents', () => {
  const events = [
    meta(T0, 'https://app.example/collections/workflows/371367'),
    full(T0 + 10),
    click(T0 + 1_000, 6, 250, 400),
    click(T0 + 1_500, 6, 255, 405),
    click(T0 + 2_000, 8, 600, 100),
    scroll(T0 + 2_500, 1, 1200),
    scroll(T0 + 2_600, 1, 400),
    // SPA navigation: a new visit on another route, never scrolled
    route(T0 + 5_000, '/queues?filter=mine'),
    click(T0 + 6_000, 13, 500, 799),
    // Viewport shrinks: later clicks fold under the new class
    { type: 3, timestamp: T0 + 7_000, data: { source: 4, width: 500, height: 900 } },
    click(T0 + 8_000, 13, 250, 450)
  ]

  it('folds clicks by route, selector, bucket and viewport — and keeps no person', () => {
    const { acc, clicks, unresolved } = foldEvents(events, { id: 'rec-1', app: null })
    expect(clicks).toBe(5)
    expect(unresolved).toBe(0)
    const cells = [...acc.cells.values()]
    for (const c of cells) {
      expect(Object.keys(c).sort()).toEqual(
        [
          'app',
          'count',
          'day',
          'depth_bucket',
          'kind',
          'route',
          'selector',
          'viewport',
          'x_bucket',
          'y_bucket'
        ].sort()
      )
    }
    const save = cells.find((c) => c.kind === 'click' && c.selector === 'button:has-text("Save")')
    expect(save).toMatchObject({
      app: 'admin',
      route: '/collections/workflows/:id',
      day: '2026-10-01',
      x_bucket: 12,
      y_bucket: 25,
      viewport: 'sm',
      count: 2
    })
    const queueClicks = cells.filter((c) => c.kind === 'click' && c.route === '/queues')
    expect(queueClicks.map((c) => [c.viewport, c.x_bucket, c.y_bucket]).sort()).toEqual([
      ['sm', 25, 49],
      ['xs', 25, 25]
    ])
  })

  it('records the deepest scroll of each route visit', () => {
    const { acc } = foldEvents(events, { id: 'rec-1', app: 'efp-new' })
    const scrolls = [...acc.cells.values()].filter((c) => c.kind === 'scroll')
    expect(scrolls.map((c) => [c.app, c.route, c.depth_bucket, c.count]).sort()).toEqual([
      ['efp-new', '/collections/workflows/:id', 10, 1],
      ['efp-new', '/queues', 4, 1]
    ])
  })

  it('points each route at the last moment it was acted on', () => {
    const { frames } = foldEvents(events, { id: 'rec-1', app: null })
    const byRoute = Object.fromEntries(frames.map((f) => [f.route, f]))
    expect(byRoute['/collections/workflows/:id']).toMatchObject({
      recording_id: 'rec-1',
      at_ms: T0 + 2_000,
      width: 1000,
      height: 800
    })
    expect(byRoute['/queues'].at_ms).toBe(T0 + 8_000)
  })

  it('a click on a node the map does not know still counts, without a selector', () => {
    const { acc, unresolved } = foldEvents(
      [meta(T0, 'https://a/x'), full(T0 + 1), click(T0 + 2, 404, 10, 10)],
      { id: 'r', app: null }
    )
    expect(unresolved).toBe(1)
    expect([...acc.cells.values()].find((c) => c.kind === 'click')?.selector).toBeNull()
  })

  it('ignores clicks before any viewport is known', () => {
    const { clicks } = foldEvents([route(T0, '/x'), full(T0 + 1), click(T0 + 2, 6, 1, 1)], {
      id: 'r',
      app: null
    })
    expect(clicks).toBe(0)
  })
})

describe('mergeCells', () => {
  it('adds counts for the same cell and keeps the rest', () => {
    const base: Omit<HeatCell, 'count'> = {
      app: 'admin',
      route: '/x',
      day: '2026-10-01',
      kind: 'click',
      selector: 'button',
      x_bucket: 1,
      y_bucket: 2,
      depth_bucket: null,
      viewport: 'md'
    }
    const merged = mergeCells(
      [{ ...base, count: 3 }],
      [
        { ...base, count: 2 },
        { ...base, x_bucket: 5, count: 1 }
      ]
    )
    expect(merged.map((c) => [c.x_bucket, c.count]).sort()).toEqual([
      [1, 5],
      [5, 1]
    ])
  })
})

describe('shapeHeat', () => {
  const rows = [
    {
      kind: 'click',
      selector: 'a',
      x_bucket: 1,
      y_bucket: 1,
      depth_bucket: null,
      viewport: 'md',
      n: 4
    },
    {
      kind: 'click',
      selector: 'b',
      x_bucket: 1,
      y_bucket: 1,
      depth_bucket: null,
      viewport: 'md',
      n: 1
    },
    {
      kind: 'click',
      selector: null,
      x_bucket: 2,
      y_bucket: 2,
      depth_bucket: null,
      viewport: 'xs',
      n: 2
    },
    {
      kind: 'scroll',
      selector: null,
      x_bucket: null,
      y_bucket: null,
      depth_bucket: 4,
      viewport: 'md',
      n: 6
    },
    {
      kind: 'scroll',
      selector: null,
      x_bucket: null,
      y_bucket: null,
      depth_bucket: 8,
      viewport: 'xs',
      n: 1
    }
  ]
  it('sums cells across selectors and lists the top elements', () => {
    const v = shapeHeat(rows, null)
    expect(v.total_clicks).toBe(7)
    expect(v.clicks[0]).toEqual({ x: 1, y: 1, count: 5 })
    expect(v.selectors).toEqual([
      { selector: 'a', count: 4 },
      { selector: 'b', count: 1 }
    ])
    expect(v.unresolved_clicks).toBe(2)
    expect(v.scroll).toEqual([
      { depth: 4, visits: 6 },
      { depth: 8, visits: 1 }
    ])
    expect(v.total_visits).toBe(7)
  })
  it('the viewport filter narrows everything but the viewport counts', () => {
    const v = shapeHeat(rows, 'xs')
    expect(v.total_clicks).toBe(2)
    expect(v.total_visits).toBe(1)
    expect(v.viewports).toEqual([
      { viewport: 'md', clicks: 5 },
      { viewport: 'xs', clicks: 2 }
    ])
  })
})

describe('FrameCollector', () => {
  it('keeps the last full snapshot at or before the moment, its Meta, and DOM changes after it', () => {
    const fc = new FrameCollector(T0 + 5_000)
    const later = mutation(T0 + 4_000, { texts: [{ id: 7, value: 'x' }] })
    for (const e of [
      meta(T0, 'https://a/x'),
      full(T0 + 1),
      mutation(T0 + 2, {}),
      meta(T0 + 3_000, 'https://a/y'),
      full(T0 + 3_001),
      click(T0 + 3_500, 6, 1, 1),
      later,
      mutation(T0 + 6_000, {})
    ])
      fc.push(e)
    const out = fc.events()
    expect(out.map((e) => e.timestamp)).toEqual([T0 + 3_000, T0 + 3_001, T0 + 4_000])
    expect(fc.done).toBe(true)
  })
})
