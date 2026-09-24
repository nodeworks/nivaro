/**
 * Everything the Firefight drill-down says about ONE outbound push (Task 15d):
 * who the partner is, what went wrong, what sent it, and who.
 *
 * Two halves on purpose. `gatherSubmissionFacts` reads — every query is
 * best-effort (`.catch`) because a missing optional table must never turn a
 * detail view into a 500. `buildSubmissionDetail` is pure: it decides the
 * trigger, the requester of the push and of each attempt, and whether a retry
 * makes sense, from the facts alone — so the precedence rules are tested
 * without a database.
 *
 * "Who" precedence (never a guess dressed as fact):
 *   1. `requested_by` / `requested_via` stored on the attempt or submission
 *      (migration 350) — `basis: 'recorded'`.
 *   2. Inferred, labelled `basis: 'inferred'` with the evidence named: the
 *      push's own retry entry in the activity log; the partner call log's
 *      user within ±10 s; the transition made moments before (a machine
 *      origin or no user = automatic); a person's edit of the record moments
 *      before (a hook-driven push); the obligation / call-log trigger text for
 *      a schedule or a flow.
 *   3. Otherwise "Not recorded" — `basis: 'none'`.
 */
import { db } from '../db/index.js'
import { accountKindOf } from './machine-accounts.js'
import { sameLoggedBody } from './secret-mask.js'

// ─── Fact shapes ────────────────────────────────────────────────────────────

export interface FactSubmission {
  id: number
  collection: string
  item: string
  external_api: number
  status: string
  attempts: number
  payload: string | null
  created_at: Date | string
  updated_at: Date | string
  error_class: string | null
  obligation_id: number | null
  requested_by: string | null
  requested_via: string | null
}

export interface FactUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  status: string | null
  is_redacted: boolean | number | null
  account_kind: string | null
}

export interface FactObligation {
  id: number
  kind: string
  api: string
  trigger: string
  trigger_ref: string | null
  outcome: string
  reason: string | null
  due_at: Date | string | null
  resolved_at: Date | string | null
  created_at: Date | string
}

export interface FactTransition {
  id: string
  label: string
  auto_trigger: boolean | number | null
  template_id: string | null
  template_name: string | null
}

export interface FactHistory {
  user: string | null
  origin: string | null
  timestamp: Date | string
  transition: FactTransition | null
}

export interface FactActivity {
  action: string
  user: string | null
  comment: string | null
  timestamp: Date | string
}

export interface FactCallLog {
  id: number
  created_at: Date | string
  method: string | null
  url: string | null
  response_status: number | null
  duration_ms: number | null
  error: string | null
  triggered_by: string | null
  user_id: string | null
  /** The request body matched the stored payload byte-for-byte (canonical). */
  body_match: boolean
}

export interface FactAttempt {
  attempt: number
  recorded_at: Date | string
  source: string
  requested_by: string | null
  requested_via: string | null
}

export interface SubmissionFacts {
  /** The submission row exactly as stored — the route serializes it. */
  raw: Record<string, unknown>
  row: FactSubmission
  api: { id: number; name: string; owner_user: string | null } | null
  record_label: string | null
  obligation: FactObligation | null
  /** The transition an obligation names by id (exact), when it does. */
  obligation_transition: FactTransition | null
  /** The flow behind an obligation's run id or a `flow:<id>` call log. */
  flow: { id: string; name: string; user: string | null } | null
  attempts: FactAttempt[]
  /** Activity rows about THIS submission (its create entry, retries). */
  activity: FactActivity[]
  call_logs: FactCallLog[]
  /** The record's transition nearest the first send (within 60 s either side). */
  history: FactHistory | null
  /** A person's write to the record just before the first send (≤ 10 s). */
  record_edit: FactActivity | null
  newer_landed: { id: number; status: string } | null
  users: FactUser[]
}

// ─── Output shapes ──────────────────────────────────────────────────────────

export type RequesterKind = 'person' | 'machine' | 'automatic' | 'scheduled' | 'flow' | 'unknown'

export interface RequesterUser {
  id: string
  name: string
  email: string | null
  /** 'suspended' / 'inactive' / 'redacted' — a person who can no longer act. */
  inactive: string | null
  /** integration | bot | service | placeholder — never a person. */
  account_kind: string | null
}

export interface Requester {
  kind: RequesterKind
  /** recorded = stored on the row; inferred = derived from the evidence in `how`. */
  basis: 'recorded' | 'inferred' | 'none'
  label: string
  user: RequesterUser | null
  via: string | null
  /** The evidence an inference rests on, in words. */
  how: string | null
}

