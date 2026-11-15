// @vitest-environment jsdom
import { act, StrictMode, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BURST_THRESHOLD,
  burstLabel,
  burstWriter,
  createBurstTracker,
  heldChangeCount,
  isListPaused,
  type LivePause,
  planRowOrder,
  resumeAsRefetch,
  setListPaused,
  totalsMayMove,
  useKeptEntries,
  useLivePause,
  useSteadyRows
} from './live-list-flow'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ups = (from: number, n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({ item: String(from + i), action: 'update', ...extra }))

describe('createBurstTracker', () => {
  it('lets a person’s few edits through', () => {
    const t = createBurstTracker()
    expect(t.push(ups(1, 3), 1000)).toBe(false)
    expect(t.push(ups(4, 3), 1500)).toBe(false)
    expect(t.current()).toBeNull()
  })

  it('starts a burst at the threshold inside the window and counts the records before it', () => {
    const t = createBurstTracker()
    expect(t.push(ups(1, 6), 1000)).toBe(false)
    expect(t.push(ups(7, 6), 1600)).toBe(true)
    expect(t.current()).toMatchObject({ count: 12, updates: 12, creates: 0 })
    // Everything after it joins while it keeps coming.
    expect(t.push(ups(13, 1), 2000)).toBe(true)
    expect(t.current()?.count).toBe(13)
  })

  it('does not add up changes spread wider than the window', () => {
    const t = createBurstTracker()
    expect(t.push(ups(1, 8), 1000)).toBe(false)
    expect(t.push(ups(9, 8), 4000)).toBe(false)
  })

  it('counts each record once (one create plus later updates = one add)', () => {
    const t = createBurstTracker()
    const creates = ups(1, BURST_THRESHOLD).map((e) => ({ ...e, action: 'create' }))
    expect(t.push(creates, 0)).toBe(true)
    t.push(ups(1, BURST_THRESHOLD), 500)
    expect(t.current()).toMatchObject({ count: BURST_THRESHOLD, creates: BURST_THRESHOLD })
  })

  it('a bulk write naming no record is a burst at once, with its count', () => {
    const t = createBurstTracker()
    expect(t.push([{ item: '*', bulk: 340 }], 0)).toBe(true)
    expect(t.current()).toMatchObject({ count: 340, approx: false })
    const u = createBurstTracker()
    u.push([{ item: '*' }], 0)
    expect(u.current()).toMatchObject({ count: 0, approx: true })
  })

  it('ends after a quiet spell; the pill keeps its burst until cleared', () => {
    const t = createBurstTracker()
    t.push(ups(1, 20), 0)
    expect(t.push(ups(50, 1), 10_000)).toBe(false)
    expect(t.current()?.count).toBe(20)
    t.clear()
    expect(t.current()).toBeNull()
  })

  it('says import only when every event did', () => {
    const t = createBurstTracker()
    t.push(ups(1, 15, { source: 'import', action: 'create' }), 0)
    expect(t.current()?.source).toBe('import')
    t.push([{ item: '99', action: 'update' }], 100)
    expect(t.current()?.source).toBeNull()
  })

  it('samples at most 10 ids for the writer read', () => {
    const t = createBurstTracker()
    t.push(ups(1, 40), 0)
    expect(t.current()?.sample).toHaveLength(10)
  })
})

describe('burstLabel', () => {
  const info = (p: Partial<Parameters<typeof burstLabel>[0]>) => ({
    count: 0,
    creates: 0,
    updates: 0,
    deletes: 0,
    source: null,
    approx: false,
    sample: [],
    ...p
  })
  it('reads like the examples', () => {
    expect(burstLabel(info({ count: 500, creates: 500, source: 'import' }))).toBe(
      'Import added 500 records'
    )
    expect(burstLabel(info({ count: 40, updates: 40 }), 'Beth')).toBe('Beth updated 40 rows')
    expect(burstLabel(info({ count: 1200, updates: 1200 }))).toBe('1,200 rows updated')
    expect(burstLabel(info({ count: 30, deletes: 30 }))).toBe('30 records removed')
    expect(burstLabel(info({ count: 30, creates: 10, updates: 20 }), 'Beth')).toBe(
      'Beth changed 30 records'
    )
    expect(burstLabel(info({ approx: true }))).toBe('Many records changed')
    expect(burstLabel(info({ count: 340 }))).toBe('340 records changed')
  })
  it('a named writer wins over "Import"', () => {
    expect(burstLabel(info({ count: 5, creates: 5, source: 'import' }), 'Beth')).toBe(
      'Beth added 5 records'
    )
  })
})

describe('burstWriter', () => {
  it('names one writer only when every row agrees', () => {
    expect(burstWriter([{ user_updated: 'U1' }, { user_updated: 'u1' }, {}])).toBe('U1')
    expect(burstWriter([{ user_updated: 'U1' }, { user_updated: { id: 'U2' } }])).toBeNull()
    expect(burstWriter([{}, {}])).toBeNull()
  })
})

