import { describe, expect, it } from 'vitest'
import type { DataGuide, GlossaryEntry } from '../../../services/ai-knowledge.js'
import {
  findConflicts,
  findingFingerprint,
  parseAiConflicts,
  referencedNames,
  type SchemaFacts,
  termKey,
  wordOverlap
} from '../../../services/ai-knowledge-check.js'
import {
  clusterQuestions,
  coverageGap,
  keywordName,
  latestQuestion,
  looksUnanswered,
  parseTopicNames,
  roleStats,
  type TopicQuestion
} from '../../../services/ai-topic-map.js'
import { classifyFreshness } from '../../../services/embedding-freshness.js'
import {
  groundSteps,
  inWindow,
  normalizeSteps,
  type RoleContext,
  safePath,
  tick
} from '../../../services/role-checklist.js'

// Migration 472: first-week checklists (#2472), the glossary conflict check
// (#2480), embedding freshness (#2482) and the Ask AI topic map (#2734).

const entry = (id: number, term: string, definition: string, extra: Partial<GlossaryEntry> = {}) =>
  ({
    id,
    term,
    slug: term.toLowerCase().replace(/\W+/g, '-'),
    aliases: [],
    definition,
    query_slug: null,
    query_note: null,
    collection: null,
    updated_at: null,
    ...extra
  }) as GlossaryEntry

const facts: SchemaFacts = {
  fields: new Map([
    ['invoices', new Set(['id', 'amount', 'is_on_hold', 'vendor'])],
    ['vendors', new Set(['id', 'name'])]
  ]),
  querySlugs: new Set(['open-invoices'])
}

describe('conflict check (#2480)', () => {
  it('flags the same word defined two different ways', () => {
    const f = findConflicts(
      [
        entry(1, 'Committed', 'An invoice that has been approved and sent to the ERP'),
        entry(2, 'committed', 'Money set aside in the budget for a project', { aliases: [] })
      ],
      [],
      facts
    )
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe('contradiction')
    expect(f[0].sides.map((s) => s.type)).toEqual(['glossary', 'glossary'])
  })

  it('treats an alias collision as the same word, and singulars as equal', () => {
    expect(termKey('Open Invoices')).toBe(termKey('open invoice'))
    const f = findConflicts(
      [
        entry(1, 'Held', 'An invoice with is_on_hold set', { aliases: ['on hold'] }),
        entry(2, 'On hold', 'Waiting for the vendor to answer')
      ],
      [],
      facts
    )
    expect(f.map((x) => x.kind)).toEqual(['contradiction'])
  })

  it('calls the same word with the same meaning a near-duplicate, not a contradiction', () => {
    const f = findConflicts(
      [
        entry(1, 'Open invoice', 'An invoice that is not yet paid'),
        entry(2, 'Open invoices', 'An invoice that is not yet paid')
      ],
      [],
      facts
    )
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe('near_duplicate')
  })

  it('catches almost-alike spellings with different meanings', () => {
    const f = findConflicts(
      [
        entry(1, 'Forecast', 'Planned spend for a year, entered by the project owner'),
        entry(2, 'Forecasts', 'x'),
        entry(3, 'Forcast', 'A misspelling that should be reported through support')
      ],
      [],
      facts
    )
    expect(f.some((x) => x.kind === 'near_duplicate')).toBe(true)
  })

  it('ignores terms scoped to different collections', () => {
    const f = findConflicts(
      [
        entry(1, 'Status', 'Where an invoice is in review', { collection: 'invoices' }),
        entry(2, 'Status', 'Whether a vendor is active', { collection: 'vendors' })
      ],
      [],
      facts
    )
    expect(f).toHaveLength(0)
  })

  it('finds references to collections, fields and queries that are gone', () => {
    const guides: DataGuide[] = [
      {
        collection: 'invoices',
        hints:
          'Use is_on_hold for held ones. The old invoices.hold_reason is gone. Totals in legacy_totals.',
        examples: [],
        updated_at: null
      },
      { collection: 'removed_things', hints: 'Anything.', examples: [], updated_at: null }
    ]
    const f = findConflicts(
      [entry(1, 'Open', 'Not yet paid', { query_slug: 'gone-query', collection: 'ghosts' })],
      guides,
      facts
    )
    const summaries = f.map((x) => x.summary).join('\n')
    expect(summaries).toMatch(/invoices\.hold_reason/)
    expect(summaries).toMatch(/legacy_totals/)
    expect(summaries).toMatch(/gone-query/)
    expect(summaries).toMatch(/ghosts/)
    expect(summaries).toMatch(/removed_things/)
    expect(summaries).not.toMatch(/is_on_hold/)
    expect(f.every((x) => x.kind === 'dead_reference')).toBe(true)
  })

  it('reads names and dotted pairs out of text', () => {
    const r = referencedNames('Join invoices.vendor to vendors; use is_on_hold')
    expect(r.names).toContain('is_on_hold')
    expect(r.dotted).toContainEqual(['invoices', 'vendor'])
  })

  it('gives one conflict one fingerprint regardless of side order', () => {
    const a = entry(1, 'A term', 'x')
    const b = entry(2, 'B term', 'y')
    const d1 = {
      kind: 'contradiction',
      severity: 'high',
      summary: '',
      key: 'k',
      sides: [
        { type: 'glossary', ref: a.slug, label: 'A' },
        { type: 'glossary', ref: b.slug, label: 'B' }
      ]
    } as const
    const d2 = { ...d1, sides: [...d1.sides].reverse() }
    expect(findingFingerprint(d1 as never)).toBe(findingFingerprint(d2 as never))
  })

  it('takes only terms it sent from the model, and needs a reason', () => {
    const e1 = entry(1, 'Alpha', 'x')
    const e2 = entry(2, 'Beta', 'y')
    const by = new Map([
      ['alpha', e1],
      ['beta', e2]
    ])
    const out = parseAiConflicts(
      [
        { a: 'Alpha', b: 'Beta', why: 'one says 30 days, the other 60' },
        { a: 'Alpha', b: 'Nope', why: 'x' },
        { a: 'Alpha', b: 'Alpha', why: 'x' },
        { a: 'Alpha', b: 'Beta' },
        'junk'
      ],
      by
    )
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('ai_conflict')
  })

  it('measures word overlap', () => {
    expect(wordOverlap('an invoice not paid', 'an invoice not paid')).toBe(1)
    expect(wordOverlap('alpha beta', 'gamma delta')).toBe(0)
  })
})

