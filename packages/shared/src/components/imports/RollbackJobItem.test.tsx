// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { ROLLBACK_QUESTION, RollbackJobItem } from './CollectionImportPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// "Roll back this import" used to ask through window.confirm, which blocks
// the page and hangs an automated tab. It now asks inside the menu.
let root: Root | null = null
let nativeConfirm: MockInstance<typeof window.confirm>
beforeEach(() => {
  nativeConfirm = vi.spyOn(window, 'confirm').mockImplementation(() => true)
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  nativeConfirm.mockRestore()
})

function mount(props: { disabled?: boolean; onConfirm: () => void }) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RollbackJobItem
            disabled={props.disabled ?? false}
            rolledBack={false}
            onConfirm={props.onConfirm}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  )
}
const item = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) =>
    /Roll back/.test(el.textContent ?? '')
  )

describe('RollbackJobItem — asks in the menu, never natively', () => {
  it('first pick shows the question and keeps the menu open; second pick rolls back', () => {
    const onConfirm = vi.fn()
    mount({ onConfirm })
    expect(item()?.textContent).toBe('Roll back this import')
    act(() => item()?.click())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(item()?.textContent).toContain(ROLLBACK_QUESTION)
    expect(item()?.hasAttribute('data-armed')).toBe(true)
    act(() => item()?.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(nativeConfirm).not.toHaveBeenCalled()
  })

  it('closing the menu after the first pick cancels: nothing runs', () => {
    const onConfirm = vi.fn()
    mount({ onConfirm })
    act(() => item()?.click())
    act(() => {
      item()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(item()).toBeUndefined()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(nativeConfirm).not.toHaveBeenCalled()
  })
})
