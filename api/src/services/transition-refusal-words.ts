import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can, getAllowedFields } from './permissions.js'

/**
 * The words a refused pipeline move answers with — ONE place for every path
 * that refuses a move (the record's transition route, branch transitions,
 * bulk transition, GraphQL / REST updates that name a target step). Each
 * sentence names the move, the step the record is at and what would let the
 * move run, so an integration reading only the message can act on it.
 */

export const PIPELINE_COMPLETED = 'PIPELINE_COMPLETED'
export const TRANSITION_NOT_VALID = 'TRANSITION_NOT_VALID'
export const TRANSITION_AUTOMATIC = 'TRANSITION_AUTOMATIC'
export const TRANSITION_FORBIDDEN = 'TRANSITION_FORBIDDEN'
export const TRANSITION_CONDITIONS = 'TRANSITION_CONDITIONS'

export interface ConditionRuleLike {
  field: string
  op: string
  value: string | number | null
}

function fieldWords(field: string): string {
  return field
    .split('.')
    .map((seg) => seg.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(' › ')
}

/** A transition condition rule in words: 'Vendor must be set',
 *  'Needs at least one Workflow Line Items row'. */
export function describeConditionRule(rule: ConditionRuleLike): string {
  const op = String(rule.op)
  const value = rule.value == null ? '' : String(rule.value)
  if (op === 'related_some' || op === 'related_none') {
    const child = fieldWords(String(rule.field).split(':')[0] ?? '')
    return op === 'related_some'
      ? `Needs at least one ${child} row`
      : `Must have no matching ${child} rows`
  }
  if (op === 'children_in_state' || op === 'children_not_in_state') {
    const child = fieldWords(String(rule.field).split(':')[0] ?? '')
    return op === 'children_in_state'
      ? `Every ${child} row must be at ${value}`
      : `No ${child} row may be at ${value}`
  }
  if (rule.field === HIDDEN_RULE_FIELD) return "A condition you can't see is not met"
  if (rule.field === '$state') return `The record must be at step ${value}`
  if (rule.field === '$addendum_active')
    return /^(1|true)$/i.test(value)
      ? 'An addendum must be going through approval'
      : 'No addendum may be going through approval'
  const f = fieldWords(String(rule.field))
  switch (op) {
    case 'nnull':
      return `${f} must be set`
    case 'null':
      return `${f} must be empty`
    case 'eq':
      return `${f} must be ${value}`
    case 'neq':
      return `${f} must not be ${value}`
    case 'in':
      return `${f} must be one of ${value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .join(', ')}`
    case 'notin':
      return `${f} must not be any of ${value}`
    case 'contains':
      return `${f} must contain ${value}`
    case 'gt':
      return `${f} must be more than ${value}`
    case 'gte':
      return `${f} must be at least ${value}`
    case 'lt':
      return `${f} must be less than ${value}`
    case 'lte':
      return `${f} must be at most ${value}`
    case 'within_days':
      return `${f} must be within ${value} days`
    case 'beyond_days':
      return `${f} must be more than ${value} days away`
    default:
      return `${f} ${op.replace(/_/g, ' ')} ${value}`.trim()
  }
}

/** Stands in for a rule on a field the caller may not read (see visibleUnmetRules). */
export const HIDDEN_RULE_FIELD = '$hidden'
const HIDDEN_RULE: ConditionRuleLike = { field: HIDDEN_RULE_FIELD, op: 'hidden', value: null }

/**
 * The unmet rules a refusal may show THIS caller. A rule names a field and the
 * value it wants, so a failed rule tells something about the record ("Salary
 * must be less than 100000" failing says it is not): a rule on a field the
 * caller may not read, or on child rows of a collection they may not read,
 * becomes one "a condition you can't see" placeholder — never its field, op,
 * value or related filter. A dotted path (an M2O hop) is shown to
 * administrators only. A failed permission read hides the rule (fail closed).
 * Administrators see every rule.
 */
export async function visibleUnmetRules(
  user: User | undefined,
  isAdmin: boolean,
  collection: string,
  unmet: ConditionRuleLike[]
): Promise<ConditionRuleLike[]> {
  if (isAdmin || unmet.length === 0) return unmet
  if (!user) return [HIDDEN_RULE]
  let fields: string[] | null | undefined
  const readable = async (field: string): Promise<boolean> => {
    if (field === '$state') return true
    if (field === '$addendum_active') return true
    if (field.includes(':')) {
      const child = field.split(':')[0] ?? ''
      return child ? await can(user, 'read', child) : false
    }
    if (field.includes('.')) return false
    if (fields === undefined) fields = await getAllowedFields(user, 'read', collection)
    return fields === null || fields.includes('*') || fields.includes(field)
  }
  const shown: ConditionRuleLike[] = []
  let hidden = false
  for (const r of unmet) {
    let ok = false
    try {
      ok = await readable(String(r.field))
    } catch {
      ok = false
    }
    if (ok) shown.push(r)
    else hidden = true
  }
  return hidden ? [...shown, HIDDEN_RULE] : shown
}

/** Unmet rules in words, each a sentence ending in a full stop. */
export function conditionSentences(unmet: ConditionRuleLike[]): string[] {
  return unmet.map((r) => `${describeConditionRule(r)}.`)
}

const quoted = (s: string | null | undefined) => (s ? `"${s}"` : 'this move')

export function completedMessage(move: string | null, stepLabel: string | null): string {
  const at = stepLabel ? ` at "${stepLabel}"` : ''
  return `This record's pipeline has ended${at}, so ${quoted(move)} can't run. It has to be reopened before it can move again.`
}

export function notFromHereMessage(
  move: string | null,
  currentLabel: string | null,
  fromLabel: string | null
): string {
  const here = currentLabel ? `"${currentLabel}"` : 'the step this record is at'
  const only = fromLabel ? ` It only runs from "${fromLabel}".` : ''
  return `${capital(quoted(move))} can't run from ${here}.${only}`
}

export function automaticMessage(move: string | null): string {
  return `${capital(quoted(move))} runs automatically when its conditions are met; it can't be made by hand.`
}

export function roleMessage(move: string | null, allowedRoles: string[]): string {
  const who = allowedRoles.length > 0 ? ` Roles that can: ${allowedRoles.join(', ')}.` : ''
  return `Your role can't make ${quoted(move)}.${who}`
}

/** One move's unmet conditions: '"Submit" can't run yet. Needs at least one … row.' */
export function conditionsMessage(move: string | null, unmet: ConditionRuleLike[]): string {
  const why = conditionSentences(unmet)
  return why.length > 0
    ? `${capital(quoted(move))} can't run yet. ${why.join(' ')}`
    : `${capital(quoted(move))} can't run yet: this record doesn't meet its conditions.`
}

/**
 * Several moves lead to the same step and each one's conditions fail (a branch
 * per record type, say): what would let ANY of them run.
 */
export function conditionsToStepMessage(
  targetLabel: string,
  alternatives: ConditionRuleLike[][]
): string {
  const options = alternatives
    .map((unmet) => conditionSentences(unmet).join(' '))
    .filter((s) => s.length > 0)
  const unique = [...new Set(options)]
  if (unique.length === 0)
    return `Can't move to "${targetLabel}" yet: this record doesn't meet the conditions of any move that leads there.`
  if (unique.length === 1) return `Can't move to "${targetLabel}" yet. ${unique[0]}`
  return `Can't move to "${targetLabel}" yet. Any one of these would allow it: ${unique
    .map((s, i) => `(${i + 1}) ${s}`)
    .join(' ')}`
}

function capital(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** Run a label read; a failed read only costs the words, never the refusal. */
async function quietly<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}

/** Labels for the words: the move's own label and the steps' labels, one read each. */
export async function refusalLabels(input: {
  transitionId: string
  transitionLabel?: string | null
  stateIds: Array<string | null | undefined>
}): Promise<{ move: string | null; states: Map<string, string> }> {
  let move = input.transitionLabel ?? null
  if (!move) {
    const row = await quietly(
      async () =>
        (await db('nivaro_workflow_transitions')
          .where({ id: input.transitionId })
          .first('label')) as { label?: string | null } | undefined,
      undefined
    )
    move = typeof row?.label === 'string' && row.label ? row.label : null
  }
  const ids = [...new Set(input.stateIds.filter((s): s is string => !!s))]
  const states = new Map<string, string>()
  if (ids.length > 0) {
    const rows = await quietly(
      async () =>
        (await db('nivaro_workflow_states')
          .whereIn('id', ids)
          .select('id', 'key', 'label')) as Array<{
          id: string
          key: string
          label: string | null
        }>,
      []
    )
    if (Array.isArray(rows))
      for (const r of rows)
        if (r?.id != null) states.set(String(r.id).toUpperCase(), r.label || r.key)
  }
  return { move, states }
}

export const stateLabel = (states: Map<string, string>, id: string | null | undefined) =>
  id ? (states.get(String(id).toUpperCase()) ?? null) : null

/** Role names for the role refusal: ids resolved through nivaro_roles, names kept as given. */
export async function roleNames(roles: string[]): Promise<string[]> {
  const ids = roles.filter((r) => /^[0-9a-f-]{36}$/i.test(r))
  if (ids.length === 0) return roles
  const rows = await quietly(
    async () =>
      (await db('nivaro_roles').whereIn('id', ids).select('id', 'name')) as Array<{
        id: string
        name: string
      }>,
    []
  )
  const byId = new Map(
    (Array.isArray(rows) ? rows : []).map((r) => [String(r.id).toUpperCase(), r.name])
  )
  return roles.map((r) => byId.get(r.toUpperCase()) ?? r)
}
