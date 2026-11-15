/**
 * Move a record's ticked lines to a new record (idea 4, 2026-11-14). The switch
 * lives in the collection meta: `browser_config.line_split = {enabled, relations:
 * ['<line collection>.<link field>'], …}` — off unless an admin turns it on.
 * Client twin of api services/record-split.ts `parseLineSplitConfig` (relations
 * only); the server judges every split again.
 */

const RELATION_KEY = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/

function objectOf(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `<line collection>.<link field>` — how a line list is named in the config. */
export function lineSplitKey(lineCollection: string, linkField: string): string {
  return `${lineCollection}.${linkField}`
}

/** The line lists of a collection whose lines may move to a new record (none = off). */
export function lineSplitRelations(browserConfig: unknown): string[] {
  const cfg = objectOf(objectOf(browserConfig)?.line_split)
  if (cfg?.enabled !== true || !Array.isArray(cfg.relations)) return []
  const out: string[] = []
  for (const r of cfg.relations) {
    const s = typeof r === 'string' ? r.trim() : ''
    if (RELATION_KEY.test(s) && !out.includes(s)) out.push(s)
  }
  return out.slice(0, 10)
}

/** May this line list split? Needs the switch on for it and a saved record. */
export function canOfferLineSplit(
  browserConfig: unknown,
  lineCollection: string,
  linkField: string
): boolean {
  return lineSplitRelations(browserConfig).includes(lineSplitKey(lineCollection, linkField))
}

/** Why the ticked lines cannot move yet, or null when they can. */
export function lineSplitBlocker(p: {
  selectedSaved: number
  selectedUnsaved: number
  totalSaved: number
  unsavedEdits: boolean
}): string | null {
  if (p.selectedUnsaved > 0) return 'Save the new lines first — only saved lines can move.'
  if (p.unsavedEdits) return 'Save your line changes first.'
  if (p.selectedSaved === 0) return 'Tick the lines to move.'
  if (p.selectedSaved >= p.totalSaved)
    return 'Leave at least one line here. To move every line, duplicate the record instead.'
  return null
}

/** The API path of a split. */
export function lineSplitPath(collection: string, id: string | number): string {
  return `/record-split/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`
}
