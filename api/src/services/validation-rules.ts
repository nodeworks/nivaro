import { getFields } from './collections.js'
import { validatorRegistry } from '../extensions/validators.js'

/**
 * Server-side enforcement of `nivaro_fields.validation_rules`.
 *
 * These rules were documented as "enforced server-side in createOne/updateOne"
 * for months while the only evaluator lived in the browser — an SDK write, a
 * GraphQL mutation, an import or an integration could set a delivery date
 * three days out past a min_days_from_today(7) rule and nothing said a word.
 * This mirrors the shared client evaluator
 * (packages/shared/src/lib/validation-rules.ts) rule for rule; the two must
 * not drift, because a value the form accepts must never be rejected by the
 * save it triggers.
 *
 * Scope, chosen deliberately:
 *
 *   - Only fields PRESENT in the payload are judged. Demanding absent fields
 *     would break every integration that legitimately writes partial rows
 *     (mwf-ingest, Nuvolo shaping, import execute) — `required` therefore
 *     fires only when a caller EXPLICITLY sends an empty value, which is the
 *     one case where emptiness is a statement rather than an omission.
 *   - Every non-required rule already skips empty values (same as the client),
 *     so optional fields stay optional.
 *   - First failure wins, as the admin docs always described:
 *     400 { error, field, rule }.
 */

export interface ValidationRule {
  type: string
  value?: unknown
  message?: string
  // required_if only: sibling field + condition making this field required
  field?: string
  op?: string
}

export class FieldValidationError extends Error {
  statusCode = 400
  code = 'VALIDATION_RULE_FAILED'
  violations: Array<{ field: string; rule: string; message: string }>
  constructor(
    message: string,
    readonly field: string,
    readonly rule: string
  ) {
    super(message)
    // Rides the server error handler's existing code/violations forwarding —
    // same channel AI validation and sum_cap already use.
    this.violations = [{ field, rule, message }]
  }
}

function isEmptyVal(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

function calendarDaysFromToday(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((a - b) / 86_400_000)
}

/** One rule against one value. Returns the error message, or null. */
function conditionMatches(other: unknown, op: string, cmp: unknown): boolean {
  switch (op) {
    case 'null':
      return isEmptyVal(other)
    case 'nnull':
      return !isEmptyVal(other)
    case 'neq':
      return String(other ?? '') !== String(cmp ?? '')
    case 'in': {
      const list = Array.isArray(cmp) ? cmp : String(cmp ?? '').split(',')
      return list.some((v) => String(v).trim() === String(other ?? ''))
    }
    default:
      return String(other ?? '') === String(cmp ?? '')
  }
}

export function applyValidationRule(
  rule: ValidationRule,
  value: unknown,
  label: string,
  record?: Record<string, unknown>
): string | null {
  // required_if (#65): required only when a SIBLING field matches a condition.
  // Mirrors the shared client evaluator exactly — the two must not drift. No
  // record (or a rule without `field`, the legacy shape) = can't judge = pass.
  if (rule.type === 'required_if') {
    if (!rule.field || !record || !(rule.field in record)) return null
    if (!conditionMatches(record[rule.field], String(rule.op ?? 'eq'), rule.value)) return null
    return isEmptyVal(value)
      ? (rule.message ?? `${label} is required when ${rule.field} matches this condition`)
      : null
  }
  if (isEmptyVal(value) && rule.type !== 'required') return null
  switch (rule.type) {
    case 'required':
      return isEmptyVal(value) ? (rule.message ?? `${label} is required`) : null
    case 'min': {
      const min = Number(rule.value)
      if (typeof value === 'number' && value < min)
        return rule.message ?? `${label} must be at least ${min}`
      if (typeof value === 'string' && value.length < min)
        return rule.message ?? `${label} must be at least ${min} characters`
      return null
    }
    case 'max': {
      const max = Number(rule.value)
      if (typeof value === 'number' && value > max)
        return rule.message ?? `${label} must be at most ${max}`
      if (typeof value === 'string' && value.length > max)
        return rule.message ?? `${label} must be at most ${max} characters`
      return null
    }
    case 'regex': {
      try {
        const re = new RegExp(String(rule.value))
        return re.test(String(value)) ? null : (rule.message ?? `${label} is invalid`)
      } catch {
        // A broken pattern is admin config error, not caller error — pass.
        return null
      }
    }
    case 'email': {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      return re.test(String(value)) ? null : (rule.message ?? `${label} must be a valid email`)
    }
    case 'url': {
      try {
        new URL(String(value))
        return null
      } catch {
        return rule.message ?? `${label} must be a valid URL`
      }
    }
    case 'min_days_from_today': {
      const diff = calendarDaysFromToday(value)
      const n = Number(rule.value)
      if (diff === null || Number.isNaN(n)) return null
      return diff >= n ? null : (rule.message ?? `${label} must be at least ${n} days from today`)
    }
    case 'max_days_from_today': {
      const diff = calendarDaysFromToday(value)
      const n = Number(rule.value)
      if (diff === null || Number.isNaN(n)) return null
      return diff <= n ? null : (rule.message ?? `${label} must be within ${n} days of today`)
    }
    case 'custom': {
      // Custom validators (#239): extension-registered functions keyed by
      // operator. The CLIENT skips these (unknown type = pass), so the server
      // is the enforcement point — exactly right for extension logic.
      try {
        const op = (rule as { operator?: string }).operator
        if (!op || !validatorRegistry.has(op)) return null
        const err = validatorRegistry.run(op, value, (rule as { options?: unknown }).options)
        return err ? (rule.message ?? err) : null
      } catch {
        return null
      }
    }
    default:
      // An unknown rule type is a NEWER client's config on an older server —
      // never a reason to block the write.
      return null
  }
}

function parseRules(raw: unknown): ValidationRule[] {
  if (raw == null) return []
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (r): r is ValidationRule => !!r && typeof r === 'object' && typeof (r as ValidationRule).type === 'string'
  )
}

/**
 * Throws FieldValidationError (400 {error, field, rule}) on the first rule a
 * payload value violates. `callerFields` restricts judgment to fields the
 * ORIGINAL request carried — machine-derived values (field rules, computed
 * fields, autofill) are never the caller's fault and must not 400 the write.
 */
export async function enforceValidationRules(
  collection: string,
  payload: Record<string, unknown>,
  callerFields: Set<string>
): Promise<void> {
  if (collection.startsWith('nivaro_')) return

  let fields: Array<{ field: string; validation_rules?: unknown; label?: string | null }>
  try {
    fields = (await getFields(collection)) as typeof fields
  } catch {
    return // unreadable metadata must never block a write
  }

  for (const f of fields) {
    if (!callerFields.has(f.field)) continue
    const rules = parseRules(f.validation_rules)
    if (rules.length === 0) continue
    const label = f.field
    const value = payload[f.field]
    for (const rule of rules) {
      const error = applyValidationRule(rule, value, label, payload)
      if (error) throw new FieldValidationError(error, f.field, rule.type)
    }
  }
}
