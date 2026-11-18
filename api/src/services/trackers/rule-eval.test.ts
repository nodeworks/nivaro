import { describe, expect, it } from 'vitest'
import {
  type Counts,
  evaluateRule,
  evaluateTicketRule,
  type GuardState,
  type IssueFacts,
  nextQuietEnd
} from './rule-eval.js'
import { type TrackerRule, validateRule } from './rules.js'

const NOW = new Date('2026-11-17T15:00:00Z')

function rule(over: Record<string, unknown> = {}): TrackerRule {
  const r = validateRule({ name: 'r', mode: 'create', action: { connection: 1 }, ...over })
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return { id: 1, ...r.rule }
}
const facts = (o: Partial<IssueFacts> = {}): IssueFacts => ({
  id: 1,
  title: 'Boom in checkout',
  details: 'TypeError: x',
  severity: 'high',
  status: 'open',
  source: 'server',
  route: '/items/workflows',
  collection: null,
  item: null,
  environment: 'prod',
  build: '1.0',
  current_build: '1.0',
  first_build: '1.0',
  fingerprint: 'fp',
  group_lead_id: null,
  raised_by: null,
  raised_by_role: null,
  assigned_to: null,
  has_screenshot: false,
  has_replay: false,
  created_at: new Date(NOW.getTime() - 3600_000),
  linked: false,
  recurrences: 0,
  total_hits: 50,
  ...o
})
const counts = (hits = 0, people = 0): Counts => ({ hits: () => hits, people: () => people })
const guard = (o: Partial<GuardState> = {}): GuardState => ({
  firedLastHour: 0,
  firedLastDay: 0,
  connectionLastHour: 0,
  connectionCap: 30,
  ...o
})
const run = (r: TrackerRule, f = facts(), c = counts(), g = guard(), now = NOW) =>
  evaluateRule(r, f, c, g, now)

describe('match', () => {
  it('matches source and severity_min', () => {
    const r = rule({ match: { sources: ['server'], severity_min: 'high' } })
    expect(run(r)).toEqual({ act: 'fire' })
    expect(run(r, facts({ severity: 'low' }))).toMatchObject({ outcome: 'no_match' })
    expect(run(r, facts({ source: 'client' }))).toMatchObject({ outcome: 'no_match' })
  })
  it('unknown severity ranks as medium', () => {
    const r = rule({ match: { severity_min: 'medium' } })
    expect(run(r, facts({ severity: 'weird' }))).toEqual({ act: 'fire' })
  })
  it('severity aliases map to the real names', () => {
    const r = rule({ match: { severity_min: 'error' } })
    expect(r.match.severity_min).toBe('high')
    expect(run(r, facts({ severity: 'error' }))).toEqual({ act: 'fire' })
    expect(run(r, facts({ severity: 'medium' }))).toMatchObject({ outcome: 'no_match' })
    const s = rule({ match: { severities: ['warning', 'critical'] } })
    expect(s.match.severities).toEqual(['medium', 'critical'])
  })
  it('text none excludes', () => {
    const r = rule({ match: { text: { op: 'none', terms: ['checkout'], in: ['title'] } } })
    expect(run(r)).toMatchObject({ outcome: 'no_match' })
    expect(run(r, facts({ title: 'other' }))).toEqual({ act: 'fire' })
  })
  it('regex matches, plain terms are case-insensitive substrings', () => {
    const rx = rule({
      match: { text: { op: 'any', terms: ['^boom\\b'], regex: true, in: ['title'] } }
    })
    expect(run(rx)).toEqual({ act: 'fire' })
    const plain = rule({
      match: { text: { op: 'all', terms: ['BOOM', 'typeerror'], in: ['title', 'details'] } }
    })
    expect(run(plain)).toEqual({ act: 'fire' })
  })
  it('regex compiles safely (invalid regex → validateRule error)', () => {
    const r = validateRule({
      name: 'x',
      action: { connection: 1 },
      match: { text: { op: 'any', terms: ['ok', '('], regex: true, in: ['title'] } }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0].path).toBe('match.text.terms[1]')
  })
  it('route glob /items/* matches /items/workflows', () => {
    const r = rule({ match: { routes: ['/items/*'] } })
    expect(run(r)).toEqual({ act: 'fire' })
    expect(run(r, facts({ route: '/users/1' }))).toMatchObject({ outcome: 'no_match' })
    expect(run(r, facts({ route: null }))).toMatchObject({ outcome: 'no_match' })
  })
  it('new_in_current true when first_build === current_build', () => {
    const r = rule({ match: { release: { new_in_current: true } } })
    expect(run(r)).toEqual({ act: 'fire' })
    expect(run(r, facts({ first_build: '0.9' }))).toMatchObject({ outcome: 'no_match' })
  })
})

