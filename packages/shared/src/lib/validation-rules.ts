import type { FormValidationRule } from '../types'

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

/** Evaluate one field validation rule against a value. Returns an error message
 *  or null. Shared by useNivaroForm (headless) and ItemEditForm (admin). */
export function applyValidationRule(
  rule: FormValidationRule,
  value: unknown,
  label: string
): string | null {
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
    // Date must be at least N calendar days from today (EFP delivery-date
    // minimums). max_days_from_today caps how far out a date may be.
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
    default:
      return null
  }
}
