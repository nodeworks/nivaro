import {
  isReferenceName,
  type NumberFieldMeta,
  type NumberKind,
  numberCurrencyOf,
  numberDecimalsOf,
  numberKindOf,
  numberKindOfValue
} from './number-kind'
import { numberLocale } from './utils'

/**
 * Display-only number formatting: the one place a figure a person READS on
 * screen is turned into text (12345 → 12,345, money → $12,345.67). Never use
 * these for inputs, edit cells, form state, API payloads, CSV or logs — those
 * keep the stored value.
 *
 * Both helpers follow the person's number locale (Profile → number format).
 * Field values are never shortened by the "compact numbers" preference: a
 * stored amount is something people check digit by digit. Counts in prose and
 * summary figures go through `formatNumber` (lib/utils.ts), which does honour it.
 */

export type { NumberFieldMeta, NumberKind } from './number-kind'
export {
  isReferenceName,
  nameWords,
  numberCurrencyOf,
  numberDecimalsOf,
  numberKindOf,
  numberKindOfValue
} from './number-kind'

export interface CurrencyFormatOptions {
  /** ISO currency code; default USD. An unknown code falls back to USD. */
  currency?: string | null
  /** Fraction digits: 2 (default), 0 (whole units), 'auto' (cents only when
   *  the value has them), or any 0–10 a field's precision asks for. */
  decimals?: number | 'auto'
  /** Short form at and above 1,000: $12.3K, $1.2M (999,999 → $1M, never $1000K). */
  compact?: boolean
}

/** A value as a finite number, or null ('' / null / NaN / text that is not a number). */
export function toFiniteNumber(value: unknown): number | null {
  if (value == null || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function emptyOrRaw(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'number') return ''
  const s = String(value)
  return s.trim() ? s : ''
}

function currencyCode(code: string | null | undefined): string {
  const c = String(code ?? 'USD').toUpperCase()
  return /^[A-Z]{3}$/.test(c) ? c : 'USD'
}

/**
 * Money as people read it: $12,345.67, -$1,234.56, $12.3K (compact).
 * null / '' / NaN → ''. A string that is not a number comes back as it was.
 */
export function formatCurrency(value: unknown, opts: CurrencyFormatOptions = {}): string {
  const n = toFiniteNumber(value)
  if (n == null) return emptyOrRaw(value)
  const currency = currencyCode(opts.currency)
  const locale = numberLocale()
  const decimals = opts.decimals ?? 2
  const digits =
    decimals === 'auto'
      ? Number.isInteger(n)
        ? 0
        : 2
      : Math.min(Math.max(Math.trunc(Number(decimals) || 0), 0), 10)
  const make = (o: Intl.NumberFormatOptions) => {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency, ...o }).format(n)
    } catch {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...o }).format(n)
    }
  }
  if (opts.compact && Math.abs(n) >= 1000)
    return make({ notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 })
  return make({ minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** A plain grouped number in the person's locale (no compact form), up to `maxDecimals`. */
export function formatGrouped(value: unknown, maxDecimals = 2): string {
  const n = toFiniteNumber(value)
  if (n == null) return emptyOrRaw(value)
  return new Intl.NumberFormat(numberLocale(), {
    maximumFractionDigits: Math.min(Math.max(Math.trunc(maxDecimals), 0), 10)
  }).format(n)
}

/**
 * A stored number as a person reads it, by its field (rule: lib/number-kind.ts):
 *   money   → formatCurrency in the field's currency and precision ($135,297.66)
 *   decimal → grouped, up to the field's precision (135,297.66)
 *   count   → grouped (12,345)
 *   plain   → as stored (2026, 4500123, a PO number)
 * A field unit other than '$' is appended ("12 days", "40%").
 * With no field, the value decides (numberKindOfValue): numbers are grouped,
 * whole-number strings stay as stored.
 * null / '' → ''. Anything that is not a number comes back unchanged.
 */
export function formatFieldNumber(value: unknown, field?: NumberFieldMeta | null): string {
  if (value == null || value === '') return ''
  const n = toFiniteNumber(value)
  if (n == null) return emptyOrRaw(value)
  // A field of no known number type (a list column without its type) still keeps a
  // reference-named value as stored: an `id` / `po_number` column never reads 4,500,123.
  const kind =
    numberKindOf(field) ??
    (isReferenceName(field?.field) ? 'plain' : (numberKindOfValue(value) ?? 'plain'))
  return formatNumberAs(n, kind, field, value)
}

/** formatFieldNumber for a kind already decided (column totals, sums of a field). */
export function formatNumberAs(
  n: number,
  kind: NumberKind,
  field?: NumberFieldMeta | null,
  raw?: unknown
): string {
  if (!Number.isFinite(n)) return ''
  if (kind === 'money')
    return formatCurrency(n, {
      currency: numberCurrencyOf(field) ?? 'USD',
      decimals: numberDecimalsOf(field, 2)
    })
  if (kind === 'plain')
    return raw != null && typeof raw !== 'object' ? String(raw).trim() : String(n)
  // A count never rounds away a fraction it actually has (a quantity of 2.5).
  const text = formatGrouped(
    n,
    kind === 'count' && Number.isInteger(n) ? 0 : numberDecimalsOf(field, 2)
  )
  const unit = unitOf(field)
  if (!unit || unit === '$') return text
  return unit === '%' ? `${text}%` : `${text} ${unit}`
}

function unitOf(field: NumberFieldMeta | null | undefined): string {
  const o = field?.options
  let opts: Record<string, unknown> = {}
  if (typeof o === 'string') {
    try {
      opts = JSON.parse(o) ?? {}
    } catch {
      opts = {}
    }
  } else if (o && typeof o === 'object') opts = o as Record<string, unknown>
  return typeof opts.unit === 'string' ? opts.unit.trim() : ''
}