describe('regex safety', () => {
  const v = (term: string) =>
    validateRule({
      name: 'x',
      action: { connection: 1 },
      match: { text: { op: 'any', terms: [term], regex: true, in: ['title'] } }
    })
  it('rejects nested quantifier regex', () => {
    for (const p of ['(a+)+$', '(.*)*x', '(a+)*', '(a{2,})+', '.*.*x', '((a+)b)+'])
      expect(v(p).ok, p).toBe(false)
    const r = v('(a+)+$')
    if (!r.ok) expect(r.errors[0].message).toContain('simplify it')
  })
  it('rejects backreference', () => {
    expect(v('(a)\\1').ok).toBe(false)
  })
  it('accepts simple regex like timeout|ECONNRESET', () => {
    for (const p of ['timeout|ECONNRESET', '^boom\\b', '(foo|bar)+', 'error \\d+', 'a.*b'])
      expect(v(p).ok, p).toBe(true)
  })
})

describe('threshold', () => {
  it('hits 20/60 not met at 19', () => {
    const r = rule({ threshold: { hits: { n: 20, window_minutes: 60 } } })
    const o = run(r, facts(), counts(19))
    expect(o).toMatchObject({ outcome: 'threshold', detail: 'Seen 19 times in 60 min — needs 20' })
    expect(run(r, facts(), counts(20))).toEqual({ act: 'fire' })
  })
  it('people 3/60 met', () => {
    const r = rule({ threshold: { people: { n: 3, window_minutes: 60 } } })
    expect(run(r, facts(), counts(0, 3))).toEqual({ act: 'fire' })
    expect(run(r, facts(), counts(0, 2))).toMatchObject({ outcome: 'threshold' })
  })
})

describe('guards', () => {
  it('cap holds a burst', () => {
    const r = rule({ guards: { per_hour: 5 } })
    expect(run(r, facts(), counts(), guard({ firedLastHour: 5 }))).toMatchObject({ outcome: 'cap' })
    expect(run(r, facts(), counts(), guard({ firedLastHour: 4 }))).toEqual({ act: 'fire' })
  })
  it('daily cap holds', () => {
    expect(run(rule(), facts(), counts(), guard({ firedLastDay: 20 }))).toMatchObject({
      outcome: 'cap'
    })
  })
  it('connection cap 30 holds', () => {
    expect(run(rule(), facts(), counts(), guard({ connectionLastHour: 30 }))).toMatchObject({
      outcome: 'cap'
    })
  })
  it('already linked → linked; resolved → status', () => {
    expect(run(rule(), facts({ linked: true }))).toMatchObject({ outcome: 'linked' })
    expect(run(rule(), facts({ status: 'resolved' }))).toMatchObject({ outcome: 'status' })
  })
  it('suggest mode returns suggest', () => {
    expect(run(rule({ mode: 'suggest' }))).toEqual({ act: 'suggest' })
  })
})

describe('quiet hours', () => {
  const quiet = { from: '22:00', to: '06:00', days: [0, 1, 2, 3, 4, 5, 6], tz: 'America/New_York' }
  it('quiet 22:00–06:00 America/New_York holds at 23:30 ET and nextQuietEnd = 06:00 ET', () => {
    const now = new Date('2026-11-17T04:30:00Z') // 23:30 EST on 11-16
    const r = rule({ guards: { quiet } })
    expect(run(r, facts(), counts(), guard(), now)).toMatchObject({ outcome: 'quiet' })
    expect(nextQuietEnd(quiet, now)?.toISOString()).toBe('2026-11-17T11:00:00.000Z')
  })
  it('not quiet at noon ET; weekday belongs to the day the window started', () => {
    expect(nextQuietEnd(quiet, new Date('2026-11-17T17:00:00Z'))).toBeNull()
    // Tue 11-17 02:00 ET started Monday (1): only Monday quiet -> held; only Tuesday (2) -> not held
    const early = new Date('2026-11-17T07:00:00Z')
    expect(nextQuietEnd({ ...quiet, days: [1] }, early)).not.toBeNull()
    expect(nextQuietEnd({ ...quiet, days: [2] }, early)).toBeNull()
  })
})

