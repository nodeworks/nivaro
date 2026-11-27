import type { FieldChange } from '../types.js'

/**
 * Task 19 (security fix): a protection change is `public_exposure` (a Hub administrator applies
 * it) unless it is PROVABLY a tightening. "Cannot prove" always counts as weakening: a missing
 * from/to, an unknown field, a value of an unexpected shape.
 */

const strs = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null

/** More of a number is stronger. */
const numberUp = (c: FieldChange): boolean =>
  typeof c.from === 'number' && typeof c.to === 'number' && c.to >= c.from

/** A flag that protects when true: only staying or going true is a tightening. */
const flagOn = (c: FieldChange): boolean => c.to === true || (c.from === false && c.to === true)

/** A flag that weakens when true (allow force pushes): only staying or going false is safe. */
const flagOff = (c: FieldChange): boolean => c.to === false

/** A required set (reviewers, status checks): everything required before is still required. */
const keepsAll = (c: FieldChange): boolean => {
  const from = strs(c.from)
  const to = strs(c.to)
  return !!from && !!to && from.every((x) => to.includes(x))
}

/** An allowed set (deployment branch patterns): the new set is a subset of the old. */
const subset = (c: FieldChange): boolean => {
  const from = strs(c.from)
  const to = strs(c.to)
  return !!from && !!to && to.every((x) => from.includes(x))
}

export function environmentChangeIsTightening(c: FieldChange): boolean {
  switch (c.field) {
    case 'reviewers':
      return keepsAll(c)
    case 'prevent_self_review':
      return flagOn(c)
    case 'wait_timer':
      return numberUp(c)
    case 'deployment_branches':
      // Only "any branch" to a restricted policy is provably tighter.
      return c.from === 'all' && (c.to === 'protected' || c.to === 'selected')
    case 'branch_patterns':
      return subset(c)
    default:
      return false
  }
}

const RULESET_ON = new Set([
  'dismiss_stale_reviews',
  'require_code_owner_review',
  'require_conversation_resolution',
  'strict_status_checks',
  'block_deletions',
  'block_force_pushes',
  'require_linear_history',
  'require_signatures'
])

export function rulesetChangeIsTightening(c: FieldChange): boolean {
  if (c.field === 'name') return true
  if (c.field === 'required_reviews') return numberUp(c)
  if (c.field === 'required_status_checks') return keepsAll(c)
  if (RULESET_ON.has(c.field)) return flagOn(c)
  // enforcement, target, include / exclude / repositories conditions, anything unknown.
  if (c.field === 'enforcement') return c.to === 'active'
  return false
}

const PROTECTION_ON = new Set([
  'dismiss_stale_reviews',
  'require_code_owner_reviews',
  'strict_status_checks',
  'enforce_admins',
  'required_linear_history',
  'required_conversation_resolution'
])
const PROTECTION_OFF = new Set(['allow_force_pushes', 'allow_deletions'])

export function branchProtectionChangeIsTightening(c: FieldChange): boolean {
  if (c.field === 'required_reviews') return numberUp(c)
  if (c.field === 'required_status_checks') return keepsAll(c)
  if (PROTECTION_ON.has(c.field)) return flagOn(c)
  if (PROTECTION_OFF.has(c.field)) return flagOff(c)
  return false
}

/** Paths a repository file may be written to by an owner without a Hub administrator. */
export function isAllowListedPath(path: string): boolean {
  const p = path.replace(/^\/+/, '')
  if (/(^|\/)\.github(\/|$)/i.test(p) || /(^|\/)\.\.(\/|$)/.test(p)) return false
  if (/^README[^/]*$/i.test(p)) return true
  // A file that runs or decides reviews is never allow-listed, wherever it sits.
  const base = p.split('/').pop() ?? ''
  if (/^(CODEOWNERS|Dockerfile.*|action\.ya?ml|package\.json)$/i.test(base)) return false
  if (/\.(sh|ya?ml)$/i.test(base)) return false
  if (/^docs\//i.test(p)) return true
  return /\.md$/i.test(p)
}
