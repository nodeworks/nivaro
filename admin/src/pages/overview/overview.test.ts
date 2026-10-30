import { describe, expect, it } from 'vitest'
import { layoutOf, mergeOrder, moveSection, resolveSections, setVisible } from './layout'
import { buildQuickActions, groupRecent, type RecentRecord, togglePin } from './model'
import { EXTERNAL_SECTION_KEYS, type OverviewSectionMeta, SECTION_META } from './sections-meta'
import { deltaText, digestSentence, greetingSentence, sincePhrase } from './text'

describe('deltaText', () => {
  it('reads up, down and the same against yesterday', () => {
    expect(deltaText(12, 10, 'yesterday')).toEqual({
      tone: 'up',
      short: '+2',
      long: '2 more than this time yesterday'
    })
    expect(deltaText(3, 1500, 'previous_24h')?.short).toBe('−1,497')
    expect(deltaText(3, 1500, 'previous_24h')?.long).toBe('1,497 fewer than the 24 hours before')
    expect(deltaText(4, 4, 'yesterday')?.tone).toBe('flat')
    expect(deltaText(4, null, 'yesterday')).toBeNull()
  })
})

describe('greetingSentence', () => {
  it('names what needs the person and hides zero parts', () => {
    expect(
      greetingSentence({ hour: 20, name: 'Robert', needsYou: 4, myRecordsChanged: 2 })
    ).toEqual({
      greeting: 'Good evening, Robert',
      detail: '4 things need you, 2 changed on your records'
    })
    expect(greetingSentence({ hour: 9, name: 'Robert', needsYou: 1, myRecordsChanged: 0 })).toEqual(
      { greeting: 'Good morning, Robert', detail: '1 thing needs you' }
    )
    expect(greetingSentence({ hour: 13, name: null, needsYou: 0 }).detail).toBeNull()
    expect(greetingSentence({ hour: 13, name: ' ' }).greeting).toBe('Good afternoon')
  })
})

describe('digestSentence', () => {
  const now = new Date(2026, 9, 29, 21, 0)
  const base = {
    since: new Date(2026, 9, 27, 9, 0).toISOString(),
    clamped: false,
    records_changed: 38,
    my_records_changed: 0,
    new_people: 1,
    failed_jobs: 0,
    release: { from: '0.3.55', to: '0.3.56' }
  }
  it('lists what changed since the last visit, leaving zeros out', () => {
    expect(digestSentence(base, now)).toBe(
      'Since Tuesday: 38 records changed, 1 release, 1 new person'
    )
  })
  it('says nothing new plainly', () => {
    expect(
      digestSentence(
        {
          ...base,
          records_changed: 0,
          new_people: 0,
          release: null,
          since: new Date(2026, 9, 28, 9).toISOString()
        },
        now
      )
    ).toBe('Nothing new since yesterday.')
    expect(
      digestSentence(
        { ...base, clamped: true, records_changed: 0, new_people: null, release: null },
        now
      )
    ).toBe('Nothing new in the last 14 days.')
  })
  it('marks a capped count and the person’s own records', () => {
    expect(
      digestSentence(
        { ...base, records_capped: true, my_records_changed: 2, new_people: null, release: null },
        now
      )
    ).toBe('Since Tuesday: 38+ records changed, 2 of yours')
  })
  it('phrases the time of the last visit', () => {
    expect(sincePhrase(new Date(2026, 9, 29, 14, 15), now)).toBe('2:15 PM')
    expect(sincePhrase(new Date(2026, 9, 10, 9), now)).toBe('Oct 10')
  })
})

