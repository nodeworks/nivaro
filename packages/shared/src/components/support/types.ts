/** Shapes served by /api/support (#999). */

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled'

export interface SupportCategory {
  id: number
  name: string
  description: string | null
  /** The kind of record this type is for; null = offered everywhere. */
  collection: string | null
  team_id: number | null
  team_name: string | null
  default_assignee: string | null
  default_assignee_name: string | null
  is_active: boolean
  sort: number
  legacy: boolean
}

export interface SupportTicket {
  id: number
  title: string
  description: string | null
  status: TicketStatus
  status_label: string
  priority: 'low' | 'normal' | 'urgent'
  collection: string | null
  item: string | null
  record_label: string | null
  category_id: number | null
  category_name: string | null
  team_id: number | null
  team_name: string | null
  assignee: string | null
  assignee_name: string | null
  created_by: string
  requester_name: string | null
  attachments: string[]
  /** #1390 — the issue a Report a problem filed alongside this request. */
  issue_id?: number | null
  /** #1377 — the requester's replay at the moment they asked (admins open it). */
  replay?: { recording_id: string; offset_ms: number | null } | null
  replies: number
  legacy: boolean
  created_at: string
  updated_at: string | null
  completed_at: string | null
  /** When the requester last heard back (newest reply from anyone else), else when they asked.
   *  Served by the list only (older APIs leave it out). */
  waiting_since?: string | null
}

export interface SupportTicketDetail extends SupportTicket {
  files: Array<{
    id: string
    title: string | null
    filename_download: string | null
    type: string | null
    filesize: number | string | null
  }>
  thread: Array<{
    id: string
    text: string
    user: string
    user_name: string | null
    created_at: string
    from_requester: boolean
    /** Mirrored in from GitLab: the GitLab author (the writer is the GitLab machine user). */
    tracker?: { provider: 'gitlab'; author: string | null } | null
  }>
  history: Array<{
    id: number
    /** The activity action (screen-share-start / -watch / -stop fold into one line). */
    action?: string | null
    text: string
    user: string | null
    user_name: string | null
    at: string
  }>
  can: {
    work: boolean
    reply: boolean
    cancel: boolean
    reopen: boolean
    /** The reader raised this request (older APIs leave it out). */
    requester?: boolean
  }
}

export interface SupportSummary {
  mine_open: number
  desk: boolean
  unassigned: number
  assigned_to_me: number
}

/** GET /support/workload — who has what on the desk the reader works. */
export interface SupportWorkload {
  assignees: Array<{
    id: string
    name: string
    open: number
    urgent: number
    oldest_waiting: string | null
    /** false = suspended / no longer active, still holding requests. */
    active: boolean
  }>
  unassigned: { open: number; urgent: number; oldest_waiting: string | null }
  /** Everyone who works this desk (the assignee filter's and Assign to…'s choices). */
  workers: Array<{ id: string; name: string }>
}

/** POST /support/tickets/bulk — what happened to each request. */
export interface SupportBulkResult {
  results: Array<
    | { id: number; outcome: 'updated' | 'unchanged' }
    | { id: number; outcome: 'refused'; code: string; reason: string }
  >
  updated: number
  unchanged: number
  refused: number
}

export const STATUS_TONE: Record<TicketStatus, string> = {
  open: 'bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300',
  in_progress: 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300',
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  cancelled: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
}

// ── Auto-assign rules (/api/support/assign-rules; the server owns the meaning) ──

export type AssignSetOp = 'in' | 'not_in'
export type AssignFieldOp =
  | 'is'
  | 'is_not'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'empty'
  | 'not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
export type AssignSource = 'general' | 'record' | 'error' | 'report_problem'

export type AssignCondition =
  | { kind: 'type'; op: AssignSetOp; values: number[] }
  | { kind: 'about'; op: 'record_in' | 'general'; collections: string[] }
  | { kind: 'field'; collection: string; field: string; op: AssignFieldOp; values: string[] }
  | { kind: 'step'; op: AssignSetOp; states: string[] }
  | { kind: 'requester'; op: AssignSetOp; users: string[] }
  | { kind: 'requester_role'; op: AssignSetOp; roles: string[] }
  | { kind: 'requester_team'; op: AssignSetOp; teams: number[] }
  | { kind: 'priority'; op: AssignSetOp; values: string[] }
  | { kind: 'text'; op: 'any' | 'all' | 'none'; words: string[] }
  | { kind: 'source'; op: AssignSetOp; values: AssignSource[] }
  | { kind: 'hours'; op: 'inside' | 'outside' }

export type AssignStrategy =
  | 'fewest_open'
  | 'least_recent'
  | 'fewest_today'
  | 'fewest_week'
  | 'fewest_urgent'
  | 'most_closed_type'
  | 'last_helped'
  | 'step_owner'
  | 'random'

export interface AssignSharePerson {
  id: string
  cap: number | null
  when: 'always' | 'business_hours' | 'online'
}

export type AssignAction =
  | { kind: 'person'; user: string }
  | {
      kind: 'share'
      people: AssignSharePerson[]
      strategy: AssignStrategy
      give_to_cover: boolean
    }
  | { kind: 'step_owner'; pick: 'first' | 'fewest_open' }
  | { kind: 'team'; team: number }

export interface AssignRule {
  id: string
  name: string
  active: boolean
  match: 'all' | 'any'
  conditions: AssignCondition[]
  action: AssignAction
  fallback: { kind: 'desk' } | { kind: 'person'; user: string }
  on_type_change: boolean
  note: string | null
}

export interface AssignHours {
  start: string
  end: string
  days: number[]
}

export interface AssignRuleSet {
  rules: AssignRule[]
  hours: AssignHours
}

export interface AssignOptions {
  types: Array<{ id: number; name: string; collection: string | null }>
  teams: Array<{ id: number; name: string }>
  roles: Array<{ id: string; name: string }>
  collections: Array<{ collection: string; name: string; hidden: boolean }>
  steps: Record<string, Array<{ id: string; label: string }>>
}

export interface AssignField {
  field: string
  label: string
  type: string
  related: string | null
  choices: Array<{ value: string; label: string }> | null
}

export interface AssignTestResult {
  trace: Array<{
    id: string
    name: string
    active: boolean
    result: 'matched' | 'no_match' | 'not_reached' | 'held'
    reasons: string[]
  }>
  outcome:
    | {
        kind: 'person'
        user: { id: string; name: string }
        via: 'rule' | 'rule_fallback' | 'type_default'
        rule: { id: string; name: string } | null
        note: string
      }
    | {
        kind: 'team'
        team: { id: number; name: string }
        via: 'rule'
        rule: { id: string; name: string }
        note: string
      }
    | {
        kind: 'desk'
        via: 'rule_fallback' | 'no_rule' | 'keep'
        rule: { id: string; name: string } | null
        note: string
      }
  pick: {
    winner: { id: string; name: string } | null
    ranking: Array<{ id: string; name: string; measure: string; for?: string }>
    skipped: Array<{ id: string; name: string; reason: string }>
    used: AssignStrategy
  } | null
}
