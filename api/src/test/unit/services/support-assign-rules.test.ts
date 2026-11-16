import { describe, expect, it } from 'vitest'
import {
  type AssignRule,
  type Candidate,
  DEFAULT_HOURS,
  fieldMatches,
  insideHours,
  matchRule,
  pickPerson,
  type RequestFacts,
  type SharePerson,
  validateRuleSet
} from '../../../services/support-assign-rules.js'

const A = 'AAAAAAAA-0000-0000-0000-000000000001'
const B = 'BBBBBBBB-0000-0000-0000-000000000002'
const C = 'CCCCCCCC-0000-0000-0000-000000000003'
const D = 'DDDDDDDD-0000-0000-0000-000000000004'

const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  category_id: 3,
  collection: 'workflows',
  item: '42',
  fields: { 'workflows.zone': 'EAST-ID', 'workflows.amount': 1500, 'workflows.tags': '["a","b"]' },
  state: 'S1',
  requester: A,
  requester_role: 'R1',
  requester_teams: [7],
  priority: 'normal',
  title: 'Vendor change for PO',
  description: 'Please swap the vendor',
  source: 'record',
  // Monday 2026-11-16 10:00 Eastern
  at: new Date('2026-11-16T15:00:00Z'),
  ...over
})

const rule = (over: Partial<AssignRule> = {}): AssignRule => ({
  id: 'r1',
  name: 'Vendor changes East',
  active: true,
  match: 'all',
  conditions: [],
  action: { kind: 'person', user: B },
  fallback: { kind: 'desk' },
  on_type_change: false,
  note: null,
  ...over
})

