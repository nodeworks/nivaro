// Traffic Map group D: whole-view links, natural-language filter mapping, presence messages,
// capture segments, rewind backfill, the summary strip's second row.
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/socket', () => ({
  adminRealtime: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
  joinWatchRoom: vi.fn(() => vi.fn()),
  getSocket: vi.fn()
}))

import { longestRunning } from './features/capture'
import { applyNl, callersOfKind } from './features/nl-filter'
import { applyViewerMessage, pruneViewers, resetViewers } from './features/presence'
import { defaultFilters, TrafficModel } from './model'
import { register } from './registry/registry'
import { stripTiles } from './registry/stripTiles'
import { SummaryStrip } from './SummaryStrip'
import type { TrafficCatalog, TrafficSnapshot } from './types'
import { decodeView, encodeView } from './viewUrl'

describe('#1166 whole-view links', () => {
  const base = { filters: defaultFilters(), selection: null, at: null }
  it('a default view encodes to nothing', () => {
    expect(encodeView(base)).toEqual([])
  })
  it('round-trips filters, selection (with a caller focus) and the rewind second', () => {
    const f = defaultFilters()
    f.types.delete('system')
    f.kinds = new Set(['create', 'update'])
    f.win = 300
    f.callers = ['k1', 'k2']
    const v = {
      filters: f,
      selection: { kind: 'entity' as const, id: 'items/work@flows', caller: 'uA' },
      at: 1_800_000_123
    }
    const p = new URLSearchParams(encodeView(v))
    expect(p.get('win')).toBe('300')
    const back = decodeView(p, base)
    expect([...back.filters.types].sort()).toEqual([...f.types].sort())
    expect([...back.filters.kinds]).toEqual(['create', 'update'])
    expect(back.filters.callers).toEqual(['k1', 'k2'])
    expect(back.selection).toEqual(v.selection)
    expect(back.at).toBe(1_800_000_123)
  })
  it('ignores malformed values', () => {
    const back = decodeView(
      new URLSearchParams('lanes=nope&win=7&sel=secret:x&at=abc&kinds='),
      base
    )
    expect(back.filters.types).toEqual(base.filters.types)
    expect(back.filters.win).toBe(60)
    expect(back.selection).toBeNull()
    expect(back.at).toBeNull()
  })
})

describe('#1133 natural-language filter mapping', () => {
  const cat = {
    callers: {
      k1: { label: 'LinX', kind: 'key' },
      u1: { label: 'Ada', kind: 'person' },
      u9: { label: 'Bot', kind: 'machine' }
    }
  } as unknown as TrafficCatalog
  it('resolves a caller kind to the callers of that kind on the map', () => {
    expect(callersOfKind(['k1', 'u1', 'u9', 'cron:x'], cat, 'machine')).toEqual(['u9'])
    expect(callersOfKind(['k1', 'cron:x'], null, 'source')).toEqual(['cron:x'])
  })
  it('applies the compiled filters and keeps what the result leaves out', () => {
    const cur = defaultFilters()
    const next = applyNl(
      cur,
      {
        lanes: ['items'],
        kinds: ['create', 'update', 'delete'],
        caller: null,
        caller_kind: 'machine',
        window: 300,
        entity: null,
        summary: ''
      },
      ['k1', 'u1', 'u9'],
      cat
    )
    expect([...next.types]).toEqual(['items'])
    expect(next.win).toBe(300)
    expect(next.callers).toEqual(['u9'])
    expect(next.caller).toBe('')
    const same = applyNl(
      cur,
      {
        lanes: null,
        kinds: null,
        caller: null,
        caller_kind: null,
        window: null,
        entity: null,
        summary: ''
      },
      [],
      cat
    )
    expect(same.types).toBe(cur.types)
    expect(same.win).toBe(60)
  })
})

