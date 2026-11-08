import { describe, expect, it } from 'vitest'
import { collisionNumberText, differingTails, isMoneyFieldName } from './collision-format'

describe('Theirs / Mine values (army 11 f4 M1)', () => {
  it('money totals read as dollars, without float artefacts', () => {
    expect(collisionNumberText('total', 18.900000000000002)).toBe('$18.90')
    expect(collisionNumberText('total', 10.5)).toBe('$10.50')
    expect(collisionNumberText('amount', '110')).toBe('$110.00')
    expect(collisionNumberText('unit_price', 2.1)).toBe('$2.10')
  })
  it('other numbers read plainly', () => {
    expect(collisionNumberText('quantity', 20)).toBe('20')
    expect(collisionNumberText('quantity', 1234.5)).toBe('1,234.5')
    expect(collisionNumberText('december', 0.1 + 0.2)).toBe('0.3')
  })
  it('text and blanks are left to the dialog', () => {
    expect(collisionNumberText('description', 'ARMY11 lock test')).toBeNull()
    expect(collisionNumberText('total', null)).toBeNull()
    expect(collisionNumberText('total', '')).toBeNull()
  })
  it('names money fields by their name only', () => {
    expect(isMoneyFieldName('requisition_amount')).toBe(true)
    expect(isMoneyFieldName('amount_left')).toBe(true)
    expect(isMoneyFieldName('line_number')).toBe(false)
    expect(isMoneyFieldName('totality')).toBe(false)
  })
})

describe('differing tails', () => {
  it('cuts a long shared start so the change shows', () => {
    const r = differingTails(
      'ARMY11 Sudharsan f4 lock test A S1 B2 B3',
      'ARMY11 Sudharsan f4 lock test A S1 B2 S3'
    )
    expect(r.a.startsWith('…')).toBe(true)
    expect(r.a.endsWith('B2 B3')).toBe(true)
    expect(r.b.endsWith('B2 S3')).toBe(true)
    expect(r.a.length).toBeLessThan(30)
  })
  it('leaves short or different texts whole', () => {
    expect(differingTails('abc', 'abd')).toEqual({ a: 'abc', b: 'abd' })
    expect(differingTails('Hello world', 'Goodbye')).toEqual({ a: 'Hello world', b: 'Goodbye' })
  })
})
