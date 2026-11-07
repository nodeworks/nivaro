// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeptText } from './FieldRenderer'

// army6 M1: the record form's text boxes keep what was typed when the form's
// update for a keystroke is refused (React throws past its nested-update
// limit) or a render lags behind the box.
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

function key(el: HTMLInputElement, ch: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  set?.call(el, el.value + ch)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

let setOutside: (v: string) => void = () => {}
let failNext = 0
let refuse = false
function Box() {
  const [value, setValue] = useState('')
  setOutside = setValue
  const kept = useKeptText<HTMLInputElement>(value, (v) => {
    if (failNext > 0) {
      failNext--
      throw new Error('Maximum update depth exceeded')
    }
    if (refuse) return
    setValue(v)
  })
  return (
    <>
      <input {...kept} />
      <output>{value}</output>
    </>
  )
}

const input = () => host.querySelector('input') as HTMLInputElement
const stored = () => host.querySelector('output')?.textContent

describe('useKeptText', () => {
  it('keeps a key whose form update threw; the next key sends the whole text', async () => {
    failNext = 0
    refuse = false
    await act(async () => root.render(<Box />))
    const errors: unknown[] = []
    const onErr = (e: ErrorEvent) => {
      errors.push(e.error)
      e.preventDefault()
    }
    window.addEventListener('error', onErr)
    await act(async () => key(input(), 'a'))
    failNext = 1
    await act(async () => key(input(), 'b'))
    expect(input().value).toBe('ab')
    expect(stored()).toBe('a')
    await act(async () => key(input(), 'c'))
    expect(input().value).toBe('abc')
    expect(stored()).toBe('abc')
    // The last key's update threw: leaving the box sends it.
    failNext = 1
    await act(async () => key(input(), 'd'))
    expect(stored()).toBe('abc')
    await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(stored()).toBe('abcd')
    window.removeEventListener('error', onErr)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('a change from outside replaces the text', async () => {
    failNext = 0
    refuse = false
    await act(async () => root.render(<Box />))
    await act(async () => key(input(), 'x'))
    await act(async () => setOutside('Theirs'))
    expect(input().value).toBe('Theirs')
    await act(async () => key(input(), '!'))
    expect(stored()).toBe('Theirs!')
  })

  it('a refused edit shows what the form holds, as a controlled box would', async () => {
    failNext = 0
    refuse = false
    await act(async () => root.render(<Box />))
    await act(async () => key(input(), 'a'))
    refuse = true
    await act(async () => key(input(), 'b'))
    expect(input().value).toBe('a')
    expect(stored()).toBe('a')
  })
})
