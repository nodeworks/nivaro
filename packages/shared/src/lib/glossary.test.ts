import { describe, expect, it } from 'vitest'
import { type GlossaryTerm, glossarySegments, glossaryTip } from './glossary'

const term = (id: number, t: string, extra: Partial<GlossaryTerm> = {}): GlossaryTerm => ({
  id,
  term: t,
  slug: t.toLowerCase().replace(/\W+/g, '-'),
  aliases: [],
  definition: `${t} defined`,
  query_slug: null,
  query_note: null,
  collection: null,
  updated_at: null,
  ...extra
})

describe('glossarySegments (#1899 / #1997)', () => {
  const terms = [
    term(1, 'Open'),
    term(2, 'Open unbilled'),
    term(3, 'Held', { aliases: ['on hold'] }),
    term(4, 'Committed', { collection: 'budgets' })
  ]

  it('marks whole words, longest first, aliases included', () => {
    const segs = glossarySegments('3 are open unbilled, 2 on hold; reopened 1', terms)
    expect(segs.filter((s) => s.term).map((s) => [s.text, s.term?.id])).toEqual([
      ['open unbilled', 2],
      ['on hold', 3]
    ])
    expect(segs.map((s) => s.text).join('')).toBe('3 are open unbilled, 2 on hold; reopened 1')
  })

  it('marks each term once when a shared set is passed', () => {
    const once = new Set<number>()
    const a = glossarySegments('Held and held', terms, { once })
    const b = glossarySegments('held again', terms, { once })
    expect(a.filter((s) => s.term)).toHaveLength(1)
    expect(b.filter((s) => s.term)).toHaveLength(0)
  })

  it('skips a term scoped to another collection on labels', () => {
    expect(glossarySegments('Committed', terms, { collection: 'invoices' })[0].term).toBeUndefined()
    expect(glossarySegments('Committed', terms, { collection: 'budgets' })[0].term?.id).toBe(4)
    expect(glossarySegments('Committed', terms)[0].term?.id).toBe(4)
  })

  it('returns the text untouched without terms', () => {
    expect(glossarySegments('anything', [])).toEqual([{ text: 'anything' }])
  })

  it('tips carry the rule', () => {
    expect(glossaryTip(term(5, 'Held', { query_note: 'is_on_hold = 1' }))).toBe(
      'Held: Held defined (is_on_hold = 1)'
    )
  })
})