export type TriggerKind =
  | 'transition'
  | 'auto-transition'
  | 'flow'
  | 'item-action'
  | 'hook'
  | 'cron'
  | 'retry'
  | 'resend'
  | 'api'
  | 'reconcile'
  | 'unknown'

export interface TriggerInfo {
  kind: TriggerKind
  label: string
  /** Admin-shaped path the host may map (`/pipelines/:id`, `/flows/:id`). */
  link: string | null
  source: 'obligation' | 'recorded' | 'call-log' | 'activity' | 'history' | 'none'
}

export interface SubmissionDetail {
  partner: {
    id: number | null
    name: string | null
    owner: { id: string; name: string } | null
  }
  endpoint: { method: string; path: string | null }
  obligation: {
    id: number
    kind: string
    outcome: string
    reason: string | null
    due_at: string | null
    resolved_at: string | null
    trigger: string
    trigger_ref: string | null
    open: boolean
  } | null
  trigger: TriggerInfo
  triggered_by: Requester
  attempt_requesters: Array<{ attempt: number; requester: Requester }>
  call_logs: Array<{
    id: number
    created_at: string
    method: string | null
    url: string | null
    status: number | null
    duration_ms: number | null
    error: string | null
    triggered_by: string | null
    user: RequesterUser | null
  }>
  retry: { eligible: boolean; reason: string | null; warning: string | null }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : new Date(v).toISOString()
const ms = (v: Date | string) => new Date(v).getTime()

// How close a transition/record edit must sit to the first send to be read
// as its cause (Task 15d fix round 1). The history window used to be ±60s
// and the record-edit window −10s/+2s; both were wide enough on a busy
// record to risk matching something unrelated — a later transition, an
// edit made for a different reason moments earlier.
export const HISTORY_WINDOW_MS = 15_000
/** A partner call within this of a known attempt (same endpoint) is the push's call. */
export const CALL_LOG_WINDOW_MS = 10_000
export const RECORD_EDIT_WINDOW_BEFORE_MS = 3_000
export const RECORD_EDIT_WINDOW_AFTER_MS = 1_000

const KIND_WORD: Record<string, string> = {
  integration: 'Integration account',
  bot: 'Bot',
  service: 'Service account',
  placeholder: 'Placeholder account'
}

export function displayName(u: FactUser): string {
  const n = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return n || u.email || u.id
}

export function toRequesterUser(u: FactUser): RequesterUser {
  const kind = accountKindOf(u)
  const redacted = u.is_redacted === true || u.is_redacted === 1
  const status = String(u.status ?? 'active').toLowerCase()
  return {
    id: u.id,
    name: displayName(u),
    email: u.email,
    inactive: redacted ? 'redacted' : status !== 'active' ? status : null,
    account_kind: kind
  }
}

/** "sync-inventory" → "Sync inventory". */
function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : slug
}

function transitionText(t: FactTransition): string {
  return `“${t.label}” transition${t.template_name ? ` · ${t.template_name}` : ''}`
}

const isAuto = (t: FactTransition | null | undefined) =>
  t?.auto_trigger === true || t?.auto_trigger === 1

/** What a call-log `triggered_by` value says the send was. */
export function viaFromCallLog(triggeredBy: string | null, attempt: number): string | null {
  const t = String(triggeredBy ?? '')
  if (!t) return null
  if (t === 'transition-action') return 'transition'
  if (t === 'erp-submission') return attempt > 1 ? 'retry' : 'api'
  if (t.startsWith('item-action:')) return 'item-action'
  if (t.startsWith('flow:')) return 'flow'
  if (t.startsWith('cron:')) return 'cron'
  return null
}

/**
 * What sent this push. The obligation names it exactly when there is one;
 * otherwise the stored `requested_via`, the partner call log's
 * `triggered_by`, then the push's own activity entry, in that order.
 */
