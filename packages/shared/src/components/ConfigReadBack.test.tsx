// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChangeImpactStrip, ConfigReadBack } from './ConfigReadBack'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('ConfigReadBack', () => {
  it('renders nothing without a sentence (unknown shapes stay silent)', () => {
    const el = mount(<ConfigReadBack sentences={null} kind='x' />)
    expect(el.querySelector('[data-config-readback]')).toBeNull()
  })
  it('joins the sentences into one quiet line', () => {
    const el = mount(<ConfigReadBack sentences={['A is set.', 'B is empty.']} kind='alert' />)
    expect(el.querySelector('[data-config-readback="alert"]')?.textContent).toBe(
      'A is set. B is empty.'
    )
  })
})

describe('ChangeImpactStrip', () => {
  it('shows the sentences and asks before saving', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const el = mount(
      <ChangeImpactStrip
        sentences={['This will hide Vendor on 1 form (“Default”).']}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
    expect(el.textContent).toContain('This will hide Vendor on 1 form')
    act(() => (el.querySelector('[data-change-impact-confirm]') as HTMLButtonElement).click())
    act(() => (el.querySelector('[data-change-impact-cancel]') as HTMLButtonElement).click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
  it('cannot confirm while the check is still running', () => {
    const el = mount(
      <ChangeImpactStrip sentences={[]} loading onConfirm={() => {}} onCancel={() => {}} />
    )
    expect((el.querySelector('[data-change-impact-confirm]') as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})
