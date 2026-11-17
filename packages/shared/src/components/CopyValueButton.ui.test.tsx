// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyValueButton } from './CopyValueButton'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
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

const setClipboard = (writeText: (v: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

describe('CopyValueButton', () => {
  it('shows "Copied" with a check after a copy, then goes back', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard(writeText)
    act(() => root.render(<CopyValueButton value='nvk_abc' label='Copy token' testId='c' />))
    const btn = host.querySelector('[data-testid="c"]') as HTMLButtonElement
    await act(async () => btn.click())
    expect(writeText).toHaveBeenCalledWith('nvk_abc')
    expect(btn.dataset.copyState).toBe('copied')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied')
    expect(host.querySelector('[role="status"]')?.className).not.toContain('invisible')
    act(() => vi.advanceTimersByTime(2100))
    expect(btn.dataset.copyState).toBe('idle')
  })

  it('says it did not copy when the clipboard refuses', async () => {
    setClipboard(async () => {
      throw new Error('denied')
    })
    act(() => root.render(<CopyValueButton value='x' testId='c' />))
    const btn = host.querySelector('[data-testid="c"]') as HTMLButtonElement
    await act(async () => btn.click())
    expect(btn.dataset.copyState).toBe('failed')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Not copied')
  })
})
