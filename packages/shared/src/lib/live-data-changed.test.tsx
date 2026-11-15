// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_REFRESH_TAB_PER_MINUTE,
  countsAsDataChange,
  readAutoRefresh,
  runStamp,
  takeAutoRefreshSlot,
  useLiveStamp,
  watchedTables,
  writeAutoRefresh
} from './live-data-changed'
import { type CollectionUpdateEvent, type RealtimeAdapter, RealtimeContext } from './realtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('chip inputs', () => {
  it('watches the tables a response names, once each; none known = nothing to watch', () => {
    expect(
      watchedTables({
        freshness_sources: [{ table: 'invoices' }, { table: 'projects' }, { table: 'invoices' }]
      })
    ).toEqual(['invoices', 'projects'])
    expect(watchedTables({ freshness_sources: [] })).toEqual([])
    expect(watchedTables({})).toEqual([])
    expect(watchedTables(null)).toEqual([])
  })

  it('one stamp per run', () => {
    expect(runStamp({ cached_at: 'A', executed_at: 'B' })).toBe('A')
    expect(runStamp({ executed_at: 'B' })).toBe('B')
    expect(runStamp({})).toBeNull()
  })

  it('a comment/lock-only notice is not a data change', () => {
    expect(countsAsDataChange({ aspectsOnly: true, events: [{}] })).toBe(false)
    expect(countsAsDataChange({ aspectsOnly: false, events: [] })).toBe(false)
    expect(countsAsDataChange({ aspectsOnly: false, events: [{}] })).toBe(true)
  })
})

describe('auto-refresh budget', () => {
  it('lets a tab start only so many a minute, then frees slots as they age out', () => {
    const starts: number[] = []
    for (let i = 0; i < AUTO_REFRESH_TAB_PER_MINUTE; i++)
      expect(takeAutoRefreshSlot(1000 + i, starts)).toBe(true)
    expect(takeAutoRefreshSlot(5000, starts)).toBe(false)
    expect(takeAutoRefreshSlot(61_500, starts)).toBe(true) // the oldest has aged out
  })

  it('remembers the choice per scope and survives blocked storage', () => {
    writeAutoRefresh('report:1', true)
    expect(readAutoRefresh('report:1')).toBe(true)
    expect(readAutoRefresh('report:2')).toBe(false)
    writeAutoRefresh('report:1', false)
    expect(readAutoRefresh('report:1')).toBe(false)
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readAutoRefresh('report:1')).toBe(false)
    spy.mockRestore()
  })
})

function adapter() {
  const subs: Array<{ names: string[]; cb: (e: CollectionUpdateEvent) => void }> = []
  const rt: RealtimeAdapter = {
    subscribeCollections: (names, cb) => {
      const s = { names, cb }
      subs.push(s)
      return () => subs.splice(subs.indexOf(s), 1)
    },
    on: () => () => {},
    emit: () => {}
  }
  const fire = (e: CollectionUpdateEvent & Record<string, unknown>) => {
    for (const s of subs) if (s.names.includes(String(e.collection))) s.cb(e)
  }
  return { rt, fire, subs }
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  try {
    localStorage.clear()
  } catch {
    /* none */
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useLiveStamp', () => {
  const env = (cachedAt: string, tables: string[] = ['invoices']) => ({
    cached_at: cachedAt,
    freshness_sources: tables.map((table) => ({ table }))
  })

  function mount(
    rt: RealtimeAdapter,
    envelope: ReturnType<typeof env>,
    refresh: () => void,
    out: { live?: ReturnType<typeof useLiveStamp> },
    autoOverride?: boolean
  ) {
    function Probe(p: { envelope: ReturnType<typeof env> }) {
      out.live = useLiveStamp({ envelope: p.envelope, scope: 'widget:1', refresh, autoOverride })
      return null
    }
    const render = (e: ReturnType<typeof env>) =>
      act(() =>
        root.render(
          createElement(
            RealtimeContext.Provider,
            { value: rt },
            createElement(Probe, { envelope: e })
          )
        )
      )
    render(envelope)
    return render
  }

  it('raises the chip on the first write to a table the query reads, and clears on the next run', async () => {
    const { rt, fire } = adapter()
    const out: { live?: ReturnType<typeof useLiveStamp> } = {}
    const render = mount(rt, env('T1'), () => {}, out)
    expect(out.live?.changed).toBe(false)

    act(() => fire({ collection: 'invoices', item: '5', changed_fields: ['amount'] }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(out.live?.changed).toBe(true)

    render(env('T2')) // refreshed: a new run
    expect(out.live?.changed).toBe(false)
  })

  it('a write to some other collection, or a comment-only notice, raises nothing', async () => {
    const { rt, fire } = adapter()
    const out: { live?: ReturnType<typeof useLiveStamp> } = {}
    mount(rt, env('T1'), () => {}, out)
    act(() => {
      fire({ collection: 'projects', item: '5' })
      fire({ collection: 'invoices', item: '5', changed_fields: ['$comments'] })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(out.live?.changed).toBe(false)
  })

  it('tables unknown (nothing declared or inferred) = never watched, no chip, no opt-in offered', async () => {
    const { rt, fire, subs } = adapter()
    const out: { live?: ReturnType<typeof useLiveStamp> } = {}
    mount(rt, env('T1', []), () => {}, out)
    expect(subs.length).toBe(0)
    act(() => fire({ collection: 'invoices', item: '5' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(out.live?.changed).toBe(false)
    expect(out.live?.autoRefresh).toBeNull()
  })

  it('opted in: refreshes once per change instead of showing a chip', async () => {
    const { rt, fire } = adapter()
    const out: { live?: ReturnType<typeof useLiveStamp> } = {}
    const refresh = vi.fn()
    mount(rt, env('T1'), refresh, out)
    act(() => out.live?.autoRefresh?.onChange(true))
    act(() => fire({ collection: 'invoices', item: '5' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(out.live?.changed).toBe(false) // no chip while it handles itself
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(refresh).toHaveBeenCalledTimes(1) // one refresh per change, never a loop
  })

  it('opted in: a second change inside the minimum gap waits for it', async () => {
    const { rt, fire } = adapter()
    const out: { live?: ReturnType<typeof useLiveStamp> } = {}
    const refresh = vi.fn()
    const render = mount(rt, env('T1'), refresh, out)
    act(() => out.live?.autoRefresh?.onChange(true))
    act(() => fire({ collection: 'invoices', item: '5' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    render(env('T2')) // the refresh landed
    act(() => fire({ collection: 'invoices', item: '6' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200) // debounce passed, but the gap (15 s) has not
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('a report-wide switch decides (override), and no per-widget opt-in is offered', async () => {
    const { rt, fire } = adapter()
    const out: { live?: ReturnType<typeof useLiveStamp> } = {}
    const refresh = vi.fn()
    mount(rt, env('T1'), refresh, out, true)
    expect(out.live?.autoRefresh).toBeNull()
    act(() => fire({ collection: 'invoices', item: '5' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
