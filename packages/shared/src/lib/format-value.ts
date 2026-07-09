import { formatRelative } from './utils'

// Mirrors ColumnFormatConfig in api/src/services/queues.ts (duplicated by
// design — admin does not import api types). Display-only: raw values stay
// raw in QueueItem.extra and the materialized cache.
export type ColumnFormatConfig =
  | { type: 'datetime'; template: string }
  | { type: 'number'; decimals?: number; thousands?: boolean; prefix?: string; suffix?: string }
  | { type: 'boolean'; true_label: string; false_label: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const TRUTHY = new Set(['true', '1', 'yes', 'y'])
const FALSY = new Set(['false', '0', 'no', 'n'])

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDateTemplate(raw: string, template: string): string {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  if (template === 'relative') return formatRelative(d)
  // Longest tokens first so YYYY wins over YY, MMM over MM, hh over h.
  return template.replace(/YYYY|MMM|YY|MM|DD|HH|hh|mm|ss|h|A|a/g, (token) => {
    switch (token) {
      case 'YYYY':
        return String(d.getFullYear())
      case 'YY':
        return String(d.getFullYear()).slice(-2)
      case 'MMM':
        return MONTHS[d.getMonth()]
      case 'MM':
        return pad(d.getMonth() + 1)
      case 'DD':
        return pad(d.getDate())
      case 'HH':
        return pad(d.getHours())
      case 'hh':
        return pad(d.getHours() % 12 || 12)
      case 'h':
        return String(d.getHours() % 12 || 12)
      case 'mm':
        return pad(d.getMinutes())
      case 'ss':
        return pad(d.getSeconds())
      case 'A':
        return d.getHours() < 12 ? 'AM' : 'PM'
      case 'a':
        return d.getHours() < 12 ? 'am' : 'pm'
      default:
        return token
    }
  })
}

// Garbage in, raw out: never throws, never blanks a non-empty value.
export function formatValue(raw: string, cfg: ColumnFormatConfig): string {
  if (cfg.type === 'datetime') return formatDateTemplate(raw, cfg.template)
  if (cfg.type === 'number') {
    const n = Number(raw)
    if (Number.isNaN(n) || raw.trim() === '') return raw
    const formatted = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: cfg.decimals ?? 0,
      maximumFractionDigits: cfg.decimals ?? 0,
      useGrouping: cfg.thousands ?? false
    }).format(n)
    return `${cfg.prefix ?? ''}${formatted}${cfg.suffix ?? ''}`
  }
  const lower = raw.trim().toLowerCase()
  if (TRUTHY.has(lower)) return cfg.true_label
  if (FALSY.has(lower)) return cfg.false_label
  return raw
}

// Multi-value relation cells arrive as one joined string: "A, B, C +2 more"
// (formatMultiValueCell in api/src/services/queues.ts). Split, format each,
// rejoin. Safe because raw datetimes (ISO) and raw numbers never contain ', '
// and text values are never format targets.
export function formatMultiValue(raw: string, cfg: ColumnFormatConfig): string {
  if (!raw) return raw
  const suffixMatch = raw.match(/ \+\d+ more$/)
  const suffix = suffixMatch ? suffixMatch[0] : ''
  const body = suffix ? raw.slice(0, -suffix.length) : raw
  const formatted = body
    .split(', ')
    .map((v) => formatValue(v, cfg))
    .join(', ')
  return formatted + suffix
}
