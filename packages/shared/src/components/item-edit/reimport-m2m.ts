/**
 * Re-import of a header to-many field (funding years, project sub types, zones, regions) on an
 * existing record, by the template's `reimport.header_fields` policy — the same policy plain
 * header fields follow (2026-11-17: re-imported bids kept the old funding year and sub type
 * beside the new ones, because to-many fields only ever added).
 *
 *   - overwrite  → the stored set becomes the imported set: link what's missing, unlink the rest
 *                  (a link stored twice for the same value keeps one and drops the copy);
 *   - fill_empty → link the imported values only when nothing is linked yet;
 *   - skip       → leave the field alone.
 *
 * An import that names no value never clears the field. Pure — the caller stages the result.
 */
export type ReimportHeaderPolicy = 'overwrite' | 'fill_empty' | 'skip'

export interface StoredLink {
  /** The junction (link) row id. */
  junctionId: string | number
  /** The related record the link points at. */
  target: string
}

export function planReimportM2m(
  existing: StoredLink[],
  imported: unknown[],
  policy: ReimportHeaderPolicy
): { link: string[]; unlink: Array<string | number> } {
  const wanted = [
    ...new Set(
      imported.filter((v) => v !== null && v !== undefined && v !== '').map((v) => String(v))
    )
  ]
  if (policy === 'skip' || wanted.length === 0) return { link: [], unlink: [] }
  if (policy === 'fill_empty') {
    return existing.length === 0 ? { link: wanted, unlink: [] } : { link: [], unlink: [] }
  }
  const kept = new Set<string>()
  const unlink: Array<string | number> = []
  for (const row of existing) {
    if (wanted.includes(row.target) && !kept.has(row.target)) kept.add(row.target)
    else unlink.push(row.junctionId)
  }
  return { link: wanted.filter((v) => !kept.has(v)), unlink }
}
