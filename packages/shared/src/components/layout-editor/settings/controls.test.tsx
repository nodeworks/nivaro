// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PickList } from './controls'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView ??= () => {}

const OPTIONS = [
  { value: 'a4', label: 'A4', hint: '210 × 297' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' }
]

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
  document.body.innerHTML = ''
})

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function openList(onChange: (v: string | null) => void) {
  act(() =>
    root.render(
      <PickList
        value='a4'
        options={OPTIONS}
        onChange={onChange}
        ariaLabel='Page size'
        clearLabel='Default'
      />
    )
  )
  await act(async () => {
    ;(host.querySelector('[data-pick-list="Page size"]') as HTMLButtonElement).click()
  })
  await tick()
  return document.querySelector('[aria-label="Search Page size"]') as HTMLInputElement
}

const key = async (el: Element, k: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}

describe('PickList', () => {
  it('is a keyboard list: arrows move the active entry, Enter picks it', async () => {
    const onChange = vi.fn()
    const input = await openList(onChange)
    expect(document.activeElement).toBe(input)
    // First entry (Default) is active; down twice reaches Letter.
    await key(input, 'ArrowDown')
    await key(input, 'ArrowDown')
    expect(document.querySelector('[role="option"][data-selected="true"]')?.textContent).toBe(
      'Letter'
    )
    await key(input, 'Enter')
    expect(onChange).toHaveBeenCalledWith('letter')
  })

  it('typing filters by label and hint; the none entry picks null', async () => {
    const onChange = vi.fn()
    const input = await openList(onChange)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '297')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const shown = () =>
      Array.from(document.querySelectorAll('[role="option"]')).map(
        (o) => o.querySelector('span')?.textContent
      )
    expect(shown()).toEqual(['A4'])
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(document.querySelector('[role="option"]') as HTMLElement).click()
    })
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
