import {
  defaultBodyTemplate,
  defaultTicketBodyTemplate,
  defaultTicketTitleTemplate,
  defaultTitleTemplate
} from './templates.js'

export type ListOp = 'any' | 'all' | 'none'
export type SeverityName = 'low' | 'medium' | 'high' | 'critical'
export const SEVERITIES: SeverityName[] = ['low', 'medium', 'high', 'critical']
const SEVERITY_ALIASES: Record<string, SeverityName> = {
  info: 'low',
  warning: 'medium',
  error: 'high'
}

/** Real severity name for an issue or rule value; aliases map over, unknown ranks as medium. */
export function normalizeSeverity(s: string | null | undefined): SeverityName {
  const v = String(s ?? '')
    .trim()
    .toLowerCase()
  if ((SEVERITIES as string[]).includes(v)) return v as SeverityName
  return Object.hasOwn(SEVERITY_ALIASES, v) ? SEVERITY_ALIASES[v] : 'medium'
}
const knownSeverity = (s: string) =>
  (SEVERITIES as string[]).includes(s.toLowerCase()) ||
  Object.hasOwn(SEVERITY_ALIASES, s.toLowerCase())
const SEVERITY_HELP = `${SEVERITIES.join(', ')} (info, warning and error also work)`

/** Rules match text by words; regular expressions are refused (final review M1, final shape). */
export const NO_REGEX_MESSAGE =
  'Regular expressions are not supported in rules — use words, or * as a wildcard.'
/** A text term: at most 200 characters and 3 `*` wildcards. */
export const MAX_TERM_LENGTH = 200
export const MAX_TERM_WILDCARDS = 3

export interface RuleMatch {
  sources?: string[]
  severity_min?: SeverityName
  severities?: string[]
  statuses?: string[]
  text?: { op: ListOp; terms: string[]; in: Array<'title' | 'details'> }
  routes?: string[]
  collections?: string[]
  items?: string[]
  environments?: string[]
  release?: { equals?: string; new_in_current?: boolean }
  fingerprints?: string[]
  group_lead_ids?: number[]
  raised_by_roles?: string[]
  raised_by_users?: string[]
  assigned?: 'any' | 'assigned' | 'unassigned'
  has_screenshot?: boolean
  has_replay?: boolean
  min_age_minutes?: number
  max_age_minutes?: number
  /** Ticket rules: request type ids. */
  categories?: number[]
  /** Ticket rules: low | normal | urgent. */
  priorities?: string[]
}

/** What a rule is about: issue-log entries (default) or support tickets. */
export type RuleAppliesTo = 'issue' | 'ticket'
export const TICKET_RULE_PRIORITIES = ['low', 'normal', 'urgent']
/** Match conditions that only mean something for issue-log entries. */
const ISSUE_ONLY_MATCH = [
  'sources',
  'severity_min',
  'severities',
  'routes',
  'collections',
  'items',
  'environments',
  'release',
  'fingerprints',
  'group_lead_ids',
  'has_screenshot',
  'has_replay'
] as const

export interface RuleThreshold {
  hits?: { n: number; window_minutes: number }
  people?: { n: number; window_minutes: number }
  open_minutes?: number
  recurrences?: number
  total_hits?: number
}

export interface RuleGuards {
  per_hour: number
  per_day: number
  group: boolean
  quiet?: { from: string; to: string; days: number[]; tz: string }
  skip_linked: true
  skip_statuses: string[]
}

export interface RuleAction {
  connection: number
  project_id?: number
  issue_type: 'issue' | 'incident'
  labels: string[]
  assignee_ids: number[]
  map_assignee_by_email: boolean
  milestone_id?: number
  due_in_days?: number
  weight?: number
  confidential: boolean
  title_template: string
  body_template: string
  attach_screenshot: boolean
  attach_replay_link: boolean
  include_details: boolean
  assign_nivaro_to?: string
}

export interface TrackerRule {
  id: number
  /** Missing = 'issue' (validateRule always sets it). */
  applies_to?: RuleAppliesTo
  name: string
  enabled: boolean
  mode: 'create' | 'suggest'
  sort: number
  continue_after: boolean
  match: RuleMatch
  threshold: RuleThreshold
  guards: RuleGuards
  action: RuleAction
}