export function describeTrigger(f: SubmissionFacts): TriggerInfo {
  const ob = f.obligation
  const history = f.history
  const templateLink = (t: FactTransition | null) =>
    t?.template_id ? `/pipelines/${t.template_id}` : null
  const fromHistory = (source: TriggerInfo['source']): TriggerInfo | null =>
    history?.transition
      ? {
          kind: isAuto(history.transition) ? 'auto-transition' : 'transition',
          label: transitionText(history.transition),
          link: templateLink(history.transition),
          source
        }
      : null

  if (ob) {
    switch (ob.trigger) {
      case 'transition': {
        const t = f.obligation_transition
        if (t)
          return {
            kind: isAuto(t) ? 'auto-transition' : 'transition',
            label: transitionText(t),
            link: templateLink(t),
            source: 'obligation'
          }
        return (
          fromHistory('obligation') ?? {
            kind: 'transition',
            label: 'A transition',
            link: null,
            source: 'obligation'
          }
        )
      }
      case 'flow':
        return {
          kind: 'flow',
          label: f.flow ? `Flow “${f.flow.name}”` : 'A flow',
          link: f.flow ? `/flows/${f.flow.id}` : null,
          source: 'obligation'
        }
      case 'cron':
        return {
          kind: 'cron',
          label: `Scheduled — ${ob.trigger_ref ?? 'a background job'}`,
          link: null,
          source: 'obligation'
        }
      case 'hook':
        return {
          kind: 'hook',
          label: `A change to the record${ob.trigger_ref ? ` (${ob.trigger_ref})` : ''}`,
          link: null,
          source: 'obligation'
        }
      case 'reconcile':
        return {
          kind: 'reconcile',
          label: 'The reconciliation sweep',
          link: null,
          source: 'obligation'
        }
      case 'manual': {
        const t = f.obligation_transition
        return {
          kind: 'resend',
          label: t ? `Sent by hand from the ${transitionText(t)}` : 'Sent by hand',
          link: templateLink(t),
          source: 'obligation'
        }
      }
    }
  }

  const via = f.row.requested_via
  if (via === 'transition' || via === 'auto-transition') {
    const h = fromHistory('recorded')
    if (h) return h
    return {
      kind: via,
      label: via === 'auto-transition' ? 'An automatic transition' : 'A transition',
      link: null,
      source: 'recorded'
    }
  }
  if (via === 'flow' && f.flow)
    return {
      kind: 'flow',
      label: `Flow “${f.flow.name}”`,
      link: `/flows/${f.flow.id}`,
      source: 'recorded'
    }
  if (via === 'resend')
    return { kind: 'resend', label: 'Re-sent by hand', link: null, source: 'recorded' }
  if (via === 'item-action') {
    const log = f.call_logs.find((l) => l.triggered_by?.startsWith('item-action:'))
    return {
      kind: 'item-action',
      label: log
        ? `Item action — ${humanize(String(log.triggered_by).slice('item-action:'.length))}`
        : 'An item action',
      link: null,
      source: 'recorded'
    }
  }
  if (via === 'cron') {
    const create = f.activity.find(isCreateEntry)
    const source = create?.comment?.split(' → ')[0]?.trim()
    return {
      kind: 'cron',
      label: `Scheduled — ${source || 'a background job'}`,
      link: null,
      source: 'recorded'
    }
  }
  if (via === 'flow') return { kind: 'flow', label: 'A flow', link: null, source: 'recorded' }

  // The first send's own call-log entry — the nearest to created_at.
  const first = firstSendLog(f)
  const tb = first?.triggered_by ?? null
  if (tb === 'transition-action') {
    return (
      fromHistory('call-log') ?? {
        kind: 'transition',
        label: 'A transition',
        link: null,
        source: 'call-log'
      }
    )
  }
  if (tb?.startsWith('item-action:'))
    return {
      kind: 'item-action',
      label: `Item action — ${humanize(tb.slice('item-action:'.length))}`,
      link: null,
      source: 'call-log'
    }
  if (tb?.startsWith('flow:'))
    return {
      kind: 'flow',
      label: f.flow ? `Flow “${f.flow.name}”` : 'A flow',
      link: f.flow ? `/flows/${f.flow.id}` : null,
      source: 'call-log'
    }
  if (tb?.startsWith('cron:'))
    return { kind: 'cron', label: `Scheduled — ${tb.slice(5)}`, link: null, source: 'call-log' }
  if (tb === 'erp-submission')
    return { kind: 'api', label: 'Sent through the push API', link: null, source: 'call-log' }

  // The push's own create entry says what the writer called itself.
  const create = f.activity.find(isCreateEntry)
  const comment = create?.comment ?? ''
  const head = comment.split(' → ')[0]?.trim() ?? ''
  if (/^transition action$/i.test(head)) {
    return (
      fromHistory('activity') ?? {
        kind: 'transition',
        label: 'A transition',
        link: null,
        source: 'activity'
      }
    )
  }
  const named = /^transition\s+(.+)$/i.exec(head)
  if (named) {
    const h = fromHistory('activity')
    return (
      h ?? { kind: 'transition', label: `“${named[1]}” transition`, link: null, source: 'activity' }
    )
  }
  if (head && !/^\w+\/\S+$/.test(head)) {
    return {
      kind: 'hook',
      label: head[0].toUpperCase() + head.slice(1),
      link: null,
      source: 'activity'
    }
  }
  if (via === 'api')
    return { kind: 'api', label: 'A record change or API call', link: null, source: 'recorded' }
  return { kind: 'unknown', label: 'Not recorded', link: null, source: 'none' }
}

