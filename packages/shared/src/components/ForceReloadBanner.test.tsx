// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORCE_RELOAD_EVENT, ForceReloadBanner } from './ForceReloadBanner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const reload = vi.fn()
const realLocation = window.location

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T14:34:58Z'))
  reload.mockReset()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, reload }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ForceReloadBanner />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  vi.useRealTimers()
})

function push(seconds: number) {
  act(() => {
    window.dispatchEvent(new CustomEvent(FORCE_RELOAD_EVENT, { detail: { seconds } }))
  })
}

describe('ForceReloadBanner', () => {
  it('counts down and reloads at the deadline', () => {
    push(15)
    expect(
      document.querySelector('[data-nvr-force-reload]')?.getAttribute('data-nvr-force-reload')
    ).toBe('15')
    act(() => vi.advanceTimersByTime(14_000))
    expect(reload).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1_000))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a throttled tab reloads at its first wake past the deadline, not after N ticks', () => {
    push(15)
    // A background tab: the clock moves a minute while no 1 s tick has run.
    act(() => vi.setSystemTime(new Date('2026-10-23T14:35:58Z')))
    expect(reload).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1_000))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a frozen tab reloads the moment it is shown again', () => {
    push(15)
    act(() => vi.setSystemTime(new Date('2026-10-23T14:50:00Z')))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(reload).toHaveBeenCalledTimes(1)
    // Later ticks never reload twice.
    act(() => vi.advanceTimersByTime(3_000))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
