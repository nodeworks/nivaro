import { describe, expect, it } from 'vitest'
import { isSamePick } from './RelationCombobox'
import { summaryPlainText } from './SummaryPanel'

// Army 2026-11-05 (a02-9): a plain MWF ID `<b>x</b>` read literally on the
// form but `x` in the Summary rail.
describe('summaryPlainText', () => {
  it('leaves a plain text field to show exactly what was typed', () => {
    expect(summaryPlainText('<b>x</b>', 'input')).toBeNull()
    expect(summaryPlainText('A & B "quoted"', 'input')).toBeNull()
    expect(summaryPlainText('<b>x</b>', '')).toBeNull()
  })

  it('flattens a rich-text field to its words', () => {
    expect(summaryPlainText('<p>Hello <b>there</b></p>', 'input-rich-text-html')).toBe(
      'Hello there'
    )
  })

  it('still reads a legacy EditorJS blob as words in any field', () => {
    const blob = JSON.stringify({ blocks: [{ type: 'paragraph', data: { text: 'Old note' } }] })
    expect(summaryPlainText(blob, 'input')).toBe('Old note')
  })

  it('is null for a non-string value', () => {
    expect(summaryPlainText(5, 'input')).toBeNull()
    expect(summaryPlainText(null, 'input-rich-text-html')).toBeNull()
  })
})

// Army 2026-11-05 (a01-11): re-picking the selected Project Type cleared the
// Sub Type it had filled.
describe('isSamePick', () => {
  it('is the current value whatever its id type', () => {
    expect(isSamePick(2, 2)).toBe(true)
    expect(isSamePick('2', 2)).toBe(true)
    expect(isSamePick(2, '2')).toBe(true)
  })
  it('is never a pick into or from an empty field, or a different option', () => {
    expect(isSamePick(null, 2)).toBe(false)
    expect(isSamePick('', 2)).toBe(false)
    expect(isSamePick(undefined, 2)).toBe(false)
    expect(isSamePick(2, null)).toBe(false)
    expect(isSamePick(2, 3)).toBe(false)
  })
})
