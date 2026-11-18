import { describe, expect, it } from 'vitest'
import {
  type Counts,
  containsTerm,
  evaluateRule,
  evaluateTicketRule,
  type GuardState,
  globMatch,
  type IssueFacts,
  nextQuietEnd
} from './rule-eval.js'
import { NO_REGEX_MESSAGE, normalizeSeverity, type TrackerRule, validateRule } from './rules.js'

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
  it('plain terms are case-insensitive substrings', () => {
    const plain = rule({
      match: { text: { op: 'all', terms: ['BOOM', 'typeerror'], in: ['title', 'details'] } }
    })
    expect(run(plain)).toEqual({ act: 'fire' })
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

// Final review M1, final shape: no regular expressions in rules; words with * wildcards
describe('text terms (no regular expressions)', () => {
  const v = (terms: string[], extra: Record<string, unknown> = {}) =>
    validateRule({
      name: 'x',
      action: { connection: 1 },
      match: { text: { op: 'any', terms, in: ['title'], ...extra } }
    })
  it('refuses regex: true, the old catastrophic patterns included', () => {
    for (const p of ['(a|aa)+$', 'a*a*a*b', '(a+)+', '(.*)*', '\\d+\\d+$', 'timeout|deadlock']) {
      const r = v([p], { regex: true })
      expect(r.ok, p).toBe(false)
      if (!r.ok)
        expect(r.errors.find((e) => e.path === 'match.text.regex')?.message).toBe(NO_REGEX_MESSAGE)
    }
    expect(NO_REGEX_MESSAGE).toBe(
      'Regular expressions are not supported in rules — use words, or * as a wildcard.'
    )
    expect(v(['boom'], { regex: false }).ok).toBe(true)
  })
  it('matches * wildcards in order, case-insensitively', () => {
    expect(containsTerm('Request TIME went OUT', 'time*out')).toBe(true)
    expect(containsTerm('out of time', 'time*out')).toBe(false)
    expect(containsTerm('a Deadlock victim', '*deadlock*')).toBe(true)
    expect(containsTerm('ERR-42-zone 3', 'ERR-*-zone')).toBe(true)
    expect(containsTerm('ERR-zone', 'ERR-*-zone')).toBe(false)
    expect(containsTerm('err--zone', 'ERR-*-zone')).toBe(true)
    const r = rule({ match: { text: { op: 'any', terms: ['boom*checkout'], in: ['title'] } } })
    expect(run(r)).toEqual({ act: 'fire' })
    expect(run(r, facts({ title: 'checkout boom' }))).toMatchObject({ outcome: 'no_match' })
  })
  it('limits a term to 3 wildcards and 200 characters, and to more than stars', () => {
    expect(v(['a*b*c*d']).ok).toBe(true)
    const four = v(['a*b*c*d*e'])
    expect(four.ok).toBe(false)
    if (!four.ok) expect(four.errors[0].message).toBe('A term can use * at most 3 times.')
    expect(v(['x'.repeat(201)]).ok).toBe(false)
    expect(v(['**']).ok).toBe(false)
  })
  it('a 2,000-character adversarial text with 3 wildcards runs in < 50 ms', () => {
    const hostile = 'a'.repeat(2000)
    const r = rule({ match: { text: { op: 'any', terms: ['a*a*a*b'], in: ['title', 'details'] } } })
    const t0 = performance.now()
    for (let i = 0; i < 10; i++)
      expect(run(r, facts({ title: hostile, details: hostile }))).toMatchObject({
        outcome: 'no_match'
      })
    expect((performance.now() - t0) / 10).toBeLessThan(50)
  })
  it('a route glob never backtracks either', () => {
    expect(globMatch('/items/workflows', '/items/*')).toBe(true)
    expect(globMatch('/items/workflows/7', '/items/*/7')).toBe(true)
    expect(globMatch('/items', '/items/*')).toBe(false)
    expect(globMatch('/ITEMS/x', '/items/*')).toBe(true)
    expect(globMatch('/a/b', '/a/b')).toBe(true)
    expect(globMatch('ab', 'a*b*')).toBe(true)
    expect(globMatch('aXbYa', '*a*b*a')).toBe(true)
    const t0 = performance.now()
    expect(globMatch('a'.repeat(5000), '*a*a*a*a*a*a*b')).toBe(false)
    expect(performance.now() - t0).toBeLessThan(50)
  })
  it('a stored regex rule is invalid and never runs', () => {
    // as stored before this change: validateRule refuses it, so the engine never loads it
    const stored = {
      name: 'old',
      action: { connection: 1 },
      match: { text: { op: 'any', terms: ['(a|aa)+$'], regex: true, in: ['title'] } }
    }
    const res = validateRule(stored)
    expect(res.ok).toBe(false)
    // and if one reached the evaluator anyway, the term is plain text: no match, no hang
    const r = rule({ match: { text: { op: 'any', terms: ['boom'], in: ['title'] } } })
    ;(r.match.text as Record<string, unknown>).regex = true
    r.match.text!.terms = ['(a|aa)+$']
    const t0 = performance.now()
    expect(run(r, facts({ title: `${'a'.repeat(40)}!` }))).toMatchObject({ outcome: 'no_match' })
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe('severity aliases', () => {
  it('an Object.prototype name is not an alias', () => {
    expect(normalizeSeverity('constructor')).toBe('medium')
    expect(normalizeSeverity('__proto__')).toBe('medium')
    expect(normalizeSeverity('warning')).toBe('medium')
    expect(normalizeSeverity('error')).toBe('high')
    expect(
      validateRule({ name: 'x', action: { connection: 1 }, match: { severity_min: 'toString' } }).ok
    ).toBe(false)
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
