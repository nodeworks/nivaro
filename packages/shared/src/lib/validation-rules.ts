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

// ─── Phone normalization (#520) ──────────────────────────────────────────────
// Lightweight NANP + international normalizer — deliberately no libphonenumber
// dependency. Stored form is E.164-ish digits ('+13125550100'); display form is
// '+1 (312) 555-0100' for NANP, '+<digits>' for international. The server-side
// evaluator (api/src/services/validation-rules.ts) mirrors isValidPhone's
// acceptance rule exactly — the two must not drift.

export function normalizePhone(raw: unknown): {
  stored: string | null
  display: string
  valid: boolean
} {
  const s = String(raw ?? '').trim()
  if (!s) return { stored: null, display: '', valid: true }
  const hadPlus = s.startsWith('+')
  const digits = s.replace(/\D/g, '')
  if (digits.length === 0) return { stored: null, display: s, valid: false }
  // NANP: 10 bare digits, or 11 starting with 1 (with or without the +).
  const nanp10 =
    digits.length === 10 && !hadPlus
      ? digits
      : digits.length === 11 && digits.startsWith('1')
        ? digits.slice(1)
        : null
  if (nanp10) {
    return {
      stored: `+1${nanp10}`,
      display: `+1 (${nanp10.slice(0, 3)}) ${nanp10.slice(3, 6)}-${nanp10.slice(6)}`,
      valid: true
    }
  }
  // International: explicit + with a plausible digit count passes through.
  if (hadPlus && digits.length >= 8 && digits.length <= 15) {
    return { stored: `+${digits}`, display: `+${digits}`, valid: true }
  }
  // Junk-stripped but unrecognized — keep what was typed, flag invalid.
  return { stored: hadPlus ? `+${digits}` : digits, display: s, valid: false }
}

/** Display formatting for a STORED phone value (E.164-ish digits). */
export function formatPhone(stored: unknown): string {
  const n = normalizePhone(stored)
  return n.valid && n.stored ? n.display : String(stored ?? '')
}

/** Evaluate one field validation rule against a value. Returns an error message
 *  or null. Shared by useNivaroForm (headless) and ItemEditForm (admin). */
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
  rule: FormValidationRule,
  value: unknown,
  label: string,
  record?: Record<string, unknown>
): string | null {
  // required_if (#65): required only when a SIBLING field matches a condition.
  // Judged before the empty-guard — an empty value is exactly what it catches.
  // A rule without a `field` is the legacy no-op shape; no record = can't judge.
  if (rule.type === 'required_if') {
    const dep = (rule as { field?: string }).field
    if (!dep || !record) return null
    if (!conditionMatches(record[dep], String((rule as { op?: string }).op ?? 'eq'), rule.value))
      return null
    return isEmptyVal(value)
      ? (rule.message ?? `${label} is required when ${dep} matches this condition`)
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
        return null
      }
    }
    case 'email': {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      return re.test(String(value)) ? null : (rule.message ?? `${label} must be a valid email`)
    }
    case 'phone': {
      return normalizePhone(value).valid
        ? null
        : (rule.message ?? `${label} must be a valid phone number`)
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
