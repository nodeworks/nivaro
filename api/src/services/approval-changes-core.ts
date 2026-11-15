/**
 * "Changed after approval" — the pure half (round 7, item 21; Rob approved 2026-11-14).
 *
 * A record that reached an approved step (the post-approval lock's admin-only states, or the
 * states a collection names) and changed afterwards — an administrator editing through the lock,
 * a procedure or partner writing back, an accepted change proposal — shows a live badge with a
 * compact diff: the value it had when it was approved → the value now, who changed it and when.
 * This module holds what can be judged without the database: the setting, the approval moment
 * from the run's history, value equality and the diff itself (approval-changes.ts reads the rows).
 *
 * Setting: `summary_mode_rules.changed_after_approval` on the collection —
 *   absent / true      on where the post-approval lock (edit_lock.admin_only) exists, with its
 *                      states; nothing where there is no such lock
 *   false              off
 *   { states: [...] }  on, with these approved state keys (works without a lock)
 * Fields the lock leaves open (admin_only.open_fields) never count: changing them after
 * approval is what the lock allows on purpose.
 */

const STATE_KEY_RE = /^[A-Za-z0-9_\-:.]{1,100}$/
const MAX_STATES = 50

export type ChangedAfterApprovalSetting = false | { states: string[] }

function stateList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [
    ...new Set(v.filter((x): x is string => typeof x === 'string' && STATE_KEY_RE.test(x)))
  ].slice(0, MAX_STATES)
}

/** Lenient read: `false`, `{ states }`, or undefined (= the default). */
export function parseChangedAfterApproval(raw: unknown): ChangedAfterApprovalSetting | undefined {
  if (raw === false) return false
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as { states?: unknown; enabled?: unknown }
    if (o.enabled === false) return false
    const states = stateList(o.states)
    return states.length > 0 ? { states } : undefined
  }
  return undefined
}

/** Strict write of the key (Form UX save). */
export function validateChangedAfterApproval(
  raw: unknown
):
  | { value: ChangedAfterApprovalSetting | undefined; error?: undefined }
  | { value?: undefined; error: string } {
  if (raw === undefined || raw === null || raw === true) return { value: undefined }
  if (raw === false) return { value: false }
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'summary_mode_rules.changed_after_approval must be false or { states }' }
  const o = raw as { states?: unknown }
  if (o.states !== undefined && !Array.isArray(o.states))
    return {
      error: 'summary_mode_rules.changed_after_approval.states must be a list of state keys'
    }
  if (Array.isArray(o.states) && o.states.length > MAX_STATES)
    return { error: `summary_mode_rules.changed_after_approval.states: at most ${MAX_STATES}` }
  for (const s of (o.states as unknown[] | undefined) ?? [])
    if (typeof s !== 'string' || !STATE_KEY_RE.test(s))
      return {
        error: 'summary_mode_rules.changed_after_approval.states entries must be state keys'
      }
  return { value: parseChangedAfterApproval(raw) }
}

export interface ApprovalChangesConfig {
  /** Approved state keys: a record whose latest run sits in one was approved. */
  states: string[]
  /** States of the approval tier (edit_lock.states): moves out of them are approvals. */
  approvalStates: string[]
  /** Record fields that never count (the lock's open fields). */
  ignore: string[]
}

interface RulesLike {
  edit_lock?: {
    states?: string[]
    admin_only?: { states?: string[]; open_fields?: string[] }
  }
  changed_after_approval?: ChangedAfterApprovalSetting
}

/** The collection's setting resolved, or null when the badge is off there. */
export function approvalChangesConfigOf(
  rules: RulesLike | null | undefined
): ApprovalChangesConfig | null {
  if (!rules) return null
  const setting = rules.changed_after_approval
  if (setting === false) return null
  const adminOnly = rules.edit_lock?.admin_only
  const states =
    setting && setting.states.length > 0 ? setting.states : stateList(adminOnly?.states)
  if (states.length === 0) return null
  return {
    states,
    approvalStates: stateList(rules.edit_lock?.states),
    ignore: Array.isArray(adminOnly?.open_fields) ? adminOnly.open_fields.map(String) : []
  }
}

