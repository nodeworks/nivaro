// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GridNumberInput } from './InlineGridField'

// Army 4 a01-15: grid number cells re-rendered "2.0" as "2" between keys.
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

/** One key at a time after the text the person sees (see shared number-draft-input.test). */
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

let latest: unknown = null
function Cell() {
  const [v, setV] = useState<unknown>(null)
  latest = v
  return <GridNumberInput value={v} onValue={setV} />
}

describe('GridNumberInput', () => {
  const cases: Array<[string, number]> = [
    ['2.05', 2.05],
    ['0.05', 0.05],
    ['10.02', 10.02],
    ['100.505', 100.505],
    ['1.0', 1],
    ['-3', -3]
  ]
  for (const [text, expected] of cases) {
    it(`"${text}" stays as typed and stores ${expected}`, () => {
      latest = null
      act(() => root.render(<Cell />))
      const input = host.querySelector('input') as HTMLInputElement
      expect(typeKeys(input, text)).toBe(text)
      expect(latest).toBe(expected)
      act(() => {
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      })
      expect(input.value).toBe(String(expected))
      expect(latest).toBe(expected)
    })
  }
})
