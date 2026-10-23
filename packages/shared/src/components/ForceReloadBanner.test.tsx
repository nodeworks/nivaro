// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientVersion, markReloadFor, obeyedReloads } from '../lib/client-version'
import { __resetUnsavedWorkForTests, registerUnsavedWork } from '../lib/unsaved-work'
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

function pushDetail(detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(FORCE_RELOAD_EVENT, { detail }))
  })
}

const banner = () => document.querySelector('[data-nvr-force-reload]')

describe('ForceReloadBanner — unsaved work holds the reload', () => {
  afterEach(() => __resetUnsavedWorkForTests())

  it('waits while a form is dirty and reloads the moment it is saved', () => {
    const off = registerUnsavedWork('Record form', () => true)
    push(5)
    act(() => vi.advanceTimersByTime(10_000))
    expect(reload).not.toHaveBeenCalled()
    expect(banner()?.getAttribute('data-nvr-force-reload-held')).toBe('true')
    expect(banner()?.textContent).toContain('A reload is waiting')
    act(() => off())
    act(() => vi.advanceTimersByTime(0))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('Reload now skips the hold', () => {
    registerUnsavedWork('Record form', () => true)
    push(5)
    act(() => vi.advanceTimersByTime(6_000))
    expect(reload).not.toHaveBeenCalled()
    act(() => (banner()?.querySelector('button') as HTMLButtonElement).click())
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('ForceReloadBanner — sticky instructions', () => {
  beforeEach(() => sessionStorage.clear())

  it('ignores the same instruction arriving twice and marks it before reloading', () => {
    pushDetail({ seconds: 10, id: 'i-1', reason: 'push', issued_at: Date.now() })
    act(() => vi.advanceTimersByTime(5_000))
    // The remembered copy after a reconnect does not restart the clock.
    pushDetail({ seconds: 10, id: 'i-1', reason: 'sticky', issued_at: Date.now() })
    act(() => vi.advanceTimersByTime(5_000))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(obeyedReloads()).toEqual(['i-1'])
    expect(clientVersion().obeyed).toEqual(['i-1'])
  })

  it('a tab that already reloaded for an instruction never counts down for it again', () => {
    markReloadFor('i-2')
    pushDetail({ seconds: 5, id: 'i-2', reason: 'sticky', issued_at: Date.now() + 60_000 })
    expect(banner()).toBeNull()
  })

  it('a remembered instruction issued before this page loaded is ignored (shared worker)', () => {
    pushDetail({ seconds: 5, id: 'i-3', reason: 'sticky', issued_at: 1_000 })
    expect(banner()).toBeNull()
  })
})
