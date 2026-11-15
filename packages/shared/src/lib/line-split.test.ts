import { describe, expect, it } from 'vitest'
import {
  canOfferLineSplit,
  lineSplitBlocker,
  lineSplitPath,
  lineSplitRelations
} from './line-split'

describe('line split switch (client twin)', () => {
  it('is off unless enabled with relations', () => {
    expect(lineSplitRelations(null)).toEqual([])
    expect(lineSplitRelations({ line_split: { relations: ['a.b'] } })).toEqual([])
    expect(lineSplitRelations({ line_split: { enabled: true } })).toEqual([])
  })

  it('reads object or JSON text and drops malformed names', () => {
    const bc = JSON.stringify({
      line_split: { enabled: true, relations: ['lines.request', 'bad', 'lines.request', 1] }
    })
    expect(lineSplitRelations(bc)).toEqual(['lines.request'])
    expect(canOfferLineSplit(bc, 'lines', 'request')).toBe(true)
    expect(canOfferLineSplit(bc, 'notes', 'request')).toBe(false)
  })

  it('says why the ticked lines cannot move yet', () => {
    const base = { selectedSaved: 2, selectedUnsaved: 0, totalSaved: 5, unsavedEdits: false }
    expect(lineSplitBlocker(base)).toBeNull()
    expect(lineSplitBlocker({ ...base, selectedUnsaved: 1 })).toMatch(/Save the new lines/)
    expect(lineSplitBlocker({ ...base, unsavedEdits: true })).toMatch(/Save your line changes/)
    expect(lineSplitBlocker({ ...base, selectedSaved: 0 })).toMatch(/Tick/)
    expect(lineSplitBlocker({ ...base, selectedSaved: 5 })).toMatch(/at least one line/)
  })

  it('encodes the path', () => {
    expect(lineSplitPath('requests', 'a b')).toBe('/record-split/requests/a%20b')
  })
})
