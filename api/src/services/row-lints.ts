/**
 * Row lints (#766) — `options.row_lints` on an inline grid: "when X, expect
 * Y" per line. The grid judges them in the browser (the amber triangle beside
 * the line number); this is the same rule, word for word, for the integrity
 * sweep, so the record banner and /data-integrity report what the grid
 * shows. Ops eq | neq | in | null | nnull; values compare as strings, an M2O
 * value by its id. Never auto-fixed — a lint says two columns disagree, not
 * which one is wrong.
 */
export interface RowLintCondition {
  field: string
  op?: 'eq' | 'neq' | 'in' | 'null' | 'nnull'
  value?: unknown
}

export interface RowLint {
  label: string
  when: RowLintCondition
  expect: RowLintCondition
}

export function lintCondition(row: Record<string, unknown>, c: RowLintCondition): boolean {
  const v = row[c.field]
  const empty = v === null || v === undefined || v === ''
  const op = c.op ?? 'eq'
  if (op === 'null') return empty
  if (op === 'nnull') return !empty
  if (empty) return false
  const sv =
    typeof v === 'object' && v ? String((v as Record<string, unknown>).id ?? '') : String(v)
  if (op === 'in') {
    const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',')
    return list.map((x) => String(x).trim()).includes(sv)
  }
  const cv = String(c.value ?? '')
  return op === 'neq' ? sv !== cv : sv === cv
}

/** Labels of the lints a row fails. */
export function failingLints(
  row: Record<string, unknown>,
  lints: RowLint[] | null | undefined
): string[] {
  if (!lints?.length) return []
  const out: string[] = []
  for (const l of lints) {
    if (!l?.when?.field || !l?.expect?.field) continue
    if (!lintCondition(row, l.when)) continue
    if (lintCondition(row, l.expect)) continue
    out.push(l.label || `${l.when.field} vs ${l.expect.field}`)
  }
  return out
}

export function parseRowLints(raw: unknown): RowLint[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (l): l is RowLint =>
      !!l &&
      typeof l === 'object' &&
      typeof (l as RowLint).when?.field === 'string' &&
      typeof (l as RowLint).expect?.field === 'string'
  )
}