export type RuleError = { path: string; message: string }
export type ValidateResult =
  | { ok: true; rule: Omit<TrackerRule, 'id'> }
  | { ok: false; errors: RuleError[] }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function validateRule(raw: unknown): ValidateResult {
  const errors: RuleError[] = []
  const err = (path: string, message: string) => errors.push({ path, message })
  const src: Obj = isObj(raw) ? raw : {}
  if (!isObj(raw)) err('', 'The rule must be an object.')

  const strList = (v: unknown, path: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      err(path, 'Must be a list of text values.')
      return undefined
    }
    const out = (v as string[]).map((s) => s.trim()).filter(Boolean)
    return out.length ? out : undefined
  }
  const numList = (v: unknown, path: string): number[] | undefined => {
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x))) {
      err(path, 'Must be a list of whole numbers.')
      return undefined
    }
    return (v as number[]).length ? (v as number[]) : undefined
  }
  const int = (v: unknown, path: string, min: number, max: number, label: string) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      err(path, `${label} must be a whole number from ${min} to ${max}.`)
      return undefined
    }
    return v
  }
  const bool = (v: unknown, dflt: boolean, path: string): boolean => {
    if (v === undefined || v === null) return dflt
    if (typeof v !== 'boolean') {
      err(path, 'Must be on or off.')
      return dflt
    }
    return v
  }

  // name
  let name = ''
  if (typeof src.name !== 'string' || !src.name.trim()) err('name', 'Give the rule a name.')
  else if (src.name.trim().length > 200) err('name', 'The name can be at most 200 characters.')
  else name = src.name.trim()

  let applies_to: RuleAppliesTo = 'issue'
  if (src.applies_to !== undefined && src.applies_to !== null) {
    if (src.applies_to === 'issue' || src.applies_to === 'ticket') applies_to = src.applies_to
    else err('applies_to', 'Choose "issue" (the issue log) or "ticket" (support requests).')
  }
  const ticket = applies_to === 'ticket'

  const enabled = bool(src.enabled, false, 'enabled')
  const continue_after = bool(src.continue_after, false, 'continue_after')
  let mode: 'create' | 'suggest' = 'suggest'
  if (src.mode !== undefined && src.mode !== null) {
    if (src.mode === 'create' || src.mode === 'suggest') mode = src.mode
    else err('mode', 'Mode must be "create" or "suggest".')
  }
  let sort = 0
  if (src.sort !== undefined && src.sort !== null) {
    if (typeof src.sort === 'number' && Number.isFinite(src.sort)) sort = Math.trunc(src.sort)
    else err('sort', 'Order must be a number.')
  }

  // match
  const m: Obj = isObj(src.match) ? src.match : {}
  if (src.match !== undefined && src.match !== null && !isObj(src.match))
    err('match', 'Match must be an object.')
  const match: RuleMatch = {}
  const sources = strList(m.sources, 'match.sources')
  if (sources) match.sources = sources
  if (m.severity_min !== undefined && m.severity_min !== null) {
    if (typeof m.severity_min === 'string' && knownSeverity(m.severity_min))
      match.severity_min = normalizeSeverity(m.severity_min)
    else err('match.severity_min', `Unknown severity. Use one of: ${SEVERITY_HELP}.`)
  }
  const severities = strList(m.severities, 'match.severities')
  if (severities) {
    severities.forEach((s, i) => {
      if (!knownSeverity(s))
        err(`match.severities[${i}]`, `"${s}" is not a severity. Use one of: ${SEVERITY_HELP}.`)
    })
    match.severities = [...new Set(severities.filter(knownSeverity).map(normalizeSeverity))]
  }
  const statuses = strList(m.statuses, 'match.statuses')
  if (statuses) match.statuses = statuses
  if (m.text !== undefined && m.text !== null) {
    const t = m.text
    if (!isObj(t)) err('match.text', 'Text match must be an object.')
    else {
      const op = t.op === undefined ? 'any' : t.op
      if (op !== 'any' && op !== 'all' && op !== 'none')
        err('match.text.op', 'Choose "any", "all" or "none".')
      const terms = strList(t.terms, 'match.text.terms') ?? []
      // Stored or sent `regex: true` is refused: such a rule never runs and is listed as invalid.
      if (t.regex !== undefined && t.regex !== null && t.regex !== false)
        err('match.text', NO_REGEX_MESSAGE)
      let where: Array<'title' | 'details'> = ['title', 'details']
      if (t.in !== undefined && t.in !== null) {
        if (
          Array.isArray(t.in) &&
          t.in.length > 0 &&
          t.in.every((x) => x === 'title' || x === 'details')
        )
          where = [...new Set(t.in as Array<'title' | 'details'>)]
        else err('match.text.in', 'Choose where to look: "title", "details" or both.')
      }
      terms.forEach((term, i) => {
        if (term.length > MAX_TERM_LENGTH)
          err(`match.text.terms[${i}]`, 'A term can be at most 200 characters.')
        else if ((term.match(/\*/g)?.length ?? 0) > MAX_TERM_WILDCARDS)
          err(`match.text.terms[${i}]`, 'A term can use * at most 3 times.')
        else if (!term.replace(/\*/g, '').trim())
          err(`match.text.terms[${i}]`, 'A term needs some text besides *.')
      })
      if (terms.length) match.text = { op: op as ListOp, terms, in: where }
    }
  }
  const routes = strList(m.routes, 'match.routes')
  if (routes) match.routes = routes
  const collections = strList(m.collections, 'match.collections')
  if (collections) match.collections = collections
  const items = strList(m.items, 'match.items')
  if (items) match.items = items
  const environments = strList(m.environments, 'match.environments')
  if (environments) match.environments = environments
  if (m.release !== undefined && m.release !== null) {
    if (!isObj(m.release)) err('match.release', 'Release match must be an object.')
    else {
      const rel: { equals?: string; new_in_current?: boolean } = {}
      if (m.release.equals !== undefined && m.release.equals !== null && m.release.equals !== '') {
        if (typeof m.release.equals === 'string') rel.equals = m.release.equals.trim()
        else err('match.release.equals', 'The build must be text.')
      }
      if (m.release.new_in_current !== undefined && m.release.new_in_current !== null) {
        rel.new_in_current = bool(m.release.new_in_current, false, 'match.release.new_in_current')
      }
      if (rel.equals || rel.new_in_current) match.release = rel
    }
  }
  const fingerprints = strList(m.fingerprints, 'match.fingerprints')
  if (fingerprints) match.fingerprints = fingerprints
  const leads = numList(m.group_lead_ids, 'match.group_lead_ids')
  if (leads) match.group_lead_ids = leads
  const roles = strList(m.raised_by_roles, 'match.raised_by_roles')
  if (roles) match.raised_by_roles = roles
  const users = strList(m.raised_by_users, 'match.raised_by_users')
  if (users) match.raised_by_users = users
  if (m.assigned !== undefined && m.assigned !== null) {
    if (m.assigned === 'any' || m.assigned === 'assigned' || m.assigned === 'unassigned')
      match.assigned = m.assigned
    else err('match.assigned', 'Choose "any", "assigned" or "unassigned".')
  }
  for (const k of ['has_screenshot', 'has_replay'] as const) {
    if (m[k] !== undefined && m[k] !== null) match[k] = bool(m[k], false, `match.${k}`)
  }
  for (const k of ['min_age_minutes', 'max_age_minutes'] as const) {
    if (m[k] !== undefined && m[k] !== null) {
      const v = int(m[k], `match.${k}`, 0, 100000000, 'Age')
      if (v !== undefined) match[k] = v
    }
  }
  if (
    match.min_age_minutes !== undefined &&
    match.max_age_minutes !== undefined &&
    match.min_age_minutes > match.max_age_minutes
  )
    err('match.min_age_minutes', 'The minimum age cannot be larger than the maximum age.')
  const categories = numList(m.categories, 'match.categories')
  const priorities = strList(m.priorities, 'match.priorities')
  if (ticket) {
    if (categories) match.categories = categories
    if (priorities) {
      priorities.forEach((p, i) => {
        if (!TICKET_RULE_PRIORITIES.includes(p.toLowerCase()))
          err(`match.priorities[${i}]`, `"${p}" is not a priority. Use low, normal or urgent.`)
      })
      match.priorities = [...new Set(priorities.map((p) => p.toLowerCase()))]
    }
    for (const k of ISSUE_ONLY_MATCH)
      if (match[k] !== undefined)
        err(
          `match.${k}`,
          'This condition is for issue-log rules — support requests do not have it.'
        )
  } else {
    if (categories) err('match.categories', 'Request types are for support-request rules.')
    if (priorities) err('match.priorities', 'Request priorities are for support-request rules.')
  }

  // threshold
  const th: Obj = isObj(src.threshold) ? src.threshold : {}
  if (src.threshold !== undefined && src.threshold !== null && !isObj(src.threshold))
    err('threshold', 'Threshold must be an object.')
  const threshold: RuleThreshold = {}
  for (const k of ['hits', 'people'] as const) {
    const w = th[k]
    if (w === undefined || w === null) continue
    if (!isObj(w)) {
      err(`threshold.${k}`, 'Must have a count and a window.')
      continue
    }
    const n = int(w.n, `threshold.${k}.n`, 1, 100000000, 'The count')
    const win = int(
      w.window_minutes,
      `threshold.${k}.window_minutes`,
      5,
      43200,
      'The window (minutes)'
    )
    if (n !== undefined && win !== undefined) threshold[k] = { n, window_minutes: win }
  }
  for (const k of ['open_minutes', 'recurrences', 'total_hits'] as const) {
    if (th[k] === undefined || th[k] === null) continue
    const v = int(th[k], `threshold.${k}`, 1, 100000000, 'This value')
    if (v !== undefined) threshold[k] = v
  }
  if (ticket)
    for (const k of ['hits', 'people', 'recurrences', 'total_hits'] as const)
      if (threshold[k] !== undefined)
        err(
          `threshold.${k}`,
          'Hit and people counts apply to issue-log rules only — a support request has none.'
        )

  // guards
  const g: Obj = isObj(src.guards) ? src.guards : {}
  if (src.guards !== undefined && src.guards !== null && !isObj(src.guards))
    err('guards', 'Guards must be an object.')
  const per_hour =
    g.per_hour === undefined || g.per_hour === null
      ? 5
      : (int(g.per_hour, 'guards.per_hour', 1, 1000, 'The hourly limit') ?? 5)
  const per_day =
    g.per_day === undefined || g.per_day === null
      ? 20
      : (int(g.per_day, 'guards.per_day', 1, 1000, 'The daily limit') ?? 20)
  const guards: RuleGuards = {
    per_hour,
    per_day,
    group: bool(g.group, true, 'guards.group'),
    skip_linked: true,
    skip_statuses: ticket ? ['done', 'cancelled'] : ['resolved', 'closed']
  }
  if (g.skip_linked === false)
    err('guards.skip_linked', 'Issues that already have a GitLab issue are always skipped.')
  if (g.skip_statuses !== undefined && g.skip_statuses !== null) {
    const s = strList(g.skip_statuses, 'guards.skip_statuses')
    guards.skip_statuses = s ?? []
  }
  if (g.quiet !== undefined && g.quiet !== null) {
    const q = g.quiet
    if (!isObj(q)) err('guards.quiet', 'Quiet hours must be an object.')
    else {
      const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
      let ok = true
      for (const k of ['from', 'to'] as const) {
        if (typeof q[k] !== 'string' || !hhmm.test(q[k] as string)) {
          err(`guards.quiet.${k}`, 'Use a 24-hour time like 22:00.')
          ok = false
        }
      }
      if (ok && q.from === q.to) {
        err('guards.quiet.to', 'The end time must differ from the start time.')
        ok = false
      }
      let days: number[] = [0, 1, 2, 3, 4, 5, 6]
      if (q.days !== undefined && q.days !== null) {
        if (Array.isArray(q.days) && q.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
          days = [...new Set(q.days as number[])].sort()
        else {
          err('guards.quiet.days', 'Days must be numbers from 0 (Sunday) to 6 (Saturday).')
          ok = false
        }
      }
      let tz = 'America/New_York'
      if (q.tz !== undefined && q.tz !== null && q.tz !== '') {
        if (typeof q.tz === 'string' && isValidTimeZone(q.tz)) tz = q.tz
        else {
          err('guards.quiet.tz', 'This is not a known time zone. Use a name like America/New_York.')
          ok = false
        }
      }
      if (ok) guards.quiet = { from: q.from as string, to: q.to as string, days, tz }
    }
  }

  // action
  const a: Obj = isObj(src.action) ? src.action : {}
  if (!isObj(src.action)) err('action', 'Choose what to do when the rule matches.')
  let connection = 0
  if (!Number.isInteger(a.connection) || (a.connection as number) < 1)
    err('action.connection', 'Choose a GitLab connection.')
  else connection = a.connection as number
  let issue_type: 'issue' | 'incident' = 'issue'
  if (a.issue_type !== undefined && a.issue_type !== null) {
    if (a.issue_type === 'issue' || a.issue_type === 'incident') issue_type = a.issue_type
    else err('action.issue_type', 'Choose "issue" or "incident".')
  }
  const action: RuleAction = {
    connection,
    issue_type,
    labels: strList(a.labels, 'action.labels') ?? [],
    assignee_ids: numList(a.assignee_ids, 'action.assignee_ids') ?? [],
    map_assignee_by_email: bool(a.map_assignee_by_email, false, 'action.map_assignee_by_email'),
    confidential: bool(a.confidential, false, 'action.confidential'),
    title_template:
      typeof a.title_template === 'string' && a.title_template.trim()
        ? a.title_template
        : ticket
          ? defaultTicketTitleTemplate()
          : defaultTitleTemplate(),
    body_template:
      typeof a.body_template === 'string' && a.body_template.trim()
        ? a.body_template
        : ticket
          ? defaultTicketBodyTemplate()
          : defaultBodyTemplate(),
    attach_screenshot: bool(a.attach_screenshot, false, 'action.attach_screenshot'),
    attach_replay_link: bool(a.attach_replay_link, false, 'action.attach_replay_link'),
    include_details: bool(a.include_details, true, 'action.include_details')
  }
  if (a.project_id !== undefined && a.project_id !== null) {
    const v = int(a.project_id, 'action.project_id', 1, Number.MAX_SAFE_INTEGER, 'The project id')
    if (v !== undefined) action.project_id = v
  }
  if (a.milestone_id !== undefined && a.milestone_id !== null) {
    const v = int(
      a.milestone_id,
      'action.milestone_id',
      1,
      Number.MAX_SAFE_INTEGER,
      'The milestone id'
    )
    if (v !== undefined) action.milestone_id = v
  }
  if (a.due_in_days !== undefined && a.due_in_days !== null) {
    const v = int(a.due_in_days, 'action.due_in_days', 0, 3650, 'Due in days')
    if (v !== undefined) action.due_in_days = v
  }
  if (a.weight !== undefined && a.weight !== null) {
    const v = int(a.weight, 'action.weight', 0, 1000000, 'Weight')
    if (v !== undefined) action.weight = v
  }
  if (typeof a.assign_nivaro_to === 'string' && a.assign_nivaro_to.trim())
    action.assign_nivaro_to = a.assign_nivaro_to.trim()

  const FORBIDDEN_TAG = /\{%-?\s*(include|render|layout)\b/
  for (const k of ['title_template', 'body_template'] as const) {
    if (typeof a[k] === 'string' && FORBIDDEN_TAG.test(a[k] as string))
      err(`action.${k}`, 'include, render and layout are not available in issue templates.')
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    rule: {
      applies_to,
      name,
      enabled,
      mode,
      sort,
      continue_after,
      match,
      threshold,
      guards,
      action
    }
  }
}
