// Leaf helpers for line-item number entry (catalog picker quantities, grid
// cells). No React, no heavy imports — unit-tested directly.

import { evaluateNumeric } from '../../lib/expression'
import { applyValidationRule } from '../../lib/validation-rules'
import type { FormValidationRule } from '../../types'

/** Column types that only hold whole numbers, with the largest value each can
 *  store. bigint is capped at the largest integer a JS number holds exactly
 *  (the driver refuses anything past it: "Bigint must be safe integer"). */
const INTEGER_LIMITS: Record<string, number> = {
  tinyint: 255,
  smallint: 32_767,
  integer: 2_147_483_647,
  int: 2_147_483_647,
  bigInteger: Number.MAX_SAFE_INTEGER,
  bigint: Number.MAX_SAFE_INTEGER
}

/** Every numeric column type a grid cell may hold. */
export const NUMBER_FIELD_TYPES = new Set([
  ...Object.keys(INTEGER_LIMITS),
  'decimal',
  'float',
  'double',
  'real',
  'numeric',
  'money',
  'smallmoney',
  'number'
])

export function isIntegerFieldType(type: string | null | undefined): boolean {
  return type != null && Object.hasOwn(INTEGER_LIMITS, type)
}

export type NumberEntryCheck = { ok: true; value: number | null } | { ok: false; message: string }

/** Validates one typed number against its column: finite, whole where the
 *  column is an integer type, within what the column can store, and not
 *  below `min`. Empty input is `{ ok: true, value: null }`. */
export function checkNumberEntry(
  raw: unknown,
  opts: { type?: string | null; min?: number; label?: string } = {}
): NumberEntryCheck {
  const label = opts.label ?? 'Value'
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === ''))
    return { ok: true, value: null }
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isNaN(n)) return { ok: false, message: `${label} must be a number` }
  const limit = isIntegerFieldType(opts.type)
    ? INTEGER_LIMITS[opts.type as string]
    : Number.MAX_SAFE_INTEGER
  if (!Number.isFinite(n) || Math.abs(n) > limit)
    return { ok: false, message: `${label} can't be more than ${limit.toLocaleString('en-US')}` }
  if (isIntegerFieldType(opts.type) && !Number.isInteger(n))
    return { ok: false, message: `${label} must be a whole number` }
  if (opts.min !== undefined && n < opts.min)
    return {
      ok: false,
      message: opts.min === 0 ? `${label} can't be negative` : `${label} can't be below ${opts.min}`
    }
  return { ok: true, value: n }
}

/** A staged (not yet saved) line after a quantity commit: the freshly built
 *  payload over the row, except columns the person may edit by hand keep the
 *  row's value (a typed price must survive a qty change), then every formula
 *  re-runs over the result. The saved-row paths follow the same rule. */
export function mergePendingQtyRow(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
  editableFields: string[],
  computeFields: Record<string, string> = {}
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row, ...payload }
  for (const f of editableFields) {
    if (row[f] != null && row[f] !== '') next[f] = row[f]
  }
  for (const [dst, formula] of Object.entries(computeFields)) {
    const v = evaluateNumeric(formula, next)
    if (v !== null) next[dst] = v
  }
  return next
}

/** What a saved line's edit sends: only the writable columns whose value
 *  differs from the stored row (a `_change_reason` always rides along). The
 *  server judges validation_rules on the fields a write carries, so a legacy
 *  value nobody touched (a negative quantity from before a min rule) never
 *  blocks an edit to another column. No stored row = the whole payload. */
export function changedRowFields(
  draft: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined,
  writableKeys: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(draft)) {
    if (!writableKeys.has(k)) continue
    if (stored && k !== '_change_reason' && String(v ?? '') === String(stored[k] ?? '')) continue
    out[k] = v
  }
  return out
}

/** The largest line money value the server stores: decimal(12,2) money
 *  columns (the same bound the server's numeric fit check and the line
 *  "must be smaller than 10,000,000,000" rules hold). Mirrored here — the
 *  shared package has no export of the API's limit. */
export const MAX_LINE_MONEY = 9_999_999_999.99

/** A line's write-computed number columns (Amount = qty × price) judged at the
 *  LINE Save (army6 M4): the column's own validation rule (the server's
 *  words), else the money fit — "Line 1: Amount must be smaller than
 *  $10,000,000,000". A column whose value equals the stored one is never
 *  re-judged (legacy figures stay editable). */
export function computedColumnErrors(
  cols: Array<{
    field: string
    label?: string | null
    type?: string | null
    computed_type?: string | null
    computed_formula?: string | null
    validation_rules?: unknown
  }>,
  computed: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined,
  lineLabel: string
): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = []
  for (const c of cols) {
    if (c.computed_type !== 'write' || !c.computed_formula) continue
    if (c.type && !NUMBER_FIELD_TYPES.has(c.type)) continue
    const raw = computed[c.field]
    if (raw === null || raw === undefined || raw === '') continue
    const v = Number(raw)
    if (!Number.isFinite(v)) continue
    if (stored && String(stored[c.field] ?? '') === String(raw)) continue
    const label = c.label || c.field
    const ruleErr = lineRuleErrors(
      [{ field: c.field, label, type: c.type ?? 'decimal', validation_rules: c.validation_rules }],
      { [c.field]: v },
      { ...computed, [c.field]: v }
    )[0]
    if (ruleErr) {
      out.push({ field: c.field, message: `${lineLabel}: ${ruleErr.message}` })
      continue
    }
    if (Math.abs(v) > MAX_LINE_MONEY)
      out.push({
        field: c.field,
        message: `${lineLabel}: ${label} must be smaller than $10,000,000,000`
      })
  }
  return out
}

