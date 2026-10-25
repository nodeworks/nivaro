import { describe, expect, it } from 'vitest'
import { riskFilterEntry, splitRiskFilter } from './saved-view-risk'

const rules = [
  { id: 3, name: 'On hold' },
  { id: 7, name: 'Sent back' }
]

describe('saved-view highlight pills', () => {
  it('saves pressed pills as one $at_risk entry and reads them back', () => {
    const entry = riskFilterEntry([3, 7], rules)
    expect(entry).toMatchObject({
      path: ['$at_risk'],
      op: '_eq',
      value: [3, 7],
      valueLabels: ['On hold', 'Sent back']
    })
    const chip = {
      id: 'f1',
      path: ['status'],
      pathLabels: ['Status'],
      fieldType: 'string',
      op: '_eq',
      value: 'open'
    }
    const split = splitRiskFilter([chip, entry!])
    expect(split.filters).toEqual([chip])
    expect(split.riskIds).toEqual([3, 7])
  })

  it('saves nothing when no pill is pressed', () => {
    expect(riskFilterEntry([], rules)).toBeNull()
    expect(splitRiskFilter([]).riskIds).toEqual([])
  })

  it('reads a single-value entry too', () => {
    const split = splitRiskFilter([
      { id: 'x', path: ['$at_risk'], pathLabels: [], fieldType: 'at_risk', op: '_eq', value: '3' }
    ])
    expect(split.riskIds).toEqual([3])
    expect(split.filters).toEqual([])
  })
})
