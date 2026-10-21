import { describe, expect, it } from 'vitest'
import {
  capacityChars,
  fitWarnings,
  maskStoredLength,
  suggestSpan,
  typeWords,
  valueMisfit,
  widthCheckApplies,
  widthVerdict
} from './width-fit'

const col = (over: Partial<Parameters<typeof valueMisfit>[0]> = {}) => ({
  type: 'nvarchar',
  max_length: 10,
  precision: null,
  scale: null,
  nullable: true,
  ...over
})

describe('width fit', () => {
  it('narrower widths show fewer characters', () => {
    expect(capacityChars(12)).toBeGreaterThan(capacityChars(6))
    expect(capacityChars(6)).toBeGreaterThan(capacityChars(4))
    expect(capacityChars(4)).toBeGreaterThan(capacityChars(3))
    expect(capacityChars(null)).toBe(capacityChars(12))
  })

  it('suggests the narrowest width that shows the value', () => {
    expect(suggestSpan(5)).toBe(3)
    expect(suggestSpan(capacityChars(3) + 1)).toBe(4)
    expect(suggestSpan(capacityChars(6))).toBe(6)
    expect(suggestSpan(10_000)).toBe(12)
  })

  it('flags a width that cuts the 95th percentile, and one far wider than needed', () => {
    expect(widthVerdict(3, capacityChars(6))).toEqual({ cut: true, suggest: 6, roomy: false })
    expect(widthVerdict(12, 4)).toEqual({ cut: false, suggest: 3, roomy: true })
    expect(widthVerdict(6, capacityChars(4))).toEqual({ cut: false, suggest: 4, roomy: false })
  })

  it('checks single-line inputs only', () => {
    expect(widthCheckApplies({ type: 'string' })).toBe(true)
    expect(widthCheckApplies({ type: 'text' })).toBe(false)
    expect(widthCheckApplies({ type: 'integer', relKind: 'M2O' })).toBe(false)
    expect(widthCheckApplies({ type: 'string', iface: 'input-rich-text-html' })).toBe(false)
  })
})

describe('column fit', () => {
  it('writes the type with its size', () => {
    expect(typeWords(col())).toBe('nvarchar(10)')
    expect(typeWords(col({ max_length: null }))).toBe('nvarchar(max)')
    expect(typeWords(col({ type: 'decimal', max_length: null, precision: 18, scale: 2 }))).toBe(
      'decimal(18,2)'
    )
    expect(typeWords(col({ type: 'int', max_length: null }))).toBe('int')
  })

  it('counts what a mask stores', () => {
    expect(maskStoredLength('(###) ###-####')).toBe(10)
    expect(maskStoredLength('AA-**')).toBe(4)
  })

  it('judges values against length, integer range and precision', () => {
    expect(valueMisfit(col(), 'short')).toBeNull()
    expect(valueMisfit(col(), 'far too long a value')).toMatch(/20 characters/)
    expect(valueMisfit(col(), '$NOW')).toBeNull()
    expect(valueMisfit(col({ type: 'tinyint', max_length: null }), 300)).toMatch(/255/)
    const dec = col({ type: 'decimal', max_length: null, precision: 5, scale: 2 })
    expect(valueMisfit(dec, '123.45')).toBeNull()
    expect(valueMisfit(dec, '1234.5')).toMatch(/4 digits/)
    expect(valueMisfit(dec, '1.234')).toMatch(/3 decimals/)
  })

  it('lists mask, default and label problems', () => {
    const w = fitWarnings({
      column: col({ max_length: 8 }),
      mask: '(###) ###-####',
      defaultValue: 'a value longer than eight',
      label: 'x'.repeat(60),
      span: 3
    })
    expect(w.map((x) => x.key)).toEqual(['mask', 'default', 'label'])
    expect(fitWarnings({ column: null, label: 'Name', span: 3 })).toEqual([])
    expect(
      fitWarnings({ column: null, label: 'x'.repeat(60), span: 3, layoutType: 'table' })
    ).toEqual([])
  })
})