describe('pause queue', () => {
  afterEach(() => {
    setListPaused('t:list', false)
    sessionStorage.clear()
  })

  it('counts distinct records held and bulk writes by their count', () => {
    expect(heldChangeCount([{ item: '1' }, { item: '1' }, { item: '2' }])).toBe(2)
    expect(heldChangeCount([{ item: '*', bulk: 30 }, { item: '*' }, { item: 'a' }])).toBe(32)
    expect(resumeAsRefetch([{ item: '1' }, { item: '2' }])).toBe(false)
    expect(resumeAsRefetch([{ item: '*' }])).toBe(true)
    expect(resumeAsRefetch(ups(1, BURST_THRESHOLD))).toBe(true)
  })

  it('is remembered per list for the session', () => {
    expect(isListPaused('t:list')).toBe(false)
    setListPaused('t:list', true)
    expect(isListPaused('t:list')).toBe(true)
    expect(isListPaused('t:other')).toBe(false)
    expect(JSON.parse(sessionStorage.getItem('nvr:live-paused') ?? '[]')).toEqual(['t:list'])
  })

  it('holds deliveries while paused and hands them over in one go on resume', () => {
    const resumed = vi.fn()
    const applied = vi.fn()
    let api: LivePause<{ item: string }> | null = null
    function Probe() {
      api = useLivePause<{ item: string }>('t:list', resumed)
      return <span data-held={api.held} data-paused={String(api.paused)} />
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<Probe />))
    const pause = () => api as unknown as LivePause<{ item: string }>
    // Live: straight through.
    act(() => pause().gate([{ item: '1' }], applied))
    expect(applied).toHaveBeenCalledTimes(1)
    act(() => pause().toggle())
    expect(host.querySelector('span')?.getAttribute('data-paused')).toBe('true')
    act(() => {
      pause().gate([{ item: '2' }], applied)
      pause().gate([{ item: '3' }], applied)
      pause().gate([{ item: '2' }], applied)
    })
    expect(applied).toHaveBeenCalledTimes(1)
    expect(host.querySelector('span')?.getAttribute('data-held')).toBe('2')
    act(() => pause().toggle())
    expect(resumed).toHaveBeenCalledTimes(1)
    expect(resumed.mock.calls[0][0]).toEqual([{ item: '2' }, { item: '3' }, { item: '2' }])
    expect(host.querySelector('span')?.getAttribute('data-held')).toBe('0')
    act(() => root.unmount())
  })

  it('a refresh while paused drops what was held', () => {
    const resumed = vi.fn()
    let api: LivePause<{ item: string }> | null = null
    function Probe() {
      api = useLivePause<{ item: string }>('t:list', resumed)
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe />))
    const pause = () => api as unknown as LivePause<{ item: string }>
    act(() => pause().toggle())
    act(() => pause().gate([{ item: '9' }], () => {}))
    act(() => pause().dropHeld())
    act(() => pause().toggle())
    expect(resumed).not.toHaveBeenCalled()
    act(() => root.unmount())
  })
})

describe('planRowOrder (reorder hold)', () => {
  const shown = ['a', 'b', 'c', 'd', 'e']

  it('applies the new order when nobody is pointing at a row', () => {
    expect(planRowOrder(shown, ['x', 'a', 'b'], [null, null])).toMatchObject({
      order: ['x', 'a', 'b'],
      held: false
    })
  })

  it('applies changes below the pointer at once', () => {
    const p = planRowOrder(shown, ['a', 'b', 'c', 'e', 'x'], ['c'])
    expect(p).toMatchObject({ order: ['a', 'b', 'c', 'e', 'x'], held: false, gone: [] })
  })

  it('holds a new row that would land above the pointer', () => {
    const p = planRowOrder(shown, ['x', 'a', 'b', 'c', 'd', 'e'], ['c'])
    expect(p.held).toBe(true)
    expect(p.order).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(p.hidden).toEqual(['x'])
  })

  it('keeps a removed row above the pointer in place, faded', () => {
    const p = planRowOrder(shown, ['a', 'c', 'd', 'e'], ['c'])
    expect(p.order).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(p.gone).toEqual(['b'])
  })

  it('keeps the row under the pointer when it leaves the list', () => {
    const p = planRowOrder(shown, ['a', 'b', 'd', 'e'], ['c'])
    expect(p.order).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(p.gone).toEqual(['c'])
  })

  it('does not move rows that a re-sort would move above the pointer', () => {
    const p = planRowOrder(shown, ['e', 'a', 'b', 'c', 'd'], ['c'])
    expect(p.order).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect(p.hidden).toEqual([])
  })

  it('a new row below the pointer shows straight away (in the held tail)', () => {
    const p = planRowOrder(shown, ['b', 'a', 'c', 'x', 'd', 'e'], ['c'])
    expect(p.held).toBe(true)
    expect(p.order).toEqual(['a', 'b', 'c', 'x', 'd', 'e'])
  })

  it('the lower of pointer and keyboard focus protects everything above it', () => {
    const p = planRowOrder(shown, ['a', 'b', 'c', 'e', 'd'], ['a', 'e'])
    expect(p.order).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(p.held).toBe(true)
  })

  it('an anchor that is not on screen holds nothing', () => {
    expect(planRowOrder(shown, ['x'], ['zz']).held).toBe(false)
  })
})