describe('section layout', () => {
  const meta: OverviewSectionMeta[] = [
    { key: 'a', title: 'A', hint: '', column: 'main', defaultOrder: 1, defaultVisible: true },
    { key: 'b', title: 'B', hint: '', column: 'main', defaultOrder: 2, defaultVisible: true },
    {
      key: 'c',
      title: 'C',
      hint: '',
      column: 'main',
      defaultOrder: 3,
      defaultVisible: false
    },
    {
      key: 's',
      title: 'S',
      hint: '',
      column: 'side',
      defaultOrder: 4,
      defaultVisible: true,
      adminOnly: true
    }
  ]

  it('inserts keys a layout does not name after their default predecessor', () => {
    expect(mergeOrder(['a', 'b', 'c', 's'], ['c', 'a'])).toEqual(['c', 'a', 'b', 's'])
    expect(mergeOrder(['a', 'b'], ['zz'])).toEqual(['a', 'b'])
  })

  it('uses the role starter until the person has their own, and drops admin-only', () => {
    const role = { order: ['b', 'a'], hidden: ['a'], shown: ['c'] }
    const r = resolveSections({ meta, roleDefault: role, isAdmin: false })
    expect(r.map((s) => [s.key, s.visible])).toEqual([
      ['b', true],
      ['a', false],
      ['c', true]
    ])
    const own = resolveSections({
      meta,
      roleDefault: role,
      personal: { order: ['a'], hidden: [], shown: [] },
      isAdmin: true
    })
    expect(own.map((s) => [s.key, s.visible])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['s', true]
    ])
  })

  it('leaves out sections with no mounted component', () => {
    const r = resolveSections({ meta, isAdmin: true, available: new Set(['a', 's']) })
    expect(r.map((s) => s.key)).toEqual(['a', 's'])
  })

  it('moves within a column and stores what is on screen', () => {
    let r = resolveSections({ meta, isAdmin: true })
    r = moveSection(r, 'b', -1)
    expect(r.map((s) => s.key)).toEqual(['b', 'a', 'c', 's'])
    // The side column's only section cannot move into the main one.
    expect(moveSection(r, 's', -1).map((s) => s.key)).toEqual(['b', 'a', 'c', 's'])
    r = setVisible(setVisible(r, 'c', true), 'a', false)
    expect(layoutOf(r)).toEqual({ order: ['b', 'a', 'c', 's'], hidden: ['a'], shown: ['c'] })
    expect(resolveSections({ meta, personal: layoutOf(r), isAdmin: true })).toEqual(r)
  })

  it('knows every key the other sections mount under', () => {
    const keys = new Set(SECTION_META.map((m) => m.key))
    for (const k of EXTERNAL_SECTION_KEYS) expect(keys.has(k)).toBe(true)
    expect(new Set(SECTION_META.map((m) => m.defaultOrder)).size).toBe(SECTION_META.length)
  })
})

describe('recently viewed grouping', () => {
  const rec = (collection: string, id: string): RecentRecord => ({
    collection,
    item_id: id,
    label: `${collection} ${id}`,
    state: null,
    last_viewed_at: '2026-10-29T00:00:00Z'
  })
  it('folds three or more from one collection where the newest sat', () => {
    const blocks = groupRecent([
      rec('po', '1'),
      rec('vendor', '9'),
      rec('po', '2'),
      rec('po', '3'),
      rec('vendor', '8')
    ])
    expect(
      blocks.map((b) => (b.kind === 'group' ? `g:${b.records.length}` : b.record.item_id))
    ).toEqual(['g:3', '9', '8'])
  })
})

describe('quick actions', () => {
  const labels: Record<string, string> = {
    '/flows': 'Flows',
    '/users': 'Users',
    '/jobs': 'Jobs',
    '/roles': 'Roles'
  }
  it('puts pins first, then usage, then the role defaults, skipping disallowed', () => {
    const out = buildQuickActions({
      pinned: [{ path: '/roles', label: 'Roles' }],
      usage: [
        { path: '/flows', opens: 30 },
        { path: '/secret', opens: 20 },
        { path: '/roles', opens: 5 }
      ],
      defaults: ['/users', '/jobs', '/'],
      dismissed: ['/jobs'],
      labelFor: (p) => labels[p] ?? null,
      allowed: (p) => p !== '/users',
      max: 5
    })
    expect(out.map((a) => [a.path, a.source])).toEqual([
      ['/roles', 'pinned'],
      ['/flows', 'usage']
    ])
  })
  it('toggles a pin', () => {
    const one = togglePin([], { path: '/flows', label: 'Flows' })
    expect(one).toEqual([{ path: '/flows', label: 'Flows' }])
    expect(togglePin(one, { path: '/flows', label: 'Flows' })).toEqual([])
  })
})
