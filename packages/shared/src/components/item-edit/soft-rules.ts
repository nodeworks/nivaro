import { titleCase } from '../../lib/utils'
import { applyValidationRule } from '../../lib/validation-rules'
import type { FormValidationRule } from '../../types'
import { ruleValueFor } from './line-qty'

/**
 * The first SOFT (warning-only) validation rule a field's value breaks, as the
 * message to show under the field — or null. Soft rules never block a save:
 * the form's save check skips them and so does the server
 * (enforceValidationRules), so the only place they speak is here (army4
 * a01-5: they used to say nothing anywhere while the server refused them).
 */
export function softRuleWarning(
  field: {
    field: string
    type?: string | null
    label?: string | null
    validation_rules?: unknown
  },
  draft: Record<string, unknown>
): string | null {
  const raw = field.validation_rules
  if (raw == null || raw === '') return null
  let rules: unknown = raw
  if (typeof raw === 'string') {
    try {
      rules = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(rules)) return null
  const value = ruleValueFor(field.type, draft[field.field])
  if (value === null || value === undefined || value === '') return null
  const label = field.label || titleCase(field.field)
  for (const rule of rules as FormValidationRule[]) {
    if (!rule || typeof rule !== 'object' || !rule.soft) continue
    const msg = applyValidationRule(rule, value, label, draft)
    if (msg) return msg
  }
  return null
}