describe('totals follow the rows', () => {
  const totalled = new Set(['amount'])
  it('moves on creates, deletes, unnamed updates and totalled or filter fields', () => {
    expect(totalsMayMove([{ action: 'create' }], totalled)).toBe(true)
    expect(totalsMayMove([{ action: 'delete' }], totalled)).toBe(true)
    expect(totalsMayMove([{ action: 'update' }], totalled)).toBe(true)
    expect(totalsMayMove([{ action: 'update', changed_fields: ['amount'] }], totalled)).toBe(true)
    expect(
      totalsMayMove(
        [{ action: 'update', changed_fields: ['status'] }],
        totalled,
        new Set(['status'])
      )
    ).toBe(true)
  })
  it('stays put for other fields, aspects, or with no totals on', () => {
    expect(totalsMayMove([{ action: 'update', changed_fields: ['title'] }], totalled)).toBe(false)
    expect(totalsMayMove([{ changed_fields: ['$tasks'] }], totalled)).toBe(false)
    expect(totalsMayMove([{ action: 'create' }], new Set())).toBe(false)
  })
})

describe('useSteadyRows', () => {
  type R = { id: string; v: number }
  function List({ rows, resetKey }: { rows: R[]; resetKey?: string }) {
    const ref = useRef<HTMLDivElement | null>(null)
    const s = useSteadyRows(rows, (r) => r.id, ref, { resetKey })
    return (
      <div ref={ref}>
        {s.rows.map((r) => (
          <p key={r.id} data-row-key={r.id} data-gone={s.isGone(r.id) ? '1' : '0'}>
            {r.id}:{r.v}
          </p>
        ))}
      </div>
    )
  }
  const text = (host: HTMLElement) =>
    [...host.querySelectorAll('p')].map(
      (p) => `${p.textContent}${p.dataset.gone === '1' ? '!' : ''}`
    )
  const over = (host: HTMLElement, key: string) =>
    act(() => {
      host
        .querySelector(`[data-row-key="${key}"]`)
        ?.dispatchEvent(new Event('pointerover', { bubbles: true }))
    })

  it('keeps rows at and above the pointer still, updates values, releases on leave', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id, v: 1 }))
    act(() => root.render(<List rows={rows} />))
    act(() => root.render(<List rows={[...rows]} />))
    over(host, 'c')
    // b leaves, a's value changes, x arrives at the top.
    act(() =>
      root.render(
        <List
          rows={[
            { id: 'x', v: 1 },
            { id: 'a', v: 2 },
            { id: 'c', v: 1 },
            { id: 'd', v: 1 }
          ]}
        />
      )
    )
    expect(text(host)).toEqual(['a:2', 'b:1!', 'c:1', 'd:1'])
    act(() => {
      host.firstElementChild?.dispatchEvent(new Event('pointerleave'))
    })
    expect(text(host)).toEqual(['x:1', 'a:2', 'c:1', 'd:1'])
    act(() => root.unmount())
    host.remove()
  })

  it('still listens under StrictMode (effects run twice on mount)', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const rows = ['a', 'b', 'c'].map((id) => ({ id, v: 1 }))
    act(() =>
      root.render(
        <StrictMode>
          <List rows={rows} />
        </StrictMode>
      )
    )
    act(() =>
      root.render(
        <StrictMode>
          <List rows={[...rows]} />
        </StrictMode>
      )
    )
    over(host, 'c')
    act(() =>
      root.render(
        <StrictMode>
          <List rows={[rows[1], rows[2]]} />
        </StrictMode>
      )
    )
    expect(text(host)).toEqual(['a:1!', 'b:1', 'c:1'])
    act(() => root.unmount())
  })

  it('draws the person’s own page / sort change at once', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const rows = ['a', 'b', 'c'].map((id) => ({ id, v: 1 }))
    act(() => root.render(<List rows={rows} resetKey='p1' />))
    act(() => root.render(<List rows={[...rows]} resetKey='p1' />))
    over(host, 'c')
    act(() => root.render(<List rows={[{ id: 'z', v: 1 }]} resetKey='p2' />))
    expect(text(host)).toEqual(['z:1'])
    act(() => root.unmount())
  })
})

describe('useKeptEntries (labels of a held row)', () => {
  it('keeps the previous read for keys the new read lacks; the new read wins', () => {
    let out: Record<string, string> | undefined
    function Probe({ m }: { m?: Record<string, string> }) {
      out = useKeptEntries(m)
      return null
    }
    const root = createRoot(document.createElement('div'))
    const first = { a: 'Zone 1', b: 'Zone 2' }
    act(() => root.render(<Probe m={first} />))
    expect(out).toBe(first)
    act(() => root.render(<Probe m={{ a: 'Zone 3' }} />))
    expect(out).toEqual({ a: 'Zone 3', b: 'Zone 2' })
    act(() => root.unmount())
  })
})
