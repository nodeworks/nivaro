import { describe, expect, it } from 'vitest'
import { hoursWords, listWords, type RuleNames, ruleSentence } from './assign-rules-text'
import type { AssignRule } from './types'

const names: RuleNames = {
  type: (id) => ({ 3: 'Vendor change', 4: 'Access' })[id] ?? `#${id}`,
  collection: (c) => ({ workflows: 'Workflows' })[c] ?? c,
  field: (_c, f) => ({ zone: 'Zone' })[f] ?? f,
  value: (_c, _f, v) => ({ E1: 'East' })[v] ?? v,
  step: () => 'Review',
  person: (id) => ({ B: 'Beth', S: 'Sam', K: 'Kim', D: 'Dee' })[id] ?? 'someone',
  role: () => 'Approver',
  team: () => 'Finance'
}

const rule = (over: Partial<AssignRule>): AssignRule => ({
  id: 'r',
  name: 'R',
  active: true,
  match: 'all',
  conditions: [],
  action: { kind: 'person', user: 'B' },
  fallback: { kind: 'desk' },
  on_type_change: false,
  note: null,
  ...over
})

describe('rule sentences', () => {
  it('reads conditions, sharing strategy and caps as one sentence', () => {
    expect(
      ruleSentence(
        rule({
          conditions: [
            { kind: 'type', op: 'in', values: [3] },
            { kind: 'field', collection: 'workflows', field: 'zone', op: 'in', values: ['E1'] }
          ],
          action: {
            kind: 'share',
            people: [
              { id: 'B', cap: 15, when: 'always' },
              { id: 'S', cap: 15, when: 'always' },
              { id: 'K', cap: 15, when: 'always' }
            ],
            strategy: 'fewest_open',
            give_to_cover: false
          }
        }),
        names
      )
    ).toBe(
      'When the type is Vendor change and the record’s Zone is East, share it among Beth, Sam and Kim — whoever has the fewest open requests, max 15 each. If nobody can take it, it waits on the desk.'
    )
  })

  it('any-of conditions, a fallback person, and no conditions at all', () => {
    expect(
      ruleSentence(
        rule({
          match: 'any',
          conditions: [
            { kind: 'priority', op: 'in', values: ['urgent'] },
            { kind: 'hours', op: 'outside' }
          ],
          fallback: { kind: 'person', user: 'D' }
        }),
        names
      )
    ).toBe(
      'When the priority is urgent or it comes in outside business hours, give it to Beth. If nobody can take it, Dee does.'
    )
    expect(ruleSentence(rule({ action: { kind: 'team', team: 1 } }), names)).toBe(
      'For every request, send it to Finance’s desk, unassigned.'
    )
  })

  it('lists and hours', () => {
    expect(listWords(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c or 2 more')
    expect(hoursWords({ start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] })).toBe(
      'Mon–Fri, 8:00 AM – 6:00 PM Eastern'
    )
    expect(hoursWords({ start: '09:30', end: '13:00', days: [1, 3] })).toBe(
      'Mon, Wed, 9:30 AM – 1:00 PM Eastern'
    )
  })
})