describe('#1164 presence messages', () => {
  beforeEach(() => resetViewers())
  const me = { tab: 'tab-me', userId: 'U-ME' }
  it('adds other admins, ignores my own tabs, removes on gone and when stale', () => {
    expect(
      applyViewerMessage(
        { sid: 's1', tab: 'tab-a', user: { id: 'U1', name: 'Ada' }, selection: null },
        me,
        1000
      )
    ).toBe(true)
    expect(
      applyViewerMessage(
        { sid: 's1', tab: 'tab-a', user: { id: 'U1', name: 'Ada' }, selection: null },
        me,
        1500
      )
    ).toBe(false)
    expect(applyViewerMessage({ sid: 's2', tab: 'tab-me', user: { id: 'U2' } }, me)).toBe(false)
    expect(applyViewerMessage({ sid: 's3', tab: 'tab-x', user: { id: 'u-me' } }, me)).toBe(false)
    applyViewerMessage({ sid: 's4', tab: 'tab-b', user: { id: 'U4', name: 'Bo' } }, me, 1000)
    applyViewerMessage({ sid: 's1', gone: true }, me)
    pruneViewers(1000 + 26_000)
    // s1 left; s4 went stale
    expect(applyViewerMessage({ sid: 's4', tab: 'tab-b', user: { id: 'U4' } }, me)).toBe(true)
  })
})

describe('#1165 capture segments', () => {
  it('saves from the recorder that has run longest', () => {
    expect(longestRunning([{ started: 30 }, { started: 10 }, { started: 20 }])).toEqual({
      started: 10
    })
    expect(longestRunning([])).toBeNull()
  })
})

describe('#1100 backfill', () => {
  const snapAt = (sec: number, win: number, req: number): TrafficSnapshot => ({
    instance: 'n',
    node_scope: '',
    at: new Date(sec * 1000).toISOString(),
    window_s: win,
    uptime_s: 1,
    frame: 1,
    lanes: [],
    entities: [
      {
        key: 'items/a',
        lane: 'items',
        entity: 'a',
        label: 'a',
        system: false,
        req,
        read: req,
        create: 0,
        update: 0,
        delete: 0,
        error: 0,
        p50: 0,
        p95: 0,
        series: [],
        routes: [],
        callers: [],
        down: {},
        recent_errors: [],
        recent_writes: []
      }
    ],
    callers: [],
    down: [],
    totals: {
      req,
      read: req,
      create: 0,
      update: 0,
      delete: 0,
      error: 0,
      p50: 0,
      p95: 0,
      outbound_req: 0,
      outbound_error: 0
    },
    sockets: { count: 0, users: 0 },
    journal_seq: null
  })
  it('fills only the seconds before what the ring holds', () => {
    const T = 1_800_000_000
    const m = new TrafficModel()
    m.applySnapshot(snapAt(T, 60, 60)) // 1/s over T-59..T
    m.backfill(snapAt(T, 900, 900)) // 1/s over T-899..T: only T-899..T-60 is new
    expect(m.entitySum('items/a', 60)[0]).toBe(60) // the live minute is untouched
    expect(m.fineFrom).toBe(T - 59)
    m.setView(T - 300)
    expect(m.entitySum('items/a', 60)[0]).toBe(60)
    expect(m.rewindRange(60).min).toBe(T - 899 + 59)
  })
})

describe('summary strip second row', () => {
  it('feature tiles render in their own row; an empty row renders nothing', () => {
    const { container, unmount } = render(<SummaryStrip d={null} />)
    expect(container.querySelector('[data-tm-strip-more]')).toBeNull() // loading skeleton
    unmount()
    register(stripTiles, { id: 'test-tile', Component: () => <div data-testid='x'>x</div> })
    const d = {
      rps: 1,
      series: [],
      p95: 0,
      p50: 0,
      req: 0,
      errN: 0,
      lastError: null,
      writesPerMin: 0,
      writesMix: { create: 0, update: 0, delete: 0 },
      outboundPerMin: 0,
      outboundErr: 0,
      partners: [],
      sockets: 0,
      users: 0,
      peak: 0
    }
    const r = render(<SummaryStrip d={d} />)
    const more = r.container.querySelector('[data-tm-strip-more]')
    expect(more?.querySelector('[data-testid="x"]')).not.toBeNull()
    expect(r.container.querySelector('#tm-strip')?.children).toHaveLength(6)
    stripTiles.splice(
      stripTiles.findIndex((t) => t.id === 'test-tile'),
      1
    )
  })
})
