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
  synonymIndex
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
