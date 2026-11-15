// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toLiveBatch } from './live'
import {
  type FindingRef,
  findingsTouchedBy,
  type ResolvedMark,
  resolvedLabel,
  useResolvedFindings
} from './live-findings'
import { type CollectionUpdateEvent, type RealtimeAdapter, RealtimeContext } from './realtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ref = (key: string, itemId: string, collection = 'wf'): FindingRef => ({
  key,
  collection,
  itemId
})
const batch = (...evs: Array<Partial<CollectionUpdateEvent> & { item: string }>) =>
  toLiveBatch(evs.map((e) => ({ collection: 'wf', own: false, ...e }) as never))

describe('findingsTouchedBy', () => {
  const findings = [ref('f1', 'aa'), ref('f2', 'aa'), ref('f3', 'bb'), ref('f4', 'cc', 'other')]

  it('picks every finding of a named record (ids compare upper-case)', () => {
    expect(findingsTouchedBy(findings, batch({ item: 'AA' })).map((f) => f.key)).toEqual([
      'f1',
      'f2'
    ])
  })

  it('a collection must match too', () => {
    expect(findingsTouchedBy(findings, batch({ item: 'cc' }))).toEqual([])
    expect(
      findingsTouchedBy(findings, batch({ item: 'cc', collection: 'other' })).map((f) => f.key)
    ).toEqual(['f4'])
  })

  it('a bulk write that named no record picks every finding of that collection, capped', () => {
    expect(findingsTouchedBy(findings, batch({ item: '*' }), 2).map((f) => f.key)).toEqual([
      'f1',
      'f2'
    ])
  })

  it('a comment- or lock-only notice picks nothing', () => {
    expect(
      findingsTouchedBy(findings, batch({ item: 'aa', changed_fields: ['$comments'] }))
    ).toEqual([])
  })
})

describe('resolvedLabel', () => {
  const mark: ResolvedMark = { at: 1, by: 'U1' }
  it('names the person, or says "you", or just "Fixed"', () => {
    expect(resolvedLabel(mark, 'Beth', 'U9')).toBe('Fixed by Beth')
    expect(resolvedLabel(mark, 'Beth', 'u1')).toBe('Fixed by you')
    expect(resolvedLabel(mark, null, 'U9')).toBe('Fixed')
    expect(resolvedLabel({ at: 1, by: null }, 'Beth')).toBe('Fixed')
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
  return { rt, fire }
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

describe('useResolvedFindings', () => {
  const findings = [ref('f1', 'aa'), ref('f2', 'bb')]

  function mount(
    rt: RealtimeAdapter,
    list: FindingRef[],
    recheck: (r: FindingRef[]) => Promise<string[]>,
    out: { resolved?: ReadonlyMap<string, ResolvedMark> }
  ) {
    function Probe({ list: l }: { list: FindingRef[] }) {
      out.resolved = useResolvedFindings({
        findings: l,
        recheck,
        lookupWriter: async () => 'U7'
      }).resolved
      return null
    }
    const render = (l: FindingRef[]) =>
      act(() =>
        root.render(
          createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe, { list: l }))
        )
      )
    render(list)
    return render
  }

  it('marks a finding whose record was fixed, with who saved it, and leaves the others', async () => {
    const { rt, fire } = adapter()
    const out: { resolved?: ReadonlyMap<string, ResolvedMark> } = {}
    const recheck = vi.fn(async (refs: FindingRef[]) =>
      refs.filter((r) => r.key === 'f1').map((r) => r.key)
    )
    mount(rt, findings, recheck, out)

    act(() => fire({ collection: 'wf', item: 'aa', changed_fields: ['status'] }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })

    expect(recheck).toHaveBeenCalledTimes(1)
    expect(recheck.mock.calls[0][0].map((r) => r.key)).toEqual(['f1']) // only the named record
    expect(out.resolved?.get('f1')?.by).toBe('U7')
    expect(out.resolved?.has('f2')).toBe(false)
  })

  it('a re-check that still finds the problem marks nothing', async () => {
    const { rt, fire } = adapter()
    const out: { resolved?: ReadonlyMap<string, ResolvedMark> } = {}
    mount(rt, findings, async () => [], out)
    act(() => fire({ collection: 'wf', item: 'aa' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(out.resolved?.size).toBe(0)
  })

  it('a failed re-check keeps what is shown', async () => {
    const { rt, fire } = adapter()
    const out: { resolved?: ReadonlyMap<string, ResolvedMark> } = {}
    mount(
      rt,
      findings,
      async () => {
        throw new Error('503')
      },
      out
    )
    act(() => fire({ collection: 'wf', item: 'aa' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(out.resolved?.size).toBe(0)
  })

  it('a record that breaks again loses its mark; a refresh drops marks for rows that left', async () => {
    const { rt, fire } = adapter()
    const out: { resolved?: ReadonlyMap<string, ResolvedMark> } = {}
    let fixed = true
    const render = mount(rt, findings, async (refs) => (fixed ? refs.map((r) => r.key) : []), out)
    act(() => fire({ collection: 'wf', item: 'aa' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(out.resolved?.has('f1')).toBe(true)

    fixed = false
    act(() => fire({ collection: 'wf', item: 'aa' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(out.resolved?.has('f1')).toBe(false)

    fixed = true
    act(() => fire({ collection: 'wf', item: 'bb' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(out.resolved?.has('f2')).toBe(true)
    render([ref('f9', 'zz')]) // the board refreshed: f2 is no longer on it
    expect(out.resolved?.size).toBe(0)
  })

  it('a burst is one re-check', async () => {
    const { rt, fire } = adapter()
    const out: { resolved?: ReadonlyMap<string, ResolvedMark> } = {}
    const recheck = vi.fn(async (refs: FindingRef[]) => refs.map((r) => r.key))
    mount(rt, findings, recheck, out)
    act(() => {
      fire({ collection: 'wf', item: 'aa' })
      fire({ collection: 'wf', item: 'bb' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(out.resolved?.size).toBe(2)
  })
})
