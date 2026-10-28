import { describe, expect, it } from 'vitest'
import {
  expandTokens,
  highlightParts,
  matchesSearch,
  searchRankTier,
  searchRankWords,
  tokenize
} from './search-text'
import { matchesAllTokens } from './utils'

const marked = (text: string, q: string, synonyms?: string[][]) =>
  highlightParts(text, q, { synonyms })
    .map((p) => (p.match ? `[${p.text}]` : p.text))
    .join('')

describe('tokenize', () => {
  it('splits words, folds case + accents, keeps quoted phrases, dedupes', () => {
    expect(tokenize('  Café  FIBER fiber ')).toEqual(['cafe', 'fiber'])
    expect(tokenize('"patch  cord" lc')).toEqual(['patch cord', 'lc'])
    expect(tokenize('')).toEqual([])
    expect(tokenize(null)).toEqual([])
    expect(tokenize('""')).toEqual([])
  })
})

describe('matchesSearch', () => {
  it('agrees with matchesAllTokens on plain text', () => {
    const cases: Array<[string, string]> = [
      ['Robert Lee', 'robert lee'],
      ['Robert Lee', 'lee rob'],
      ['Robert Lee', 'robert x'],
      ['anything', '   '],
      ['CABLE, FIBER LC/UPC', 'lc fiber']
    ]
    for (const [t, q] of cases) expect(matchesSearch(t, q)).toBe(matchesAllTokens(t, q))
  })

  it('folds accents and honours synonyms', () => {
    expect(matchesSearch('Résumé', 'resume')).toBe(true)
    expect(matchesSearch('Purchase order 12', 'po 12')).toBe(false)
    expect(
      matchesSearch('Purchase order 12', 'po 12', { synonyms: [['po', 'purchase order']] })
    ).toBe(true)
  })
})

describe('expandTokens', () => {
  it('adds the other words of a shared group, token first', () => {
    expect(expandTokens(['po', 'x'], [['PO', 'Purchase Order']])).toEqual([
      ['po', 'purchase order'],
      ['x']
    ])
    expect(expandTokens(['a'])).toEqual([['a']])
  })
})

describe('highlightParts', () => {
  it('marks every token, case-insensitively', () => {
    expect(marked('Fiber Jumper LC-LC', 'lc fiber')).toBe('[Fiber] Jumper [LC]-[LC]')
  })

  it('merges overlapping matches and maps folded indices back', () => {
    expect(marked('abcabc', 'abc bca')).toBe('[abcabc]')
    expect(marked('Café crème', 'cafe creme')).toBe('[Café] [crème]')
  })

  it('marks synonyms and returns one plain part when nothing matches', () => {
    expect(marked('Purchase Order 9', 'po', [['po', 'purchase order']])).toBe('[Purchase Order] 9')
    expect(highlightParts('Plain', 'zzz')).toEqual([{ text: 'Plain', match: false }])
    expect(highlightParts('Plain', '')).toEqual([{ text: 'Plain', match: false }])
    expect(highlightParts('', 'x')).toEqual([])
  })
})

describe('searchRankTier (twin of api search_rank)', () => {
  it('exact primary, exact other, prefix primary, prefix other, word starts, other', () => {
    expect(searchRankTier(['1002', 'Cable'], '1002')).toBe(0)
    expect(searchRankTier(['9', '1002'], ' 1002 ')).toBe(1)
    expect(searchRankTier(['10021', 'Cable'], '1002')).toBe(2)
    expect(searchRankTier(['9', '1002 kit'], '1002')).toBe(3)
    expect(searchRankTier(['9', 'CABLE,FIBER LC'], 'fiber cab')).toBe(4)
    expect(searchRankTier(['9', 'subfiber'], 'fiber')).toBe(5)
    expect(searchRankTier(['9', null, { x: 1 }], 'fiber')).toBe(5)
    expect(searchRankTier(['9'], '')).toBe(5)
  })

  it('caps words at five like the server', () => {
    expect(searchRankWords('a b c d e f a')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
