// What fits where (#2634, #2636): how many characters a field shows at each
// width, the width the stored values need, and the placement settings (input
// mask, form default, label) that cannot fit the column behind the field.

/** The widths the inspector offers, widest first (col_span of 12). */
export const SPANS = [12, 6, 4, 3] as const
export type Span = (typeof SPANS)[number]

export const SPAN_WORDS: Record<number, string> = { 12: 'Full', 6: '½', 4: '⅓', 3: '¼' }

// A desktop form is about 960px across its 12 columns; an input loses ~40px
// to the gutter and its padding; DM Sans at 13px averages ~7px a character.
const FORM_PX = 960
const INPUT_CHROME_PX = 40
const CHAR_PX = 7

/** Characters an input of `span` columns shows before it cuts the value off. */
export function capacityChars(span: number | null | undefined): number {
  const s = Math.max(1, Math.min(12, Number(span) || 12))
  return Math.max(1, Math.floor(((s / 12) * FORM_PX - INPUT_CHROME_PX) / CHAR_PX))
}

/** The narrowest offered width that shows `chars` characters (Full when none does). */
export function suggestSpan(chars: number): Span {
  for (const s of [...SPANS].reverse()) if (capacityChars(s) >= chars) return s
  return 12
}

export interface WidthVerdict {
  /** The current width cuts off the 95th-percentile value. */
  cut: boolean
  /** The narrowest width that shows it; equals the current width when it already fits. */
  suggest: Span
  /** The current width is wider than any value needs (only said when two steps wider). */
  roomy: boolean
}

export function widthVerdict(span: number | null | undefined, p95: number): WidthVerdict {
  const cur = Number(span) || 12
  const suggest = suggestSpan(p95)
  return {
    cut: capacityChars(cur) < p95,
    suggest,
    roomy: p95 > 0 && SPANS.indexOf(suggest) - SPANS.indexOf(cur as Span) >= 2
  }
}

/** Single-line inputs only: long text wraps, pickers show labels, not the stored id. */
export function widthCheckApplies(info: {
  type: string
  relKind?: string | null
  isPath?: boolean
  iface?: string | null
}): boolean {
  if (info.relKind || info.isPath) return false
  if (['text', 'json', 'boolean', 'alias'].includes(info.type)) return false
  const iface = info.iface ?? ''
  if (/textarea|rich|markdown|wysiwyg|code|tags|repeater|file|image/i.test(iface)) return false
  return true
}

// ─── Column fit (#2636) ──────────────────────────────────────────────────────

export interface ColumnFact {
  type: string
  max_length: number | null
  precision: number | null
  scale: number | null
  nullable: boolean
}

/** "nvarchar(50)", "decimal(18,2)", "int". */
export function typeWords(c: ColumnFact): string {
  if (c.max_length != null) return `${c.type}(${c.max_length})`
  if (/^n?varchar$/.test(c.type)) return `${c.type}(max)`
  if (c.precision != null) return `${c.type}(${c.precision},${c.scale ?? 0})`
  return c.type
}

/** Characters an input mask stores: # a digit, A a letter, * anything. */
export function maskStoredLength(mask: string): number {
  return [...mask].filter((ch) => ch === '#' || ch === 'A' || ch === '*').length
}

const INT_MAX: Record<string, number> = {
  tinyint: 255,
  smallint: 32767,
  int: 2147483647,
  integer: 2147483647
}

/** Why `value` cannot be stored in the column, or null when it fits. */
export function valueMisfit(c: ColumnFact, value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'object') return null // tokens, picks: judged when the record saves
  const text = String(value)
  if (text.startsWith('$') || text.includes('{{')) return null // $NOW, $CURRENT_USER, templates
  if (c.max_length != null && text.length > c.max_length)
    return `${text.length} characters; the column holds ${c.max_length}`
  const max = INT_MAX[c.type]
  if (max != null) {
    const n = Number(text)
    if (Number.isFinite(n) && Math.abs(n) > max) return `larger than ${c.type} holds (${max})`
  }
  if (c.precision != null && /^-?\d+(\.\d+)?$/.test(text)) {
    const [int = '', frac = ''] = text.replace('-', '').split('.')
    const intDigits = int.replace(/^0+/, '').length
    const room = c.precision - (c.scale ?? 0)
    if (intDigits > room) return `${intDigits} digits before the point; the column allows ${room}`
    if (c.scale != null && frac.length > c.scale)
      return `${frac.length} decimals; the column keeps ${c.scale}`
  }
  return null
}

export interface FitWarning {
  /** What it is about: mask, default, label. */
  key: 'mask' | 'default' | 'label'
  text: string
}

/** Placement settings that cannot fit the column or the width. */
export function fitWarnings(input: {
  column: ColumnFact | null
  mask?: string | null
  defaultValue?: unknown
  label?: string | null
  span?: number | null
  layoutType?: string
}): FitWarning[] {
  const out: FitWarning[] = []
  const c = input.column
  if (c && input.mask) {
    const n = maskStoredLength(input.mask)
    if (c.max_length != null && n > c.max_length)
      out.push({
        key: 'mask',
        text: `The input mask stores ${n} characters; the column holds ${c.max_length}.`
      })
  }
  if (c && input.defaultValue !== undefined) {
    const why = valueMisfit(c, input.defaultValue)
    if (why) out.push({ key: 'default', text: `This form's default value does not fit: ${why}.` })
  }
  if (input.label && input.layoutType !== 'table') {
    const room = capacityChars(input.span)
    if (input.label.length > room)
      out.push({
        key: 'label',
        text: `The label (${input.label.length} characters) is cut off at this width, which shows about ${room}.`
      })
  }
  return out
}
