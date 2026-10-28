// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { PersonalDefaultPill } from './PersonalDefaultPill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PersonalDefaultPill', () => {
  it('the undo control has a 24×24 hit area around its 16px glyph', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const onUndo = vi.fn()
    act(() => root.render(<PersonalDefaultPill field='zone' label='Zone' onUndo={onUndo} />))
    const btn = host.querySelector<HTMLButtonElement>('[data-personal-default-undo="zone"]')
    expect(btn?.getAttribute('aria-label')).toBe('Undo your default for Zone')
    const cls = btn?.className.split(/\s+/) ?? []
    // 16px box + a 4px invisible extension on every side = 24px.
    expect(cls).toEqual(expect.arrayContaining(['relative', 'h-4', 'w-4', 'before:-inset-1']))
    act(() => btn?.click())
    expect(onUndo).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })
})
