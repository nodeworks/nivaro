// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { type RealtimeAdapter, RealtimeContext } from '../lib/realtime'
import {
  type CoverLine,
  coverBatchMatters,
  coverEnds,
  coverSentence,
  DelegateCoverLine,
  nextCoverEnd
} from './DelegateCoverLine'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const jane = (over: Partial<CoverLine> = {}): CoverLine => ({
  user_id: 'J1',
  name: 'Jane Smith',
  first_name: 'Jane',
  ends_at: null,
  records: 4,
  keys: ['workflows:1', 'workflows:2', 'workflows:3', 'workflows:4'],
  ...over
})

describe('covering line — words (rt5 #15)', () => {
  it('says who, and how many of theirs need you', () => {
    const now = new Date(2026, 10, 14, 9, 0)
    expect(coverSentence(jane(), now)).toEqual({
      lead: "You're covering for Jane Smith today",
      count: 4,
      tail: "of Jane's records need you"
    })
    expect(coverSentence(jane({ records: 1 }), now).tail).toBe("of Jane's record needs you")
    expect(coverSentence(jane({ records: 0 }), now)).toMatchObject({
      count: null,
      tail: "none of Jane's records need you right now"
    })
    expect(coverSentence(jane({ first_name: null }), now).tail).toBe(
      "of Jane Smith's records need you"
    )
    // Ends today: "today" alone (no "until 11:59 PM"); a later day replaces "today".
    expect(
      coverSentence(jane({ ends_at: new Date(2026, 10, 14, 23, 59).toISOString() }), now).lead
    ).toBe("You're covering for Jane Smith today")
    expect(
      coverSentence(jane({ ends_at: new Date(2026, 10, 20, 9, 0).toISOString() }), now).lead
    ).toMatch(/^You're covering for Jane Smith until .*20$/)
  })

  it('names the end only when it is a later day', () => {
    const now = new Date(2026, 10, 14, 9, 0)
    expect(coverEnds(null, now)).toBeNull()
    expect(coverEnds(new Date(2026, 10, 14, 17, 0).toISOString(), now)).toBeNull()
    expect(coverEnds(new Date(2026, 10, 20, 9, 0).toISOString(), now)).toMatch(/^until .*20/)
  })

  it('wakes at the earliest end still ahead', () => {
    const now = Date.parse('2026-11-14T12:00:00Z')
    expect(nextCoverEnd([jane()], now)).toBeNull()
    expect(
      nextCoverEnd(
        [
          jane({ ends_at: '2026-11-14T13:00:00Z' }),
          jane({ ends_at: '2026-11-14T12:30:00Z' }),
          jane({ ends_at: '2026-11-14T11:00:00Z' })
        ],
        now
      )
    ).toBe(30 * 60_000)
  })

  it('a live write matters only for a counted record (or a bulk write on its collection)', () => {
    const watched = new Map([['workflows', new Set(['1', '2'])]])
    expect(coverBatchMatters(watched, [{ collection: 'workflows', item: '2' }])).toBe(true)
    expect(coverBatchMatters(watched, [{ collection: 'workflows', item: '9' }])).toBe(false)
    expect(coverBatchMatters(watched, [{ collection: 'workflows', item: '*' }])).toBe(true)
    expect(coverBatchMatters(watched, [{ collection: 'orders', item: '1' }])).toBe(false)
  })
})

describe('covering line — live', () => {
  // Reduced motion: the count snaps (jsdom's animation frames do not keep real time).
  window.matchMedia = ((q: string) => ({
    matches: q.includes('reduce'),
    media: q,
    addEventListener() {},
    removeEventListener() {}
  })) as never
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })

  it('renders nothing for someone covering nobody', async () => {
    const client = { request: vi.fn(async () => ({ data: { covering: [] } })) }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client as never}>
            <DelegateCoverLine />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(document.querySelector('[data-delegate-cover]')).toBeNull()
  })

  it('a handled record lowers the count without a reload', async () => {
    let answer = [jane()]
    const client = {
      request: vi.fn(async (cmd: { _path: string }) =>
        cmd._path === '/my-work/covering' ? { data: { covering: answer } } : { data: null }
      )
    }
    const collectionListeners: Array<(ev: unknown) => void> = []
    const rt: RealtimeAdapter = {
      subscribeCollections: (_c, cb) => {
        collectionListeners.push(cb as (ev: unknown) => void)
        return () => {}
      },
      on: () => () => {},
      emit() {}
    }
    const onShow = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client as never}>
            <RealtimeContext.Provider value={rt}>
              <DelegateCoverLine onShow={onShow} />
            </RealtimeContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const settle = async () => {
      for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    }
    await settle()
    const line = () => document.querySelector('[data-delegate-cover-line="J1"]')?.textContent ?? ''
    expect(line()).toContain("You're covering for Jane Smith today")
    expect(line()).toContain("4 of Jane's records need you")

    // Jane's record 3 was approved: one fewer needs the delegate.
    answer = [jane({ records: 3, keys: ['workflows:1', 'workflows:2', 'workflows:4'] })]
    for (const l of collectionListeners)
      l({ collection: 'workflows', item: '3', action: 'update', changed_fields: ['$state'] })
    await act(async () => new Promise((r) => setTimeout(r, 1100)))
    await settle()
    expect(line()).toContain("of Jane's records need you")
    expect(document.querySelector('[data-delegate-cover-count]')?.textContent?.trim()).toBe('3')

    // A write to a record that is not counted asks nothing.
    const asked = client.request.mock.calls.length
    for (const l of collectionListeners)
      l({ collection: 'workflows', item: '99', action: 'update', changed_fields: ['title'] })
    await act(async () => new Promise((r) => setTimeout(r, 1100)))
    expect(client.request.mock.calls.length).toBe(asked)

    // "Show them" hands the line to the host.
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      /Show them/.test(b.textContent ?? '')
    )
    act(() => btn?.click())
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'J1', records: 3 }))
  })
})
