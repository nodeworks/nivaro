import { describe, expect, it } from 'vitest'
import {
  fuzzyChunks,
  isIdColumn,
  isNumericIdColumn,
  learnedBoost,
  looksLikeId,
  matchTier,
  rankHits,
  scoreHit,
  similarity,
  wantsFuzzy
} from '../../../services/search-rank.js'

describe('matchTier', () => {
  it('equal > prefix > word > contains, case-insensitive, across synonym forms', () => {
    expect(matchTier('Canton', ['canton'])).toBe('equal')
    expect(matchTier('Canton grounding', ['canton'])).toBe('prefix')
    expect(matchTier('North Canton', ['canton'])).toBe('word')
    expect(matchTier('Cantonese', ['tone'])).toBe('contains')
    expect(matchTier('Purchase order 9', ['po', 'purchase order'])).toBe('prefix')
    expect(matchTier('nothing', ['canton'])).toBeNull()
    expect(matchTier({ a: 1 }, ['a'])).toBeNull()
  })
})

describe('scoreHit / rankHits', () => {
  const s = (h: Parameters<typeof scoreHit>[0]) => scoreHit(h)

  it('exact id > equal > prefix > contains > near spelling', () => {
    const order = [
      s({ tier: 'exact' }),
      s({ tier: 'equal' }),
      s({ tier: 'prefix' }),
      s({ tier: 'word' }),
      s({ tier: 'contains' }),
      s({ tier: 'fuzzy', similarity: 1 })
    ]
    expect([...order].sort((a, b) => b - a)).toEqual(order)
  })

  it('boosts reorder within a band but never lift a contains over a prefix', () => {
    const mineContains = s({ tier: 'contains', mine: true, learned: 50 })
    expect(mineContains).toBeGreaterThan(s({ tier: 'contains' }))
    expect(mineContains).toBeLessThan(s({ tier: 'prefix' }))
    expect(s({ tier: 'prefix', mine: true })).toBeGreaterThan(s({ tier: 'prefix' }))
  })

  it('learned boost grows with distinct people and is capped', () => {
    expect(learnedBoost(0)).toBe(0)
    expect(learnedBoost(1)).toBe(20)
    expect(learnedBoost(3)).toBe(40)
    expect(learnedBoost(1000)).toBe(55)
  })

  it('ranks by score, then the shorter label', () => {
    const hits = rankHits([
      { label: 'Canton grounding long', score: 200 },
      { label: 'Canton', score: 300 },
      { label: 'Canton g', score: 200 }
    ])
    expect(hits.map((h) => h.label)).toEqual(['Canton', 'Canton g', 'Canton grounding long'])
  })
})

describe('id detection', () => {
  it('looksLikeId: one token with a digit', () => {
    for (const q of ['AB26-77260', 'B1234-2', '368808', 'PO-00042', 'B12'])
      expect(looksLikeId(q)).toBe(true)
    for (const q of ['canton', 'canton 12', 'x', '']) expect(looksLikeId(q)).toBe(false)
  })

  it('business id columns, never the FK-ish numeric *_id', () => {
    expect(isIdColumn('workflow_id')).toBe(true)
    expect(isIdColumn('po_number')).toBe(true)
    expect(isIdColumn('id')).toBe(false)
    expect(isIdColumn('name')).toBe(false)
    expect(isNumericIdColumn('po_number')).toBe(true)
    expect(isNumericIdColumn('project_id')).toBe(false)
  })
})

describe('typo tolerance', () => {
  it('scores near spellings high and unrelated words low', () => {
    expect(similarity('cantn', 'Canton grounding')).toBeGreaterThan(0.35)
    expect(similarity('grounidng', 'Canton grounding')).toBeGreaterThan(0.35)
    expect(similarity('vendor', 'Canton grounding')).toBeLessThan(0.2)
  })

  it('chunks are capped and about half must hit', () => {
    expect(fuzzyChunks('cantn')).toEqual({ chunks: ['can', 'ant', 'ntn'], need: 2 })
    const long = fuzzyChunks('extraordinarily complicated')
    expect(long.chunks).toHaveLength(8)
    expect(long.need).toBe(4)
  })

  it('only word queries get a typo pass', () => {
    expect(wantsFuzzy('cantn')).toBe(true)
    expect(wantsFuzzy('AB26-77260')).toBe(false)
    expect(wantsFuzzy('ab')).toBe(false)
  })
})
