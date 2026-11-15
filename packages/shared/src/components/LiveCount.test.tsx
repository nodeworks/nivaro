// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countText, LiveCount } from './LiveCount'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  vi.unstubAllGlobals()
})

const render = (value: number | string | null) =>
  act(() => root.render(createElement(LiveCount, { value })))

describe('countText', () => {
  it('shows numbers and strings, nothing for null', () => {
    expect(countText(0)).toBe('0')
    expect(countText('99+')).toBe('99+')
    expect(countText(null)).toBe('')
    expect(countText(undefined)).toBe('')
  })
})

describe('LiveCount', () => {
  it('shows the number with no outgoing copy on first render', () => {
    render(12)
    expect(host.textContent).toBe('12')
    expect(host.querySelectorAll('[aria-hidden]').length).toBe(0)
  })

  it('cross-fades: the old number stays (hidden from readers) until the fade ends', () => {
    render(12)
    render(13)
    expect(host.querySelector('[data-live-count]')?.getAttribute('data-live-count')).toBe('13')
    const old = host.querySelector('[aria-hidden="true"]')
    expect(old?.textContent).toBe('12')
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(host.querySelectorAll('[aria-hidden]').length).toBe(0)
    expect(host.textContent).toBe('13')
  })

  it('reduced motion swaps the number with no outgoing copy', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    render(12)
    render(13)
    expect(host.querySelectorAll('[aria-hidden]').length).toBe(0)
    expect(host.textContent).toBe('13')
  })

  it('an unchanged value does nothing', () => {
    render(5)
    render(5)
    expect(host.querySelectorAll('[aria-hidden]').length).toBe(0)
  })
})