describe('embedding freshness (#2482)', () => {
  const base = {
    records: 100,
    embedded_rows: 100,
    lag_records: 0,
    oldest_lag_at: null,
    other_provider_rows: 0
  }
  it('is fresh with no lag', () => {
    expect(classifyFreshness(base)).toMatchObject({ status: 'fresh', warn: false })
  })
  it('needs a reindex after a provider switch, whatever the lag', () => {
    expect(classifyFreshness({ ...base, other_provider_rows: 3 })).toMatchObject({
      status: 'needs_reindex',
      warn: true
    })
  })
  it('warns when a share of the records lag, not for a handful', () => {
    expect(
      classifyFreshness({ ...base, lag_records: 2, oldest_lag_at: new Date().toISOString() }).warn
    ).toBe(false)
    expect(
      classifyFreshness({ ...base, lag_records: 12, oldest_lag_at: new Date().toISOString() })
    ).toMatchObject({
      status: 'lagging',
      warn: true
    })
  })
  it('warns when one change has waited over a day', () => {
    const now = Date.now()
    const r = classifyFreshness({
      ...base,
      lag_records: 1,
      oldest_lag_at: new Date(now - 30 * 3_600_000).toISOString(),
      now
    })
    expect(r.warn).toBe(true)
  })
  it('is empty with no records and no vectors', () => {
    expect(classifyFreshness({ ...base, records: 0, embedded_rows: 0 }).status).toBe('empty')
  })
})

describe('topic map (#2734)', () => {
  const q = (id: string, vec: number[], extra: Partial<TopicQuestion> = {}): TopicQuestion => ({
    request_id: id,
    question: `question ${id} about invoices`,
    role: 'Creator',
    unanswered: false,
    thumbs_down: false,
    thumbs_up: false,
    cost: 0.01,
    vec,
    ...extra
  })

  it('groups close questions and splits distant ones', () => {
    const c = clusterQuestions([q('a', [1, 0]), q('b', [0.99, 0.1]), q('c', [0, 1])], 0.9)
    expect(c.map((x) => x.members.length).sort()).toEqual([1, 2])
  })

  it('computes per-role figures', () => {
    const s = roleStats([
      q('a', [1], { role: 'Creator', unanswered: true, cost: 0.02 }),
      q('b', [1], { role: 'Creator', thumbs_down: true, cost: 0.04 }),
      q('c', [1], { role: 'Approver' })
    ])
    const creator = s.find((x) => x.role === 'Creator')!
    expect(creator).toMatchObject({ volume: 2, unanswered_rate: 0.5, thumbs_down_rate: 0.5 })
    expect(creator.avg_cost_usd).toBeCloseTo(0.03)
    expect(s[0].role).toBe('Creator')
  })

  it('points at what is missing only when a topic goes badly and nothing covers it', () => {
    const members = [
      q('a', [1], { unanswered: true }),
      q('b', [1], { thumbs_down: true }),
      q('c', [1])
    ]
    const gap = coverageGap(members, { glossary: 0, guides: 0, playbooks: 0 })
    expect(gap.gap).toBe(true)
    expect(gap.missing).toEqual(['guide', 'glossary', 'playbook'])
    expect(coverageGap(members, { glossary: 0, guides: 2, playbooks: 0 }).gap).toBe(false)
    expect(
      coverageGap([q('a', [1]), q('b', [1])], { glossary: 0, guides: 0, playbooks: 0 }).gap
    ).toBe(false)
  })

  it('judges an answer unanswered by emptiness, a failure or a nothing-found reply', () => {
    expect(looksUnanswered('', false)).toBe(true)
    expect(looksUnanswered('There are 4 open invoices.', false)).toBe(false)
    expect(looksUnanswered('I could not find any matching records.', false)).toBe(true)
    expect(looksUnanswered('Fine', true)).toBe(true)
  })

  it('names a topic from frequent words and parses model names defensively', () => {
    expect(keywordName([q('a', [1]), q('b', [1])])).toMatch(/invoices/i)
    const m = parseTopicNames(
      [
        { i: 0, name: '  Open invoices  ' },
        { i: 9, name: 'Out of range' },
        { i: 1, name: '' },
        null
      ],
      2
    )
    expect([...m.entries()]).toEqual([[0, 'Open invoices']])
  })

  it('reads the latest user turn, not the opener', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
        { role: 'user', content: [{ type: 'text', text: 'second question' }] }
      ]
    })
    expect(latestQuestion(body)).toBe('second question')
  })
})

