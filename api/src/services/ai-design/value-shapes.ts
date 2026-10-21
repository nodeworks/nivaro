/**
 * Shapes of a column's stored values (#2679), so a placeholder can show what
 * people type without showing anything they typed. Values never leave this
 * module: callers get masked patterns ("PO-######"), lengths and rounded
 * number ranges, and `copiesRealValue` checks every example against the
 * sample before it is offered. Pure.
 */

export interface TextShape {
  kind: 'text'
  sampled: number
  /** Share of sampled values that are different from each other (0–1). */
  distinct_share: number
  /** Most common masked patterns: A = capital, a = small letter, # = digit. */
  patterns: Array<{ pattern: string; share: number }>
  length: { min: number; max: number; typical: number }
}

export interface NumberShape {
  kind: 'number'
  sampled: number
  /** Rounded to two significant figures — a range, never a stored amount. */
  min: number
  max: number
  typical: number
  decimals: number
  negative: boolean
}

export type ValueShape = TextShape | NumberShape

const MASK_MAX = 32
const PATTERNS = 3

/** A value as its character classes; long runs of letters shorten to keep words unreadable. */
export function maskValue(value: string): string {
  const masked = String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\p{Lu}/gu, 'A')
    .replace(/\p{Ll}/gu, 'a')
    .replace(/\p{N}/gu, '#')
    // Word lengths can hint at a name: any run of 4+ small letters reads "aaa…".
    .replace(/a{4,}/g, 'aaa…')
  return masked.length > MASK_MAX ? `${masked.slice(0, MASK_MAX)}…` : masked
}

/** n rounded to two significant figures (1234 → 1200, 0.0456 → 0.046). */
export function roundish(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0
  const mag = 10 ** (Math.floor(Math.log10(Math.abs(n))) - 1)
  return Math.round(n / mag) * mag
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Shape of the sampled values, or null when there is nothing to learn from. */
export function valueShape(values: unknown[], numeric: boolean): ValueShape | null {
  const present = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
  if (present.length < 3) return null
  if (numeric) {
    const nums = present
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    if (nums.length < 3) return null
    const decimals = Math.min(
      4,
      Math.max(...nums.map((n) => (String(n).split('.')[1] ?? '').length))
    )
    return {
      kind: 'number',
      sampled: nums.length,
      min: roundish(nums[0]),
      max: roundish(nums[nums.length - 1]),
      typical: roundish(median(nums)),
      decimals,
      negative: nums[0] < 0
    }
  }
  const strings = present.map((v) => String(v).trim())
  const counts = new Map<string, number>()
  for (const s of strings) {
    const m = maskValue(s)
    counts.set(m, (counts.get(m) ?? 0) + 1)
  }
  const lengths = strings.map((s) => s.length).sort((a, b) => a - b)
  return {
    kind: 'text',
    sampled: strings.length,
    distinct_share: Math.round((new Set(strings).size / strings.length) * 100) / 100,
    patterns: [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PATTERNS)
      .map(([pattern, n]) => ({ pattern, share: Math.round((n / strings.length) * 100) / 100 })),
    length: { min: lengths[0], max: lengths[lengths.length - 1], typical: median(lengths) }
  }
}

const DIGITS = '4718293605'
const UPPER = 'KMRTBDHLPN'
const LOWER = 'example'

/**
 * A made-up value with the pattern's shape: digits and letters from fixed
 * sequences ("PO-######" → "PO-471829"). Null when the pattern is mostly
 * shortened words (free text has no useful shape).
 */
export function exampleFromPattern(pattern: string): string | null {
  if (pattern.includes('…')) return null
  let d = 0
  let u = 0
  let l = 0
  return pattern.replace(/[A#a]/g, (c) => {
    if (c === '#') return DIGITS[d++ % DIGITS.length]
    if (c === 'A') return UPPER[u++ % UPPER.length]
    return LOWER[l++ % LOWER.length]
  })
}

/** A made-up number inside the typical range, formatted like the column. */
export function exampleFromNumbers(shape: NumberShape): string {
  const n = shape.typical || shape.max || 1
  return n.toLocaleString('en-US', {
    minimumFractionDigits: shape.decimals ? Math.min(2, shape.decimals) : 0,
    maximumFractionDigits: Math.min(2, shape.decimals)
  })
}

function bare(s: string): string {
  return s
    .trim()
    .replace(/^(?:e\.?\s?g\.?|for example|like|such as)[:,]?\s*/i, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .replace(/[,\s]/g, '')
    .toLowerCase()
}

/**
 * Whether an example repeats a stored value: equal to one (ignoring "e.g.",
 * quotes, case, spaces and thousands separators), or containing one that is
 * at least `minInside` characters long.
 */
export function copiesRealValue(
  example: string,
  samples: Iterable<unknown>,
  minInside = 5
): boolean {
  const ex = bare(example)
  if (!ex) return false
  for (const raw of samples) {
    if (raw === null || raw === undefined) continue
    const v = bare(String(raw))
    if (!v) continue
    if (v === ex) return true
    if (v.length >= minInside && ex.includes(v)) return true
    // Numbers: 1250 and 1250.00 are the same amount.
    const a = Number(v)
    const b = Number(ex)
    if (Number.isFinite(a) && Number.isFinite(b) && a === b) return true
  }
  return false
}
