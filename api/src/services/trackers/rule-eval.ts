// Pure rule evaluation: no database, no network.
import {
  isRiskyRegex,
  normalizeSeverity,
  type RuleGuards,
  SEVERITIES,
  type TrackerRule
} from './rules.js'

export interface IssueFacts {
  id: number
  title: string
  details: string | null
  severity: string
  status: string
  source: string
  route: string | null
  collection: string | null
  item: string | null
  environment: string | null
  build: string | null
  current_build: string
  first_build: string | null
  fingerprint: string | null
  group_lead_id: number | null
  raised_by: string | null
  raised_by_role: string | null
  assigned_to: string | null
  has_screenshot: boolean
  has_replay: boolean
  created_at: Date
  linked: boolean
  recurrences: number
  total_hits: number
}

export interface Counts {
  hits(windowMin: number): number
  people(windowMin: number): number
}

export interface GuardState {
  firedLastHour: number
  firedLastDay: number
  connectionLastHour: number
  connectionCap: number
}

export type Outcome =
  | { act: 'fire' | 'suggest' }
  | {
      act: 'skip'
      outcome: 'no_match' | 'threshold' | 'cap' | 'quiet' | 'linked' | 'status'
      detail: string
    }

const TEXT_CAP = 5000
const REGEX_INPUT_CAP = 2000

