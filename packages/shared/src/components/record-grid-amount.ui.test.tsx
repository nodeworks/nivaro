// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NumberCell } from './RecordGridEditor'

// Manage Forecast grid (F/army-finance.md): Tab into a money cell and type
// 5000 over 10 — the focus swap ("10.00" → "10") dropped the browser's
// select-all, the caret sat at the end and the cell became 105000.
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

let latest = ''
function Cell({ allowNegative = false }: { allowNegative?: boolean }) {
  const [v, setV] = useState('10')
  latest = v
  return <NumberCell value={v} original='10' onChange={setV} allowNegative={allowNegative} />
}

/** What the browser does with a keystroke: replace the selection with the text. */
function typeOver(input: HTMLInputElement, text: string) {
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? input.value.length
  const next = input.value.slice(0, start) + text + input.value.slice(end)
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    set?.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function focusByKeyboard(input: HTMLInputElement) {
  await act(async () => {
    input.focus()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

describe('Manage Forecast amount cell', () => {
  it('typing after keyboard focus replaces the value', async () => {
    act(() => root.render(<Cell />))
    const input = host.querySelector('input') as HTMLInputElement
    await focusByKeyboard(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    typeOver(input, '5000')
    expect(latest).toBe('5000')
  })

  it('refuses a negative with the reason, and keeps the old value', async () => {
    act(() => root.render(<Cell />))
    const input = host.querySelector('input') as HTMLInputElement
    await focusByKeyboard(input)
    typeOver(input, '-7')
    expect(latest).toBe('10')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter an amount of zero or more'
    )
  })

  it('allows a negative where the grid says so', async () => {
    act(() => root.render(<Cell allowNegative />))
    const input = host.querySelector('input') as HTMLInputElement
    await focusByKeyboard(input)
    typeOver(input, '-7')
    expect(latest).toBe('-7')
  })
})
