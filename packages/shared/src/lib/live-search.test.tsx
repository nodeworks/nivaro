// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type LiveSearchState,
  newMatchesText,
  reconcileSearch,
  searchRowKey,
  useLiveSearchResults
} from './live-search'
import { type CollectionUpdateEvent, type RealtimeAdapter, RealtimeContext } from './realtime'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Row {
  collection: string
  id: string
  label: string
}
const row = (collection: string, id: string, label = `${collection} ${id}`): Row => ({
  collection,
  id,
  label
})

describe('reconcileSearch', () => {
  const shown = [row('wf', 'a'), row('wf', 'b'), row('inv', 'c')]

  it('updates a row that still matches but reads differently, in place', () => {
    const r = reconcileSearch(
      shown,
      [row('wf', 'a', 'NEW'), row('wf', 'b'), row('inv', 'c')],
      new Set(['wf:A'])
    )
    expect([...r.updated.keys()]).toEqual(['wf:A'])
    expect(r.gone.size).toBe(0)
    expect(r.added.size).toBe(0)
  })

  it('a row the events named that the fresh answer lacks stops matching (dims)', () => {
    const r = reconcileSearch(shown, [row('wf', 'a'), row('inv', 'c')], new Set(['wf:B']))
    expect([...r.gone]).toEqual(['wf:B'])
  })

  it('a row the events did NOT name never dims, even if it fell down the ranking', () => {
    const r = reconcileSearch(shown, [row('wf', 'a'), row('inv', 'c')], new Set(['wf:A']))
    expect(r.gone.size).toBe(0)
  })

  it('counts only named rows as new matches, never a row that merely moved up', () => {
    const fresh = [...shown, row('wf', 'n1'), row('wf', 'n2')]
    const r = reconcileSearch(shown, fresh, new Set(['wf:N1']))
    expect([...r.added.keys()]).toEqual(['wf:N1'])
  })

  it('a bulk write that named nobody counts every unseen row and dims nothing', () => {
    const r = reconcileSearch(shown, [row('wf', 'a'), row('wf', 'z')], 'any')
    expect([...r.added.keys()]).toEqual(['wf:Z'])
    expect(r.gone.size).toBe(0)
  })

  it('ids compare upper-case so an event id and a row id agree', () => {
    expect(searchRowKey({ collection: 'wf', id: 'ab12' })).toBe('wf:AB12')
    expect(searchRowKey({ collection: 'wf', id: 7 })).toBe('wf:7')
  })

  it('a windowed answer (first page of a longer list) leaves later rows alone', () => {
    const r = reconcileSearch(shown, [row('wf', 'a')], new Set(['wf:B', 'inv:C']), 1)
    expect(r.gone.size).toBe(0)
  })

  it('says it in words', () => {
    expect(newMatchesText(1)).toBe('1 new match')
    expect(newMatchesText(3)).toBe('3 new matches')
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
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function mount(
  rt: RealtimeAdapter,
  props: {
    rows: Row[]
    fetchFresh: () => Promise<Row[]>
    onShow?: () => void
    resetKey?: string
    detectNew?: boolean
  },
  out: { state?: LiveSearchState<Row> }
) {
  function Probe(p: typeof props) {
    out.state = useLiveSearchResults<Row>({
      rows: p.rows,
      collections: ['wf'],
      fetchFresh: p.fetchFresh,
      onShow: p.onShow ?? (() => {}),
      resetKey: p.resetKey ?? 'k1',
      detectNew: p.detectNew
    })
    return null
  }
  const render = (p: typeof props) =>
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe, p)))
    )
  render(props)
  return render
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100) // the 1 s burst window
    await vi.advanceTimersByTimeAsync(5000) // the minimum gap between re-asks
  })
}