const severityRank = (s: string) => SEVERITIES.indexOf(normalizeSeverity(s))

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`, 'i')
}

const ci = (a: string | null | undefined, list: string[]) =>
  a != null && list.some((x) => x.toLowerCase() === a.toLowerCase())

/** Returns null when the rule matches, else a short reason. */
function matchReason(rule: TrackerRule, f: IssueFacts, now: Date): string | null {
  const m = rule.match
  if (m.sources?.length && !ci(f.source, m.sources))
    return `Source "${f.source}" is not one of the chosen sources`
  if (m.severity_min && severityRank(f.severity) < severityRank(m.severity_min))
    return `Severity ${f.severity} is below ${m.severity_min}`
  if (
    m.severities?.length &&
    !m.severities.some((s) => normalizeSeverity(s) === normalizeSeverity(f.severity))
  )
    return `Severity ${f.severity} is not one of the chosen severities`
  if (m.statuses?.length && !ci(f.status, m.statuses))
    return `Status "${f.status}" is not one of the chosen statuses`
  if (m.text?.terms.length) {
    const t = m.text
    const hay: string[] = []
    const where = t.in?.length ? t.in : ['title', 'details']
    const cap = t.regex ? REGEX_INPUT_CAP : TEXT_CAP
    if (where.includes('title')) hay.push((f.title ?? '').slice(0, cap))
    if (where.includes('details')) hay.push((f.details ?? '').slice(0, cap))
    // Compile once per evaluation, not once per haystack.
    const tests: Array<(h: string) => boolean> = t.terms.map((term) => {
      if (!t.regex) {
        const needle = term.toLowerCase()
        return (h) => h.toLowerCase().includes(needle)
      }
      // A stored pattern outside the safe subset never runs (final review M1).
      if (isRiskyRegex(term)) return () => false
      try {
        const re = new RegExp(term, 'i')
        return (h) => re.test(h)
      } catch {
        return () => false
      }
    })
    const hits = tests.map((fn) => hay.some(fn))
    if (t.op === 'any' && !hits.some(Boolean)) return 'None of the text terms were found'
    if (t.op === 'all' && !hits.every(Boolean)) return 'Not all of the text terms were found'
    if (t.op === 'none' && hits.some(Boolean)) return 'An excluded text term was found'
  }
  if (m.routes?.length) {
    if (!f.route || !m.routes.some((g) => globToRegExp(g).test(f.route as string)))
      return 'The route does not match'
  }
  if (m.collections?.length && !ci(f.collection, m.collections))
    return 'The collection does not match'
  if (m.items?.length && !ci(f.item, m.items)) return 'The record does not match'
  if (m.environments?.length && !ci(f.environment, m.environments))
    return 'The environment does not match'
  if (m.release?.equals && f.build !== m.release.equals) return 'The build does not match'
  if (m.release?.new_in_current && f.first_build !== f.current_build)
    return 'It was already seen before the current release'
  if (m.fingerprints?.length && !ci(f.fingerprint, m.fingerprints))
    return 'The fingerprint does not match'
  if (
    m.group_lead_ids?.length &&
    (f.group_lead_id == null || !m.group_lead_ids.includes(f.group_lead_id))
  )
    return 'It is not in the chosen issue group'
  if (m.raised_by_roles?.length && !ci(f.raised_by_role, m.raised_by_roles))
    return 'The role of the person who raised it does not match'
  if (m.raised_by_users?.length && !ci(f.raised_by, m.raised_by_users))
    return 'The person who raised it does not match'
  if (m.assigned === 'assigned' && !f.assigned_to) return 'It is not assigned'
  if (m.assigned === 'unassigned' && f.assigned_to) return 'It is already assigned'
  if (m.has_screenshot !== undefined && f.has_screenshot !== m.has_screenshot)
    return m.has_screenshot ? 'It has no screenshot' : 'It has a screenshot'
  if (m.has_replay !== undefined && f.has_replay !== m.has_replay)
    return m.has_replay ? 'It has no replay' : 'It has a replay'
  const ageMin = (now.getTime() - f.created_at.getTime()) / 60000
  if (m.min_age_minutes !== undefined && ageMin < m.min_age_minutes)
    return `Only ${Math.floor(ageMin)} min old — needs ${m.min_age_minutes}`
  if (m.max_age_minutes !== undefined && ageMin > m.max_age_minutes)
    return `Older than ${m.max_age_minutes} min`
  return null
}

function thresholdReason(rule: TrackerRule, f: IssueFacts, c: Counts, now: Date): string | null {
  const t = rule.threshold
  if (t.hits) {
    const n = c.hits(t.hits.window_minutes)
    if (n < t.hits.n) return `Seen ${n} times in ${t.hits.window_minutes} min — needs ${t.hits.n}`
  }
  if (t.people) {
    const n = c.people(t.people.window_minutes)
    if (n < t.people.n)
      return `Seen by ${n} people in ${t.people.window_minutes} min — needs ${t.people.n}`
  }
  if (t.open_minutes !== undefined) {
    const open = Math.floor((now.getTime() - f.created_at.getTime()) / 60000)
    if (open < t.open_minutes) return `Open for ${open} min — needs ${t.open_minutes}`
  }
  if (t.recurrences !== undefined && f.recurrences < t.recurrences)
    return `Came back ${f.recurrences} times — needs ${t.recurrences}`
  if (t.total_hits !== undefined && f.total_hits < t.total_hits)
    return `Seen ${f.total_hits} times in total — needs ${t.total_hits}`
  return null
}

function localParts(tz: string, now: Date): { weekday: number; minutes: number; seconds: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return {
    weekday: wd,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    seconds: Number(get('second'))
  }
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Minutes until the current quiet window ends, or null when not in quiet hours. */
function quietRemaining(q: NonNullable<RuleGuards['quiet']>, now: Date): number | null {
  const { weekday, minutes } = localParts(q.tz, now)
  const from = toMin(q.from)
  const to = toMin(q.to)
  const days = q.days?.length ? q.days : [0, 1, 2, 3, 4, 5, 6]
  if (from < to) {
    if (minutes >= from && minutes < to && days.includes(weekday)) return to - minutes
    return null
  }
  // Crosses midnight: the early-morning part belongs to the day the window started.
  if (minutes >= from) return days.includes(weekday) ? 24 * 60 - minutes + to : null
  if (minutes < to) return days.includes((weekday + 6) % 7) ? to - minutes : null
  return null
}

export function nextQuietEnd(q: NonNullable<RuleGuards['quiet']>, now: Date): Date | null {
  const rem = quietRemaining(q, now)
  if (rem === null) return null
  const { seconds } = localParts(q.tz, now)
  const flooredToMinute = now.getTime() - seconds * 1000 - now.getUTCMilliseconds()
  return new Date(flooredToMinute + rem * 60000)
}

export function evaluateRule(
  rule: TrackerRule,
  f: IssueFacts,
  c: Counts,
  g: GuardState,
  now: Date
): Outcome {
  const noMatch = matchReason(rule, f, now)
  if (noMatch) return { act: 'skip', outcome: 'no_match', detail: noMatch }

  if (rule.guards.skip_statuses.some((s) => s.toLowerCase() === f.status.toLowerCase()))
    return {
      act: 'skip',
      outcome: 'status',
      detail: `Status is "${f.status}", which this rule skips`
    }

  if (rule.guards.skip_linked && f.linked)
    return { act: 'skip', outcome: 'linked', detail: 'Already linked to a GitLab issue' }

  const th = thresholdReason(rule, f, c, now)
  if (th) return { act: 'skip', outcome: 'threshold', detail: th }

  return guardOutcome(rule, g, now)
}

/** Quiet hours, then the caps; else fire / suggest. Shared by issue and ticket rules. */
function guardOutcome(rule: TrackerRule, g: GuardState, now: Date): Outcome {
  if (rule.guards.quiet) {
    const end = nextQuietEnd(rule.guards.quiet, now)
    if (end)
      return {
        act: 'skip',
        outcome: 'quiet',
        detail: `Quiet hours until ${rule.guards.quiet.to} ${rule.guards.quiet.tz}`
      }
  }

  if (g.firedLastHour >= rule.guards.per_hour)
    return {
      act: 'skip',
      outcome: 'cap',
      detail: `Rule already opened ${g.firedLastHour} in the last hour (limit ${rule.guards.per_hour})`
    }
  if (g.firedLastDay >= rule.guards.per_day)
    return {
      act: 'skip',
      outcome: 'cap',
      detail: `Rule already opened ${g.firedLastDay} in the last day (limit ${rule.guards.per_day})`
    }
  if (g.connectionLastHour >= g.connectionCap)
    return {
      act: 'skip',
      outcome: 'cap',
      detail: `Connection already sent ${g.connectionLastHour} in the last hour (limit ${g.connectionCap})`
    }

  return { act: rule.mode === 'suggest' ? 'suggest' : 'fire' }
}

// ── Support-ticket rules ──────────────────────────────────────────────────────

export interface TicketFacts {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  category_id: number | null
  requester: string | null
  requester_role: string | null
  assignee: string | null
  created_at: Date
  linked: boolean
}

/** Returns null when the ticket rule matches, else a short reason. */
function ticketMatchReason(rule: TrackerRule, f: TicketFacts, now: Date): string | null {
  const m = rule.match
  if (m.categories?.length && (f.category_id == null || !m.categories.includes(f.category_id)))
    return 'The request type is not one of the chosen types'
  if (m.priorities?.length && !ci(f.priority, m.priorities))
    return `Priority "${f.priority}" is not one of the chosen priorities`
  if (m.statuses?.length && !ci(f.status, m.statuses))
    return `Status "${f.status}" is not one of the chosen statuses`
  if (m.text?.terms.length) {
    const t = m.text
    const where = t.in?.length ? t.in : ['title', 'details']
    const cap = t.regex ? REGEX_INPUT_CAP : TEXT_CAP
    const hay: string[] = []
    if (where.includes('title')) hay.push((f.title ?? '').slice(0, cap))
    if (where.includes('details')) hay.push((f.description ?? '').slice(0, cap))
    const tests: Array<(h: string) => boolean> = t.terms.map((term) => {
      if (!t.regex) {
        const needle = term.toLowerCase()
        return (h) => h.toLowerCase().includes(needle)
      }
      // A stored pattern outside the safe subset never runs (final review M1).
      if (isRiskyRegex(term)) return () => false
      try {
        const re = new RegExp(term, 'i')
        return (h) => re.test(h)
      } catch {
        return () => false
      }
    })
    const hits = tests.map((fn) => hay.some(fn))
    if (t.op === 'any' && !hits.some(Boolean)) return 'None of the text terms were found'
    if (t.op === 'all' && !hits.every(Boolean)) return 'Not all of the text terms were found'
    if (t.op === 'none' && hits.some(Boolean)) return 'An excluded text term was found'
  }
  if (m.raised_by_roles?.length && !ci(f.requester_role, m.raised_by_roles))
    return 'The role of the requester does not match'
  if (m.raised_by_users?.length && !ci(f.requester, m.raised_by_users))
    return 'The requester does not match'
  if (m.assigned === 'assigned' && !f.assignee) return 'It is not assigned'
  if (m.assigned === 'unassigned' && f.assignee) return 'It is already assigned'
  const ageMin = (now.getTime() - f.created_at.getTime()) / 60000
  if (m.min_age_minutes !== undefined && ageMin < m.min_age_minutes)
    return `Only ${Math.floor(ageMin)} min old — needs ${m.min_age_minutes}`
  if (m.max_age_minutes !== undefined && ageMin > m.max_age_minutes)
    return `Older than ${m.max_age_minutes} min`
  return null
}

/**
 * A support-ticket rule against one ticket: match, skip statuses, already linked, open for at
 * least N minutes (the only threshold that applies — tickets have no hits), quiet hours, caps.
 */
export function evaluateTicketRule(
  rule: TrackerRule,
  f: TicketFacts,
  g: GuardState,
  now: Date
): Outcome {
  const noMatch = ticketMatchReason(rule, f, now)
  if (noMatch) return { act: 'skip', outcome: 'no_match', detail: noMatch }
  if (rule.guards.skip_statuses.some((s) => s.toLowerCase() === f.status.toLowerCase()))
    return {
      act: 'skip',
      outcome: 'status',
      detail: `Status is "${f.status}", which this rule skips`
    }
  if (rule.guards.skip_linked && f.linked)
    return { act: 'skip', outcome: 'linked', detail: 'Already linked to a GitLab issue' }
  const t = rule.threshold
  if (t.open_minutes !== undefined) {
    const open = Math.floor((now.getTime() - f.created_at.getTime()) / 60000)
    if (open < t.open_minutes)
      return {
        act: 'skip',
        outcome: 'threshold',
        detail: `Open for ${open} min — needs ${t.open_minutes}`
      }
  }
  return guardOutcome(rule, g, now)
}
