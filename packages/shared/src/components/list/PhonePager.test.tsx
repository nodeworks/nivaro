// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhonePager } from './PhonePager'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('PhonePager', () => {
  it('is one line: previous, the range, next — named buttons, md:hidden', () => {
    const onPrev = vi.fn()
    const onNext = vi.fn()
    act(() =>
      root.render(
        <PhonePager
          range='1–25 of 2,431'
          prevDisabled
          nextDisabled={false}
          onPrev={onPrev}
          onNext={onNext}
        />
      )
    )
    const pager = host.querySelector('[data-phone-pager]') as HTMLElement
    expect(pager.className).toContain('md:hidden')
    const [prev, range, next] = Array.from(pager.children) as HTMLElement[]
    expect(prev.getAttribute('aria-label')).toBe('Previous page')
    expect((prev as HTMLButtonElement).disabled).toBe(true)
    expect(range.textContent).toBe('1–25 of 2,431')
    expect(range.className).toContain('whitespace-nowrap')
    expect(next.getAttribute('aria-label')).toBe('Next page')
    act(() => next.click())
    expect(onNext).toHaveBeenCalledOnce()
  })
})
