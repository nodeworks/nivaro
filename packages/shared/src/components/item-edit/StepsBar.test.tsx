// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LayoutDesign, LayoutDesignContext } from '../layout-editor/design-context'
import { StepsBar } from './StepsBar'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const design: LayoutDesign = {
  selected: null,
  onSelect: vi.fn(),
  showHidden: false,
  inheritedFrom: () => null,
  dnd: { draggableProps: () => ({}), isDragging: () => false, dropSlot: () => null }
}

const steps = [
  { key: 'one', label: 'One' },
  { key: 'two', label: 'Two' }
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
})

const bar = () => (
  <StepsBar steps={steps} active='one' completed={new Set()} onStepClick={() => {}} />
)

describe('StepsBar design markers', () => {
  it('a normal record page carries no design attributes', () => {
    act(() => root.render(bar()))
    expect(host.querySelectorAll('[data-design-tab]')).toHaveLength(0)
  })

  it('the layout editor canvas marks each step for drag and drop', () => {
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={design}>{bar()}</LayoutDesignContext.Provider>
      )
    )
    expect(host.querySelectorAll('[data-design-tab]')).toHaveLength(2)
  })
})
