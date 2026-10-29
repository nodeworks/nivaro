// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type LayoutRefusals,
  REFUSAL_MIN_ATTEMPTS,
  refusalOverlayFor,
  refusalPct,
  refusalTone,
  setShowRefusals,
  useShowRefusals
} from './refusal-lens'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DATA: LayoutRefusals = {
  ready: true,
  days: 30,
  saves: 80,
  refused: 20,
  attempts: 100,
  fields: [
    { field: 'title', required: 20, invalid: 5, refusals: 25, rate: 0.25 },
    { field: 'amount', required: 0, invalid: 6, refusals: 6, rate: 0.06 },
    { field: 'notes', required: 0, invalid: 1, refusals: 1, rate: 0.01 }
  ]
}

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
  setShowRefusals(false)
})

describe('error-rate lens (#3185)', () => {
  it('tones and percentages', () => {
    expect(refusalTone(0.25)).toBe('high')
    expect(refusalTone(0.06)).toBe('some')
    expect(refusalTone(0.01)).toBe('none')
    expect(refusalPct(0.004)).toBe('<1%')
    expect(refusalPct(0.25)).toBe('25%')
  })

  it('tints fields with refusals; nothing for sections, clean fields or too few saves', () => {
    const title = refusalOverlayFor(DATA, { kind: 'field', field: 'title', group_key: 'main' })
    expect(title?.className).toContain('ring-red-300')
    expect(title?.className).toContain('dark:')
    expect(
      refusalOverlayFor(DATA, { kind: 'field', field: 'notes', group_key: null })?.className
    ).toBe('')
    expect(refusalOverlayFor(DATA, { kind: 'field', field: 'site', group_key: null })).toBeNull()
    expect(refusalOverlayFor(DATA, { kind: 'group', key: 'main' })).toBeNull()
    expect(
      refusalOverlayFor(
        { ...DATA, attempts: REFUSAL_MIN_ATTEMPTS - 1 },
        { kind: 'field', field: 'title', group_key: 'main' }
      )
    ).toBeNull()
    act(() => root.render(<div>{title?.chip}</div>))
    const chip = host.querySelector('[data-design-refusal]')
    expect(chip?.textContent).toContain('25% refused')
    expect(chip?.getAttribute('data-tip')).toBe(
      'Refused 25 of 100 saves in 30 days: 20 left empty while required, 5 broke another rule'
    )
  })

  it('one switch, shared by every component that reads it', () => {
    function Probe({ id }: { id: string }) {
      const [on] = useShowRefusals()
      return <span data-probe={id}>{on ? 'on' : 'off'}</span>
    }
    act(() =>
      root.render(
        <>
          <Probe id='a' />
          <Probe id='b' />
        </>
      )
    )
    expect(host.textContent).toBe('offoff')
    act(() => setShowRefusals(true))
    expect(host.textContent).toBe('onon')
  })
})
