// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NumberDraftInput, numberFromDraft } from './number-draft-input'

// Army 4 a01-15 (BLOCKER): a PO line Price typed 2.05 one key at a time was
// stored as 25 — the input re-rendered "2.0" as "2" before the "5" landed.
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

/**
 * Type `text` one key at a time, the way a browser (and user-event) does: each
 * key goes after the text the person sees. When the page writes the input's
 * value between keys, the person sees what the page wrote, and the next key
 * lands after THAT — which is how 2.05 became 25.
 */
function typeKeys(input: HTMLInputElement, text: string) {
  let shown = input.value
  for (const ch of text) {
    shown += ch
    nativeSet?.call(input, shown)
    // jsdom stores "" for text a number input cannot parse yet ("2.", "-");
    // a browser keeps showing it. Only a change AFTER this point is the page.
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

let committed: Array<number | null> = []
let latest: number | null = null

function Field({
  type,
  allowNegative,
  initial = null
}: {
  type?: string
  allowNegative?: boolean
  initial?: number | null
}) {
  const [v, setV] = useState<number | null>(initial)
  latest = v
  return (
    <NumberDraftInput
      aria-label='Price'
      type={type}
      allowNegative={allowNegative}
      value={v}
      onValue={(n) => {
        committed.push(n)
        setV(n)
      }}
    />
  )
}

/** The old FieldRenderer pattern, kept here to prove the helper reproduces the bug. */
function OldField() {
  const [v, setV] = useState<number | null>(null)
  latest = v
  return (
    <input
      type='number'
      aria-label='Price'
      value={v === null ? '' : String(v)}
      onChange={(e) => setV(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

function mount(node: React.ReactNode) {
  committed = []
  latest = null
  act(() => root.render(node))
  return host.querySelector('input') as HTMLInputElement
}

describe('typing helper reproduces the reported bug', () => {
  it('the old controlled input turns 2.05 into 25', () => {
    const input = mount(<OldField />)
    expect(typeKeys(input, '2.05')).toBe('25')
    expect(latest).toBe(25)
  })
})

describe('NumberDraftInput — typed one key at a time', () => {
  const cases: Array<[string, number]> = [
    ['2.05', 2.05],
    ['0.05', 0.05],
    ['10.02', 10.02],
    ['100.505', 100.505],
    ['100.005', 100.005],
    ['1.0', 1],
    ['-3', -3],
    ['12.3456', 12.3456]
  ]

  for (const type of ['number', 'text']) {
    describe(`type=${type}`, () => {
      for (const [text, expected] of cases) {
        it(`"${text}" stays as typed and commits ${expected}`, () => {
          const input = mount(<Field type={type} />)
          const shown = typeKeys(input, text)
          expect(shown).toBe(text)
          expect(latest).toBe(expected)
          // No wrong figure was ever committed on the way (no 25, no 5).
          for (const n of committed) {
            if (n === null) continue
            expect(text.startsWith(String(n)) || String(expected) === String(n)).toBe(true)
          }
          blur(input)
          expect(latest).toBe(expected)
          expect(input.value).toBe(String(expected))
        })
      }
    })
  }

  it('keeps a trailing zero visible while typing (2.50) and shows 2.5 after blur', () => {
    const input = mount(<Field type='text' />)
    expect(typeKeys(input, '2.50')).toBe('2.50')
    expect(input.value).toBe('2.50')
    expect(latest).toBe(2.5)
    blur(input)
    expect(input.value).toBe('2.5')
  })

  it('keeps "-" and "." partial text without committing a number', () => {
    const input = mount(<Field type='text' initial={7} />)
    act(() => {
      nativeSet?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(latest).toBe(null)
    expect(typeKeys(input, '-')).toBe('-')
    expect(latest).toBe(null)
    expect(typeKeys(input, '.')).toBe('-.')
    expect(latest).toBe(null)
    expect(typeKeys(input, '5')).toBe('-.5')
    expect(latest).toBe(-0.5)
  })

  it('backspacing 2.05 to 2.0 commits 2 at once', () => {
    const input = mount(<Field type='text' />)
    typeKeys(input, '2.05')
    act(() => {
      nativeSet?.call(input, '2.0')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('2.0')
    expect(latest).toBe(2)
  })

  it('a partial "-" left on blur keeps the stored value', () => {
    const input = mount(<Field type='text' initial={4} />)
    act(() => {
      nativeSet?.call(input, '-')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('-')
    blur(input)
    expect(latest).toBe(4)
    expect(input.value).toBe('4')
  })

  it('clearing the text commits null', () => {
    const input = mount(<Field initial={3} />)
    act(() => {
      nativeSet?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(latest).toBe(null)
    expect(input.value).toBe('')
  })

  it('text mode refuses letters and, with allowNegative false, a minus sign', () => {
    const input = mount(<Field type='text' allowNegative={false} initial={1} />)
    expect(typeKeys(input, 'a')).toBe('1')
    expect(typeKeys(input, '-')).toBe('1')
    expect(latest).toBe(1)
    expect(typeKeys(input, '.5')).toBe('1.5')
    expect(latest).toBe(1.5)
  })

  it('keeps the typed text over an outside change, and shows the new value after blur', () => {
    let setOutside: (n: number) => void = () => {}
    function Outer() {
      const [v, setV] = useState<number | null>(1)
      setOutside = setV
      latest = v
      return <NumberDraftInput value={v} onValue={setV} type='text' />
    }
    const input = mount(<Outer />)
    typeKeys(input, '.0')
    expect(input.value).toBe('1.0')
    act(() => setOutside(9))
    expect(input.value).toBe('1.0')
    blur(input)
    expect(input.value).toBe('9')
    expect(latest).toBe(9)
  })

  it('shows an outside change at once when nothing is being typed', () => {
    let setOutside: (n: number) => void = () => {}
    function Outer() {
      const [v, setV] = useState<number | null>(1)
      setOutside = setV
      return <NumberDraftInput value={v} onValue={setV} />
    }
    const input = mount(<Outer />)
    act(() => setOutside(4.25))
    expect(input.value).toBe('4.25')
  })
})

describe('numberFromDraft', () => {
  it('reads complete numbers, null for empty, undefined for part-way text', () => {
    expect(numberFromDraft('2.05')).toBe(2.05)
    expect(numberFromDraft('2.')).toBe(2)
    expect(numberFromDraft('')).toBe(null)
    expect(numberFromDraft('  ')).toBe(null)
    expect(numberFromDraft('-')).toBe(undefined)
    expect(numberFromDraft('.')).toBe(undefined)
    expect(numberFromDraft('-.')).toBe(undefined)
    expect(numberFromDraft('1e')).toBe(undefined)
  })
})