export interface HistoryStep {
  from_key: string | null
  to_key: string
  user: string | null
  at: Date
}

export interface ApprovalMoment {
  /** When the record entered its approved stretch. */
  at: Date
  /** The approved state it entered. */
  state: string
  /** The people whose moves approved it, newest first (no machine moves). */
  approvers: string[]
}

/** Writes this soon after the approving move are part of it (transition actions, stamps). */
export const APPROVAL_GRACE_MS = 15_000

/**
 * When did the record (its latest run, history oldest first) become approved? The newest move
 * INTO an approved state from a state that is not one (approved → closed stays one stretch; a
 * send-back and re-approval starts a new one). Null while the run is not in an approved state.
 * A run that started in an approved state counts from its start.
 *
 * Approvers: whoever made that move, plus the people who moved the record out of the approval
 * tier's states in the unbroken chain leading up to it (manager → director → approved).
 */
export function approvalMomentOf(
  steps: HistoryStep[],
  currentKey: string | null,
  cfg: Pick<ApprovalChangesConfig, 'states' | 'approvalStates'>,
  startedAt?: Date | null
): ApprovalMoment | null {
  const approved = new Set(cfg.states)
  if (!currentKey || !approved.has(currentKey)) return null
  let i = steps.length - 1
  for (; i >= 0; i--) {
    const s = steps[i]
    if (approved.has(s.to_key) && (s.from_key == null || !approved.has(s.from_key))) break
  }
  if (i < 0) {
    if (!startedAt || Number.isNaN(startedAt.getTime())) return null
    return { at: startedAt, state: currentKey, approvers: [] }
  }
  const tier = new Set(cfg.approvalStates)
  const approvers: string[] = []
  const add = (u: string | null) => {
    if (u && !approvers.includes(u)) approvers.push(u)
  }
  add(steps[i].user)
  for (let j = i - 1; j >= 0; j--) {
    const from = steps[j].from_key
    if (!from || !tier.has(from)) break
    add(steps[j].user)
  }
  return { at: steps[i].at, state: steps[i].to_key, approvers: approvers.slice(0, 10) }
}

/**
 * Rich text as its words: a legacy EditorJS document (object or JSON text) and the Tiptap HTML it
 * was converted to read the same, so the conversion is never "a change after approval". Null when
 * the value is neither.
 */
export function richPlain(v: unknown): string | null {
  let doc: unknown = v
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('{') && /"blocks"\s*:/.test(s)) {
      try {
        doc = JSON.parse(s)
      } catch {
        return null
      }
    } else if (/^<[a-z][\s\S]*>$/i.test(s)) return plainWords(s)
    else return null
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { blocks?: unknown }).blocks))
    return null
  const parts: string[] = []
  for (const b of (doc as { blocks: Array<{ data?: Record<string, unknown> }> }).blocks) {
    const d = b?.data ?? {}
    if (typeof d.text === 'string') parts.push(d.text)
    else if (Array.isArray(d.items))
      for (const it of d.items as unknown[])
        parts.push(
          typeof it === 'string' ? it : String((it as { content?: unknown })?.content ?? '')
        )
  }
  return plainWords(parts.join(' '))
}

function plainWords(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function norm(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null
  const rich = richPlain(v)
  if (rich !== null) return rich === '' ? null : rich
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    // A stored decimal reads "12.50" from one path and 12.5 from another.
    if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 17) return Number(t)
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
      const d = new Date(t.includes('T') ? t : t.replace(' ', 'T'))
      if (!Number.isNaN(d.getTime())) return d.toISOString()
    }
    if (t === 'true' || t === 'false') return t === 'true'
    return t
  }
  return JSON.stringify(v)
}

/** Equal as values, not as spellings (numbers vs numeric text, Date vs ISO text, '' vs null). */
export function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'boolean' && typeof y === 'number') return Number(x) === y
  if (typeof y === 'boolean' && typeof x === 'number') return Number(y) === x
  return x === y
}

export type WriterVia = 'user' | 'import' | 'integration' | 'proposal' | 'system' | 'outside'