/** The push's own create entry — an extension's writer namespaces the
 *  action (`<ext>:create`), core's does not. */
const isCreateEntry = (a: FactActivity) => a.action === 'create' || a.action.endsWith(':create')

/** The call-log entry of the first send: body-matched, nearest to created_at. */
function firstSendLog(f: SubmissionFacts): FactCallLog | null {
  const t0 = ms(f.row.created_at)
  const near = f.call_logs
    .filter((l) => Math.abs(ms(l.created_at) - t0) <= 10_000)
    .sort((a, b) => Math.abs(ms(a.created_at) - t0) - Math.abs(ms(b.created_at) - t0))
  return near.find((l) => l.body_match) ?? near[0] ?? null
}

function userFor(f: SubmissionFacts, id: string | null | undefined): FactUser | null {
  if (!id) return null
  const want = String(id).toLowerCase()
  return f.users.find((u) => String(u.id).toLowerCase() === want) ?? null
}

function personRequester(
  u: FactUser | null,
  id: string,
  basis: Requester['basis'],
  via: string | null,
  how: string | null
): Requester {
  if (!u) {
    // A stored id for an account that no longer exists: say so, never drop it.
    return {
      kind: 'person',
      basis,
      label: 'A user who no longer exists',
      user: { id, name: id, email: null, inactive: 'deleted', account_kind: null },
      via,
      how
    }
  }
  const ru = toRequesterUser(u)
  if (ru.account_kind) {
    return {
      kind: 'machine',
      basis,
      label: `${KIND_WORD[ru.account_kind] ?? 'Machine account'} — ${ru.name}`,
      user: ru,
      via,
      how
    }
  }
  return { kind: 'person', basis, label: ru.name, user: ru, via, how }
}

const VIA_WORD: Record<string, string> = {
  transition: 'A transition',
  'item-action': 'An item action',
  retry: 'A retry',
  resend: 'A resend',
  api: 'An API call'
}

const transitionLikeKind = (k: TriggerKind) => k === 'transition' || k === 'auto-transition'

/** A send nobody started by hand — named by what did start it. */
function noPersonRequester(
  via: string,
  trigger: TriggerInfo | null,
  basis: Requester['basis'],
  how: string | null
): Requester {
  let kind: RequesterKind = 'automatic'
  let label: string
  if (via === 'cron') {
    kind = 'scheduled'
    label = trigger?.kind === 'cron' ? trigger.label : 'Scheduled'
  } else if (via === 'flow') {
    kind = 'flow'
    label = trigger?.kind === 'flow' ? trigger.label : 'A flow'
  } else if (via === 'auto-transition') {
    label =
      trigger && transitionLikeKind(trigger.kind) ? `Automatic — ${trigger.label}` : 'Automatic'
  } else {
    label = VIA_WORD[via] ?? 'Automatic'
  }
  return { kind, basis, label, user: null, via, how }
}

const NOT_RECORDED: Requester = {
  kind: 'unknown',
  basis: 'none',
  label: 'Not recorded',
  user: null,
  via: null,
  how: null
}

/**
 * Who started attempt `n` (1 = the original send). `at` is when the attempt
 * happened, as the attempt history knows it.
 */
