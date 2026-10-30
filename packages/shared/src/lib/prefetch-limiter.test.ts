// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPrefetchBudget,
  connectionAllowsPrefetch,
  createPrefetchLimiter,
  INTENT_DWELL_MS,
  intentProps,
  listQueryKeys,
  MAX_PREFETCH_IN_FLIGHT,
  prefetchCollectionList,
  prefetchLimiter
} from './prefetch'

beforeEach(() => __resetPrefetchBudget())
afterEach(() => vi.useRealTimers())

describe('prefetch limiter (#3230)', () => {
  it('runs at most MAX_PREFETCH_IN_FLIGHT jobs at once and starts the next as one ends', async () => {
    const lim = createPrefetchLimiter(MAX_PREFETCH_IN_FLIGHT, 6)
    const resolvers: Array<() => void> = []
    let started = 0
    const job = (id: string) => ({
      id,
      group: 'g',
      run: () =>
        new Promise<void>((res) => {
          started++
          resolvers.push(res)
        })
    })
    for (const id of ['a', 'b', 'c', 'd']) lim.add(job(id))
    await vi.waitFor(() => expect(started).toBe(2))
    expect(lim.inFlight).toBe(2)
    expect(lim.queued).toBe(2)
    expect(lim.add(job('a'))).toBe(false)
    resolvers.shift()?.()
    await vi.waitFor(() => expect(started).toBe(3))
    expect(lim.inFlight).toBe(2)
  })

  it('cancelGroup drops waiting jobs and cancels running ones of that group only', () => {
    const lim = createPrefetchLimiter(1, 6)
    const cancel = vi.fn()
    lim.add({ id: 'r', group: 'x', run: () => new Promise(() => {}), cancel })
    lim.add({ id: 'q1', group: 'x', run: async () => {} })
    lim.add({ id: 'q2', group: 'y', run: async () => {} })
    expect(lim.queued).toBe(2)
    lim.cancelGroup('x')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(lim.queued).toBe(1)
    expect(lim.has('q2')).toBe(true)
    expect(lim.has('q1')).toBe(false)
  })

  it('keeps only the newest waiting intents', () => {
    const lim = createPrefetchLimiter(1, 2)
    lim.add({ id: 'run', run: () => new Promise(() => {}) })
    for (const id of ['a', 'b', 'c']) lim.add({ id, run: async () => {} })
    expect(lim.has('a')).toBe(false)
    expect(lim.has('b')).toBe(true)
    expect(lim.has('c')).toBe(true)
  })
})

describe('connectionAllowsPrefetch', () => {
  it('skips save-data and 2g connections', () => {
    expect(connectionAllowsPrefetch(undefined)).toBe(true)
    expect(connectionAllowsPrefetch({ effectiveType: '4g' })).toBe(true)
    expect(connectionAllowsPrefetch({ saveData: true })).toBe(false)
    expect(connectionAllowsPrefetch({ effectiveType: '2g' })).toBe(false)
    expect(connectionAllowsPrefetch({ effectiveType: 'slow-2g' })).toBe(false)
  })
})

describe('intentProps', () => {
  it('acts only after the dwell; leaving after acting cancels, unless it was pressed', () => {
    vi.useFakeTimers()
    const act = vi.fn(() => 1)
    const spy = vi.spyOn(prefetchLimiter, 'cancelGroup')
    const p = intentProps('record:x:1', act)
    // a quick pass does nothing
    p.onPointerEnter()
    vi.advanceTimersByTime(INTENT_DWELL_MS - 10)
    p.onPointerLeave()
    vi.advanceTimersByTime(100)
    expect(act).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    // resting acts; leaving cancels what it started
    p.onPointerEnter()
    vi.advanceTimersByTime(INTENT_DWELL_MS + 1)
    expect(act).toHaveBeenCalledTimes(1)
    p.onPointerLeave()
    expect(spy).toHaveBeenCalledWith('record:x:1')
    spy.mockClear()
    // pressed = wanted: leaving afterwards cancels nothing
    p.onPointerEnter()
    vi.advanceTimersByTime(INTENT_DWELL_MS + 1)
    p.onPointerDown()
    p.onPointerLeave()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('prefetchCollectionList', () => {
  it('warms the list metadata under the key the list reads', async () => {
    const qc = new QueryClient()
    const paths: string[] = []
    const client = {
      request: vi.fn(async (cmd: { _path?: string }) => {
        paths.push(String(cmd._path))
        return { data: { collection: 'projects', fields: [] } }
      })
    } as never
    expect(prefetchCollectionList(qc, client, 'projects')).toBe(1)
    await vi.waitFor(() => expect(paths).toContain('/collections/projects'))
    await vi.waitFor(() =>
      expect(qc.getQueryData(listQueryKeys('projects').meta)).toEqual({
        collection: 'projects',
        fields: []
      })
    )
    expect(listQueryKeys('projects').meta).toEqual(['cbv-collection-meta', 'projects'])
    expect(prefetchCollectionList(qc, client, 'nivaro_users')).toBe(0)
  })
})
