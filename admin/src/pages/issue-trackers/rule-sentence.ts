import type {
  RuleAction,
  RuleAppliesTo,
  RuleDraft,
  RuleMatch,
  RuleThreshold,
  SourceSwitches,
  TrackerRule
} from './api'

/**
 * GitLab sync rules — the pure side of the builder: the sentence a rule reads
 * as, new-rule defaults, which conditions belong to which kind, and the body
 * sent to the server. api/src/services/trackers/rules.ts (validateRule) is the
 * source of truth for every shape and limit here.
 */

// ── Durations ───────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** 60 → "1 hour", 90 → "90 minutes", 2880 → "2 days". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m >= 1440 && m % 1440 === 0) return plural(m / 1440, 'day')
  if (m >= 60 && m % 60 === 0) return plural(m / 60, 'hour')
  return plural(m, 'minute')
}

/** Durations a window or age can be picked in, with their minute factor. */
export const DURATION_UNITS = [
  { key: 'minutes', label: 'minutes', factor: 1 },
  { key: 'hours', label: 'hours', factor: 60 },
  { key: 'days', label: 'days', factor: 1440 }
] as const
export type DurationUnit = (typeof DURATION_UNITS)[number]['key']

/** The largest whole unit a minute count divides into (for an amount + unit editor). */
export function splitDuration(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes >= 1440 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: 'days' }
  if (minutes >= 60 && minutes % 60 === 0) return { amount: minutes / 60, unit: 'hours' }
  return { amount: minutes, unit: 'minutes' }
}

// ── Which conditions apply to which kind ───────────────────────────────────

/** Match conditions only issue-log entries have (rules.ts ISSUE_ONLY_MATCH). */
export const ISSUE_ONLY_MATCH: Array<keyof RuleMatch> = [
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
]
/** Match conditions only support-ticket rules have. */
export const TICKET_ONLY_MATCH: Array<keyof RuleMatch> = ['categories', 'priorities']
/** Thresholds a support ticket has (no hits, people or recurrences). */
export const TICKET_THRESHOLDS: Array<keyof RuleThreshold> = ['open_minutes']

export function isValidMatchKey(kind: RuleAppliesTo, key: keyof RuleMatch): boolean {
  return kind === 'ticket' ? !ISSUE_ONLY_MATCH.includes(key) : !TICKET_ONLY_MATCH.includes(key)
}

export const ISSUE_SOURCES = ['client', 'crash', 'server', 'monitor', 'manual']
export const ISSUE_STATUSES = ['open', 'in_progress', 'resolved', 'closed']
export const TICKET_STATUSES = ['open', 'in_progress', 'done', 'cancelled']
export const TICKET_RULE_PRIORITIES = ['low', 'normal', 'urgent']

/** The kinds a rule on this connection can be about: those whose source is switched on. */
export function appliesToChoices(sources: SourceSwitches | undefined): RuleAppliesTo[] {
  const out: RuleAppliesTo[] = []
  if (sources?.issue !== false) out.push('issue')
  if (sources?.ticket !== false) out.push('ticket')
  return out
}

export const APPLIES_TO_LABELS: Record<RuleAppliesTo, string> = {
  issue: 'Issue log',
  ticket: 'Support tickets'
}

// ── Drafts ──────────────────────────────────────────────────────────────────

/** A new rule: switched off and only suggesting until someone turns it on. */
export function newRule(connection: number, kind: RuleAppliesTo): RuleDraft {
  const ticket = kind === 'ticket'
  return {
    applies_to: kind,
    name: ticket ? 'New support ticket rule' : 'New rule',
    description: null,
    enabled: false,
    mode: 'suggest',
    continue_after: false,
    match: {},
    threshold: ticket ? {} : { hits: { n: 10, window_minutes: 60 } },
    guards: {
      per_hour: 5,
      per_day: 20,
      group: true,
      skip_linked: true,
      skip_statuses: ticket ? ['done', 'cancelled'] : ['resolved', 'closed']
    },
    action: {
      connection,
      issue_type: 'issue',
      labels: [],
      assignee_ids: [],
      map_assignee_by_email: false,
      confidential: false,
      // empty = the kind's default template (the server fills it in)
      title_template: '',
      body_template: '',
      attach_screenshot: false,
      attach_replay_link: false,
      include_details: true
    }
  }
}

/**
 * The same rule about another kind: conditions and counts the new kind does
 * not have are dropped, and the templates go back to that kind's default (an
 * issue template names variables a ticket does not have).
 */
