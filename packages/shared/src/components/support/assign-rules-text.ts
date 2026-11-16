/**
 * Auto-assign rules in words (pure). The editor's list reads each rule as a
 * sentence — "When the type is Vendor change and the record's Zone is East,
 * share it among Beth, Sam and Kim — whoever has the fewest open requests, max
 * 15 each." Matching is the server's (POST /support/assign-rules/test).
 */
import type {
  AssignAction,
  AssignCondition,
  AssignFieldOp,
  AssignHours,
  AssignRule,
  AssignSource,
  AssignStrategy
} from './types'

export interface RuleNames {
  type: (id: number) => string
  collection: (name: string) => string
  field: (collection: string, field: string) => string
  /** A field's value as the person would read it (a related record's name, a choice label). */
  value: (collection: string, field: string, value: string) => string
  step: (id: string) => string
  person: (id: string) => string
  role: (id: string) => string
  team: (id: number) => string
}

export const STRATEGY_OPTIONS: Array<{
  value: AssignStrategy
  label: string
  description: string
}> = [
  {
    value: 'fewest_open',
    label: 'Fewest open requests',
    description: 'Whoever has the least on their plate right now.'
  },
  {
    value: 'least_recent',
    label: 'Least recently assigned',
    description: 'Fair turns: whoever has gone longest without a new request.'
  },
  {
    value: 'fewest_today',
    label: 'Fewest assigned today',
    description: 'Evens out the day: counts requests given to each person since midnight.'
  },
  {
    value: 'fewest_week',
    label: 'Fewest assigned this week',
    description: 'Evens out the week (from Monday).'
  },
  {
    value: 'fewest_urgent',
    label: 'Fewest urgent open requests',
    description: 'Keeps urgent work spread out.'
  },
  {
    value: 'most_closed_type',
    label: 'Most experience with this kind',
    description:
      'Whoever has closed the most requests of this type (or for this kind of record). Ties: fewest open.'
  },
  {
    value: 'last_helped',
    label: 'Whoever last helped this person',
    description: 'Keeps the same requester with the same helper. Nobody has yet: fewest open.'
  },
  {
    value: 'step_owner',
    label: 'The record’s step owner, if listed',
    description: 'Someone on the list who owns the record’s current step. None: fewest open.'
  },
  {
    value: 'random',
    label: 'Random',
    description: 'Anyone on the list who can take it.'
  }
]

export const STRATEGY_PHRASE: Record<AssignStrategy, string> = {
  fewest_open: 'whoever has the fewest open requests',
  least_recent: 'whoever was assigned least recently',
  fewest_today: 'whoever was given the fewest today',
  fewest_week: 'whoever was given the fewest this week',
  fewest_urgent: 'whoever has the fewest urgent requests',
  most_closed_type: 'whoever has closed the most of this kind',
  last_helped: 'whoever last helped this requester',
  step_owner: 'the record’s step owner if they are listed',
  random: 'at random'
}

export const SOURCE_LABELS: Record<AssignSource, string> = {
  general: 'Get help',
  record: 'a record’s Request help',
  error: 'an error’s Get help',
  report_problem: 'Report a problem'
}

/** "A", "A or B", "A, B or C" (`and` for every-of lists). */
export function listWords(items: string[], joiner: 'or' | 'and' = 'or'): string {
  const list = items.filter(Boolean)
  if (list.length <= 1) return list[0] ?? ''
  if (list.length > 4) return `${list.slice(0, 3).join(', ')} ${joiner} ${list.length - 3} more`
  return `${list.slice(0, -1).join(', ')} ${joiner} ${list.at(-1)}`
}

const FIELD_OP_WORDS: Record<AssignFieldOp, string> = {
  is: 'is',
  is_not: 'is not',
  in: 'is',
  not_in: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  empty: 'is empty',
  not_empty: 'is filled in',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most'
}

