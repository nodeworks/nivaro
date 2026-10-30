import { describe, expect, it } from 'vitest'
import {
  bestUnwatched,
  type ContextRow,
  mentionedTerm,
  rankScreenVideos,
  screenKeys,
  type VideoFacts
} from './help-video-match.js'

const fact = (id: string, over: Partial<VideoFacts> = {}): VideoFacts => ({
  id,
  title: `Video ${id}`,
  description: null,
  category: null,
  required: false,
  forMyRole: false,
  viewers: 0,
  updatedAt: 0,
  ...over
})
const facts = (...list: VideoFacts[]) => new Map(list.map((f) => [f.id.toLowerCase(), f]))

describe('screenKeys', () => {
  it('derives screen, pattern, area, collection and record from an admin path', () => {
    expect(screenKeys({ path: '/collections/inventory_request/1234' })).toEqual({
      exact: ['admin.collections.inventory_request'],
      patterns: ['admin.collections.:c'],
      areas: ['admin.collections'],
      collection: 'inventory_request',
      item: '1234'
    })
  })

  it('reads an efp-new page key the same way', () => {
    const k = screenKeys({ page: 'efp.records.purchase_orders' })
    expect(k.exact).toEqual(['efp.records.purchase_orders'])
    expect(k.patterns).toEqual(['efp.records.:c'])
    expect(k.areas).toEqual(['efp.records'])
    expect(k.collection).toBe('purchase_orders')
  })

  it('hub tabs share their hub as the area', () => {
    const k = screenKeys({ path: '/jobs/timeline' })
    expect(k.exact).toEqual(['admin.jobs.timeline'])
    expect(k.areas).toEqual(['admin.jobs'])
    expect(k.collection).toBeNull()
  })
})

describe('rankScreenVideos', () => {
  const keys = screenKeys({ path: '/collections/inventory_request/12' })
  const rows: ContextRow[] = [
    { video_id: 'AREA', kind: 'page', key: 'admin.collections.other_thing', state_key: null },
    { video_id: 'COL', kind: 'collection', key: 'inventory_request', state_key: null },
    { video_id: 'STATE', kind: 'collection', key: 'inventory_request', state_key: 'review' },
    { video_id: 'OTHERSTATE', kind: 'collection', key: 'inventory_request', state_key: 'done' },
    { video_id: 'PAT', kind: 'page', key: 'admin.collections.:c', state_key: null },
    { video_id: 'EXACT', kind: 'page', key: 'admin.collections.inventory_request', state_key: null }
  ]
  const all = facts(
    fact('AREA'),
    fact('COL'),
    fact('STATE'),
    fact('OTHERSTATE'),
    fact('PAT'),
    fact('EXACT'),
    fact('TERM', { title: 'How to fill the CIFA form' })
  )

  it('orders state → screen → pattern → collection → area → term, dropping other states', () => {
    const ranked = rankScreenVideos(rows, keys, { state: 'review', terms: ['CIFA'] }, all)
    expect(ranked.map((m) => m.id)).toEqual(['STATE', 'EXACT', 'PAT', 'COL', 'AREA', 'TERM'])
    expect(ranked.map((m) => m.tier)).toEqual([0, 1, 2, 3, 4, 5])
    expect(ranked[5].reason).toBe('Mentions CIFA')
  })

  it('within a tier: required for my role, then made for my role, then popular, then newest', () => {
    const r: ContextRow[] = ['A', 'B', 'C', 'D', 'E'].map((id) => ({
      video_id: id,
      kind: 'collection',
      key: 'inventory_request',
      state_key: null
    }))
    const f = facts(
      fact('A', { viewers: 50 }),
      fact('B', { required: true }),
      fact('C', { forMyRole: true }),
      fact('D', { viewers: 50, updatedAt: 10 }),
      fact('E', { viewers: 5 })
    )
    expect(rankScreenVideos(r, keys, {}, f).map((m) => m.id)).toEqual(['B', 'C', 'D', 'A', 'E'])
  })

  it('leaves out videos the caller may not see (no facts)', () => {
    const ranked = rankScreenVideos(rows, keys, { state: 'review' }, facts(fact('COL')))
    expect(ranked.map((m) => m.id)).toEqual(['COL'])
  })
})

describe('mentionedTerm', () => {
  it('matches whole words and plurals only', () => {
    expect(mentionedTerm({ title: 'Submitting IRs', description: null }, ['IR'])).toBe('IR')
    expect(mentionedTerm({ title: 'Stirring things', description: null }, ['IR'])).toBeNull()
  })
})

describe('bestUnwatched', () => {
  const ranked = [
    { id: 'DONE', tier: 1 as const, reason: '' },
    { id: 'WAIT', tier: 1 as const, reason: '' },
    { id: 'NEXT', tier: 3 as const, reason: '' },
    { id: 'WEAK', tier: 4 as const, reason: '' }
  ]
  it('offers the best strong match not finished and ready to play', () => {
    const watch = (id: string) =>
      ({
        DONE: { completed: true, ready: true },
        WAIT: { completed: false, ready: false },
        NEXT: { completed: false, ready: true },
        WEAK: { completed: false, ready: true }
      })[id]
    expect(bestUnwatched(ranked, watch)?.id).toBe('NEXT')
  })
  it('never offers a weak (area / term) match', () => {
    expect(bestUnwatched(ranked.slice(3), () => ({ completed: false, ready: true }))).toBeNull()
  })
})
