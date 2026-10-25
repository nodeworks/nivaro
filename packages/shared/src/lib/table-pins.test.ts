import { describe, expect, it } from 'vitest'
import { fitPins } from './table-pins'

const widths: Record<string, number> = { request: 120, state: 140, owners: 145, actions: 80 }
const widthOf = (k: string) => widths[k] ?? 100

describe('fitPins', () => {
  it('keeps every pin when they fit the budget (desktop)', () => {
    expect(fitPins(['request'], ['state', 'owners', 'actions'], widthOf, 40, 1000)).toEqual({
      left: ['request'],
      right: ['state', 'owners', 'actions']
    })
  })

  it('drops the right pins on a phone so the identifier stays visible', () => {
    // 311 px viewport: checkbox + Request already use most of the budget.
    expect(fitPins(['request'], ['state', 'owners', 'actions'], widthOf, 40, 311)).toEqual({
      left: ['request'],
      right: []
    })
  })

  it('keeps right pins contiguous from the outer edge', () => {
    // budget 270: 160 used on the left, Actions (80) fits, Owners does not.
    expect(fitPins(['request'], ['state', 'owners', 'actions'], widthOf, 40, 450)).toEqual({
      left: ['request'],
      right: ['actions']
    })
  })

  it('always keeps the first left pin, even past the budget', () => {
    expect(fitPins(['request', 'state'], [], widthOf, 40, 200)).toEqual({
      left: ['request'],
      right: []
    })
  })

  it('pins as configured before the table is measured', () => {
    expect(fitPins(['request'], ['actions'], widthOf, 40, 0)).toEqual({
      left: ['request'],
      right: ['actions']
    })
  })
})
