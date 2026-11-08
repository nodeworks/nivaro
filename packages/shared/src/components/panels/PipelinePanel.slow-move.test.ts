import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  dismiss: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))
vi.mock('sonner', () => ({ toast }))

import { SLOW_MOVE_MS, slowMoveToast } from './PipelinePanel'

// Army9 b06 N-AC: a slow move says it is working, and its answer replaces that toast.
describe('slowMoveToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    toast.loading.mockClear()
    toast.dismiss.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('a quick move shows nothing extra', () => {
    const t = slowMoveToast('Submit')
    vi.advanceTimersByTime(SLOW_MOVE_MS - 100)
    expect(t.done()).toEqual({})
    vi.advanceTimersByTime(1000)
    expect(toast.loading).not.toHaveBeenCalled()
  })

  it('a slow move says "Submit…" and the result replaces it', () => {
    const t = slowMoveToast('Submit')
    vi.advanceTimersByTime(SLOW_MOVE_MS + 10)
    expect(toast.loading).toHaveBeenCalledWith(
      'Submit…',
      expect.objectContaining({ id: expect.any(String) })
    )
    const opts = t.done()
    expect(opts.id).toBe(toast.loading.mock.calls[0][1].id)
    expect(opts.duration).toBeGreaterThan(4000)
  })

  it('a failed slow move drops the loading toast', () => {
    const t = slowMoveToast(null)
    vi.advanceTimersByTime(SLOW_MOVE_MS + 10)
    expect(toast.loading).toHaveBeenCalledWith('Moving…', expect.anything())
    t.fail()
    expect(toast.dismiss).toHaveBeenCalled()
  })
})