describe('useLiveSearchResults', () => {
  const rows = [row('wf', 'a'), row('wf', 'b')]

  it('updates in place, dims a row that stopped matching and counts a new match', async () => {
    const { rt, fire } = adapter()
    const out: { state?: LiveSearchState<Row> } = {}
    const fetchFresh = vi.fn(async () => [row('wf', 'a', 'EDITED'), row('wf', 'n')])
    mount(rt, { rows, fetchFresh }, out)

    act(() => {
      fire({ collection: 'wf', item: 'a', changed_fields: ['title'] })
      fire({ collection: 'wf', item: 'b', changed_fields: ['title'] })
      fire({ collection: 'wf', item: 'n', action: 'create' })
    })
    await settle()

    expect(fetchFresh).toHaveBeenCalledTimes(1) // one re-ask for the whole burst
    expect(out.state?.rows.map((r) => r.label)).toEqual(['EDITED', 'wf b']) // same order, same length
    expect([...(out.state?.dimmed ?? [])]).toEqual(['wf:B'])
    expect(out.state?.newCount).toBe(1)
  })

  it('does not ask while nothing changed and ignores comment-only notices', async () => {
    const { rt, fire } = adapter()
    const out: { state?: LiveSearchState<Row> } = {}
    const fetchFresh = vi.fn(async () => rows)
    mount(rt, { rows, fetchFresh }, out)
    act(() => fire({ collection: 'wf', item: 'a', changed_fields: ['$comments'] }))
    await settle()
    expect(fetchFresh).not.toHaveBeenCalled()
    expect(out.state?.newCount).toBe(0)
  })

  it('a refused or failed re-ask leaves the page exactly as it was', async () => {
    const { rt, fire } = adapter()
    const out: { state?: LiveSearchState<Row> } = {}
    const fetchFresh = vi.fn(async () => {
      throw new Error('503')
    })
    mount(rt, { rows, fetchFresh }, out)
    act(() => fire({ collection: 'wf', item: 'a' }))
    await settle()
    expect(out.state?.rows).toEqual(rows)
    expect(out.state?.dimmed.size).toBe(0)
  })

  it('Show runs the page query and clears the count; a new answer clears everything', async () => {
    const { rt, fire } = adapter()
    const out: { state?: LiveSearchState<Row> } = {}
    const onShow = vi.fn()
    const render = mount(
      rt,
      { rows, fetchFresh: async () => [...rows, row('wf', 'n')], onShow },
      out
    )
    act(() => fire({ collection: 'wf', item: 'n', action: 'create' }))
    await settle()
    expect(out.state?.newCount).toBe(1)
    act(() => out.state?.show())
    expect(onShow).toHaveBeenCalledTimes(1)
    expect(out.state?.newCount).toBe(0)

    // pending again, then the page's own query answers anew (resetKey moves): clean slate
    act(() => fire({ collection: 'wf', item: 'n', action: 'create' }))
    await settle()
    expect(out.state?.newCount).toBe(1)
    render({ rows: [...rows, row('wf', 'n')], fetchFresh: async () => rows, resetKey: 'k2' })
    expect(out.state?.newCount).toBe(0)
    expect(out.state?.dimmed.size).toBe(0)
  })

  it('does not count new matches when the page cannot say (a later page)', async () => {
    const { rt, fire } = adapter()
    const out: { state?: LiveSearchState<Row> } = {}
    mount(rt, { rows, fetchFresh: async () => [...rows, row('wf', 'n')], detectNew: false }, out)
    act(() => fire({ collection: 'wf', item: 'n', action: 'create' }))
    await settle()
    expect(out.state?.newCount).toBe(0)
  })

  it('a hidden tab holds the re-ask until it is visible again', async () => {
    const { rt, fire } = adapter()
    const out: { state?: LiveSearchState<Row> } = {}
    const fetchFresh = vi.fn(async () => [...rows, row('wf', 'n')])
    mount(rt, { rows, fetchFresh }, out)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => fire({ collection: 'wf', item: 'n', action: 'create' }))
    await settle()
    expect(fetchFresh).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle()
    expect(fetchFresh).toHaveBeenCalledTimes(1)
    expect(out.state?.newCount).toBe(1)
  })
})