export function withAppliesTo(rule: RuleDraft, kind: RuleAppliesTo): RuleDraft {
  if (rule.applies_to === kind) return rule
  const match: RuleMatch = {}
  for (const [k, v] of Object.entries(rule.match) as Array<[keyof RuleMatch, unknown]>)
    if (isValidMatchKey(kind, k)) (match as Record<string, unknown>)[k] = v
  // statuses differ by kind (resolved/closed vs done/cancelled): keep only the ones it has,
  // or a stale one would hide in the builder and the rule would never match
  const valid = kind === 'ticket' ? TICKET_STATUSES : ISSUE_STATUSES
  const statuses = (match.statuses ?? []).filter((st) => valid.includes(st.toLowerCase()))
  if (statuses.length) match.statuses = statuses
  else delete match.statuses
  const threshold: RuleThreshold = {}
  for (const [k, v] of Object.entries(rule.threshold) as Array<[keyof RuleThreshold, unknown]>)
    if (kind !== 'ticket' || TICKET_THRESHOLDS.includes(k))
      (threshold as Record<string, unknown>)[k] = v
  return {
    ...rule,
    applies_to: kind,
    match,
    threshold,
    guards: {
      ...rule.guards,
      skip_statuses: kind === 'ticket' ? ['done', 'cancelled'] : ['resolved', 'closed']
    },
    action: { ...rule.action, title_template: '', body_template: '' }
  }
}

const DRAFT_KEYS: Array<keyof RuleDraft> = [
  'applies_to',
  'name',
  'description',
  'enabled',
  'mode',
  'continue_after',
  'match',
  'threshold',
  'guards',
  'action'
]

/** The POST / PATCH body: only what a rule is, never the list's counters. */
export function ruleBody(rule: RuleDraft | TrackerRule): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of DRAFT_KEYS) if (rule[k] !== undefined) out[k] = rule[k]
  // Text is matched as words (`*` = any run of characters); rules no longer take regular
  // expressions. A stored rule with the old `regex` flag is edited — and saved — without it
  // (the server keeps it invalid until its terms are words).
  const text = rule.match?.text
  if (text && 'regex' in text) {
    const { regex: _gone, ...words } = text
    out.match = { ...rule.match, text: words }
  }
  return out
}

/** The editable copy of a stored rule. */
export function draftOf(rule: TrackerRule): RuleDraft {
  return ruleBody(rule) as unknown as RuleDraft
}

// ── The sentence ────────────────────────────────────────────────────────────

export type SentencePart = 'subject' | 'severity' | 'threshold' | 'action' | 'project' | 'labels'
export interface SentenceBit {
  text: string
  /** Set on the bold bits a person can click to change. */
  part?: SentencePart
}

