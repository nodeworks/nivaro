/**
 * Collection-import match fields (the client half of api services/import-match.ts): a job
 * matches existing records on one or more fields, stored in `id_field` as one name or a comma
 * list. With none, every row is created — EFP prod 2026-11-19: a re-run with "Overwrite" and no
 * match field created 16k duplicates — so the wizard warns and asks for an explicit confirm.
 */

/** The match fields a stored id_field (or saved mapping) names, in order, no repeats. */
export function parseMatchFields(raw: unknown): string[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string') {
    const s = raw.trim()
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s)
        if (Array.isArray(parsed)) list = parsed
      } catch {
        list = []
      }
    } else if (s) list = s.split(',')
  }
  const out: string[] = []
  for (const v of list) {
    const name = String(v ?? '').trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

export const NO_MATCH_WARNING = 'No match fields: every row will be created as a new record'

/** The warning to show before Start, or null when at least one match field is chosen. */
export function noMatchWarning(matchFields: string[]): string | null {
  return matchFields.length === 0 ? NO_MATCH_WARNING : null
}

/** May the import start? Without a match field only after the person confirmed the warning. */
export function canStartImport(matchFields: string[], confirmedNoMatch: boolean): boolean {
  return matchFields.length > 0 || confirmedNoMatch
}