describe('validateRule defaults', () => {
  it('fills defaults', () => {
    const r = validateRule({ name: 'n', action: { connection: 2 } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.rule.mode).toBe('suggest')
      expect(r.rule.enabled).toBe(false)
      expect(r.rule.guards).toEqual({
        per_hour: 5,
        per_day: 20,
        group: true,
        skip_linked: true,
        skip_statuses: ['resolved', 'closed']
      })
      expect(r.rule.action.title_template).toBe('[{{ severity }}] {{ title }}')
    }
  })
  it('rejects bad values with readable paths', () => {
    const r = validateRule({
      name: '',
      action: {},
      guards: { per_hour: 0, quiet: { from: '25:00', to: '06:00', tz: 'Mars/Base' } },
      threshold: { hits: { n: 0, window_minutes: 1 } },
      match: { severities: ['nope'] }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const paths = r.errors.map((e) => e.path)
      for (const p of [
        'name',
        'action.connection',
        'guards.per_hour',
        'guards.quiet.from',
        'guards.quiet.tz',
        'threshold.hits.n',
        'threshold.hits.window_minutes',
        'match.severities[0]'
      ])
        expect(paths).toContain(p)
    }
  })
})

describe('ticket rules (applies_to ticket)', () => {
  it('reject hit and people thresholds and issue-only conditions', () => {
    const res = validateRule({
      name: 'Tickets',
      applies_to: 'ticket',
      match: { severities: ['high'], priorities: ['urgent', 'soon'] },
      threshold: { hits: { n: 5, window_minutes: 60 }, people: { n: 2, window_minutes: 60 } },
      action: { connection: 1 }
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.map((e) => e.path).sort()).toEqual([
      'match.priorities[1]',
      'match.severities',
      'threshold.hits',
      'threshold.people'
    ])
  })

  it('default to ticket templates and skip done / cancelled; issue rules refuse ticket fields', () => {
    const res = validateRule({
      name: 'Tickets',
      applies_to: 'ticket',
      match: { categories: [3], priorities: ['URGENT'] },
      threshold: { open_minutes: 30 },
      action: { connection: 1 }
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rule.applies_to).toBe('ticket')
    expect(res.rule.match).toEqual({ categories: [3], priorities: ['urgent'] })
    expect(res.rule.guards.skip_statuses).toEqual(['done', 'cancelled'])
    expect(res.rule.action.title_template).toBe('{{ title }}')
    const issue = validateRule({
      name: 'Issues',
      match: { categories: [3] },
      action: { connection: 1 }
    })
    expect(issue.ok).toBe(false)
  })

  it('evaluateTicketRule: match, age threshold, status skip', () => {
    const res = validateRule({
      name: 'Urgent payroll',
      applies_to: 'ticket',
      mode: 'create',
      match: { priorities: ['urgent'], categories: [3], text: { terms: ['payroll'] } },
      threshold: { open_minutes: 30 },
      action: { connection: 1 }
    })
    if (!res.ok) throw new Error('invalid')
    const rule = { ...res.rule, id: 1 }
    const now = new Date('2026-11-17T12:00:00Z')
    const facts = {
      id: 55,
      title: 'Payroll export fails',
      description: null,
      status: 'open',
      priority: 'urgent',
      category_id: 3,
      requester: null,
      requester_role: null,
      assignee: null,
      created_at: new Date('2026-11-17T11:00:00Z'),
      linked: false
    }
    const g = { firedLastHour: 0, firedLastDay: 0, connectionLastHour: 0, connectionCap: 30 }
    expect(evaluateTicketRule(rule, facts, g, now)).toEqual({ act: 'fire' })
    expect(evaluateTicketRule(rule, { ...facts, priority: 'low' }, g, now)).toMatchObject({
      outcome: 'no_match'
    })
    expect(
      evaluateTicketRule(rule, { ...facts, created_at: new Date('2026-11-17T11:50:00Z') }, g, now)
    ).toMatchObject({ outcome: 'threshold' })
    expect(evaluateTicketRule(rule, { ...facts, status: 'done' }, g, now)).toMatchObject({
      outcome: 'status'
    })
  })
})
