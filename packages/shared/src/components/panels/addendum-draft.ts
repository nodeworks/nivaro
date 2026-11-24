/**
 * What a NEW addendum draft would actually change (prod 2026-11-24, workflow 368943): the
 * create sheet pre-fills every field and every line, so a draft whose author closed the sheet
 * after "Close Out Lines" and started again stored the record's own lines as the proposal —
 * the reviewer saw an addendum that changed nothing. The sheet asks before it drops a draft
 * that holds changes, and asks before it creates one that holds none. Pure.
 */
import { diffAddendumLines } from './AddendumLinesDiff'

type Row = Record<string, unknown>

/** Same rule the create call uses to keep a field: a value equal to the parent's is not a change. */
export function proposedFieldChanges(
  formData: Record<string, unknown>,
  parentData: Record<string, unknown>,
  derived: (field: string) => boolean
): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(formData)) {
    if (derived(key)) continue
    if (value === undefined) continue
    if (String(value ?? '') === String(parentData[key] ?? '')) continue
    out.push(key)
  }
  return out
}

const strip = (rows: Row[]) => rows.map(({ __prefilled: _, ...rest }) => rest)

/** Lines added, changed or removed against the rows the sheet pre-filled. */
export function proposedLineChanges(current: Row[], prefilled: Row[], fkField: string): number {
  const d = diffAddendumLines(strip(current), strip(prefilled), fkField)
  return d.added.length + d.changed.length + d.removed.length
}

export interface DraftChanges {
  /** Fields whose proposed value differs from the record's. */
  fields: number
  /** Line rows added, changed or removed, over every line table on the form. */
  lines: number
  /** The author typed or attached something (title, notes, files) — worth asking before dropping. */
  typed: boolean
}

/** The draft changes something on the record. */
export const draftProposes = (c: DraftChanges) => c.fields + c.lines > 0

/** Closing would lose work the author did. */
export const draftHasWork = (c: DraftChanges) => c.typed || draftProposes(c)