export interface SentenceContext {
  /** The GitLab project the rule opens issues in (path), when known. */
  projectPath?: string | null
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

const orList = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`

/** Conditions the sentence does not spell out (they show in the Match section). */
function extraConditions(rule: RuleDraft): number {
  const shown: Array<keyof RuleMatch> =
    rule.applies_to === 'ticket' ? ['priorities'] : ['sources', 'severity_min']
  let n = 0
  for (const [k, v] of Object.entries(rule.match) as Array<[keyof RuleMatch, unknown]>) {
    if (shown.includes(k) || v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    n++
  }
  return n
}

function subjectText(rule: RuleDraft): string {
  if (rule.applies_to === 'ticket') return 'a support ticket'
  const sources = rule.match.sources ?? []
  if (sources.length === 1) return `${article(sources[0])} ${sources[0]}`
  if (sources.length > 1) return `${article(sources[0])} ${orList(sources)} issue`
  return 'an issue'
}

function thresholdText(rule: RuleDraft): string {
  const t = rule.threshold
  const parts: string[] = []
  if (rule.applies_to !== 'ticket') {
    const { hits, people } = t
    if (hits && people && hits.window_minutes === people.window_minutes)
      parts.push(
        `is seen ${plural(hits.n, 'time')} by ${plural(people.n, 'person', 'people')} within ${formatDuration(hits.window_minutes)}`
      )
    else {
      if (hits)
        parts.push(
          `is seen ${plural(hits.n, 'time')} within ${formatDuration(hits.window_minutes)}`
        )
      if (people)
        parts.push(
          `${hits ? '' : 'is seen '}by ${plural(people.n, 'person', 'people')} within ${formatDuration(people.window_minutes)}`.trim()
        )
    }
  }
  if (t.open_minutes) parts.push(`stays open ${formatDuration(t.open_minutes)}`)
  if (rule.applies_to !== 'ticket') {
    if (t.recurrences) parts.push(`comes back ${plural(t.recurrences, 'time')}`)
    if (t.total_hits) parts.push(`reaches ${plural(t.total_hits, 'hit')} in all`)
  }
  if (!parts.length) return rule.applies_to === 'ticket' ? 'is raised' : 'is seen'
  return parts.join(' and ')
}

/** The rule as a sentence, split into plain text and the bold, editable bits. */
export function sentenceParts(rule: RuleDraft, ctx: SentenceContext = {}): SentenceBit[] {
  const bits: SentenceBit[] = [{ text: 'When ' }, { text: subjectText(rule), part: 'subject' }]
  if (rule.applies_to === 'ticket') {
    const pr = rule.match.priorities ?? []
    if (pr.length) bits.push({ text: ' with priority ' }, { text: orList(pr), part: 'subject' })
  } else if (rule.match.severity_min) {
    bits.push({ text: ' with severity ≥ ' }, { text: rule.match.severity_min, part: 'severity' })
  }
  const extra = extraConditions(rule)
  if (extra) bits.push({ text: ` matching ${plural(extra, 'more condition')}` })
  bits.push({ text: ' ' }, { text: thresholdText(rule), part: 'threshold' }, { text: ', ' })
  const what = rule.action.issue_type === 'incident' ? 'an incident' : 'an issue'
  bits.push(
    { text: `${rule.mode === 'create' ? 'open' : 'suggest'} ${what}`, part: 'action' },
    { text: ' in ' },
    {
      text:
        ctx.projectPath ||
        (rule.action.project_id ? `project ${rule.action.project_id}` : 'the default project'),
      part: 'project'
    }
  )
  if (rule.action.labels.length)
    bits.push({ text: ' labelled ' }, { text: rule.action.labels.join(', '), part: 'labels' })
  return bits
}

export function ruleSentence(rule: RuleDraft, ctx: SentenceContext = {}): string {
  return sentenceParts(rule, ctx)
    .map((b) => b.text)
    .join('')
}

// ── Order ───────────────────────────────────────────────────────────────────

/** The order after dragging `active` onto `over`, or null when nothing moves. */
export function moveRule(order: number[], active: number, over: number): number[] | null {
  const from = order.indexOf(active)
  const to = order.indexOf(over)
  if (from < 0 || to < 0 || from === to) return null
  const next = [...order]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

// ── Why didn't it fire ──────────────────────────────────────────────────────

const OUTCOMES: Record<string, string> = {
  would_fire: 'Would act',
  would_suggest: 'Would suggest',
  no_match: 'Did not match',
  status: 'Status skipped',
  linked: 'Already linked',
  quiet: 'Quiet hours',
  cap: 'Limit reached',
  fired: 'Fired',
  suggested: 'Suggested',
  joined: 'Joined an issue',
  error: 'Failed',
  ignored: 'Ignored'
}

export function outcomeLabel(outcome: string): string {
  return OUTCOMES[outcome] ?? outcome.replace(/_/g, ' ')
}

/** Rule -1 = a flow's "Create GitLab issue" step; 0 = the sweep / GitLab sync itself. */
export function explainName(row: { rule: number; name: string }): string {
  if (row.rule === -1) return 'Flow'
  if (row.rule === 0) return row.name === 'Sweep' ? 'Catch-up sweep' : row.name || 'GitLab sync'
  return row.name || `Rule ${row.rule}`
}

/** "#123" / "123" → 123; anything else → null. */
export function parseIssueRef(raw: string): number | null {
  const m = /^#?(\d{1,15})$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** A section's validation errors (path starts with "match", "threshold", …). */
export function errorsFor(
  errors: Array<{ path: string; message: string }> | null | undefined,
  prefix: string
): Array<{ path: string; message: string }> {
  return (errors ?? []).filter((e) => e.path === prefix || e.path.startsWith(`${prefix}.`))
}

const OPTIONAL_ACTION_KEYS = ['project_id', 'milestone_id', 'due_in_days', 'weight'] as const

/**
 * An action with a change applied: an optional key set to undefined is removed, and a different
 * project drops the milestone (milestones belong to a project).
 */
export function withActionPatch(action: RuleAction, patch: Partial<RuleAction>): RuleAction {
  const next = { ...action, ...patch }
  for (const k of OPTIONAL_ACTION_KEYS) if (k in patch && patch[k] === undefined) delete next[k]
  if ('project_id' in patch && patch.project_id !== action.project_id) delete next.milestone_id
  return next
}

/**
 * The rule on another GitLab connection: the old one's project, milestone, assignees and labels
 * mean nothing there (other ids, other people), so they go.
 */
export function withConnection(rule: RuleDraft, connection: number): RuleDraft {
  if (rule.action.connection === connection) return rule
  const action: RuleAction = { ...rule.action, connection, assignee_ids: [], labels: [] }
  delete action.project_id
  delete action.milestone_id
  return { ...rule, action }
}
