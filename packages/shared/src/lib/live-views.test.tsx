// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundArm, calendarBatchMatters, isJobBoundary, useLiveJobs } from './live-views'
import { type RealtimeAdapter, RealtimeContext } from './realtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('backgroundArm', () => {
  it('stays 0 on the first answer and arms on a later refresh of the same view', () => {
    let st = { resetKey: 'v', first: null as number | null }
    let r = backgroundArm(st, 0, 'v')
    expect(r.arm).toBe(0)
    r = backgroundArm(st, 100, 'v')
    expect(r.arm).toBe(0)
    st = r.state
    expect(backgroundArm(st, 100, 'v').arm).toBe(0)
    expect(backgroundArm(st, 250, 'v').arm).toBe(250)
  })

  it('a different view starts over (a month change never fades)', () => {
    const first = backgroundArm({ resetKey: 'jan', first: null }, 100, 'jan')
    const second = backgroundArm(first.state, 400, 'feb')
    expect(second.arm).toBe(0)
    expect(second.state).toEqual({ resetKey: 'feb', first: 400 })
  })
})

describe('calendarBatchMatters', () => {
  it('ignores aspect-only notices', () => {
    expect(calendarBatchMatters({ aspectsOnly: true, changedFields: ['$comments'] })).toBe(false)
  })
  it('any write counts without a field list, or when the batch names no fields', () => {
    expect(calendarBatchMatters({ aspectsOnly: false, changedFields: ['x'] })).toBe(true)
    expect(calendarBatchMatters({ aspectsOnly: false, changedFields: null }, ['due'])).toBe(true)
  })
  it('a field list needs one of its fields named', () => {
    expect(calendarBatchMatters({ aspectsOnly: false, changedFields: ['note'] }, ['due'])).toBe(
      false
    )
    expect(calendarBatchMatters({ aspectsOnly: false, changedFields: ['due'] }, ['due'])).toBe(true)
  })
})

describe('isJobBoundary', () => {
  it('a start or finish is a boundary, a progress report is not', () => {
    expect(isJobBoundary({})).toBe(true)
    expect(isJobBoundary({ progress: { done: 1 } })).toBe(false)
    expect(isJobBoundary(null)).toBe(false)
  })
})

function adapter() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const joined: string[] = []
  const rt: RealtimeAdapter = {
    subscribeCollections: () => () => {},
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit: () => {},
    joinWatch(room) {
      joined.push(room)
      return () => {}
    }
  }
  const fire = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return { rt, fire, joined }
}

describe('useLiveJobs', () => {
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

  it('refreshes once per burst of starts and finishes; progress never refetches', () => {
    const { rt, fire, joined } = adapter()
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined)
    const progress = vi.fn()
    function Page() {
      useLiveJobs({ keys: [['job-runs'], ['job-registry']], onProgress: progress })
      return null
    }
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(RealtimeContext.Provider, { value: rt }, createElement(Page))
        )
      )
    )
    expect(joined).toEqual(['jobs'])
    for (let i = 0; i < 30; i++) {
      fire('job:update', { id: i, progress: { done: i } })
      act(() => {
        vi.advanceTimersByTime(50)
      })
    }
    expect(progress).toHaveBeenCalledTimes(30)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(spy).not.toHaveBeenCalled()
    for (let i = 0; i < 20; i++) {
      fire('job:update', { id: i, status: i % 2 ? 'completed' : 'running' })
      act(() => {
        vi.advanceTimersByTime(100)
      })
    }
    expect(spy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['job-runs'], refetchType: 'active' })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['job-registry'], refetchType: 'active' })
  })

  it('does nothing when disabled', () => {
    const { rt, fire } = adapter()
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined)
    function Page() {
      useLiveJobs({ keys: [['job-runs']], enabled: false })
      return null
    }
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(RealtimeContext.Provider, { value: rt }, createElement(Page))
        )
      )
    )
    fire('job:update', { id: 1, status: 'completed' })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(spy).not.toHaveBeenCalled()
  })
})
