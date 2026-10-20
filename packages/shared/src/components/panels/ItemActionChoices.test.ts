import { describe, expect, it } from 'vitest'
import { itemActionChoiceStep } from './ItemActionChoices'

describe('itemActionChoiceStep', () => {
  it('runs without a pick when there is nothing to choose', () => {
    expect(itemActionChoiceStep([])).toEqual({ ask: false, value: null })
  })

  it('uses the only option without asking', () => {
    expect(itemActionChoiceStep([{ value: 'f1', label: 'Quote.pdf' }])).toEqual({
      ask: false,
      value: 'f1'
    })
  })

  it('asks when there are two or more', () => {
    expect(
      itemActionChoiceStep([
        { value: 'f1', label: 'Quote.pdf' },
        { value: 'f2', label: 'Spec.pdf' }
      ])
    ).toEqual({ ask: true })
  })
})
