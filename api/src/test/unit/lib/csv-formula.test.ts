import { describe, expect, it } from 'vitest'
import { csvFormulaSafe } from '../../../lib/csv-formula.js'

describe('csvFormulaSafe', () => {
  it.each([
    ['=HYPERLINK("https://evil.example","x")', `'=HYPERLINK("https://evil.example","x")`],
    ['+cmd|" /C calc"!A0', `'+cmd|" /C calc"!A0`],
    ['-2+3+cmd', `'-2+3+cmd`],
    ['@SUM(A1:A2)', `'@SUM(A1:A2)`],
    ['\t=1+1', `'\t=1+1`],
    ['\r=1+1', `'\r=1+1`]
  ])('neutralizes %j', (input, out) => {
    expect(csvFormulaSafe(input)).toBe(out)
  })

  it.each(['-12.5', '+3', '-0.25', '1e-3', '-1E+5', '-.5'])('keeps the number %s', (n) => {
    expect(csvFormulaSafe(n)).toBe(n)
  })

  it('leaves ordinary text, numbers and empties alone', () => {
    expect(csvFormulaSafe('PO-1234')).toBe('PO-1234')
    expect(csvFormulaSafe('a=b')).toBe('a=b')
    expect(csvFormulaSafe(-42)).toBe('-42')
    expect(csvFormulaSafe(null)).toBe('')
    expect(csvFormulaSafe(undefined)).toBe('')
  })
})