describe('validateRuleSet', () => {
  it('reads a full rule and upper-cases people', () => {
    const v = validateRuleSet({
      rules: [
        {
          id: 'x',
          name: ' East ',
          match: 'any',
          conditions: [
            { kind: 'type', op: 'in', values: [3, '4'] },
            { kind: 'field', collection: 'workflows', field: 'zone', op: 'in', values: ['E'] },
            { kind: 'hours', op: 'outside' }
          ],
          action: {
            kind: 'share',
            people: [{ id: A.toLowerCase(), cap: '15', when: 'online' }, { id: B }],
            strategy: 'least_recent',
            give_to_cover: true
          },
          fallback: { kind: 'person', user: C.toLowerCase() }
        }
      ]
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const r = v.set.rules[0]
    expect(r.name).toBe('East')
    expect(r.match).toBe('any')
    expect(r.conditions[0]).toEqual({ kind: 'type', op: 'in', values: [3, 4] })
    expect(r.action).toEqual({
      kind: 'share',
      people: [
        { id: A, cap: 15, when: 'online' },
        { id: B, cap: null, when: 'always' }
      ],
      strategy: 'least_recent',
      give_to_cover: true
    })
    expect(r.fallback).toEqual({ kind: 'person', user: C })
    expect(v.set.hours).toEqual(DEFAULT_HOURS)
  })

  it('names each problem in plain words', () => {
    const v = validateRuleSet({
      rules: [
        {
          name: '',
          conditions: [{ kind: 'type', op: 'in', values: [] }],
          action: { kind: 'person' }
        },
        {
          name: 'ok',
          conditions: [
            { kind: 'field', collection: 'w', field: 'amount', op: 'gt', values: ['1', '2'] }
          ],
          action: { kind: 'share', people: [{ id: A, cap: 0 }], strategy: 'fewest_open' }
        }
      ],
      hours: { start: '18:00', end: '08:00', days: [1] }
    })
    expect(v.ok).toBe(false)
    if (v.ok) return
    const msgs = v.errors.map((e) => `${e.rule}:${e.message}`)
    expect(msgs).toContain('-1:Business hours: the end must be after the start')
    expect(msgs).toContain('0:Give the rule a name')
    expect(msgs).toContain('0:Request type: pick at least one type')
    expect(msgs).toContain('0:Assign to: pick a person')
    expect(msgs).toContain('1:Record field: "greater/less than" compares with one value')
    expect(msgs).toContain('1:Share among: a cap must be a whole number of 1 or more')
  })

  it('refuses an unknown strategy and a bad person', () => {
    const bad = (action: unknown) =>
      validateRuleSet({ rules: [{ name: 'n', conditions: [], action }] })
    expect(bad({ kind: 'share', people: [{ id: A }], strategy: 'loudest' }).ok).toBe(false)
    expect(bad({ kind: 'person', user: 'nobody' }).ok).toBe(false)
    expect(bad({ kind: 'team', team: 'x' }).ok).toBe(false)
  })
})

describe('matching', () => {
  it('fieldMatches: is / one of / contains / empty / numbers / lists', () => {
    expect(fieldMatches('is', 'East-ID', ['east-id'])).toBe(true)
    expect(fieldMatches('in', 'x', ['a', 'x'])).toBe(true)
    expect(fieldMatches('not_in', null, ['a'])).toBe(true)
    expect(fieldMatches('is_not', 'a', ['a'])).toBe(false)
    expect(fieldMatches('contains', 'Vendor East', ['east'])).toBe(true)
    expect(fieldMatches('empty', '  ', [])).toBe(true)
    expect(fieldMatches('not_empty', 0, [])).toBe(true)
    expect(fieldMatches('gt', 1500, ['1000'])).toBe(true)
    expect(fieldMatches('lte', '2026-01-01', ['2026-06-01'])).toBe(true)
    expect(fieldMatches('gt', 'abc', ['1'])).toBe(false)
    expect(fieldMatches('in', '["a","b"]', ['b'])).toBe(true)
  })

  it('all vs any, with reasons that never quote record values', () => {
    const r = rule({
      conditions: [
        { kind: 'type', op: 'in', values: [3] },
        { kind: 'field', collection: 'workflows', field: 'zone', op: 'is', values: ['WEST-ID'] }
      ]
    })
    const all = matchRule(r, facts(), DEFAULT_HOURS, { field: () => 'Zone' })
    expect(all.matched).toBe(false)
    expect(all.reasons).toEqual(['the record’s Zone does not match'])
    expect(all.reasons.join(' ')).not.toMatch(/EAST/)
    expect(matchRule({ ...r, match: 'any' }, facts(), DEFAULT_HOURS).matched).toBe(true)
  })

  it('a switched-off rule never matches; a rule with no conditions always does', () => {
    expect(matchRule(rule({ active: false }), facts(), DEFAULT_HOURS)).toEqual({
      matched: false,
      reasons: ['the rule is switched off']
    })
    expect(matchRule(rule(), facts(), DEFAULT_HOURS).matched).toBe(true)
  })

  it('about / general, step, requester, role, team, priority, words, source', () => {
    const ok = (c: AssignRule['conditions'][number], f = facts()) =>
      matchRule(rule({ conditions: [c] }), f, DEFAULT_HOURS).matched
    expect(ok({ kind: 'about', op: 'record_in', collections: ['workflows'] })).toBe(true)
    expect(ok({ kind: 'about', op: 'record_in', collections: [] })).toBe(true)
    expect(ok({ kind: 'about', op: 'general', collections: [] })).toBe(false)
    expect(ok({ kind: 'about', op: 'general', collections: [] }, facts({ collection: null }))).toBe(
      true
    )
    expect(ok({ kind: 'step', op: 'in', states: ['S1'] })).toBe(true)
    expect(ok({ kind: 'step', op: 'not_in', states: ['S1'] })).toBe(false)
    expect(ok({ kind: 'requester', op: 'in', users: [A] })).toBe(true)
    expect(ok({ kind: 'requester_role', op: 'in', roles: ['r1'] })).toBe(true)
    expect(ok({ kind: 'requester_team', op: 'not_in', teams: [7] })).toBe(false)
    expect(ok({ kind: 'priority', op: 'in', values: ['urgent'] })).toBe(false)
    expect(ok({ kind: 'text', op: 'any', words: ['VENDOR', 'zzz'] })).toBe(true)
    expect(ok({ kind: 'text', op: 'all', words: ['vendor', 'zzz'] })).toBe(false)
    expect(ok({ kind: 'text', op: 'none', words: ['swap'] })).toBe(false)
    expect(ok({ kind: 'source', op: 'in', values: ['record'] })).toBe(true)
  })

  it('business hours are Eastern, weekdays 8–6 by default', () => {
    expect(insideHours(new Date('2026-11-16T15:00:00Z'), DEFAULT_HOURS)).toBe(true) // Mon 10:00
    expect(insideHours(new Date('2026-11-16T23:30:00Z'), DEFAULT_HOURS)).toBe(false) // Mon 18:30
    expect(insideHours(new Date('2026-11-15T15:00:00Z'), DEFAULT_HOURS)).toBe(false) // Sun
    expect(insideHours(new Date('2026-11-16T13:00:00Z'), DEFAULT_HOURS)).toBe(true) // Mon 08:00
  })
})

const NOW = Date.parse('2026-11-16T15:00:00Z')
const cand = (
  id: string,
  name: string,
  over: Partial<Candidate & SharePerson> = {}
): Candidate & { cap: number | null; when: SharePerson['when'] } => ({
  id,
  name,
  inactive: false,
  out_of_office: false,
  cover: null,
  online: true,
  open: 0,
  urgent_open: 0,
  last_assigned: null,
  assigned_today: 0,
  assigned_week: 0,
  closed_same: 0,
  last_helped: null,
  step_owner: false,
  cap: null,
  when: 'always',
  ...over
})
const opts = { giveToCover: false, insideHours: true, now: NOW }

describe('pickPerson strategies', () => {
  it('fewest open (default), ties: least recently assigned, then list order', () => {
    const p = pickPerson(
      [
        cand(A, 'Ann', { open: 3 }),
        cand(B, 'Ben', { open: 1, last_assigned: NOW - 1000 }),
        cand(C, 'Cy', { open: 1, last_assigned: NOW - 5000 })
      ],
      'fewest_open',
      opts
    )
    expect(p.winner?.name).toBe('Cy')
    expect(p.ranking.map((r) => `${r.name}:${r.measure}`)).toEqual([
      'Cy:1 open',
      'Ben:1 open',
      'Ann:3 open'
    ])
    const tie = pickPerson([cand(A, 'Ann'), cand(B, 'Ben')], 'fewest_open', opts)
    expect(tie.winner?.name).toBe('Ann')
  })

  it('least recently assigned: never assigned goes first', () => {
    const p = pickPerson(
      [cand(A, 'Ann', { last_assigned: NOW - 10 }), cand(B, 'Ben', { last_assigned: null })],
      'least_recent',
      opts
    )
    expect(p.winner?.name).toBe('Ben')
    expect(p.ranking[0].measure).toBe('never assigned')
  })

  it('fewest today / this week / fewest urgent', () => {
    const people = [
      cand(A, 'Ann', { assigned_today: 2, assigned_week: 3, urgent_open: 0 }),
      cand(B, 'Ben', { assigned_today: 1, assigned_week: 9, urgent_open: 2 })
    ]
    expect(pickPerson(people, 'fewest_today', opts).winner?.name).toBe('Ben')
    expect(pickPerson(people, 'fewest_week', opts).winner?.name).toBe('Ann')
    expect(pickPerson(people, 'fewest_urgent', opts).winner?.name).toBe('Ann')
  })

  it('most knowledgeable; ties fall back to fewest open; nobody has closed any = fewest open', () => {
    const p = pickPerson(
      [
        cand(A, 'Ann', { closed_same: 5, open: 4 }),
        cand(B, 'Ben', { closed_same: 5, open: 2 }),
        cand(C, 'Cy', { closed_same: 1 })
      ],
      'most_closed_type',
      opts
    )
    expect(p.winner?.name).toBe('Ben')
    const none = pickPerson(
      [cand(A, 'Ann', { open: 2 }), cand(B, 'Ben', { open: 1 })],
      'most_closed_type',
      opts
    )
    expect(none.used).toBe('fewest_open')
    expect(none.winner?.name).toBe('Ben')
  })

  it('last helped this requester, else fewest open', () => {
    const p = pickPerson(
      [
        cand(A, 'Ann', { last_helped: NOW - 86_400_000 * 3 }),
        cand(B, 'Ben', { last_helped: NOW - 3_600_000 * 5 })
      ],
      'last_helped',
      opts
    )
    expect(p.winner?.name).toBe('Ben')
    expect(
      pickPerson([cand(A, 'Ann', { open: 1 }), cand(B, 'Ben')], 'last_helped', opts).used
    ).toBe('fewest_open')
  })

  it('step owner if listed, else fewest open', () => {
    const p = pickPerson(
      [cand(A, 'Ann'), cand(B, 'Ben', { step_owner: true, open: 9 })],
      'step_owner',
      opts
    )
    expect(p.winner?.name).toBe('Ben')
    expect(
      pickPerson([cand(A, 'Ann', { open: 2 }), cand(B, 'Ben')], 'step_owner', opts).winner?.name
    ).toBe('Ben')
  })

  it('random uses the draw it is given', () => {
    const draws = [0.9, 0.1]
    const p = pickPerson([cand(A, 'Ann'), cand(B, 'Ben')], 'random', {
      ...opts,
      rand: () => draws.shift()!
    })
    expect(p.winner?.name).toBe('Ben')
  })

  it('skips: inactive, out of office, at cap, hours, online — each with a reason', () => {
    const p = pickPerson(
      [
        cand(A, 'Ann', { inactive: true }),
        cand(B, 'Ben', { out_of_office: true }),
        cand(C, 'Cy', { open: 15, cap: 15 }),
        cand(D, 'Di', { when: 'online', online: false })
      ],
      'fewest_open',
      opts
    )
    expect(p.winner).toBeNull()
    expect(p.skipped.map((s) => `${s.name}: ${s.reason}`)).toEqual([
      'Ann: account is not active',
      'Ben: out of office',
      'Cy: at their cap (15 of 15 open)',
      'Di: only takes requests while online, and is not'
    ])
    const after = pickPerson([cand(A, 'Ann', { when: 'business_hours' })], 'fewest_open', {
      ...opts,
      insideHours: false
    })
    expect(after.skipped[0].reason).toBe('only takes requests in business hours')
  })

  it('give it to their cover: the cover stands in with the cover’s numbers', () => {
    const coverStats = cand(D, 'Di', { open: 0 })
    const p = pickPerson(
      [
        cand(A, 'Ann', {
          out_of_office: true,
          cover: { id: D, name: 'Di', stats: coverStats },
          open: 7
        }),
        cand(B, 'Ben', { open: 2 })
      ],
      'fewest_open',
      { ...opts, giveToCover: true }
    )
    expect(p.winner).toEqual({ id: D, name: 'Di' })
    expect(p.ranking[0]).toEqual({ id: D, name: 'Di', measure: '0 open', for: 'Ann' })
    expect(p.skipped[0].reason).toBe('out of office — Di covers')
  })

  it('keepOrder takes the first one left (a step’s first owner)', () => {
    const p = pickPerson([cand(A, 'Ann', { open: 9 }), cand(B, 'Ben')], 'fewest_open', {
      ...opts,
      keepOrder: true
    })
    expect(p.winner?.name).toBe('Ann')
  })
})