describe('role checklist (#2472)', () => {
  const vid = '11111111-1111-4111-8111-111111111111'
  const ctx: RoleContext = {
    role_id: 'r',
    role_name: 'Creator',
    collections: [
      { collection: 'invoices', display_name: null, can_write: true },
      { collection: 'vendors', display_name: null, can_write: false }
    ],
    layouts: [],
    queues: [{ id: 'q-1', name: 'Mine' }],
    videos: [{ id: vid, title: 'Welcome', required: true }],
    views: []
  }

  it('keeps paths inside the app', () => {
    expect(safePath('/queues/abc')).toBe('/queues/abc')
    expect(safePath('//evil.example')).toBeNull()
    expect(safePath('https://evil.example')).toBeNull()
    expect(safePath('javascript:alert(1)')).toBeNull()
    expect(safePath('/a b')).toBeNull()
  })

  it('cleans steps: drops incomplete ones, mints unique ids, caps the count', () => {
    const steps = normalizeSteps([
      { kind: 'open', title: 'Open My Work', path: '/my-work' },
      { kind: 'open', title: 'Open My Work', path: '/my-work' },
      { kind: 'video', title: 'Watch', video_id: 'nope' },
      { kind: 'record', title: 'Save one', collection: 'invoices' },
      { kind: 'open', title: '', path: '/x' },
      { kind: 'open', title: 'No path' },
      ...Array.from({ length: 20 }, (_, i) => ({ kind: 'open', title: `S${i}`, path: '/my-work' }))
    ])
    expect(steps.length).toBe(10)
    expect(new Set(steps.map((s) => s.id)).size).toBe(10)
    expect(steps[2]).toMatchObject({ kind: 'record', path: '/collections/invoices' })
  })

  it('points only at what the role really has', () => {
    const steps = normalizeSteps([
      { kind: 'open', title: 'a', path: '/queues/q-1' },
      { kind: 'open', title: 'b', path: '/queues/zzz' },
      { kind: 'open', title: 'c', path: '/collections/vendors' },
      { kind: 'open', title: 'd', path: '/collections/secret' },
      { kind: 'open', title: 'e', path: '/settings' },
      { kind: 'video', title: 'f', video_id: vid },
      { kind: 'video', title: 'g', video_id: '22222222-2222-4222-8222-222222222222' },
      { kind: 'record', title: 'h', collection: 'invoices' },
      { kind: 'open', title: 'i', path: '/my-work' }
    ])
    expect(groundSteps(steps, ctx).map((s) => s.title)).toEqual(['a', 'c', 'f', 'h', 'i'])
  })

  it('shows the list for two weeks from the role change, not before or after', () => {
    const now = Date.now()
    expect(inWindow(new Date(now - 86_400_000), now)).toBe(true)
    expect(inWindow(new Date(now - 15 * 86_400_000), now)).toBe(false)
    expect(inWindow(new Date(now + 86_400_000), now)).toBe(false)
    expect(inWindow(null, now)).toBe(false)
  })

  it('ticks steps from signals', () => {
    const steps = normalizeSteps([
      { id: 'queue', kind: 'open', title: 'Open the queue', path: '/queues/q-1' },
      { kind: 'video', title: 'Watch', video_id: vid },
      { kind: 'record', title: 'Save one', collection: 'invoices' }
    ])
    const done = tick(steps, {
      opened: new Set(['queue']),
      watched: new Set([vid]),
      saved: new Set()
    })
    expect(done.map((s) => s.done)).toEqual([true, true, false])
  })
})
