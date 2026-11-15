// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { QueueBulkBar } from './QueueBulkBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  count: 2,
  states: [],
  busy: false,
  onClaim: () => {},
  onRelease: () => {},
  onTransition: () => {},
  onClear: () => {}
}

function mount(el: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(el)
  })
  return container
}

const button = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLElement

const fire = (el: Element, type: string, init: Record<string, unknown> = {}) =>
  act(() => {
    const ev =
      type === 'keydown'
        ? new KeyboardEvent('keydown', { bubbles: true, ...init })
        : new MouseEvent(type, { bubbles: true })
    el.dispatchEvent(ev)
  })

describe('QueueBulkBar action intent (rt8)', () => {
  it('says when the person reaches for an action, by pointer or keyboard', () => {
    const intent = vi.fn()
    const root = mount(<QueueBulkBar {...base} onActionIntent={intent} />)
    fire(button(root, 'Claim'), 'pointerdown')
    expect(intent).toHaveBeenCalledTimes(1)
    fire(button(root, 'Release'), 'keydown', { key: 'Enter' })
    expect(intent).toHaveBeenCalledTimes(2)
  })

  it('does not count the notices above the bar or a click on the figures', () => {
    const intent = vi.fn()
    const root = mount(
      <QueueBulkBar
        {...base}
        onActionIntent={intent}
        notices={<button type='button'>Continue</button>}
        figures={<span data-figures=''>2 rows selected</span>}
      />
    )
    fire(button(root, 'Continue'), 'pointerdown')
    fire(root.querySelector('[data-figures]') as Element, 'pointerdown')
    expect(intent).not.toHaveBeenCalled()
  })
})
