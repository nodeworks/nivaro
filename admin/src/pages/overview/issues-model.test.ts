import { describe, expect, it } from 'vitest'
import {
  cardCounts,
  countText,
  crashAppOf,
  effectiveFilter,
  filterOptions,
  issueLink,
  issueRowView,
  listQuery,
  pageLink,
  readStoredFilter,
  severityCounts,
  writeStoredFilter
} from './issues-model'

const DAY = '2026-11-18T05:00:00.000Z'
const params = (qs: string) => Object.fromEntries(new URLSearchParams(qs))

describe('issues filters', () => {
  it('offers the GitLab filters only while GitLab sync takes issues', () => {
    expect(filterOptions(false).map((f) => f.value)).toEqual(['open', 'new-today'])
    expect(filterOptions(true).map((f) => f.value)).toEqual([
      'open',
      'new-today',
      'linked',
      'unlinked',
      'suggested'
    ])
  })

  it('falls back to Open when the remembered filter is not offered', () => {
    expect(effectiveFilter('linked', true)).toBe('linked')
    expect(effectiveFilter('linked', false)).toBe('open')
    expect(effectiveFilter('nonsense', true)).toBe('open')
    expect(effectiveFilter(null, false)).toBe('open')
  })

  it('turns each filter into the issue log query', () => {
    expect(params(listQuery('open', { limit: 8, dayStart: DAY }))).toEqual({
      status: 'active',
      sort: 'last_seen',
      limit: '8',
      people: '1'
    })
    expect(params(listQuery('new-today', { limit: 15, dayStart: DAY }))).toEqual({
      status: 'active',
      created_after: DAY,
      sort: 'newest',
      limit: '15',
      people: '1'
    })
    expect(params(listQuery('unlinked', { limit: 8, dayStart: DAY })).tracker).toBe('unlinked')
    expect(params(listQuery('suggested', { limit: 8, dayStart: DAY })).tracker).toBe('suggested')
  })

  it('links to /issues filtered the same way', () => {
    expect(pageLink('open')).toBe('/issues?status=active')
    expect(pageLink('new-today')).toBe('/issues?status=active&sort=newest')
    expect(pageLink('linked')).toBe('/issues?status=active&tracker=linked')
    expect(issueLink(42, 'linked')).toBe('/issues/42?status=active&tracker=linked')
  })

  it('remembers a choice per person and forgets Open', () => {
    localStorage.clear()
    writeStoredFilter('u1', 'suggested')
    expect(readStoredFilter('u1')).toBe('suggested')
    expect(readStoredFilter('u2')).toBeNull()
    writeStoredFilter('u1', 'open')
    expect(readStoredFilter('u1')).toBeNull()
  })
})

describe('issue rows', () => {
  const base = {
    id: 7,
    title: '[server] GET /api/items/:collection: select * from [x] - Timeout: Request failed',
    severity: 'high',
    status: 'open',
    source: 'server',
    occurrence_count: 12,
    people: 4,
    last_seen_at: '2026-11-18T14:00:00.000Z',
    created_at: '2026-11-17T10:00:00.000Z'
  }

  it('reads the headline, where, counts and last seen', () => {
    const r = issueRowView(base, false)
    expect(r.headline).toBe('Timeout: Request failed')
    expect(r.where).toBe('GET /api/items/:collection')
    expect(r.fullTitle).toBe('GET /api/items/:collection — Timeout: Request failed')
    expect(r.sourceLabel).toBe('Server')
    expect(r.countText).toBe('12× · 4 people')
    expect(r.lastSeen).toBe('2026-11-18T14:00:00.000Z')
    expect(r.gitlab).toBeNull()
  })

  it('reads GitLab states: linked, suggested, not in GitLab', () => {
    const tracker = {
      iid: 1334,
      web_url: 'https://gitlab.example/p/-/issues/1334',
      state: 'opened',
      title: 'x'
    }
    expect(issueRowView({ ...base, tracker }, true).gitlab).toEqual({ kind: 'linked', tracker })
    // A chip still shows when the row carries one, whatever the switch says.
    expect(issueRowView({ ...base, tracker }, false).gitlab?.kind).toBe('linked')
    expect(issueRowView({ ...base, tracker_suggested_rule: 3 }, true).gitlab).toEqual({
      kind: 'suggested'
    })
    expect(issueRowView(base, true).gitlab).toEqual({ kind: 'none' })
  })

  it('names the front end a browser crash came from', () => {
    const details =
      'Route: /collections/:c\nCrash: app=efp-new; release=0.3.131; kind=error; sig=a\nboom'
    const r = issueRowView(
      {
        ...base,
        source: 'client',
        title: '[client] /collections/x: nn.find is not a function',
        details
      },
      false
    )
    expect(r.app).toBe('efp-new')
    expect(r.release).toBe('0.3.131')
    expect(crashAppOf(`Alerted: 2026-11-18T00:00:00Z\n${details}`).app).toBe('efp-new')
    expect(crashAppOf('Crash: app=x')).toEqual({ app: null, release: null })
  })

  it('counts once and people only when seen', () => {
    expect(countText(1, 0)).toBe('Once')
    expect(countText(3, 1)).toBe('3× · 1 person')
    expect(countText(1200, 0)).toBe('1,200×')
    expect(
      issueRowView({ ...base, occurrence_count: null, people: undefined }, false).countText
    ).toBe('Once')
  })
})

describe('severity counts', () => {
  it('orders the open counts most severe first and leaves zeros out', () => {
    expect(
      severityCounts({ active_by_severity: { low: 3, critical: 2, medium: 0, high: '5' } })
    ).toEqual({
      counts: [
        { severity: 'critical', n: 2 },
        { severity: 'high', n: 5 },
        { severity: 'low', n: 3 }
      ],
      total: 10
    })
    expect(severityCounts(null)).toEqual({ counts: [], total: 0 })
    expect(severityCounts([])).toEqual({ counts: [], total: 0 })
  })
})

describe('card counts', () => {
  const summary = { active_by_severity: { critical: 1, high: 2, medium: 9, low: 8 } }

  it('takes the heading and the footer from the same list answer under Open', () => {
    // The issue log agrees with itself: 20 open overall, 8 shown → "20 open" and "12 more".
    const c = cardCounts({ summary, filter: 'open', listTotal: 20, shown: 8 })
    expect(c.open).toBe(20)
    expect(c.more).toBe(12)
    expect(c.open - c.more).toBe(8)
    // Even when the summary was read a moment earlier (one issue fewer), they still agree.
    const lag = cardCounts({
      summary: { active_by_severity: { critical: 1, high: 2, medium: 8, low: 8 } },
      filter: 'open',
      listTotal: 20,
      shown: 8
    })
    expect(lag.open - lag.more).toBe(8)
  })

  it('keeps the heading on all open issues under a narrower filter', () => {
    const c = cardCounts({ summary, filter: 'linked', listTotal: 3, shown: 3 })
    expect(c.open).toBe(20)
    expect(c.more).toBe(0)
    expect(c.severities.map((s) => s.severity)).toEqual(['critical', 'high', 'medium', 'low'])
  })

  it('shows no footer before the list has answered', () => {
    expect(cardCounts({ summary, filter: 'open', listTotal: null, shown: 0 })).toMatchObject({
      open: 20,
      more: 0
    })
  })
})