export function conditionWords(c: AssignCondition, n: RuleNames): string {
  const set = (op: 'in' | 'not_in', words: string[]) =>
    `${op === 'in' ? 'is' : 'is not'} ${listWords(words)}`
  switch (c.kind) {
    case 'type':
      return `the type ${set(c.op, c.values.map(n.type))}`
    case 'about':
      return c.op === 'general'
        ? 'it is General Support (not about a record)'
        : c.collections.length
          ? `it is about ${listWords(c.collections.map(n.collection))}`
          : 'it is about a record'
    case 'field': {
      const f = n.field(c.collection, c.field)
      const op = FIELD_OP_WORDS[c.op]
      if (c.op === 'empty' || c.op === 'not_empty') return `the record’s ${f} ${op}`
      const vals = c.values.map((v) => n.value(c.collection, c.field, v))
      return `the record’s ${f} ${op} ${listWords(vals, c.op === 'not_in' || c.op === 'is_not' ? 'or' : 'or')}`
    }
    case 'step':
      return `the record’s step ${set(c.op, c.states.map(n.step))}`
    case 'requester':
      return `${listWords(c.users.map(n.person))} ${c.op === 'in' ? (c.users.length > 1 ? 'raised it' : 'raised it') : 'did not raise it'}`
    case 'requester_role':
      return `the requester’s role ${set(c.op, c.roles.map(n.role))}`
    case 'requester_team':
      return `the requester ${c.op === 'in' ? 'is' : 'is not'} in ${listWords(c.teams.map(n.team))}`
    case 'priority':
      return `the priority ${set(c.op, c.values)}`
    case 'text': {
      const w = c.words.map((x) => `“${x}”`)
      return c.op === 'any'
        ? `the title or description mentions ${listWords(w)}`
        : c.op === 'all'
          ? `the title or description mentions ${listWords(w, 'and')}`
          : `the title and description never mention ${listWords(w)}`
    }
    case 'source':
      return `it was raised from ${c.op === 'not_in' ? 'anywhere but ' : ''}${listWords(c.values.map((v) => SOURCE_LABELS[v]))}`
    case 'hours':
      return c.op === 'inside'
        ? 'it comes in during business hours'
        : 'it comes in outside business hours'
  }
}

export function actionWords(a: AssignAction, n: RuleNames): string {
  switch (a.kind) {
    case 'person':
      return `give it to ${n.person(a.user)}`
    case 'team':
      return `send it to ${n.team(a.team)}’s desk, unassigned`
    case 'step_owner':
      return a.pick === 'first'
        ? 'give it to the record’s step owner (the first one)'
        : 'give it to the record’s step owner with the fewest open requests'
    case 'share': {
      const names = listWords(
        a.people.map((p) => n.person(p.id)),
        'and'
      )
      const caps = [...new Set(a.people.map((p) => p.cap))]
      const capText =
        caps.length === 1 && caps[0] != null
          ? `, max ${caps[0]} each`
          : a.people.some((p) => p.cap != null)
            ? ', some with a cap'
            : ''
      const limited = a.people.some((p) => p.when !== 'always')
        ? ', some only at certain times'
        : ''
      const cover = a.give_to_cover ? '; someone out of office hands it to their cover' : ''
      return `share it among ${names} — ${STRATEGY_PHRASE[a.strategy]}${capText}${limited}${cover}`
    }
  }
}

/** The whole rule as one sentence. */
export function ruleSentence(r: AssignRule, n: RuleNames): string {
  const when = r.conditions.length
    ? `When ${listWords(
        r.conditions.map((c) => conditionWords(c, n)),
        r.match === 'all' ? 'and' : 'or'
      )}, `
    : 'For every request, '
  const fallback =
    r.fallback.kind === 'person'
      ? ` If nobody can take it, ${n.person(r.fallback.user)} does.`
      : r.action.kind === 'team'
        ? ''
        : ' If nobody can take it, it waits on the desk.'
  return `${when}${actionWords(r.action, n)}.${fallback}`
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "8:00 AM" from "08:00". */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** "Mon–Fri, 8:00 AM – 6:00 PM Eastern". */
export function hoursWords(h: AssignHours): string {
  const days = [...h.days].sort()
  const run =
    days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1)
      ? `${DAY[days[0]]}–${DAY[days.at(-1)!]}`
      : days.map((d) => DAY[d]).join(', ')
  return `${run}, ${clock12(h.start)} – ${clock12(h.end)} Eastern`
}

/** A fresh rule for "Add a rule". */
export function blankRule(n: number): AssignRule {
  return {
    id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    name: `Rule ${n}`,
    active: true,
    match: 'all',
    conditions: [],
    action: { kind: 'share', people: [], strategy: 'fewest_open', give_to_cover: true },
    fallback: { kind: 'desk' },
    on_type_change: false,
    note: null
  }
}
