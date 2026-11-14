// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  atRiskBreakdown,
  extraChoiceText,
  formulaColumnKeys,
  worklistKeyTarget
} from './worklist-helpers'

describe('worklistKeyTarget (army 11 N10)', () => {
  it('list keys work on the page and on a focused row only', () => {
    expect(worklistKeyTarget(document.body)).toBe(true)
    const tr = document.createElement('tr')
    tr.setAttribute('data-row-key', 'workflows:1')
    expect(worklistKeyTarget(tr)).toBe(true)
    for (const tag of ['button', 'a', 'input', 'div']) {
      expect(worklistKeyTarget(document.createElement(tag))).toBe(false)
    }
  })
})

describe('atRiskBreakdown (army 11 Q1-6)', () => {
  it('names each rule, biggest first', () => {
    expect(atRiskBreakdown({ 'Sent back': 4, 'On hold': 144 })).toBe('On hold 144 · Sent back 4')
    expect(atRiskBreakdown({})).toBeNull()
    expect(atRiskBreakdown(undefined)).toBeNull()
  })
})

describe('extraChoiceText (army 11 Q1-2)', () => {
  const meta = {
    choices: [
      { value: 'at_risk', text: 'At Risk' },
      { value: 'good', text: '$t:good' }
    ]
  }
  it('shows the choice label, never the stored key', () => {
    expect(extraChoiceText(meta, 'at_risk')).toBe('At Risk')
    expect(extraChoiceText(meta, 'good')).toBe('Good')
    expect(extraChoiceText(meta, 'other')).toBe('other')
    expect(extraChoiceText(undefined, 'x')).toBe('x')
  })
})

describe('formulaColumnKeys', () => {
  it('offers every formula column with a key and a formula', () => {
    expect(
      formulaColumnKeys([
        { key: 'left', formula: '{{extra.req}} - {{extra.po}}' },
        { key: 'broken', formula: '' },
        { key: '', formula: '{{extra.req}}' }
      ])
    ).toEqual(['formula.left'])
    expect(formulaColumnKeys(null)).toEqual([])
  })
})
