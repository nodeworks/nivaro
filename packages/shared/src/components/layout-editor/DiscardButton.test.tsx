// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscardButton } from './EditorTopBar'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
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

const btn = () => host.querySelector<HTMLButtonElement>('[data-editor-discard]')!

describe('DiscardButton', () => {
  it('discards only on the second click', () => {
    const onDiscard = vi.fn()
    act(() => root.render(<DiscardButton count={3} onDiscard={onDiscard} />))
    expect(btn().getAttribute('aria-label')).toBe('Discard 3 unsaved changes')
    act(() => btn().click())
    expect(onDiscard).not.toHaveBeenCalled()
    expect(btn().hasAttribute('data-armed')).toBe(true)
    expect(btn().textContent).toContain('Discard them?')
    act(() => btn().click())
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(btn().hasAttribute('data-armed')).toBe(false)
  })

  it('disarms on its own and on Escape', () => {
    const onDiscard = vi.fn()
    act(() => root.render(<DiscardButton count={1} onDiscard={onDiscard} />))
    act(() => btn().click())
    expect(btn().textContent).toContain('Discard it?')
    act(() => vi.advanceTimersByTime(4100))
    expect(btn().hasAttribute('data-armed')).toBe(false)
    act(() => btn().click())
    act(() => {
      btn().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(btn().hasAttribute('data-armed')).toBe(false)
    act(() => btn().click())
    expect(onDiscard).not.toHaveBeenCalled()
  })
})
