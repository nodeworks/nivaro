// Leaf helpers for line-item number entry (catalog picker quantities, grid
// cells). No React, no heavy imports — unit-tested directly.

import { evaluateNumeric } from '../../lib/expression'

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
