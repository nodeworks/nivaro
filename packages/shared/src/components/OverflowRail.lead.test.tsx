// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OverflowRail } from './OverflowRail'

// The rail's pinned lead (list/queue viewers, 2026-11-15): drawn at the rail's left, outside
// the measured items, so it is never moved into ⋯.
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

describe('OverflowRail lead', () => {
  it('draws the lead first and never as a foldable item', () => {
    act(() => {
      root.render(
        <div>
          <OverflowRail
            lead={<span data-testid='viewers'>2 viewing</span>}
            items={[{ key: 'refresh', priority: 60, node: <button type='button'>Refresh</button> }]}
            trail={<button type='button'>New</button>}
          />
        </div>
      )
    })
    const rail = host.querySelector('[data-overflow-rail]') as HTMLElement
    const first = rail.firstElementChild as HTMLElement
    expect(first.hasAttribute('data-rail-lead')).toBe(true)
    expect(first.textContent).toBe('2 viewing')
    expect(first.hasAttribute('data-rail-item')).toBe(false)
    expect(rail.querySelectorAll('[data-rail-item]')).toHaveLength(1)
  })

  it('draws no lead slot when there is none', () => {
    act(() => {
      root.render(
        <div>
          <OverflowRail items={[{ key: 'a', priority: 1, node: <span>A</span> }]} />
        </div>
      )
    })
    expect(host.querySelector('[data-rail-lead]')).toBeNull()
  })
})
