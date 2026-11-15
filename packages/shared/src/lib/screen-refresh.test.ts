import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetScreenRefreshForTests,
  refreshScreenData,
  registerScreenLoader,
  screenRefreshMatches,
  screenRefreshState
} from './screen-refresh'

afterEach(() => __resetScreenRefreshForTests())

async function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const active = vi.fn(async () => 'a')
  const inactive = vi.fn(async () => 'i')
  const optedOut = vi.fn(async () => 'o')
  const off1 = new QueryObserver(qc, { queryKey: ['active'], queryFn: active }).subscribe(() => {})
  const off2 = new QueryObserver(qc, {
    queryKey: ['export'],
    queryFn: optedOut,
    meta: { screenRefresh: false }
  }).subscribe(() => {})
  await qc.fetchQuery({ queryKey: ['inactive'], queryFn: inactive })
  await new Promise((r) => setTimeout(r, 10))
  return {
    qc,
    active,
    inactive,
    optedOut,
    off: () => {
      off1()
      off2()
    }
  }
}

describe('refreshScreenData (idea 12)', () => {
  it('refetches active reads and loaders; marks inactive stale; respects opt-out', async () => {
    const { qc, active, inactive, optedOut, off } = await setup()
    const loader = vi.fn(async () => 1)
    registerScreenLoader(loader)
    const before = active.mock.calls.length
    const r = await refreshScreenData({ qc })
    expect(r.queries).toBe(1)
    expect(r.loaders).toBe(1)
    expect(r.failed).toBe(0)
    expect(active.mock.calls.length).toBe(before + 1)
    expect(optedOut).toHaveBeenCalledTimes(1)
    expect(inactive).toHaveBeenCalledTimes(1)
    expect(qc.getQueryState(['inactive'])?.isInvalidated).toBe(true)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(screenRefreshState().phase).toBe('done')
    off()
  })

  it('a second call while one runs shares it', async () => {
    const { qc, active, off } = await setup()
    const before = active.mock.calls.length
    const [a, b] = await Promise.all([refreshScreenData({ qc }), refreshScreenData({ qc })])
    expect(a.coalesced).toBeUndefined()
    expect(b.coalesced).toBe(true)
    expect(active.mock.calls.length).toBe(before + 1)
    off()
  })

  it('automatic refreshes inside a second are one; a failing loader counts as failed', async () => {
    const { qc, off } = await setup()
    registerScreenLoader(() => Promise.reject(new Error('x')))
    const first = await refreshScreenData({ qc, reason: 'idle-missed-events' })
    expect(first.failed).toBe(1)
    expect(screenRefreshState().phase).toBe('partial')
    const second = await refreshScreenData({ qc, reason: 'idle-missed-events' })
    expect(second.coalesced).toBe(true)
    off()
  })
})

describe('screenRefreshMatches (Cmd-K)', () => {
  it('matches refresh / reload words, not other searches', () => {
    expect(screenRefreshMatches('ref')).toBe(true)
    expect(screenRefreshMatches('reload page')).toBe(true)
    expect(screenRefreshMatches('refresh this page data')).toBe(true)
    expect(screenRefreshMatches('r')).toBe(false)
    expect(screenRefreshMatches('workflow 123')).toBe(false)
  })
})
