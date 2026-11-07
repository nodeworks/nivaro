import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import {
  cleanTerms,
  coveredBy,
  expandSearch,
  fitExpansion,
  patternCount,
  phraseAlternatives,
  type SynonymGroup,
  splitJoinedReading,
  synonymIndex,
  withSplitReading
} from '../../../services/search-synonyms.js'

const groups: SynonymGroup[] = [
  { id: 1, terms: ['po', 'purchase order'], collection: null },
  { id: 2, terms: ['laptop', 'notebook'], collection: 'assets' },
  { id: 3, terms: ['vendor', 'supplier'], collection: null }
]

describe('cleanTerms', () => {
  it('lower-cases, trims, dedupes and needs two words', () => {
    expect(cleanTerms([' PO ', 'Purchase  Order', 'po'])).toEqual(['po', 'purchase order'])
    expect(cleanTerms('a, b')).toEqual(['a', 'b'])
    expect(cleanTerms(['only'])).toBeNull()
    expect(cleanTerms(['x', 'X'])).toBeNull()
  })
})

describe('synonymIndex', () => {
  it('applies collection groups only to their collection', () => {
    expect(synonymIndex(groups, 'assets').get('laptop')).toEqual(['notebook'])
    expect(synonymIndex(groups, 'workflows').get('laptop')).toBeUndefined()
    expect(synonymIndex(groups, null).get('laptop')).toBeUndefined()
    expect(synonymIndex(groups, null).get('po')).toEqual(['purchase order'])
  })
})

describe('expandSearch', () => {
  const idx = synonymIndex(groups, null)

  it('is the search as typed when nothing applies', () => {
    expect(expandSearch('Robert Lee', idx)).toEqual([[['Robert'], ['Lee']]])
  })

  it('widens a single word to its group, typed word first', () => {
    expect(expandSearch('PO 123', idx)).toEqual([[['PO', 'purchase order'], ['123']]])
  })

  it('adds a reading where a multi-word term is one slot', () => {
    expect(expandSearch('acme purchase order', idx)).toEqual([
      [['acme'], ['purchase'], ['order']],
      [['acme'], ['purchase order', 'po']]
    ])
  })
})

describe('fitExpansion', () => {
  it('drops extra readings, then alternatives, never the typed words', () => {
    const v = [[['a', 'b', 'c'], ['d']], [['x', 'y']]]
    expect(patternCount(v)).toBe(6)
    expect(fitExpansion(v, 1, 10)).toEqual(v)
    expect(fitExpansion(v, 1, 4)).toEqual([[['a', 'b', 'c'], ['d']]])
    expect(fitExpansion(v, 1, 2)).toEqual([[['a'], ['d']]])
    expect(fitExpansion(v, 10, 1)).toEqual([[['a'], ['d']]])
  })
})

describe('phraseAlternatives', () => {
  const idx = synonymIndex(groups, null)
  it('lists the typed phrase first, then one substitution at a time', () => {
    expect(phraseAlternatives('PO 123', idx)).toEqual(['PO 123', 'purchase order 123'])
    expect(phraseAlternatives('purchase order', idx)).toEqual(['purchase order', 'po'])
    expect(phraseAlternatives('acme vendor', idx)).toEqual(['acme vendor', 'acme supplier'])
    expect(phraseAlternatives('nothing here', idx)).toEqual(['nothing here'])
  })
})

describe('coveredBy', () => {
  it('finds the group a search falls under, in its own scope', () => {
    expect(coveredBy(groups, 'PO', null)?.id).toBe(1)
    expect(coveredBy(groups, 'acme supplier', 'workflows')?.id).toBe(3)
    expect(coveredBy(groups, 'laptop', 'assets')?.id).toBe(2)
    expect(coveredBy(groups, 'laptop', null)).toBeNull()
    expect(coveredBy(groups, 'desk', 'assets')).toBeNull()
  })
})

describe('splitJoinedReading', () => {
  it('splits a joined code into one slot per part', () => {
    expect(splitJoinedReading('2026-NNO-POWER')).toEqual([['2026'], ['NNO'], ['POWER']])
    expect(splitJoinedReading('acme po_12/bb')).toEqual([['acme'], ['po'], ['12'], ['bb']])
  })

  it('skips parts under 2 characters (R7 review)', () => {
    expect(splitJoinedReading('acme po_12/b')).toEqual([['acme'], ['po'], ['12']])
    expect(splitJoinedReading('NNO-A-POWER')).toEqual([['NNO'], ['POWER']])
  })

  it('is null when no word has a joiner inside it, or the split adds nothing', () => {
    expect(splitJoinedReading('Robert Lee')).toBeNull()
    expect(splitJoinedReading('- x')).toBeNull()
    expect(splitJoinedReading('')).toBeNull()
    // only one part of 2+ characters left: the word stays as typed
    expect(splitJoinedReading('A-1')).toBeNull()
    expect(splitJoinedReading('PW26-7 acme')).toBeNull()
  })

  it('reads the parts as every-word-must-match (the LIKE side of items search)', () => {
    const reading = splitJoinedReading('2026-NNO-POWER') ?? []
    const label = '2026-WEST-NNO-HE-POWERING'.toLowerCase()
    expect(reading.every((slot) => slot.some((w) => label.includes(w.toLowerCase())))).toBe(true)
  })
})

describe('withSplitReading (R7 review)', () => {
  const idx = synonymIndex(groups, null)

  it('comes after the typed reading AND the multi-word synonym readings', () => {
    const variants = expandSearch('purchase order 2026-NNO-POWER', idx)
    expect(variants).toHaveLength(2) // typed + "purchase order" | "po"
    const out = withSplitReading(variants, 'purchase order 2026-NNO-POWER')
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual(variants[0])
    expect(out[1]).toEqual(variants[1])
    expect(out[2].map((s) => s[0])).toEqual(['purchase', 'order', '2026', 'NNO', 'POWER'])
  })

  it('is the first reading the parameter budget gives up', () => {
    const out = withSplitReading(expandSearch('po 2026-NNO-POWER', idx), 'po 2026-NNO-POWER')
    const fitted = fitExpansion(out, 1, patternCount(out) - 1)
    expect(fitted).toHaveLength(out.length - 1)
    expect(fitted.some((v) => v.some((s) => s[0] === 'NNO'))).toBe(false)
  })

  it('adds nothing when the search does not split', () => {
    const v = expandSearch('PW26-7', idx)
    expect(withSplitReading(v, 'PW26-7')).toBe(v)
    expect(withSplitReading([], '2026-NNO-POWER')).toEqual([])
  })
})
