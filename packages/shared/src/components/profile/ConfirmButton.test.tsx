// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmButton } from './primitives'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ConfirmButton replaced every window.confirm in the shared delete buttons
// (pipeline states/routes/dimensions/groups, alert rules, quality rules,
// recipes, the list's row menu, learning paths). The question the native box
// used to ask is the armed button's accessible name, so a screen reader and an
// automated tab read the same words.
let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.useRealTimers()
})

function mount(onConfirm: () => void) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <ConfirmButton
        onConfirm={onConfirm}
        title='Delete rule'
        confirmLabel='Delete?'
        confirmTitle='Delete rule "Late invoices"?'
      >
        ✕
      </ConfirmButton>
    )
  )
  return host.querySelector('button') as HTMLButtonElement
}

describe('ConfirmButton as the in-app confirm', () => {
  it('first press asks with the old wording; second press runs; no native dialog', () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    const onConfirm = vi.fn()
    const btn = mount(onConfirm)
    expect(btn.getAttribute('aria-label')).toBe('Delete rule')
    act(() => btn.click())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(btn.getAttribute('aria-label')).toBe('Delete rule "Late invoices"?')
    expect(btn.textContent).toContain('Delete?')
    act(() => btn.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(btn.hasAttribute('data-armed')).toBe(false)
    expect(nativeConfirm).not.toHaveBeenCalled()
    nativeConfirm.mockRestore()
  })

  it('left alone it disarms: a later press only asks again (cancel = nothing happens)', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn()
    const btn = mount(onConfirm)
    act(() => btn.click())
    expect(btn.hasAttribute('data-armed')).toBe(true)
    act(() => vi.advanceTimersByTime(3100))
    expect(btn.hasAttribute('data-armed')).toBe(false)
    act(() => btn.click())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
