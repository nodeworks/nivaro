// Alias (to-many) link identity — the one place that says when two links
// name the same related record, for the junction writes in services/items.ts.
//
// Ids compare without regard to letter case: SQL Server stores a
// uniqueidentifier case-blind and answers it upper-case, while a picker or an
// import's email lookup may send it lower-case. Comparing the raw strings let
// the same person be linked twice (IR 37827 "Peter Moniz, Peter Moniz",
// army 9/10). A link with no discriminator (rows written before it was set)
// matches any collection: it must never be duplicated beside itself.

export interface AliasLink {
  id: string | number
  /** Polymorphic link: the collection the id belongs to (the junction's discriminator value). */
  collection?: string
}

export function aliasLinkIdKey(id: unknown): string {
  return String(id ?? '').toLowerCase()
}

export function sameAliasLink(a: AliasLink, b: AliasLink): boolean {
  return (
    aliasLinkIdKey(a.id) === aliasLinkIdKey(b.id) &&
    (!a.collection || !b.collection || a.collection.toLowerCase() === b.collection.toLowerCase())
  )
}

/** The same link named twice in one write (two picks of one person, a
 *  prefill plus a pick) is written once. Order is kept; the first spelling wins. */
export function dedupeAliasLinks(links: AliasLink[]): AliasLink[] {
  const out: AliasLink[] = []
  for (const link of links) {
    if (out.some((kept) => sameAliasLink(kept, link))) continue
    out.push(link)
  }
  return out
}

/**
 * Removals the same write also adds back are no removal: the link stays.
 *
 * A form that clears a Zone (the committed link staged for removal) and then
 * gets that same Zone back (picked again, or filled from the Region by an
 * upstream cascade) sends `divisions: {create: [3], delete: [3]}`. Adds skip a
 * link that already exists and removals ran after them, so the write took the
 * Zone off and put nothing back — the workflow left its writer's Zone scope
 * (EFP prod 2026-11-17, workflow 372787: Zone and Region both lost this way).
 */
export function withoutReAddedRemovals(links: AliasLink[], removals: AliasLink[]): AliasLink[] {
  return removals.filter((r) => !links.some((l) => sameAliasLink(l, r)))
}