export function resolveRequester(
  f: SubmissionFacts,
  n: number,
  at: Date | string | null,
  trigger: TriggerInfo
): Requester {
  // 1. Stored on the attempt row, or (first send) on the submission itself.
  const attemptRow = f.attempts.find((a) => a.attempt === n)
  const storedBy = attemptRow?.requested_by ?? (n === 1 ? f.row.requested_by : null)
  const storedVia = attemptRow?.requested_via ?? (n === 1 ? f.row.requested_via : null)
  if (storedBy) return personRequester(userFor(f, storedBy), storedBy, 'recorded', storedVia, null)
  if (storedVia) {
    // A later attempt with no person behind it is the retry ladder.
    if (n > 1 && storedVia === 'cron')
      return {
        ...noPersonRequester('cron', null, 'recorded', null),
        label: 'Scheduled — the retry ladder'
      }
    return noPersonRequester(storedVia, n === 1 ? trigger : null, 'recorded', null)
  }

  // 2a. The retry route's own activity entry for this attempt ("retry #n").
  if (n > 1) {
    const retry = f.activity.find(
      (a) => a.user && new RegExp(`^retry #${n}\\b`).test(String(a.comment ?? ''))
    )
    if (retry?.user) {
      return personRequester(
        userFor(f, retry.user),
        retry.user,
        'inferred',
        'retry',
        `The activity log records attempt ${n} as a retry by this person.`
      )
    }
  }
  // 2b. The partner call log's user within ±10 s of the attempt.
  const t = at == null ? null : ms(at)
  const logs =
    t == null
      ? []
      : f.call_logs
          .filter((l) => l.user_id && Math.abs(ms(l.created_at) - t) <= 10_000)
          .sort((a, b) => Math.abs(ms(a.created_at) - t) - Math.abs(ms(b.created_at) - t))
  const log = logs.find((l) => l.body_match) ?? logs[0]
  if (log?.user_id) {
    return personRequester(
      userFor(f, log.user_id),
      log.user_id,
      'inferred',
      viaFromCallLog(log.triggered_by, n),
      'Matched the partner call made at the same moment.'
    )
  }
  if (n === 1) {
    // 2c. The transition made moments before — its user, or automatic.
    const transitionLike =
      trigger.kind === 'transition' ||
      trigger.kind === 'auto-transition' ||
      f.obligation?.trigger === 'transition'
    if (transitionLike && f.history) {
      const h = f.history
      if (h.user && h.origin !== 'machine') {
        return personRequester(
          userFor(f, h.user),
          h.user,
          'inferred',
          'transition',
          `Made the ${h.transition ? transitionText(h.transition) : 'transition'} moments before the push.`
        )
      }
      return noPersonRequester(
        'auto-transition',
        trigger,
        'inferred',
        'The transition behind it was made by the system, not a person.'
      )
    }
    // 2d. A schedule or a flow, by the trigger text — checked BEFORE a
    //     coincidental record edit, so a cron/flow push is never misread as
    //     "whoever happened to touch the record at the same moment".
    if (trigger.kind === 'cron') return noPersonRequester('cron', trigger, 'inferred', null)
    if (trigger.kind === 'flow') {
      if (f.flow?.user) {
        return personRequester(
          userFor(f, f.flow.user),
          f.flow.user,
          'inferred',
          'flow',
          'Started the flow run that sent it.'
        )
      }
      return noPersonRequester('flow', trigger, 'inferred', null)
    }
    // 2e. A person's edit of the record moments before (a change-driven
    //     push) — only for the trigger kinds that mean "something reacted
    //     to a record write with nothing clearer to name": hook | unknown |
    //     api. Any other kind (item-action, retry, resend, …) has its own
    //     dedicated inference above and must never borrow a coincidental
    //     edit instead — it may belong to something else entirely.
    if (
      (trigger.kind === 'hook' || trigger.kind === 'unknown' || trigger.kind === 'api') &&
      f.record_edit?.user
    ) {
      return personRequester(
        userFor(f, f.record_edit.user),
        f.record_edit.user,
        'inferred',
        'api',
        'Edited the record moments before the push.'
      )
    }
  }
  return NOT_RECORDED
}

/** Whether a manual Retry makes sense right now, and why not when it doesn't. */
export function retryEligibility(f: SubmissionFacts): SubmissionDetail['retry'] {
  const status = f.row.status
  let endpoint: string | null = null
  try {
    endpoint =
      (JSON.parse(f.row.payload ?? '') as { endpoint_path?: string })?.endpoint_path ?? null
  } catch {
    endpoint = null
  }
  if (status === 'accepted')
    return { eligible: false, reason: 'The partner already accepted this push.', warning: null }
  if (status === 'pending' || status === 'submitted')
    return {
      eligible: false,
      reason: 'Waiting on the partner to acknowledge it — nothing to retry yet.',
      warning: null
    }
  if (!f.row.payload)
    return {
      eligible: false,
      reason:
        'The stored request was cleared by the payload retention window — there is nothing to resend.',
      warning: null
    }
  if (!endpoint)
    return {
      eligible: false,
      reason: 'The stored request has no endpoint to resend to.',
      warning: null
    }
  if (f.newer_landed)
    return {
      eligible: false,
      reason: `A newer push to this record (#${f.newer_landed.id}) already landed — resending this older one could overwrite it.`,
      warning: null
    }
  const warning =
    f.row.error_class === 'validation'
      ? 'The partner refused the content itself — the same request will most likely fail the same way.'
      : f.row.error_class === 'not_found'
        ? 'The partner says the target does not exist — the same request will most likely fail the same way.'
        : null
  return { eligible: true, reason: null, warning }
}

