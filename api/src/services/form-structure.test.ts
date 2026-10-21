import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type PdfFieldIn, readGroupStructure, shapePdfFields } from './form-structure.js'

// #2697 rows, #2698 fold, #2700 empty text on the PDF.

const f = (field: string, value: string, over: Partial<PdfFieldIn> = {}): PdfFieldIn => ({
  field,
  label: field[0].toUpperCase() + field.slice(1),
  value,
  empty: value === '—',
  folded: false,
  ...over
})

const swap = JSON.stringify({
  enabled: false,
  row_groups: [{ key: 'row', label: 'Address', fields: ['street', 'city', 'zip'] }],
  empty_text: 'No shipping details yet'
})

describe('shapePdfFields', () => {
  it('prints a row as one value under its label, empty members left out', () => {
    const out = shapePdfFields(
      [f('name', 'Acme'), f('street', '12 Main St'), f('city', '—'), f('zip', '02134')],
      swap
    )
    expect(out).toEqual([
      { label: 'Name', value: 'Acme' },
      { label: 'Address', value: '12 Main St · 02134' }
    ])
  })

  it('leaves out empty folded fields and keeps filled ones', () => {
    const out = shapePdfFields(
      [f('name', 'Acme'), f('po', '—', { folded: true }), f('ref', 'R-1', { folded: true })],
      null
    )
    expect(out.map((x) => x.label)).toEqual(['Name', 'Ref'])
  })

  it('prints the empty-section text when nothing is filled', () => {
    expect(shapePdfFields([f('street', '—'), f('city', '—')], swap)).toEqual([
      { label: '', value: 'No shipping details yet', hideLabel: true }
    ])
    // A child table counts as filled.
    expect(
      shapePdfFields(
        [f('street', '—'), f('lines', '<table></table>', { rawHtml: true, empty: false })],
        swap
      )
    ).toHaveLength(2)
  })

  it('reads the same keys as the shared module', () => {
    expect(readGroupStructure(swap)).toEqual({
      sticky: false,
      emptyText: 'No shipping details yet',
      rows: [{ key: 'row', label: 'Address', fields: ['street', 'city', 'zip'] }]
    })
    const here = dirname(fileURLToPath(import.meta.url))
    const shared = readFileSync(
      resolve(here, '../../../packages/shared/src/lib/form-structure.ts'),
      'utf8'
    )
    for (const key of ["'row_groups'", "'empty_text'", "'fold'", "'sticky'"])
      expect(shared).toContain(key)
  })
})
