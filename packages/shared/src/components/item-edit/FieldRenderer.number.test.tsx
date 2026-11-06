// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FieldRenderer } from './FieldRenderer'
import type { CMSField } from './types'

// Army 4 a01-15 (BLOCKER): a PO line Price typed 2.05 one key at a time was
// stored as 25 — FieldRenderer's number input re-rendered "2.0" as "2".
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

const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

/** One key at a time after the text the person sees (see ui/number-draft-input.test). */
function typeKeys(input: HTMLInputElement, text: string) {
  let shown = input.value
  for (const ch of text) {
    shown += ch
    nativeSet?.call(input, shown)
    const stored = input.value
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    if (input.value !== stored) shown = input.value
  }
  return shown
}

function blur(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

let latest: unknown = null
function Price({ type = 'decimal', options }: { type?: string; options?: unknown }) {
  const [v, setV] = useState<unknown>(null)
  latest = v
  const field = { field: 'price', label: 'Price', type, options } as unknown as CMSField
  return (
    <FieldRenderer
      field={field}
      value={v}
      onChange={setV}
      relations={[]}
      collection='workflow_line_items'
      itemId=''
    />
  )
}

function mount(node: React.ReactNode) {
  latest = null
  act(() => root.render(node))
  return host.querySelector('input') as HTMLInputElement
}

describe('FieldRenderer number field — typed one key at a time', () => {
  for (const [text, expected] of [
    ['2.05', 2.05],
    ['0.05', 0.05],
    ['10.02', 10.02],
    ['100.505', 100.505],
    ['1.0', 1],
    ['-3', -3]
  ] as Array<[string, number]>) {
    it(`a price typed "${text}" stays as typed and is stored as ${expected}`, () => {
      const input = mount(<Price />)
      expect(typeKeys(input, text)).toBe(text)
      expect(latest).toBe(expected)
      blur(input)
      expect(latest).toBe(expected)
    })
  }

  it('still rounds to the configured precision on blur, not while typing', () => {
    const input = mount(<Price options={{ precision: 2 }} />)
    expect(typeKeys(input, '2.056')).toBe('2.056')
    expect(latest).toBe(2.056)
    blur(input)
    expect(latest).toBe(2.06)
    expect(input.value).toBe('2.06')
  })

  it('an integer quantity of 10 stays 10', () => {
    const input = mount(<Price type='integer' />)
    expect(typeKeys(input, '10')).toBe('10')
    expect(latest).toBe(10)
  })
})
