import { choiceLabel, formatDate, formatDateTime } from './utils'

/**
 * How a plain (non-relation) value reads in record compare (army 11 staging
 * check: "hold_final_10", "124133", "#367714"): a choice by its label, yes/no
 * in words, money as money, dates local, never a raw key. Pure — the relation
 * case (a label read as the viewer) is the caller's component.
 */

export interface CompareFieldMeta {
  field?: string
  type?: string | null
  interface?: string | null
  options?: unknown
  display_options?: unknown
}

type Choice = { text?: unknown; value?: unknown }

function obj(v: unknown): Record<string, unknown> {
  if (!v) return {}
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
    } catch {
      return {}
    }
  }
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function choicesOf(meta: CompareFieldMeta | undefined): Choice[] {
  const o = obj(meta?.options)
  const d = obj(meta?.display_options)
  const list = Array.isArray(o.choices) ? o.choices : Array.isArray(d.choices) ? d.choices : []
  return list.filter((c): c is Choice => !!c && typeof c === 'object')
}

const BOOLEAN_TYPES = new Set(['boolean'])
const DATETIME_TYPES = new Set(['timestamp', 'datetime', 'datetime-local'])
const NUMBER_TYPES = new Set(['integer', 'biginteger', 'decimal', 'float', 'bigint'])

function currencyOf(meta: CompareFieldMeta | undefined): string | null {
  const o = obj(meta?.options)
  const d = obj(meta?.display_options)
  const fmt = String(o.format ?? d.format ?? '')
  if (fmt !== 'currency' && !o.currency && !d.currency) return null
  const c = String(o.currency ?? d.currency ?? 'USD').toUpperCase()
  return /^[A-Z]{3}$/.test(c) ? c : 'USD'
}

function one(v: unknown, meta: CompareFieldMeta | undefined): string {
  if (v == null || v === '') return '—'
  const choices = choicesOf(meta)
  if (choices.length > 0) {
    const hit = choices.find((c) => String(c.value) === String(v))
    if (hit && hit.text != null && String(hit.text).trim()) return choiceLabel(String(hit.text))
  }
  const type = String(meta?.type ?? '').toLowerCase()
  const iface = String(meta?.interface ?? '').toLowerCase()
  if (typeof v === 'boolean' || BOOLEAN_TYPES.has(type) || iface === 'boolean') {
    const s = String(v).toLowerCase()
    if (v === true || s === 'true' || s === '1') return 'Yes'
    if (v === false || s === 'false' || s === '0') return 'No'
  }
  if (type === 'date') return formatDate(String(v)) || String(v)
  if (
    DATETIME_TYPES.has(type) ||
    (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v))
  ) {
    const s = String(v)
    // A UTC-midnight stamp on a date is a calendar day, not a moment.
    if (/^\d{4}-\d{2}-\d{2}(T00:00:00(\.0+)?Z)?$/.test(s)) return formatDate(s) || s
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? s : formatDateTime(d)
  }
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  const numeric =
    (typeof v === 'number' || NUMBER_TYPES.has(type)) &&
    String(v).trim() !== '' &&
    Number.isFinite(n)
  if (numeric) {
    const currency = currencyOf(meta)
    if (currency)
      try {
        return n.toLocaleString('en-US', { style: 'currency', currency })
      } catch {
        return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      }
    // Whole-number columns are often references people quote (a PO number): no grouping.
    if (type === 'integer' || type === 'biginteger' || type === 'bigint') return String(n)
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  const s = String(v)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

/** The value as people read it (arrays: each part, comma-joined). */
export function compareValueText(value: unknown, meta?: CompareFieldMeta): string {
  if (Array.isArray(value) && value.every((v) => v == null || typeof v !== 'object')) {
    const parts = value.filter((v) => v != null && v !== '').map((v) => one(v, meta))
    return parts.length ? parts.join(', ') : '—'
  }
  if (value && typeof value === 'object') {
    // Structured data (a JSON field): a short preview, as before.
    try {
      return JSON.stringify(value).slice(0, 80)
    } catch {
      return '—'
    }
  }
  return one(value, meta)
}
