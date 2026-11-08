/**
 * Duplicate rehearsal (army9 b09 LOW): More → Duplicate copies a record's
 * lines onto the new form, but the create may not keep every copied value —
 * a rule re-derives a line's price from its category, a role that may not set
 * the price has it dropped and derived instead. The Submit dialog already asks
 * before such a side effect; Duplicate applied it with no notice ($2 → $1).
 *
 * Before the first Save of a duplicated form, the create is REHEARSED
 * (`POST /items/<collection>?dry_run=1` with the staged lines nested — the
 * same request as the real create, nothing stored) and every copied line
 * value the stored row would not keep is named for the person to confirm.
 * Leaf module: no React, unit-tested directly.
 */

import { AUDIT_FIELDS } from '../panels/requirement-side-effects'

/** One nested row of a dry-run create report (api DryRunNestedRow). */
export interface RehearsedRow {
  index: number
  ok: boolean
  data?: Record<string, unknown> | null
}

export interface CopiedLineChange {
  /** `<childCollection>.<fkField>` — the staging key. */
  key: string
  /** Position of the row in that key's staged rows. */
  index: number
  field: string
  from: unknown
  to: unknown
}

const blank = (v: unknown) => v === null || v === undefined || v === ''

/** Same value for the person: numbers compare as numbers ("2" is 2), blanks
 *  are blanks, anything else by text. */
export function sameLineValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (blank(a) && blank(b)) return true
  if (blank(a) || blank(b)) return false
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '')
    return na === nb
  return String(a) === String(b)
}

/** The parent create body the rehearsal sends: the form's fields plus every
 *  staged line set under its alias (grandchild / bookkeeping keys stripped).
 *  A key with no alias on this collection is left out (it is not a child set
 *  the create would write). */
export function rehearsalBody(
  fields: Record<string, unknown>,
  rows: Record<string, Array<Record<string, unknown>>>,
  aliasOf: (key: string) => string | null
): { body: Record<string, unknown>; aliases: Record<string, string> } {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (!k.startsWith('__')) body[k] = v
  const aliases: Record<string, string> = {}
  for (const [key, list] of Object.entries(rows)) {
    const alias = aliasOf(key)
    if (!alias || !Array.isArray(list) || list.length === 0) continue
    aliases[key] = alias
    body[alias] = list.map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('__')))
    )
  }
  return { body, aliases }
}

/**
 * Every copied line value the rehearsed create would replace: for each staged
 * row, each of ITS OWN non-blank values whose stored counterpart differs.
 * Values the server fills into a blank are the derivation working as designed
 * and are not asked about; audit stamps, ids and `_` keys never are. A row the
 * rehearsal refused (or did not answer) contributes nothing — the real create
 * will say what is wrong with it.
 */
export function copiedValueChanges(
  rows: Record<string, Array<Record<string, unknown>>>,
  nested: Record<string, RehearsedRow[]> | null | undefined,
  aliases: Record<string, string>
): CopiedLineChange[] {
  const out: CopiedLineChange[] = []
  for (const [key, list] of Object.entries(rows)) {
    const alias = aliases[key]
    const answers = alias ? (nested?.[alias] ?? []) : []
    if (answers.length === 0) continue
    list.forEach((row, index) => {
      const answer = answers.find((a) => a.index === index) ?? answers[index]
      if (!answer || !answer.ok || !answer.data) return
      for (const [field, from] of Object.entries(row)) {
        if (field === 'id' || field.startsWith('_')) continue
        if (AUDIT_FIELDS.has(field.toLowerCase())) continue
        if (blank(from) || typeof from === 'object') continue
        if (!(field in answer.data)) continue
        const to = answer.data[field]
        if (sameLineValue(from, to)) continue
        out.push({ key, index, field, from, to })
      }
    })
  }
  return out
}

/** "Line 2" for a staged row: its line number when it carries one, else its position. */
export function copiedLineLabel(row: Record<string, unknown>, index: number): string {
  const n = row.line_number ?? row.sort ?? null
  return `Line ${n !== null && n !== undefined && n !== '' ? String(n) : index + 1}`
}
