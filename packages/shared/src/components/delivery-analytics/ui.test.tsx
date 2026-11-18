// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_CSP, sandboxedEmail } from './drill'
import type { DaCell } from './types'
import { Delta, DrillContext, Num } from './ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const cell: DaCell = { n: 12, s: 'n', w: [['category', ['workflow']]] }
const prev: DaCell = { ...cell, n: 8, win: 'prev' }

describe('delivery analytics numbers while the figures are stale', () => {
  it('opens the rows behind a number when the figures are current', () => {
    const open = vi.fn()
    act(() =>
      root.render(
        <DrillContext.Provider value={open}>
          <Num cell={cell} label='Workflow' />
        </DrillContext.Provider>
      )
    )
    const btn = host.querySelector('button[data-da-num]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    act(() => btn.click())
    expect(open).toHaveBeenCalledWith(cell, 'Workflow', undefined)
  })

  it('opens nothing while placeholder (previous) figures are on screen', () => {
    act(() =>
      root.render(
        <DrillContext.Provider value={null}>
          <Num cell={cell} label='Workflow' />
          <Delta cur={12} prev={prev} label='Sent' periodLabel='previous 7 days' />
        </DrillContext.Provider>
      )
    )
    expect(host.querySelector('button[data-da-num]')).toBeNull()
    const stale = host.querySelector('[data-da-num-stale]')
    expect(stale?.getAttribute('aria-disabled')).toBe('true')
    expect(stale?.textContent).toBe('12')
    expect((host.querySelector('button[data-da-delta]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('stored email bodies', () => {
  it('render behind a CSP that blocks remote images, styles and everything else', () => {
    const doc = sandboxedEmail('<img src="https://tracker.example/p.gif">')
    expect(doc.startsWith(EMAIL_CSP)).toBe(true)
    expect(EMAIL_CSP).toContain("default-src 'none'")
    expect(EMAIL_CSP).toContain('img-src data: cid:')
    expect(EMAIL_CSP).toContain("style-src 'unsafe-inline'")
  })
})