export function buildSubmissionDetail(f: SubmissionFacts): SubmissionDetail {
  const trigger = describeTrigger(f)
  const first = resolveRequester(f, 1, f.row.created_at, trigger)

  // Every attempt the submission has made, newest first, with the best time
  // we know for it — the same fill the attempt history uses: an attempt row,
  // else the first send / the submission row, else a body-matched call log.
  const total = Math.max(1, Number(f.row.attempts) || 1)
  const times = new Map<number, Date | string | null>()
  for (const a of f.attempts) times.set(a.attempt, a.recorded_at)
  if (!times.has(1)) times.set(1, f.row.created_at)
  if (!times.has(total)) times.set(total, f.row.updated_at ?? f.row.created_at)
  const known = () => [...times.values()].filter((v): v is Date | string => v != null)
  let next = total
  for (const log of [...f.call_logs]
    .filter((l) => l.body_match)
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))) {
    if (known().some((v) => Math.abs(ms(v) - ms(log.created_at)) < 5_000)) continue
    while (next >= 1 && times.has(next)) next--
    if (next < 1) break
    times.set(next, log.created_at)
  }
  for (let n = 1; n <= total; n++) if (!times.has(n)) times.set(n, null)
  const attempt_requesters = [...times.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([attempt, at]) => ({
      attempt,
      requester: attempt === 1 ? first : resolveRequester(f, attempt, at, trigger)
    }))

  const owner = f.api?.owner_user ? userFor(f, f.api.owner_user) : null
  const methodLog = firstSendLog(f) ?? f.call_logs[0]
  let path: string | null = null
  try {
    path = (JSON.parse(f.row.payload ?? '') as { endpoint_path?: string })?.endpoint_path ?? null
  } catch {
    path = null
  }
  const ob = f.obligation
  return {
    partner: {
      id: f.api?.id ?? null,
      name: f.api?.name ?? null,
      owner: owner ? { id: owner.id, name: displayName(owner) } : null
    },
    endpoint: { method: (methodLog?.method ?? 'POST').toUpperCase(), path },
    obligation: ob
      ? {
          id: Number(ob.id),
          kind: ob.kind,
          outcome: ob.outcome,
          reason: ob.reason,
          due_at: iso(ob.due_at),
          resolved_at: iso(ob.resolved_at),
          trigger: ob.trigger,
          trigger_ref: ob.trigger_ref,
          open: ob.resolved_at == null
        }
      : null,
    trigger,
    triggered_by: first,
    attempt_requesters,
    call_logs: [...f.call_logs]
      .sort((a, b) => ms(b.created_at) - ms(a.created_at))
      .slice(0, 5)
      .map((l) => {
        const u = userFor(f, l.user_id)
        return {
          id: Number(l.id),
          created_at: iso(l.created_at) as string,
          method: l.method,
          url: l.url,
          status: l.response_status,
          duration_ms: l.duration_ms,
          error: l.error,
          triggered_by: l.triggered_by,
          user: u ? toRequesterUser(u) : null
        }
      }),
    retry: retryEligibility(f)
  }
}

// ─── Reading the facts ──────────────────────────────────────────────────────

async function transitionById(id: string | null | undefined): Promise<FactTransition | null> {
  if (!id || !/^[0-9A-Fa-f-]{36}$/.test(id)) return null
  const t = (await db('nivaro_workflow_transitions as t')
    .leftJoin('nivaro_workflow_templates as tp', 'tp.id', 't.template')
    .where('t.id', id)
    .first(
      't.id',
      't.label',
      't.auto_trigger',
      't.template as template_id',
      'tp.name as template_name'
    )
    .catch(() => null)) as FactTransition | null
  return t ?? null
}

