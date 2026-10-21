import { applyValidationRule, type ValidationRule } from '../validation-rules.js'
import { asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * AI validation suggestions (#2680): infer checks (patterns, ranges, lengths)
 * from a field's stored values and say how many existing rows each one would
 * fail. Suggest-only — an admin applies a suggestion through the field's
 * global writer (nivaro_fields.validation_rules, every form).
 *
 * Privacy: the values are read here, as the admin through the read gate, and
 * reduced to SHAPES — lengths, number ranges and masked patterns ("AA-999999":
 * letters → A/a, digits → 9, punctuation kept). Only those shapes and the
 * pattern-derived candidates go to the model, never a stored value. A shared
 * literal prefix ("PO-") is kept only when many distinct values share it (a
 * code, not a person's data).
 */

export const SAMPLE_CAP = 5000
const MAX_MASKS = 8
const MAX_SUGGESTIONS = 6
const MIN_VALUES = 5

export interface ValueStats {
  kind: 'text' | 'number' | 'other'
  checked: number
  empty: number
  distinct: number
  distinctCapped: boolean
  minLength?: number
  maxLength?: number
  /** Masked shapes, most common first. */
  masks?: Array<{ mask: string; count: number }>
  /** A literal prefix most values share (only when it reads as a code). */
  prefix?: string | null
  min?: number
  max?: number
  integers?: boolean
  negatives?: number
  /** Share of text values each built-in format accepts (0–1). */
  formats?: { email: number; url: number; phone: number }
}

export interface Suggestion {
  rule: ValidationRule
  sentence: string
  source: 'pattern' | 'ai'
  /** Existing non-empty values of the sample this check would refuse. */
  fails: number
}

/** "PO-12345" → "AA-99999": letters A/a, digits 9, everything else as is. */
export function maskOf(v: string): string {
  return v.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9')
}

type Token = { cls: 'A' | 'a' | '9' | 'lit'; text: string; len: number }

/** A mask as runs: "AA-999" → [A×2, '-', 9×3]. Letters of mixed case count as one run. */
function tokens(mask: string): Token[] {
  const out: Token[] = []
  for (const ch of mask) {
    const cls: Token['cls'] = ch === 'A' || ch === 'a' || ch === '9' ? ch : 'lit'
    const last = out[out.length - 1]
    if (last && last.cls === cls && (cls !== 'lit' || last.text === ch)) {
      last.len++
      if (cls === 'lit') last.text += ch
    } else out.push({ cls, text: ch, len: 1 })
  }
  return out
}

const shapeKey = (t: Token[]) => t.map((x) => (x.cls === 'lit' ? `[${x.text[0]}]` : x.cls)).join('')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/**
 * One anchored regex covering every mask with the dominant run structure
 * (run lengths become {min,max}), or null when no structure covers `share`
 * of the values. A shared literal prefix replaces its masked runs.
 */
export function regexFromMasks(
  masks: Array<{ mask: string; count: number }>,
  total: number,
  prefix?: string | null,
  share = 0.9
): string | null {
  if (!total) return null
  const byShape = new Map<string, { toks: Token[][]; count: number }>()
  for (const m of masks) {
    const body = prefix ? m.mask.slice(prefix.length) : m.mask
    const t = tokens(body)
    const key = shapeKey(t)
    const e = byShape.get(key) ?? { toks: [], count: 0 }
    e.toks.push(t)
    e.count += m.count
    byShape.set(key, e)
  }
  const best = [...byShape.values()].sort((a, b) => b.count - a.count)[0]
  if (!best || best.count / total < share) return null
  const first = best.toks[0]
  const parts = first.map((tok, i) => {
    const lens = best.toks.map((t) => t[i].len)
    const lo = Math.min(...lens)
    const hi = Math.max(...lens)
    const q = lo === hi ? (lo === 1 ? '' : `{${lo}}`) : `{${lo},${hi}}`
    if (tok.cls === 'lit') return lo === hi ? escapeRe(tok.text) : `${escapeRe(tok.text[0])}${q}`
    const cls =
      tok.cls === '9'
        ? '\\d'
        : best.toks.some((t) => t[i].text.includes('a')) &&
            best.toks.some((t) => t[i].text.includes('A'))
          ? '[A-Za-z]'
          : tok.cls === 'A'
            ? '[A-Z]'
            : '[a-z]'
    return `${cls}${q}`
  })
  return `^${prefix ? escapeRe(prefix) : ''}${parts.join('')}$`
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isUrl = (s: string) => {
  try {
    new URL(s)
    return true
  } catch {
    return false
  }
}
const isPhone = (s: string) => {
  const hadPlus = s.trim().startsWith('+')
  const digits = s.replace(/\D/g, '')
  return (
    (digits.length === 10 && !hadPlus) ||
    (digits.length === 11 && digits.startsWith('1')) ||
    (hadPlus && digits.length >= 8 && digits.length <= 15)
  )
}

/** The longest prefix ≥ 95% of values share, kept only when it reads as a code (≥ 20 distinct values). */
function codePrefix(values: string[], distinct: number): string | null {
  if (distinct < 20 || values.length < 20) return null
  const counts = new Map<string, number>()
  for (const v of values) {
    const m = /^[A-Za-z]{1,4}[-_/.#]?/.exec(v)
    if (m) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]
  return top && top[1] / values.length >= 0.95 && top[0].length <= 6 ? top[0] : null
}

export function computeStats(values: unknown[], fieldType: string): ValueStats {
  const nonEmpty = values.filter((v) => v != null && v !== '')
  const distinctSet = new Set<string>()
  for (const v of nonEmpty) {
    if (distinctSet.size >= 2000) break
    distinctSet.add(String(v))
  }
  const base = {
    checked: values.length,
    empty: values.length - nonEmpty.length,
    distinct: distinctSet.size,
    distinctCapped: distinctSet.size >= 2000
  }
  const numeric = ['integer', 'bigInteger', 'float', 'decimal', 'number'].includes(fieldType)
  if (numeric) {
    const nums = nonEmpty.map(Number).filter((n) => Number.isFinite(n))
    return {
      kind: 'number',
      ...base,
      ...(nums.length
        ? {
            min: Math.min(...nums),
            max: Math.max(...nums),
            integers: nums.every((n) => Number.isInteger(n)),
            negatives: nums.filter((n) => n < 0).length
          }
        : {})
    }
  }
  if (!['string', 'text', 'char', 'varchar'].includes(fieldType)) return { kind: 'other', ...base }
  const strs = nonEmpty.map((v) => String(v))
  const maskCounts = new Map<string, number>()
  for (const s of strs) {
    const m = maskOf(s.slice(0, 80))
    maskCounts.set(m, (maskCounts.get(m) ?? 0) + 1)
  }
  const masks = [...maskCounts]
    .map(([mask, count]) => ({ mask, count }))
    .sort((a, b) => b.count - a.count)
  const n = strs.length || 1
  return {
    kind: 'text',
    ...base,
    minLength: strs.length ? Math.min(...strs.map((s) => s.length)) : undefined,
    maxLength: strs.length ? Math.max(...strs.map((s) => s.length)) : undefined,
    masks: masks.slice(0, 200),
    prefix: codePrefix(strs, distinctSet.size),
    formats: {
      email: strs.filter((s) => EMAIL_RE.test(s)).length / n,
      url: strs.filter((s) => /^https?:\/\//i.test(s) && isUrl(s)).length / n,
      phone: strs.filter(isPhone).length / n
    }
  }
}

/** The stats the model sees: shapes only, the top masks, no values. */
export function statsForModel(s: ValueStats) {
  return {
    kind: s.kind,
    checked: s.checked,
    empty: s.empty,
    distinct: s.distinctCapped ? `${s.distinct}+` : s.distinct,
    ...(s.kind === 'text'
      ? {
          length: { min: s.minLength, max: s.maxLength },
          masks: s.masks?.slice(0, MAX_MASKS),
          prefix: s.prefix ?? undefined,
          formats: s.formats
        }
      : {}),
    ...(s.kind === 'number'
      ? { min: s.min, max: s.max, integers: s.integers, negatives: s.negatives }
      : {})
  }
}

/** Candidates read straight off the shapes — offered with or without AI. */
export function patternCandidates(s: ValueStats): ValidationRule[] {
  const nonEmpty = s.checked - s.empty
  if (nonEmpty < MIN_VALUES) return []
  const out: ValidationRule[] = []
  if (s.kind === 'text') {
    const f = s.formats
    if (f && f.email >= 0.95) out.push({ type: 'email' })
    else if (f && f.url >= 0.95) out.push({ type: 'url' })
    else if (f && f.phone >= 0.95 && (s.maxLength ?? 0) <= 20) out.push({ type: 'phone' })
    else {
      const re = s.masks ? regexFromMasks(s.masks, nonEmpty, s.prefix) : null
      // A pattern that is just "some letters" (names, free text) is no check worth having.
      if (re && (re.includes('\\d') || !!s.prefix)) out.push({ type: 'regex', value: re })
    }
    if (s.maxLength != null && s.maxLength <= 255 && !out.some((r) => r.type === 'regex'))
      out.push({ type: 'max', value: s.maxLength })
    if (s.minLength != null && s.minLength > 1 && !out.some((r) => r.type === 'regex'))
      out.push({ type: 'min', value: s.minLength })
  }
  if (s.kind === 'number' && s.min != null && s.negatives === 0) out.push({ type: 'min', value: 0 })
  return out
}

export const VALIDATION_SYSTEM = `You propose validation checks for one form field from statistics about its stored values (you never see the values).
Masks show the shape of text values: A = capital letter, a = small letter, 9 = digit, other characters as they are.
Checks you may propose:
{"type":"regex","value":"<anchored JavaScript regex>"} {"type":"min","value":<number>} {"type":"max","value":<number>} {"type":"email"} {"type":"url"} {"type":"phone"}
For text, min/max count characters; for numbers they bound the value.
Answer with ONE JSON object and nothing else: {"suggestions":[{"rule":{...},"message":"<what a person sees when the value is refused, short>","why":"<one short reason>"}]} — at most ${MAX_SUGGESTIONS}, the most useful first. Keep only checks the statistics clearly support; an empty list is a fine answer. Never propose a check for free text such as names or notes.`

export function buildValidationPrompt(
  field: { field: string; label: string; type: string },
  stats: ValueStats,
  candidates: ValidationRule[],
  current: ValidationRule[]
): string {
  return JSON.stringify({
    field: field.field,
    label: field.label,
    type: field.type,
    stats: statsForModel(stats),
    candidates,
    already_checked: current.map((r) => r.type)
  })
}

const RULE_TYPES = new Set(['regex', 'min', 'max', 'email', 'url', 'phone'])
/** A nested quantifier ("(a+)+") can take exponential time on a bad value. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/

export function checkRule(raw: unknown): ValidationRule | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type : ''
  if (!RULE_TYPES.has(type)) return null
  const message = cleanText(o.message, 120)
  const withMsg = (r: ValidationRule) => (message ? { ...r, message } : r)
  if (type === 'regex') {
    const v = typeof o.value === 'string' ? o.value : ''
    if (!v || v.length > 300 || NESTED_QUANTIFIER.test(v)) return null
    try {
      new RegExp(v)
    } catch {
      return null
    }
    return withMsg({ type, value: v })
  }
  if (type === 'min' || type === 'max') {
    const n = Number(o.value)
    if (!Number.isFinite(n)) return null
    return withMsg({ type, value: n })
  }
  return withMsg({ type })
}

export function parseValidationAnswer(text: string): { rules: ValidationRule[]; dropped: number } {
  const parsed = parseJsonLoose(text)
  if (!parsed) return { rules: [], dropped: 0 }
  const rules: ValidationRule[] = []
  let dropped = 0
  for (const s of asArray(parsed.suggestions).slice(0, MAX_SUGGESTIONS)) {
    const o = (s ?? {}) as Record<string, unknown>
    const rule = checkRule({ ...(o.rule as object), message: o.message })
    if (rule) rules.push(rule)
    else dropped++
  }
  return { rules, dropped }
}

const sameRule = (a: ValidationRule, b: ValidationRule) =>
  a.type === b.type && String(a.value ?? '') === String(b.value ?? '')

/** How many non-empty values the server's own evaluator would refuse. */
export function countFails(rule: ValidationRule, values: unknown[], label: string): number {
  let fails = 0
  for (const v of values) {
    if (v == null || v === '') continue
    if (applyValidationRule(rule, v, label)) fails++
  }
  return fails
}

export function ruleSentence(r: ValidationRule, kind: ValueStats['kind']): string {
  switch (r.type) {
    case 'regex':
      return `Values must match the pattern ${String(r.value)}`
    case 'min':
      return kind === 'number' ? `At least ${r.value}` : `At least ${r.value} characters`
    case 'max':
      return kind === 'number' ? `At most ${r.value}` : `At most ${r.value} characters`
    case 'email':
      return 'Must be an email address'
    case 'url':
      return 'Must be a web address'
    case 'phone':
      return 'Must be a phone number'
    default:
      return r.type
  }
}

/** Candidates + AI rules, deduplicated against each other and what is stored, each with its fail count. */
export function buildSuggestions(
  candidates: ValidationRule[],
  aiRules: ValidationRule[],
  current: ValidationRule[],
  values: unknown[],
  label: string,
  kind: ValueStats['kind']
): Suggestion[] {
  const out: Suggestion[] = []
  const push = (rule: ValidationRule, source: Suggestion['source']) => {
    if (current.some((c) => sameRule(c, rule))) return
    const dup = out.findIndex((s) => sameRule(s.rule, rule))
    if (dup >= 0) {
      // The AI's wording wins over the bare candidate.
      if (source === 'ai' && rule.message) out[dup] = { ...out[dup], rule, source }
      return
    }
    out.push({
      rule,
      sentence: ruleSentence(rule, kind),
      source,
      fails: countFails(rule, values, label)
    })
  }
  for (const r of candidates) push(r, 'pattern')
  for (const r of aiRules) push(r, 'ai')
  return out.slice(0, MAX_SUGGESTIONS + 2)
}