export interface Writer {
  id: string | null
  name: string
  via: WriterVia
}

export interface AppWrite {
  at: Date
  delta: Record<string, unknown>
  by: Writer
}

export interface ApprovalChange {
  field: string
  before: unknown
  after: unknown
  /** False when the approved value was never recorded (no history before approval). */
  before_known: boolean
  /** Who changed it last; `via: 'outside'` = no app write explains it (a procedure or script). */
  by: Writer
  at: string | null
}

export const OUTSIDE_WRITER: Writer = { id: null, name: 'Outside the app', via: 'outside' }

/**
 * Field by field, the approved value → the value now. `writes` are the app's writes since the
 * approval moment, NEWEST first; the newest one naming a field says who changed it and when. A
 * field whose value differs with no write naming it was written outside the app. Without an
 * approved snapshot, the fields an app write touched are listed with an unknown before value.
 * A field changed and put back reads unchanged (the badge is about the approved value).
 */
export function diffSinceApproval(input: {
  approved: Record<string, unknown> | null
  current: Record<string, unknown>
  fields: string[]
  writes: AppWrite[]
}): ApprovalChange[] {
  const out: ApprovalChange[] = []
  const lastWrite = (f: string) => input.writes.find((w) => Object.hasOwn(w.delta, f))
  for (const f of input.fields) {
    if (!Object.hasOwn(input.current, f)) continue
    const w = lastWrite(f)
    if (input.approved) {
      if (!Object.hasOwn(input.approved, f)) continue
      if (sameValue(input.approved[f], input.current[f])) continue
      out.push({
        field: f,
        before: input.approved[f] ?? null,
        after: input.current[f] ?? null,
        before_known: true,
        by: w ? w.by : OUTSIDE_WRITER,
        at: w ? w.at.toISOString() : null
      })
    } else if (w) {
      out.push({
        field: f,
        before: null,
        after: input.current[f] ?? null,
        before_known: false,
        by: w.by,
        at: w.at.toISOString()
      })
    }
  }
  // Newest first; changes nobody in the app made last.
  return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/** Who wrote an activity row, as a reader is told (never a credential, never an id alone). */
export function writerOf(row: {
  user_id?: string | null
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  comment?: string | null
  machine?: boolean
}): Writer {
  const comment = String(row.comment ?? '')
  const name =
    [row.first_name, row.last_name].filter(Boolean).join(' ').trim() ||
    String(row.email ?? '').trim()
  const proposal = /^Accepted change proposal #(\d+)/.exec(comment)
  if (proposal)
    return {
      id: row.user_id ?? null,
      name: `${name || 'Someone'} (accepted proposal #${proposal[1]})`,
      via: 'proposal'
    }
  if (/^import:/i.test(comment)) {
    const file = comment.split(':')[1]
    return { id: row.user_id ?? null, name: file ? `Import (${file})` : 'Import', via: 'import' }
  }
  if (!row.user_id) return { id: null, name: 'The system', via: 'system' }
  if (row.machine) return { id: row.user_id, name: name || 'An integration', via: 'integration' }
  return { id: row.user_id, name: name || 'Someone', via: 'user' }
}

/** Record fields whose change after approval is news (real columns, not stamps or state). */
export function trackedFields(
  fields: Array<{
    field: string
    type?: string | null
    special?: string[] | null
    computed_type?: string | null
    computed_store?: boolean | null
  }>,
  skip: Iterable<string>
): string[] {
  const skipped = new Set(skip)
  const STAMPS = ['date-created', 'date-updated', 'user-created', 'user-updated']
  return fields
    .filter((f) => {
      if (f.field === 'id' || skipped.has(f.field)) return false
      const t = String(f.type ?? '').toLowerCase()
      if (t === 'alias' || t === 'o2m' || t === 'm2m' || t === 'm2a' || t === 'files') return false
      if ((f.special ?? []).some((s) => STAMPS.includes(String(s)) || s === 'o2m' || s === 'm2m'))
        return false
      // A read-computed figure has no column; it moves with its inputs, which are tracked.
      if (f.computed_type === 'read' && !f.computed_store) return false
      return true
    })
    .map((f) => f.field)
}