/** Reads everything `buildSubmissionDetail` needs, or null for an unknown id. */
export async function gatherSubmissionFacts(
  id: number,
  resolveLabel?: (collection: string, item: string) => Promise<string | null>
): Promise<SubmissionFacts | null> {
  const row = (await db('nivaro_erp_submissions').where({ id }).first()) as
    | (FactSubmission & Record<string, unknown>)
    | undefined
  if (!row) return null
  const created = new Date(row.created_at)
  const updated = new Date(row.updated_at ?? row.created_at)
  const pad = CALL_LOG_WINDOW_MS

  const [api, obligation, attempts, activity, logsRaw, newer, label] = await Promise.all([
    db('nivaro_external_apis')
      .where({ id: row.external_api })
      .first('id', 'name', 'owner_user')
      .catch(() => null) as Promise<{ id: number; name: string; owner_user: string | null } | null>,
    db('nivaro_integration_obligations')
      .where((q) => {
        q.where({ submission_id: id })
        if (row.obligation_id != null) q.orWhere({ id: row.obligation_id })
      })
      .orderBy('id', 'desc')
      .first()
      .catch(() => null) as Promise<FactObligation | null>,
    db('nivaro_erp_submission_attempts')
      .where({ submission_id: id })
      .orderBy('attempt', 'asc')
      .select('*')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_activity')
      .where({ collection: 'nivaro_erp_submissions' })
      .where((q) => {
        q.where('item', String(id)).orWhere((q2) =>
          q2
            .where('item', `${row.collection}/${row.item}`)
            .whereBetween('timestamp', [
              new Date(created.getTime() - pad),
              new Date(created.getTime() + pad)
            ])
        )
      })
      .orderBy('timestamp', 'asc')
      .limit(200)
      .select('action', 'user', 'comment', 'timestamp')
      .catch(() => []) as Promise<FactActivity[]>,
    db('nivaro_external_api_logs')
      .where({ api_id: row.external_api })
      .whereBetween('created_at', [
        new Date(created.getTime() - pad),
        new Date(updated.getTime() + pad)
      ])
      .whereNotIn('triggered_by', ['test', 'contract'])
      .orderBy('id', 'desc')
      .limit(200)
      .select(
        'id',
        'created_at',
        'method',
        'url',
        'request_body',
        'response_status',
        'duration_ms',
        'error',
        'triggered_by',
        'user_id'
      )
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db
      .raw(
        `SELECT TOP 1 id, status FROM nivaro_erp_submissions n
        WHERE n.collection = ? AND n.item = ? AND n.external_api = ? AND n.id > ?
          AND n.status IN ('accepted', 'pending')
          AND ISNULL(JSON_VALUE(n.payload, '$.endpoint_path'), '') =
              ISNULL(JSON_VALUE(?, '$.endpoint_path'), '')
        ORDER BY n.id DESC`,
        [row.collection, row.item, row.external_api, id, row.payload ?? '{}']
      )
      .catch(() => []) as Promise<Array<{ id: number; status: string }>>,
    resolveLabel ? resolveLabel(row.collection, String(row.item)).catch(() => null) : null
  ])

  // Call logs: this push's own calls — the stored body when we have one (the
  // window alone can catch another record's call to the same partner), else
  // anything within 10 s of a known attempt.
  let storedBody: unknown = null
  try {
    storedBody = (JSON.parse(row.payload ?? '') as { body?: unknown })?.body ?? null
  } catch {
    storedBody = null
  }
  const attemptTimes = [created, updated, ...attempts.map((a) => new Date(String(a.recorded_at)))]
  let endpointPath = ''
  try {
    endpointPath = String(
      (JSON.parse(row.payload ?? '') as { endpoint_path?: string })?.endpoint_path ?? ''
    )
  } catch {
    endpointPath = ''
  }
  const all: FactCallLog[] = logsRaw.map((l) => ({
    id: Number(l.id),
    created_at: l.created_at as Date,
    method: (l.method as string) ?? null,
    url: (l.url as string) ?? null,
    response_status: (l.response_status as number) ?? null,
    duration_ms: (l.duration_ms as number) ?? null,
    error: (l.error as string) ?? null,
    triggered_by: (l.triggered_by as string) ?? null,
    user_id: (l.user_id as string) ?? null,
    // The call log masks secrets in its bodies — compare masked forms.
    body_match: sameLoggedBody(l.request_body as string | null, storedBody)
  }))
  // A body match is proof. Without one (the stored body can legitimately
  // differ — a writer that stores a trimmed copy), fall back to the same
  // endpoint within 10 s of a known attempt; that is only as good as the
  // clock, which is why the requester built on it is labelled inferred.
  const matched = all.filter((l) => l.body_match)
  const call_logs: FactCallLog[] = matched.length
    ? matched
    : all.filter(
        (l) =>
          (!endpointPath || String(l.url ?? '').includes(endpointPath)) &&
          attemptTimes.some((t) => Math.abs(new Date(l.created_at).getTime() - t.getTime()) <= pad)
      )

  // The obligation's transition (exact) and flow run.
  const ob = obligation ?? null
  const obligationTransition =
    ob && (ob.trigger === 'transition' || ob.trigger === 'manual')
      ? await transitionById(ob.trigger_ref)
      : null
  let flow: SubmissionFacts['flow'] = null
  const flowLog = call_logs.find((l) => l.triggered_by?.startsWith('flow:'))
  if (ob?.trigger === 'flow' && ob.trigger_ref) {
    const run = (await db('nivaro_flow_runs as r')
      .leftJoin('nivaro_flows as f', 'f.id', 'r.flow')
      .where('r.id', ob.trigger_ref)
      .first('f.id', 'f.name', 'r.user')
      .catch(() => null)) as { id: string; name: string; user: string | null } | null
    if (run?.id) flow = run
  } else if (flowLog) {
    const fid = String(flowLog.triggered_by).slice('flow:'.length)
    const fl = (await db('nivaro_flows')
      .where({ id: fid })
      .first('id', 'name')
      .catch(() => null)) as { id: string; name: string } | null
    if (fl) flow = { ...fl, user: null }
  }

  // The record's transition nearest the first send. When the obligation
  // names the transition EXACTLY (`obligationTransition` above resolved a
  // real row from its trigger_ref), filter on it directly instead of
  // guessing by clock alone — several transitions on the same record inside
  // the window would otherwise let the nearest one win by timestamp even
  // when it isn't the one that actually fired this push.
  const exactTransition = obligationTransition?.id ?? null
  const history = (await db('nivaro_workflow_history as h')
    .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
    .leftJoin('nivaro_workflow_templates as tp', 'tp.id', 't.template')
    .where('i.collection', row.collection)
    .where('i.item', String(row.item))
    .modify((qb) => {
      if (exactTransition) qb.where('h.transition', exactTransition)
    })
    // A blocking action sends BEFORE its history row is written, a post
    // action after — so look both sides and take the nearest. ±15s (was
    // ±60s: a wider window risked matching an unrelated later transition on
    // a record with several).
    .whereBetween('h.timestamp', [
      new Date(created.getTime() - HISTORY_WINDOW_MS),
      new Date(created.getTime() + HISTORY_WINDOW_MS)
    ])
    .orderByRaw('ABS(DATEDIFF_BIG(millisecond, h.[timestamp], ?))', [created])
    .first(
      'h.user',
      'h.origin',
      'h.timestamp',
      't.id as t_id',
      't.label as t_label',
      't.auto_trigger as t_auto',
      't.template as t_template',
      'tp.name as t_template_name'
    )
    .catch(() => null)) as Record<string, unknown> | null

  // A person's write to the record just before (the change that fired a
  // hook). −3s/+1s: a hook-driven push follows its record write almost
  // immediately — the wider −10s/+2s this used to use was wide enough to
  // catch an unrelated edit made moments earlier for a different reason.
  const recordEdit = (await db('nivaro_activity')
    .where({ collection: row.collection, item: String(row.item) })
    .whereIn('action', ['update', 'create'])
    .whereNotNull('user')
    .whereBetween('timestamp', [
      new Date(created.getTime() - RECORD_EDIT_WINDOW_BEFORE_MS),
      new Date(created.getTime() + RECORD_EDIT_WINDOW_AFTER_MS)
    ])
    .orderBy('timestamp', 'desc')
    .first('action', 'user', 'comment', 'timestamp')
    .catch(() => null)) as FactActivity | null

  const factAttempts: FactAttempt[] = attempts.map((a) => ({
    attempt: Number(a.attempt),
    recorded_at: a.recorded_at as Date,
    source: String(a.source ?? ''),
    requested_by: (a.requested_by as string) ?? null,
    requested_via: (a.requested_via as string) ?? null
  }))

  const userIds = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && /^[0-9A-Fa-f-]{36}$/.test(v)) userIds.add(v.toUpperCase())
  }
  add(row.requested_by)
  add(api?.owner_user)
  for (const a of factAttempts) add(a.requested_by)
  for (const a of activity) add(a.user)
  for (const l of call_logs) add(l.user_id)
  add(history?.user)
  add(recordEdit?.user)
  add(flow?.user)
  const users = userIds.size
    ? ((await db('nivaro_users')
        .whereIn('id', [...userIds])
        .select('id', 'first_name', 'last_name', 'email', 'status', 'is_redacted', 'account_kind')
        .catch(() => [])) as FactUser[])
    : []

  return {
    raw: row,
    row: {
      id: Number(row.id),
      collection: row.collection,
      item: String(row.item),
      external_api: Number(row.external_api),
      status: String(row.status),
      attempts: Number(row.attempts) || 1,
      payload: row.payload ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      error_class: (row.error_class as string) ?? null,
      obligation_id: row.obligation_id != null ? Number(row.obligation_id) : null,
      requested_by: (row.requested_by as string) ?? null,
      requested_via: (row.requested_via as string) ?? null
    },
    api: api ? { id: Number(api.id), name: api.name, owner_user: api.owner_user ?? null } : null,
    record_label: label,
    obligation: ob,
    obligation_transition: obligationTransition,
    flow,
    attempts: factAttempts,
    activity,
    call_logs,
    history: history
      ? {
          user: (history.user as string) ?? null,
          origin: (history.origin as string) ?? null,
          timestamp: history.timestamp as Date,
          transition: history.t_id
            ? {
                id: String(history.t_id),
                label: String(history.t_label ?? ''),
                auto_trigger: history.t_auto as boolean | number | null,
                template_id: (history.t_template as string) ?? null,
                template_name: (history.t_template_name as string) ?? null
              }
            : null
        }
      : null,
    record_edit: recordEdit,
    newer_landed: newer[0] ? { id: Number(newer[0].id), status: newer[0].status } : null,
    users
  }
}
