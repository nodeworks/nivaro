import { describe, expect, it } from 'vitest'
import {
  clusterDocsMisses,
  type DataGuide,
  type GlossaryEntry,
  glossarySlug,
  guidesForQuestion,
  matchGlossary,
  normalizeGlossaryInput,
  normalizeGuideInput
} from '../../../services/ai-knowledge.js'
import {
  extractJsonArray,
  parseGlossaryDrafts,
  parseGuideDrafts,
  suggestionFingerprint
} from '../../../services/ai-knowledge-suggest.js'
import { type DocsIndexSection, loadDocsIndex, rankDocs } from '../../../services/docs-search.js'

// Migration 434: Ask AI's docs search (#1803), data guides (#1847), docs gaps
// (#1855), suggestions (#1898 / #1949) and the glossary (#1899).

const index: DocsIndexSection[] = [
  {
    id: 'bulk-actions',
    label: 'Bulk Actions',
    group: 'user-guide',
    group_label: 'User Guide',
    audience: 'all',
    blocks: [
      {
        h: 'Selecting rows',
        t: 'Tick rows in a collection list, then pick Delete or Update Field.'
      },
      { h: 'Transition', t: 'Move many records to another workflow state at once.' }
    ]
  },
  {
    id: 'api-keys',
    label: 'API Keys',
    group: 'security',
    group_label: 'Security',
    audience: 'admin',
    blocks: [{ h: 'Rotating a key', t: 'Create a new key, then revoke the old token.' }]
  }
]

describe('rankDocs (#1803)', () => {
  it('finds the section and quotes the passage under its heading', () => {
    const r = rankDocs(index, 'how do I update many rows at once', { admin: false })
    expect(r.hits[0]?.id).toBe('bulk-actions')
    expect(r.hits[0]?.cite).toBe('[Docs: Bulk Actions](/docs?section=bulk-actions)')
    expect(r.hits[0]?.snippet.length).toBeGreaterThan(0)
  })

  it('leaves admin sections out for non-admins', () => {
    expect(rankDocs(index, 'rotate api key', { admin: false }).hits).toHaveLength(0)
    expect(rankDocs(index, 'rotate api key', { admin: true }).hits[0]?.id).toBe('api-keys')
  })

  it('says a question is not answered when few searched words are found', () => {
    const r = rankDocs(index, 'export the gantt chart to excel', { admin: true })
    expect(r.answered).toBe(false)
  })

  it('caps the limit at 5', () => {
    expect(rankDocs(index, 'rows', { admin: true, limit: 50 }).hits.length).toBeLessThanOrEqual(5)
  })

  it('loads the generated index', async () => {
    const sections = await loadDocsIndex()
    expect(sections.length).toBeGreaterThan(50)
    expect(sections.every((s) => s.audience === 'all' || s.audience === 'admin')).toBe(true)
  })
})

const entry = (id: number, term: string, aliases: string[] = []): GlossaryEntry => ({
  id,
  term,
  slug: glossarySlug(term),
  aliases,
  definition: `${term} means something`,
  query_slug: null,
  query_note: null,
  collection: null,
  updated_at: null
})

describe('glossary (#1899)', () => {
  it('slugs a term', () => {
    expect(glossarySlug("PUB'd  Projects")).toBe('pub-d-projects')
  })

  it('matches whole words, longest form first, aliases included', () => {
    const entries = [entry(1, 'open'), entry(2, 'open unbilled'), entry(3, 'held', ['on hold'])]
    const hit = matchGlossary('Which invoices are open unbilled or on hold? Opening hours', entries)
    expect(hit.map((e) => e.id)).toEqual([2, 3])
  })

  it('validates input', () => {
    expect(normalizeGlossaryInput({ term: '', definition: 'x' }).ok).toBe(false)
    expect(normalizeGlossaryInput({ term: 'Held', definition: '' }).ok).toBe(false)
    expect(
      normalizeGlossaryInput({ term: 'Held', definition: 'x', query_slug: 'bad slug!' }).ok
    ).toBe(false)
    const v = normalizeGlossaryInput({
      term: '  Held ',
      definition: 'On hold.',
      aliases: ['held', 'On hold', 'on hold']
    })
    expect(v.ok && v.value.term).toBe('Held')
    expect(v.ok && v.value.aliases).toEqual(['On hold'])
  })
})