/** A line saved with quantity 0 (army6 L1): the grid's quantity column (a
 *  number column named qty / quantity) reads 0 — a $0 line can go to
 *  approval unnoticed. A soft warning only: close-out needs 0 lines. Returns
 *  the column's label, or null. */
export function zeroQtyColumn(
  cols: Array<{ field: string; label?: string | null; type?: string | null }>,
  draft: Record<string, unknown>
): string | null {
  const col = cols.find(
    (c) => /^(qty|quantity)$/i.test(c.field) && NUMBER_FIELD_TYPES.has(c.type ?? '')
  )
  if (!col) return null
  const raw = draft[col.field]
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === ''))
    return null
  return Number(raw) === 0 ? col.label || col.field : null
}

/** A typed money value with more decimals than the column keeps (army6 H5:
 *  a hand price 0.005 × 3 showed $0.02 and stored 0.01 — the price rounds to
 *  the column, the total did not follow). Refused at the cell, so what is
 *  shown is what is stored: "Price takes 2 decimals". Null = fine (blank,
 *  not a number — other checks own those — or within `places`). */
export function decimalPlacesProblem(raw: unknown, label: string, places = 2): string | null {
  if (raw === null || raw === undefined) return null
  const t = String(raw).trim()
  if (t === '' || Number.isNaN(Number(t))) return null
  // 1e-3 / 5E-3 spell decimals too: judge the number's own fixed form.
  const fixed = /e/i.test(t) ? Number(t).toFixed(20).replace(/0+$/, '') : t
  const frac = fixed.includes('.') ? fixed.split('.')[1].replace(/0+$/, '') : ''
  if (frac.length <= places) return null
  return `${label} takes ${places} decimal${places === 1 ? '' : 's'}`
}

/** A saved line's STAGED edit after the person edits the line again (army6
 *  H4): every staged field the new draft puts back to the STORED value leaves
 *  the staged edit — a refused 10,000,000,000 corrected back to the saved 3
 *  must stop being sent, not be kept because "3 is no change". `rest` is the
 *  staged edit without those fields; `reverted` names them. Meta keys
 *  (`_change_reason`, `__…`) are never judged. */
export function dropRevertedFields(
  staged: Record<string, unknown> | null | undefined,
  draft: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined
): { rest: Record<string, unknown>; reverted: string[] } {
  if (!staged) return { rest: {}, reverted: [] }
  if (!stored) return { rest: { ...staged }, reverted: [] }
  const rest: Record<string, unknown> = {}
  const reverted: string[] = []
  for (const [k, v] of Object.entries(staged)) {
    const meta = k === '_change_reason' || k.startsWith('__')
    if (!meta && k in draft && String(draft[k] ?? '') === String(stored[k] ?? '')) {
      reverted.push(k)
      continue
    }
    rest[k] = v
  }
  return { rest, reverted }
}

/** Whether a staged line edit still changes something: a change reason or the
 *  early-flush marker alone is not an edit (staged grandchild ops are). */
export function isRealLineEdit(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).some((k) => k !== '_change_reason' && k !== '__flush_early')
}

function parseRules(raw: unknown): FormValidationRule[] {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v)
    ? (v.filter((r) => r && typeof r.type === 'string') as FormValidationRule[])
    : []
}

/** A line's validation_rules, judged the way the server judges the write
 *  (api services/validation-rules.ts enforceValidationRules): only fields the
 *  write carries (`sent`), plus a cross-field rule whose OTHER field it
 *  carries; values read from `record` (stored row with the edit over it).
 *  Number columns (`type`) judge a typed string as the number it will be
 *  saved as (ruleValueFor). `soft` rules are skipped, as the record form
 *  skips them. One message per
 *  failing field, first failing rule wins. */
export function lineRuleErrors(
  fields: Array<{
    field: string
    label?: string | null
    type?: string | null
    validation_rules?: unknown
  }>,
  sent: Record<string, unknown>,
  record: Record<string, unknown>
): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = []
  for (const f of fields) {
    for (const rule of parseRules(f.validation_rules)) {
      if (rule.soft) continue
      const cross = rule.type === 'gte_field' || rule.type === 'lte_field'
      if (!(f.field in sent) && !(cross && rule.field && rule.field in sent)) continue
      // A typed "-5" in a number column is judged as -5, not a string.
      const value = ruleValueFor(f.type, record[f.field])
      const err = applyValidationRule(rule, value, f.label || f.field, record)
      if (err) {
        out.push({ field: f.field, message: err })
        break
      }
    }
  }
  return out
}

/** A number column's value as a validation rule should see it: a typed
 *  numeric string judged as the number it will be saved as (a `min: 0` rule
 *  read "-5" as a 2-character string and let it through). */
export function ruleValueFor(type: string | null | undefined, raw: unknown): unknown {
  if (typeof raw !== 'string' || !NUMBER_FIELD_TYPES.has(type ?? '')) return raw
  const t = raw.trim()
  if (t === '') return raw
  const n = Number(t)
  return Number.isNaN(n) ? raw : n
}
