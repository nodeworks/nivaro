import { describe, expect, it } from 'vitest'
import { m2mAsksServer, narrowM2MOptions } from './M2MCombobox'

// army8 b09: typing "2026" in the Funding Year picker showed "No results"
// though 2026 was listed — the server's text search never reads a
// number-keyed row's label. A list that fits one page is narrowed here.
describe('narrowM2MOptions', () => {
  const years = [2027, 2026, 2025, 2017].map((id) => ({ id }))
  const label = (o: { id: number }) => String(o.id)

  it('narrows a fully read list by its labels', () => {
    expect(narrowM2MOptions(years, '2026', true, label)).toEqual([{ id: 2026 }])
    expect(narrowM2MOptions(years, '20', true, label)).toHaveLength(4)
    expect(narrowM2MOptions(years, ' ', true, label)).toHaveLength(4)
  })

  it('leaves a server-searched list as the server answered it', () => {
    expect(narrowM2MOptions(years, '2026', false, label)).toHaveLength(4)
  })
})

// army8 review M2: a short list narrowed by label alone lost the server's
// search fields (an Expenditure Type typed by its Oracle code).
describe('m2mAsksServer', () => {
  const types = [
    { id: 1, name: 'Fiber Materials', code: '6110' },
    { id: 2, name: 'Labor', code: '6200' }
  ]
  const label = (o: { name: string }) => o.name

  it('keeps a label match local', () => {
    expect(m2mAsksServer(types, 'fiber', label)).toBe(false)
  })

  it('asks the server when no label matches', () => {
    expect(m2mAsksServer(types, '6110', label)).toBe(true)
  })

  it('never asks for blank text; always for a list past one page or not read yet', () => {
    expect(m2mAsksServer(types, '  ', label)).toBe(false)
    expect(m2mAsksServer(undefined, 'x', label)).toBe(true)
    const big = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Row ${i}`, code: '' }))
    expect(m2mAsksServer(big, 'Row 1', label)).toBe(true)
  })
})