describe('data guides (#1847)', () => {
  const guides: DataGuide[] = [
    {
      collection: 'forecasts',
      hints: 'One row per workflow and year.',
      examples: [],
      updated_at: null
    },
    {
      collection: 'invoices',
      hints: null,
      examples: ['which vendors have unpaid bills'],
      updated_at: null
    },
    { collection: 'secret_things', hints: 'x', examples: [], updated_at: null }
  ]
  const readable = [
    { collection: 'forecasts', display_name: 'Forecasts' },
    { collection: 'invoices', display_name: null }
  ]

  it('picks a guide by its collection name in singular form', () => {
    expect(
      guidesForQuestion('total forecast for 2026', guides, readable).map((g) => g.collection)
    ).toEqual(['forecasts'])
  })

  it('picks a guide by an example question', () => {
    expect(
      guidesForQuestion('vendors with unpaid bills', guides, readable).map((g) => g.collection)
    ).toEqual(['invoices'])
  })

  it('never sends the guide of a collection the asker cannot read', () => {
    expect(guidesForQuestion('secret things', guides, readable)).toEqual([])
  })

  it('validates guide input', () => {
    expect(normalizeGuideInput({ examples: 'nope' }).ok).toBe(false)
    const v = normalizeGuideInput({ hints: '  a  ', examples: ['q1', 'q1', ' '] })
    expect(v.ok && v.value).toEqual({ hints: 'a', examples: ['q1'] })
  })
})

describe('docs gaps (#1855)', () => {
  it('groups overlapping questions into one topic with counts', () => {
    const topics = clusterDocsMisses([
      { id: 1, query: 'export gantt chart', user: 'a', created_at: '2026-10-01T00:00:00Z' },
      { id: 2, query: 'gantt chart export', user: 'b', created_at: '2026-10-02T00:00:00Z' },
      { id: 3, query: 'reset my password', user: 'a', created_at: '2026-10-03T00:00:00Z' }
    ])
    expect(topics[0].count).toBe(2)
    expect(topics[0].people).toBe(2)
    expect(topics[0].ids.sort()).toEqual([1, 2])
    expect(topics).toHaveLength(2)
  })
})

describe('suggestions (#1898 / #1949)', () => {
  it('pulls the JSON array out of a fenced reply', () => {
    expect(extractJsonArray('Here:\n```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
    expect(extractJsonArray('no json')).toEqual([])
  })

  it('turns an invented collection into a global guide line', () => {
    const d = parseGuideDrafts(
      [
        { collection: 'forecasts', text: 'Forecasts are one row per workflow and year.' },
        { collection: 'made_up', text: 'Committed means a PO exists.' },
        { text: 'short' }
      ],
      new Set(['forecasts'])
    )
    expect(d.map((x) => x.collection)).toEqual(['forecasts', null])
  })

  it('skips terms already defined and duplicates', () => {
    const d = parseGlossaryDrafts(
      [
        { term: 'Held', definition: 'An invoice with is_on_hold set.' },
        { term: 'held', definition: 'dup' },
        { term: 'Committed', definition: 'Has a PO.' }
      ],
      new Set(),
      new Set(['committed'])
    )
    expect(d.map((x) => x.term)).toEqual(['Held'])
  })

  it('fingerprints ignore case and punctuation', () => {
    expect(suggestionFingerprint('guide', null, 'Held, means X.')).toBe(
      suggestionFingerprint('guide', null, 'held means x')
    )
    expect(suggestionFingerprint('guide', 'a', 'x')).not.toBe(
      suggestionFingerprint('guide', null, 'x')
    )
  })
})
