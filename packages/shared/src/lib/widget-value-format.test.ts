import { describe, expect, it } from 'vitest'
import { affixesFor, formatWidgetValue } from './widget-value-format'

describe('formatWidgetValue', () => {
  it('renders null as a dash whatever the format', () => {
    expect(formatWidgetValue(null, 'percent')).toBe('—')
    expect(formatWidgetValue(undefined, 'currency')).toBe('—')
  })
  it('renders percent on the 0–100 scale with one decimal', () => {
    expect(formatWidgetValue(83.2, 'percent')).toBe('83.2%')
    expect(formatWidgetValue(100, 'percent')).toBe('100.0%')
    expect(formatWidgetValue(-4.26, 'percent')).toBe('-4.3%')
  })
  it('keeps currency at two decimals and integer whole', () => {
    expect(formatWidgetValue(1234.5, 'currency')).toBe('1,234.50')
    expect(formatWidgetValue(12.6, 'integer')).toBe('13')
  })
  it('passes strings through', () => {
    expect(formatWidgetValue('n/a', 'percent')).toBe('n/a')
  })
})

describe('affixesFor', () => {
  it('drops the prefix and suffix when the value is missing', () => {
    expect(affixesFor(null, { prefix: '$', suffix: ' USD' })).toEqual({ prefix: '', suffix: '' })
    expect(affixesFor(undefined, { prefix: '$' })).toEqual({ prefix: '', suffix: '' })
  })
  it('keeps them around a real value, zero included', () => {
    expect(affixesFor(0, { prefix: '$', suffix: '%' })).toEqual({ prefix: '$', suffix: '%' })
    expect(affixesFor(12, undefined)).toEqual({ prefix: '', suffix: '' })
  })
})
