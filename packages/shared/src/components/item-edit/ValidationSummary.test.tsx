// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ValidationSummary, type ValidationSummaryItem } from './ValidationSummary'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const item = (field: string): ValidationSummaryItem => ({
  field,
  label: field.toUpperCase(),
  message: `${field} is required`
})

describe('ValidationSummary (a01-7)', () => {
  it('keeps a fixed problem as a "Fixed" row, so the box does not shrink under the cursor', () => {
    const render = (items: ValidationSummaryItem[]) =>
      act(() =>
        root.render(<ValidationSummary items={items} onJump={() => {}} onDismiss={() => {}} />)
      )
    render([item('a'), item('b'), item('c')])
    expect(host.querySelectorAll('li')).toHaveLength(3)
    render([item('a'), item('c')])
    expect(host.querySelectorAll('li')).toHaveLength(3)
    expect(host.querySelectorAll('[data-validation-fixed]')).toHaveLength(1)
    expect(host.textContent).toContain('2 fields need attention')
    expect(host.textContent).toContain('Fixed')
    // Broken again: back to an open row in its old place.
    render([item('a'), item('b'), item('c')])
    expect(host.querySelectorAll('[data-validation-fixed]')).toHaveLength(0)
  })
})
